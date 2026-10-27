import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalStableStringify,
  type JsonValue,
  type Participant,
} from '@board-game/contracts';
import type { Pool, PoolClient } from 'pg';
import {
  assertDailyChallengeRewardPlan,
  assertDailyChallengeRewardPolicy,
  calculateDailyChallengeRewardPlan,
} from './rewards.js';
import type {
  DailyChallengeAbandonInput,
  DailyChallengeAttemptRecord,
  DailyChallengeFinalizeInput,
  DailyChallengeGrinderRecord,
  DailyChallengeLeaderboardQuery,
  DailyChallengeLeaderboardRecord,
  DailyChallengeLeaderboardsQuery,
  DailyChallengeLeaderboardsRecord,
  DailyChallengePublicationInput,
  DailyChallengeReplayEligibility,
  DailyChallengeRewardPlan,
  DailyChallengeRewardPolicy,
  DailyChallengeRewardsSettledInput,
  DailyChallengeSettingsRecord,
  DailyChallengeSnapshotRecord,
} from './types.js';

export const DAILY_CHALLENGE_SCHEMA = 'board_platform_daily';

const SETTINGS_TABLE = `"${DAILY_CHALLENGE_SCHEMA}"."challenge_settings"`;
const SNAPSHOTS_TABLE = `"${DAILY_CHALLENGE_SCHEMA}"."challenge_snapshots"`;
const ATTEMPTS_TABLE = `"${DAILY_CHALLENGE_SCHEMA}"."challenge_attempts"`;
const REQUESTS_TABLE = `"${DAILY_CHALLENGE_SCHEMA}"."challenge_attempt_requests"`;
const DAILY_LOCK_SALT = 8213;
const DEFAULT_LEADERBOARD_LIMIT = 100;
const MAX_LEADERBOARD_LIMIT = 1_000;

/**
 * The DDL is deliberately additive for existing platform databases.  The
 * old per-account unique key is removed only after old rows receive
 * attemptNumber=1 and a stable opaque entry key.
 */
export function dailyChallengeMigrationStatements(): readonly string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS "${DAILY_CHALLENGE_SCHEMA}"`,
    `CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      game_id text NOT NULL,
      release_id text NOT NULL,
      settings jsonb NOT NULL,
      revision bigint NOT NULL CHECK (revision >= 1),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (game_id, release_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${SNAPSHOTS_TABLE} (
      game_id text NOT NULL,
      release_id text NOT NULL,
      mode_id text NOT NULL,
      challenge_date date NOT NULL,
      seed text NOT NULL,
      setup jsonb NOT NULL,
      settings jsonb NOT NULL,
      public_settings jsonb,
      reward_policy jsonb,
      reward_plan jsonb,
      rewards_settled_at timestamptz,
      settings_revision bigint NOT NULL CHECK (settings_revision >= 1),
      eligibility_cutoff_at timestamptz,
      finalized_at timestamptz,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (game_id, challenge_date)
    )`,
    `ALTER TABLE ${SNAPSHOTS_TABLE}
       ADD COLUMN IF NOT EXISTS eligibility_cutoff_at timestamptz,
       ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
       ADD COLUMN IF NOT EXISTS public_settings jsonb,
       ADD COLUMN IF NOT EXISTS reward_policy jsonb,
       ADD COLUMN IF NOT EXISTS reward_plan jsonb,
       ADD COLUMN IF NOT EXISTS rewards_settled_at timestamptz`,
    `CREATE INDEX IF NOT EXISTS challenge_snapshots_date_idx
       ON ${SNAPSHOTS_TABLE} (game_id, challenge_date DESC)`,
    `CREATE TABLE IF NOT EXISTS ${ATTEMPTS_TABLE} (
      attempt_id uuid PRIMARY KEY,
      game_id text NOT NULL,
      release_id text NOT NULL,
      mode_id text NOT NULL,
      challenge_date date NOT NULL,
      principal_id text NOT NULL,
      attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
      room_id text NOT NULL,
      request_id text NOT NULL,
      session_id text,
      participants jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('starting', 'started', 'completed', 'abandoned')),
      score double precision CHECK (score IS NULL OR score <> 'NaN'::double precision),
      result jsonb,
      completion_digest text,
      publication text NOT NULL DEFAULT 'pending' CHECK (publication IN ('pending', 'public', 'anonymous')),
      entry_key text NOT NULL,
      auto_publish_at timestamptz,
      publication_selected_at timestamptz,
      published_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (game_id, session_id)
    )`,
    `ALTER TABLE ${ATTEMPTS_TABLE}
       ADD COLUMN IF NOT EXISTS attempt_number integer,
       ADD COLUMN IF NOT EXISTS completion_digest text,
       ADD COLUMN IF NOT EXISTS publication text,
       ADD COLUMN IF NOT EXISTS entry_key text,
       ADD COLUMN IF NOT EXISTS auto_publish_at timestamptz,
       ADD COLUMN IF NOT EXISTS publication_selected_at timestamptz,
       ADD COLUMN IF NOT EXISTS published_at timestamptz`,
    `ALTER TABLE ${ATTEMPTS_TABLE}
       DROP CONSTRAINT IF EXISTS challenge_attempts_publication_check`,
    `DO $$
       DECLARE constraint_name text;
       BEGIN
         FOR constraint_name IN
           SELECT constraint_record.conname
             FROM pg_constraint AS constraint_record
             JOIN pg_class AS relation_record
               ON relation_record.oid = constraint_record.conrelid
             JOIN pg_namespace AS namespace_record
               ON namespace_record.oid = relation_record.relnamespace
            WHERE namespace_record.nspname = '${DAILY_CHALLENGE_SCHEMA}'
              AND relation_record.relname = 'challenge_attempts'
              AND constraint_record.contype = 'c'
              AND pg_get_constraintdef(constraint_record.oid) ILIKE '%publication%'
         LOOP
           EXECUTE format(
             'ALTER TABLE ${ATTEMPTS_TABLE} DROP CONSTRAINT %I',
             constraint_name
           );
         END LOOP;
       END
     $$`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET attempt_number = 1
      WHERE attempt_number IS NULL`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET publication = CASE WHEN status = 'completed' THEN 'public' ELSE 'pending' END
      WHERE publication IS NULL`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET publication = 'pending'
      WHERE publication = 'private'`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET entry_key = md5('platform-daily-entry:' || game_id || ':' || challenge_date::text || ':' || attempt_id::text)
      WHERE entry_key IS NULL`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET published_at = COALESCE(published_at, completed_at)
      WHERE publication IN ('public', 'anonymous') AND published_at IS NULL`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET publication_selected_at = COALESCE(publication_selected_at, published_at)
      WHERE publication IN ('public', 'anonymous') AND publication_selected_at IS NULL`,
    `UPDATE ${ATTEMPTS_TABLE}
        SET auto_publish_at = completed_at + interval '5 minutes'
      WHERE status = 'completed' AND completed_at IS NOT NULL AND auto_publish_at IS NULL`,
    `ALTER TABLE ${ATTEMPTS_TABLE}
       ALTER COLUMN attempt_number SET DEFAULT 1,
       ALTER COLUMN attempt_number SET NOT NULL,
       ALTER COLUMN publication SET DEFAULT 'pending',
       ALTER COLUMN publication SET NOT NULL,
       ALTER COLUMN entry_key SET NOT NULL`,
    `DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
            WHERE conname = 'challenge_attempts_publication_check'
         ) THEN
           ALTER TABLE ${ATTEMPTS_TABLE}
             ADD CONSTRAINT challenge_attempts_publication_check
             CHECK (publication IN ('pending', 'public', 'anonymous'));
         END IF;
       END
     $$`,
    `ALTER TABLE ${ATTEMPTS_TABLE}
       DROP CONSTRAINT IF EXISTS challenge_attempts_game_id_challenge_date_principal_id_key`,
    `DROP INDEX IF EXISTS challenge_attempts_game_id_challenge_date_principal_id_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS challenge_attempts_identity_idx
       ON ${ATTEMPTS_TABLE} (game_id, challenge_date, principal_id, attempt_number)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS challenge_attempts_active_idx
       ON ${ATTEMPTS_TABLE} (game_id, challenge_date, principal_id)
       WHERE status IN ('starting', 'started')`,
    `CREATE INDEX IF NOT EXISTS challenge_attempts_request_idx
       ON ${ATTEMPTS_TABLE} (game_id, challenge_date, principal_id, request_id)`,
    `CREATE INDEX IF NOT EXISTS challenge_attempts_leaderboard_idx
       ON ${ATTEMPTS_TABLE} (game_id, challenge_date, score DESC, completed_at ASC, attempt_id ASC)
       WHERE status = 'completed'`,
    `CREATE INDEX IF NOT EXISTS challenge_attempts_session_idx
       ON ${ATTEMPTS_TABLE} (session_id) WHERE session_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${REQUESTS_TABLE} (
      game_id text NOT NULL,
      challenge_date date NOT NULL,
      principal_id text NOT NULL,
      request_id text NOT NULL,
      attempt_id uuid NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (game_id, principal_id, request_id)
    )`,
    `ALTER TABLE ${REQUESTS_TABLE}
       DROP CONSTRAINT IF EXISTS challenge_attempt_requests_pkey`,
    `CREATE UNIQUE INDEX IF NOT EXISTS challenge_attempt_requests_identity_idx
       ON ${REQUESTS_TABLE} (game_id, principal_id, request_id)`,
    `INSERT INTO ${REQUESTS_TABLE}
       (game_id, challenge_date, principal_id, request_id, attempt_id, created_at)
     SELECT game_id, challenge_date, principal_id, request_id, attempt_id, created_at
       FROM ${ATTEMPTS_TABLE}
      ON CONFLICT (game_id, principal_id, request_id) DO NOTHING`,
    `CREATE INDEX IF NOT EXISTS challenge_attempt_requests_attempt_idx
       ON ${REQUESTS_TABLE} (attempt_id)`,
  ];
}

export interface ReserveDailyChallengeAttemptInput {
  readonly attemptId?: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly modeId: string;
  readonly challengeDate: string;
  readonly principalId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly participants: readonly Participant[];
  readonly now?: Date;
  /** Optional caller hint; the store remains authoritative. */
  readonly attemptNumber?: number;
}

export interface CompleteDailyChallengeAttemptInput {
  readonly sessionId: string;
  readonly score: number;
  readonly result?: JsonValue;
  /** Caller-provided digest, or the store derives one from score/result. */
  readonly resultDigest?: string;
  readonly completedAt?: Date;
}

function dateValue(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error('DAILY_DATE_INVALID');
    return value.toISOString();
  }
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('DAILY_DATE_INVALID');
  return date.toISOString();
}

function dateOnlyValue(value: unknown): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error('DAILY_DATE_INVALID');
    return value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  if (match?.[1]) return match[1];
  throw new Error('DAILY_DATE_INVALID');
}

function jsonValue(value: unknown): JsonValue {
  return structuredClone(value as JsonValue);
}

function optionalJsonValue(
  value: unknown,
): { readonly result: JsonValue } | Record<string, never> {
  return value === null || value === undefined
    ? {}
    : { result: jsonValue(value) };
}

function optionalDate(
  value: unknown,
  key: 'startedAt' | 'autoPublishAt' | 'publicationSelectedAt',
): Record<string, string> {
  return value === null || value === undefined
    ? {}
    : { [key]: dateValue(value) };
}

function rowSettings(
  row: Record<string, unknown>,
): DailyChallengeSettingsRecord {
  return {
    gameId: String(row.game_id),
    releaseId: String(row.release_id),
    settings: jsonValue(row.settings),
    revision: Number(row.revision),
    updatedAt: dateValue(row.updated_at),
  };
}

function rowSnapshot(
  row: Record<string, unknown>,
): DailyChallengeSnapshotRecord {
  const cutoff = row.eligibility_cutoff_at;
  const finalized = row.finalized_at;
  const rawRewardPolicy =
    row.reward_policy === null || row.reward_policy === undefined
      ? undefined
      : jsonValue(row.reward_policy);
  const rawRewardPlan =
    row.reward_plan === null || row.reward_plan === undefined
      ? undefined
      : jsonValue(row.reward_plan);
  if (rawRewardPolicy !== undefined)
    assertDailyChallengeRewardPolicy(rawRewardPolicy);
  if (rawRewardPlan !== undefined)
    assertDailyChallengeRewardPlan(rawRewardPlan);
  return {
    gameId: String(row.game_id),
    releaseId: String(row.release_id),
    modeId: String(row.mode_id),
    challengeDate: dateOnlyValue(row.challenge_date),
    seed: String(row.seed),
    setup: jsonValue(row.setup),
    settings: jsonValue(row.settings),
    ...(rawRewardPolicy === undefined ? {} : { rewardPolicy: rawRewardPolicy }),
    ...(rawRewardPlan === undefined ? {} : { rewardPlan: rawRewardPlan }),
    ...(row.public_settings === null || row.public_settings === undefined
      ? {}
      : { publicSettings: jsonValue(row.public_settings) }),
    settingsRevision: Number(row.settings_revision),
    createdAt: dateValue(row.created_at),
    ...(cutoff === null || cutoff === undefined
      ? {}
      : { eligibilityCutoffAt: dateValue(cutoff) }),
    ...(finalized === null || finalized === undefined
      ? {}
      : { finalizedAt: dateValue(finalized) }),
    ...(row.rewards_settled_at === null || row.rewards_settled_at === undefined
      ? {}
      : { rewardsSettledAt: dateValue(row.rewards_settled_at) }),
  };
}

function rowAttempt(row: Record<string, unknown>): DailyChallengeAttemptRecord {
  const sessionId =
    row.session_id === null || row.session_id === undefined
      ? undefined
      : String(row.session_id);
  const score =
    row.score === null || row.score === undefined
      ? undefined
      : Number(row.score);
  const attemptNumber = Number(row.attempt_number ?? 1);
  const publicationState =
    row.publication === 'public' || row.publication === 'anonymous'
      ? row.publication
      : 'pending';
  return {
    attemptId: String(row.attempt_id),
    gameId: String(row.game_id),
    releaseId: String(row.release_id),
    modeId: String(row.mode_id),
    challengeDate: dateOnlyValue(row.challenge_date),
    attemptNumber:
      Number.isSafeInteger(attemptNumber) && attemptNumber > 0
        ? attemptNumber
        : 1,
    principalId: String(row.principal_id),
    roomId: String(row.room_id),
    requestId: String(row.request_id),
    ...(sessionId ? { sessionId } : {}),
    participants: jsonValue(
      row.participants,
    ) as unknown as readonly Participant[],
    status: row.status as DailyChallengeAttemptRecord['status'],
    ...(score === undefined ? {} : { score }),
    ...optionalJsonValue(row.result),
    ...(row.completion_digest === null || row.completion_digest === undefined
      ? {}
      : { completionDigest: String(row.completion_digest) }),
    publicationState,
    ...optionalDate(row.auto_publish_at, 'autoPublishAt'),
    ...optionalDate(
      row.publication_selected_at ?? row.published_at,
      'publicationSelectedAt',
    ),
    ...optionalDate(row.started_at, 'startedAt'),
    ...(row.completed_at === null || row.completed_at === undefined
      ? {}
      : { completedAt: dateValue(row.completed_at) }),
    updatedAt: dateValue(row.updated_at),
  };
}

function entryKeyFor(
  gameId: string,
  challengeDate: string,
  attemptId: string,
): string {
  return createHash('sha256')
    .update(`platform-daily-entry:${gameId}:${challengeDate}:${attemptId}`)
    .digest('hex');
}

function completionDigest(
  score: number,
  result: JsonValue | undefined,
): string {
  return createHash('sha256')
    .update(canonicalStableStringify({ score, result: result ?? null }))
    .digest('hex');
}

function sameCompletion(
  row: Record<string, unknown>,
  score: number,
  result: JsonValue | undefined,
  digest: string,
): boolean {
  if (row.completion_digest !== null && row.completion_digest !== undefined)
    return String(row.completion_digest) === digest;
  return (
    Number(row.score) === score &&
    canonicalStableStringify(jsonValue(row.result ?? null)) ===
      canonicalStableStringify(result ?? null)
  );
}

function normalizeLimit(value: number | undefined): number {
  return Math.min(
    Math.max(
      Number.isSafeInteger(value)
        ? (value as number)
        : DEFAULT_LEADERBOARD_LIMIT,
      1,
    ),
    MAX_LEADERBOARD_LIMIT,
  );
}

function compareLeaderboardRows(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const score = Number(right.score) - Number(left.score);
  if (score !== 0) return score;
  const leftCompleted = new Date(String(left.completed_at)).getTime();
  const rightCompleted = new Date(String(right.completed_at)).getTime();
  if (leftCompleted !== rightCompleted) return leftCompleted - rightCompleted;
  const principal = String(left.principal_id).localeCompare(
    String(right.principal_id),
  );
  if (principal !== 0) return principal;
  return String(left.attempt_id).localeCompare(String(right.attempt_id));
}

function scoreEntries(
  sourceRows: readonly Record<string, unknown>[],
  input: Pick<
    DailyChallengeLeaderboardQuery,
    'gameId' | 'challengeDate' | 'limit'
  >,
): DailyChallengeLeaderboardRecord[] {
  const rows = [...sourceRows].sort(compareLeaderboardRows);
  const limit =
    input.limit === Number.POSITIVE_INFINITY
      ? rows.length
      : normalizeLimit(input.limit);
  let previousScore: number | undefined;
  let previousRank = 0;
  return rows.slice(0, limit).map((row, index) => {
    const score = Number(row.score);
    const rank = previousScore === score ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    const publicationState =
      row.publication === 'anonymous' ? 'anonymous' : 'public';
    const result =
      publicationState === 'anonymous' ? {} : optionalJsonValue(row.result);
    return {
      entryKey:
        row.entry_key === null || row.entry_key === undefined
          ? entryKeyFor(
              input.gameId,
              input.challengeDate,
              String(row.attempt_id),
            )
          : String(row.entry_key),
      rank,
      principalId: String(row.principal_id),
      publicationState,
      score,
      attemptNumber: Number(row.attempt_number),
      ...result,
      ...(row.session_id === null || row.session_id === undefined
        ? {}
        : { sessionId: String(row.session_id) }),
      ...(row.started_at === null || row.started_at === undefined
        ? {}
        : { startedAt: dateValue(row.started_at) }),
      completedAt: dateValue(row.completed_at),
    };
  });
}

function grinderEntries(
  sourceRows: readonly Record<string, unknown>[],
  input: Pick<
    DailyChallengeLeaderboardsQuery,
    'gameId' | 'challengeDate' | 'limit' | 'visibility'
  >,
  cutoff?: string,
): DailyChallengeGrinderRecord[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of sourceRows) {
    const principalId = String(row.principal_id);
    const current = groups.get(principalId);
    if (current) current.push(row);
    else groups.set(principalId, [row]);
  }
  const rows = [...groups.entries()]
    .map(([principalId, attempts]) => {
      const eligible = attempts.filter((row) => {
        if (
          row.status !== 'completed' ||
          row.score === null ||
          row.score === undefined
        )
          return false;
        if (row.publication !== 'public' && row.publication !== 'anonymous')
          return false;
        if (input.visibility === 'public' && row.publication !== 'public')
          return false;
        if (input.visibility === 'anonymous' && row.publication !== 'anonymous')
          return false;
        if (
          cutoff &&
          row.completed_at !== null &&
          row.completed_at !== undefined &&
          dateValue(row.completed_at) > cutoff
        )
          return false;
        return true;
      });
      if (eligible.length === 0) return null;
      const bestScore = Math.max(...eligible.map((row) => Number(row.score)));
      const latestCompletedAt = eligible
        .map((row) => dateValue(row.completed_at))
        .sort()
        .at(-1);
      const attemptCount = Math.max(
        ...attempts.map((row) => Number(row.attempt_number ?? 1)),
      );
      return {
        principalId,
        attempts,
        eligible,
        attemptCount,
        completedCount: eligible.length,
        bestScore,
        latestCompletedAt,
        publicationState: eligible.some(
          (row) => row.publication === 'anonymous',
        )
          ? ('anonymous' as const)
          : ('public' as const),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort(
      (left, right) =>
        right.attemptCount - left.attemptCount ||
        right.completedCount - left.completedCount ||
        right.bestScore - left.bestScore ||
        String(left.latestCompletedAt).localeCompare(
          String(right.latestCompletedAt),
        ) ||
        left.principalId.localeCompare(right.principalId),
    );
  let previousAttemptCount: number | undefined;
  let previousRank = 0;
  const limit =
    input.limit === Number.POSITIVE_INFINITY
      ? rows.length
      : normalizeLimit(input.limit);
  return rows.slice(0, limit).map((row, index) => {
    const rank =
      previousAttemptCount === row.attemptCount ? previousRank : index + 1;
    previousAttemptCount = row.attemptCount;
    previousRank = rank;
    const representative = [...row.attempts].sort(
      (left, right) =>
        Number(left.attempt_number ?? 1) - Number(right.attempt_number ?? 1) ||
        String(left.attempt_id).localeCompare(String(right.attempt_id)),
    )[0];
    const entryKey =
      representative?.entry_key === null ||
      representative?.entry_key === undefined
        ? entryKeyFor(
            input.gameId,
            input.challengeDate,
            String(representative?.attempt_id),
          )
        : String(representative.entry_key);
    return {
      rank,
      entryKey,
      principalId: row.principalId,
      publicationState: row.publicationState,
      attemptCount: row.attemptCount,
      completedCount: row.completedCount,
      bestScore: row.bestScore,
      latestCompletedAt: row.latestCompletedAt,
    };
  });
}

export class PostgresDailyChallengeStore {
  public constructor(private readonly pool: Pool) {}

  public async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, ${DAILY_LOCK_SALT}))`,
        ['platform:daily-challenge:migrate'],
      );
      for (const statement of dailyChallengeMigrationStatements())
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async getSettings(
    gameId: string,
    releaseId: string,
  ): Promise<DailyChallengeSettingsRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SETTINGS_TABLE} WHERE game_id = $1 AND release_id = $2`,
      [gameId, releaseId],
    );
    return result.rows[0] ? rowSettings(result.rows[0]) : null;
  }

  public async getSnapshot(
    gameId: string,
    challengeDate: string,
  ): Promise<DailyChallengeSnapshotRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SNAPSHOTS_TABLE}
       WHERE game_id = $1 AND challenge_date = $2`,
      [gameId, challengeDate],
    );
    return result.rows[0] ? rowSnapshot(result.rows[0]) : null;
  }

  public async ensureSnapshot(input: {
    readonly gameId: string;
    readonly releaseId: string;
    readonly modeId: string;
    readonly challengeDate: string;
    readonly defaults: JsonValue;
    readonly settingsRevision?: number;
    readonly seed: string;
    readonly setup: JsonValue;
    readonly publicSettings?: JsonValue;
    readonly rewardPolicy?: DailyChallengeRewardPolicy;
    readonly eligibilityCutoffAt?: Date;
    readonly now?: Date;
  }): Promise<DailyChallengeSnapshotRecord> {
    if (input.rewardPolicy !== undefined)
      assertDailyChallengeRewardPolicy(input.rewardPolicy);
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `settings:${input.gameId}:${input.releaseId}`);
      await this.lock(
        client,
        `snapshot:${input.gameId}:${input.challengeDate}`,
      );
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${SNAPSHOTS_TABLE}
         WHERE game_id = $1 AND challenge_date = $2`,
        [input.gameId, input.challengeDate],
      );
      if (existing.rows[0]) {
        const existingSnapshot = rowSnapshot(existing.rows[0]);
        if (
          existingSnapshot.releaseId !== input.releaseId ||
          existingSnapshot.modeId !== input.modeId
        )
          throw new Error('DAILY_SNAPSHOT_ROUTE_CONFLICT');
        if (input.rewardPolicy !== undefined) {
          if (
            existingSnapshot.rewardPolicy !== undefined &&
            canonicalStableStringify(existingSnapshot.rewardPolicy) !==
              canonicalStableStringify(input.rewardPolicy)
          )
            throw new Error('DAILY_SNAPSHOT_REWARD_POLICY_CONFLICT');
        }
        await client.query('COMMIT');
        return rowSnapshot(existing.rows[0]);
      }
      let settings = await this.readSettings(
        client,
        input.gameId,
        input.releaseId,
      );
      if (!settings) {
        await client.query(
          `INSERT INTO ${SETTINGS_TABLE}
             (game_id, release_id, settings, revision, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, $4)`,
          [input.gameId, input.releaseId, JSON.stringify(input.defaults), now],
        );
        settings = await this.readSettings(
          client,
          input.gameId,
          input.releaseId,
        );
      }
      if (!settings) throw new Error('DAILY_SETTINGS_MISSING');
      if (
        input.settingsRevision !== undefined &&
        input.settingsRevision !== settings.revision
      )
        throw new Error('DAILY_SETTINGS_CHANGED');
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO ${SNAPSHOTS_TABLE}
           (game_id, release_id, mode_id, challenge_date, seed, setup, settings,
            public_settings, reward_policy, eligibility_cutoff_at,
            settings_revision, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
                 $9::jsonb, $10, $11, $12)
         RETURNING *`,
        [
          input.gameId,
          input.releaseId,
          input.modeId,
          input.challengeDate,
          input.seed,
          JSON.stringify(input.setup),
          JSON.stringify(settings.settings),
          input.publicSettings === undefined
            ? null
            : JSON.stringify(input.publicSettings),
          input.rewardPolicy === undefined
            ? null
            : JSON.stringify(input.rewardPolicy),
          input.eligibilityCutoffAt ?? null,
          settings.revision,
          now,
        ],
      );
      await client.query('COMMIT');
      if (!inserted.rows[0]) throw new Error('DAILY_SNAPSHOT_MISSING');
      return rowSnapshot(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async finalizeSnapshot(
    input: DailyChallengeFinalizeInput,
  ): Promise<DailyChallengeSnapshotRecord> {
    const finalizedAt = input.finalizedAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(
        client,
        `snapshot:${input.gameId}:${input.challengeDate}`,
      );
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${SNAPSHOTS_TABLE}
         WHERE game_id = $1 AND challenge_date = $2 FOR UPDATE`,
        [input.gameId, input.challengeDate],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('DAILY_SNAPSHOT_MISSING');
      const frozenCutoff = row.eligibility_cutoff_at;
      if (frozenCutoff === null || frozenCutoff === undefined)
        throw new Error('DAILY_SNAPSHOT_CUTOFF_MISSING');
      if (
        input.eligibilityCutoffAt &&
        dateValue(frozenCutoff) !== input.eligibilityCutoffAt.toISOString()
      )
        throw new Error('DAILY_SNAPSHOT_FINALIZE_CONFLICT');
      if (row.finalized_at !== null && row.finalized_at !== undefined) {
        await client.query('COMMIT');
        return rowSnapshot(row);
      }
      const rewardPlan = await this.buildRewardPlan(client, row);
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${SNAPSHOTS_TABLE}
            SET finalized_at = $3,
                reward_plan = CASE
                  WHEN reward_plan IS NULL THEN $4::jsonb
                  ELSE reward_plan
                END
          WHERE game_id = $1 AND challenge_date = $2
          RETURNING *`,
        [
          input.gameId,
          input.challengeDate,
          finalizedAt,
          rewardPlan === null ? null : JSON.stringify(rewardPlan),
        ],
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('DAILY_SNAPSHOT_MISSING');
      return rowSnapshot(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Compatibility alias used by finalization workers. */
  public async finalizeChallenge(
    input: DailyChallengeFinalizeInput,
  ): Promise<DailyChallengeSnapshotRecord> {
    return this.finalizeSnapshot(input);
  }

  /** Freeze the reward plan for an already-finalized snapshot if needed. */
  public async freezeRewardPlan(
    gameId: string,
    challengeDate: string,
  ): Promise<DailyChallengeRewardPlan | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `snapshot:${gameId}:${challengeDate}`);
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${SNAPSHOTS_TABLE}
         WHERE game_id = $1 AND challenge_date = $2 FOR UPDATE`,
        [gameId, challengeDate],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('DAILY_SNAPSHOT_MISSING');
      const snapshot = rowSnapshot(row);
      if (!snapshot.finalizedAt)
        throw new Error('DAILY_REWARD_SNAPSHOT_NOT_FINALIZED');
      const rewardPlan = await this.buildRewardPlan(client, row);
      if (!rewardPlan) {
        await client.query('COMMIT');
        return null;
      }
      if (snapshot.rewardPlan) {
        await client.query('COMMIT');
        return snapshot.rewardPlan;
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${SNAPSHOTS_TABLE}
            SET reward_plan = $3::jsonb
          WHERE game_id = $1 AND challenge_date = $2
            AND reward_plan IS NULL
          RETURNING *`,
        [gameId, challengeDate, JSON.stringify(rewardPlan)],
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('DAILY_REWARD_PLAN_MISSING');
      return rowSnapshot(updated.rows[0]).rewardPlan ?? rewardPlan;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Mark a frozen plan settled only after all durable awards are delivered. */
  public async markRewardsSettled(
    input: DailyChallengeRewardsSettledInput,
  ): Promise<DailyChallengeSnapshotRecord> {
    if (
      typeof input.planDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(input.planDigest)
    )
      throw new Error('DAILY_REWARD_PLAN_DIGEST_INVALID');
    const settledAt = input.settledAt ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(
        client,
        `snapshot:${input.gameId}:${input.challengeDate}`,
      );
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${SNAPSHOTS_TABLE}
         WHERE game_id = $1 AND challenge_date = $2 FOR UPDATE`,
        [input.gameId, input.challengeDate],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('DAILY_SNAPSHOT_MISSING');
      const snapshot = rowSnapshot(row);
      if (!snapshot.finalizedAt)
        throw new Error('DAILY_REWARD_SNAPSHOT_NOT_FINALIZED');
      if (!snapshot.rewardPlan) throw new Error('DAILY_REWARD_PLAN_MISSING');
      if (snapshot.rewardPlan.digest !== input.planDigest)
        throw new Error('DAILY_REWARD_PLAN_DIGEST_CONFLICT');
      if (snapshot.rewardsSettledAt) {
        await client.query('COMMIT');
        return snapshot;
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${SNAPSHOTS_TABLE}
            SET rewards_settled_at = $3
          WHERE game_id = $1 AND challenge_date = $2
            AND rewards_settled_at IS NULL
          RETURNING *`,
        [input.gameId, input.challengeDate, settledAt],
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('DAILY_REWARDS_SETTLE_MISSING');
      return rowSnapshot(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateSettings(input: {
    readonly gameId: string;
    readonly releaseId: string;
    readonly challengeDate: string;
    readonly settings: JsonValue;
    readonly expectedRevision?: number;
    readonly defaults: JsonValue;
    readonly now?: Date;
  }): Promise<DailyChallengeSettingsRecord> {
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(client, `settings:${input.gameId}:${input.releaseId}`);
      await this.lock(
        client,
        `snapshot:${input.gameId}:${input.challengeDate}`,
      );
      let current = await this.readSettings(
        client,
        input.gameId,
        input.releaseId,
      );
      if (!current) {
        await client.query(
          `INSERT INTO ${SETTINGS_TABLE}
             (game_id, release_id, settings, revision, updated_at)
           VALUES ($1, $2, $3::jsonb, 1, $4)`,
          [input.gameId, input.releaseId, JSON.stringify(input.defaults), now],
        );
        current = await this.readSettings(
          client,
          input.gameId,
          input.releaseId,
        );
      }
      if (!current) throw new Error('DAILY_SETTINGS_MISSING');
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== current.revision
      )
        throw new Error('DAILY_SETTINGS_REVISION_CONFLICT');
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${SETTINGS_TABLE}
            SET settings = $3::jsonb, revision = $4, updated_at = $5
          WHERE game_id = $1 AND release_id = $2
          RETURNING *`,
        [
          input.gameId,
          input.releaseId,
          JSON.stringify(input.settings),
          current.revision + 1,
          now,
        ],
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('DAILY_SETTINGS_MISSING');
      return rowSettings(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async reserveAttempt(
    input: ReserveDailyChallengeAttemptInput,
  ): Promise<DailyChallengeAttemptRecord> {
    const now = input.now ?? new Date();
    const attemptId = input.attemptId ?? randomUUID();
    if (!input.requestId || !input.principalId)
      throw new Error('DAILY_ATTEMPT_REQUEST_INVALID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lock(
        client,
        `request:${input.gameId}:${input.principalId}:${input.requestId}`,
      );
      await this.lock(
        client,
        `attempt:${input.gameId}:${input.challengeDate}:${input.principalId}`,
      );
      const sameRequest = await client.query<Record<string, unknown>>(
        `SELECT attempt.*
           FROM ${REQUESTS_TABLE} AS request
           JOIN ${ATTEMPTS_TABLE} AS attempt
             ON attempt.attempt_id = request.attempt_id
           JOIN ${SNAPSHOTS_TABLE} AS snapshot
             ON snapshot.game_id = attempt.game_id
            AND snapshot.challenge_date = attempt.challenge_date
            AND snapshot.release_id = attempt.release_id
            AND snapshot.mode_id = attempt.mode_id
          WHERE request.game_id = $1
            AND request.principal_id = $2
            AND request.request_id = $3
          FOR UPDATE OF attempt`,
        [input.gameId, input.principalId, input.requestId],
      );
      if (sameRequest.rows[0]) {
        await client.query('COMMIT');
        return rowAttempt(sameRequest.rows[0]);
      }
      const snapshot = await client.query<Record<string, unknown>>(
        `SELECT release_id, mode_id
           FROM ${SNAPSHOTS_TABLE}
          WHERE game_id = $1 AND challenge_date = $2
          FOR UPDATE`,
        [input.gameId, input.challengeDate],
      );
      const snapshotRow = snapshot.rows[0];
      if (!snapshotRow) throw new Error('DAILY_SNAPSHOT_MISSING');
      if (
        String(snapshotRow.release_id) !== input.releaseId ||
        String(snapshotRow.mode_id) !== input.modeId
      )
        throw new Error('DAILY_ATTEMPT_SNAPSHOT_ROUTE_CONFLICT');
      const active = await client.query<Record<string, unknown>>(
        `SELECT attempt.* FROM ${ATTEMPTS_TABLE} AS attempt
         JOIN ${SNAPSHOTS_TABLE} AS snapshot
           ON snapshot.game_id = attempt.game_id
          AND snapshot.challenge_date = attempt.challenge_date
          AND snapshot.release_id = attempt.release_id
          AND snapshot.mode_id = attempt.mode_id
         WHERE attempt.game_id = $1
           AND attempt.challenge_date = $2
           AND attempt.principal_id = $3
           AND attempt.status IN ('starting', 'started')
         ORDER BY attempt.attempt_number DESC LIMIT 1 FOR UPDATE OF attempt`,
        [input.gameId, input.challengeDate, input.principalId],
      );
      if (active.rows[0]) {
        await client.query(
          `INSERT INTO ${REQUESTS_TABLE}
             (game_id, challenge_date, principal_id, request_id, attempt_id, created_at)
           VALUES ($1, $2, $3, $4, $5::uuid, $6)
           ON CONFLICT (game_id, principal_id, request_id)
           DO NOTHING`,
          [
            input.gameId,
            input.challengeDate,
            input.principalId,
            input.requestId,
            active.rows[0].attempt_id,
            now,
          ],
        );
        await client.query('COMMIT');
        return rowAttempt(active.rows[0]);
      }
      const next = await client.query<{ attempt_number: number }>(
        `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
           FROM ${ATTEMPTS_TABLE} AS attempt
           JOIN ${SNAPSHOTS_TABLE} AS snapshot
             ON snapshot.game_id = attempt.game_id
            AND snapshot.challenge_date = attempt.challenge_date
            AND snapshot.release_id = attempt.release_id
            AND snapshot.mode_id = attempt.mode_id
          WHERE attempt.game_id = $1
            AND attempt.challenge_date = $2
            AND attempt.principal_id = $3`,
        [input.gameId, input.challengeDate, input.principalId],
      );
      const attemptNumber = Number(next.rows[0]?.attempt_number ?? 1);
      const inserted = await client.query<Record<string, unknown>>(
        `INSERT INTO ${ATTEMPTS_TABLE}
           (attempt_id, game_id, release_id, mode_id, challenge_date,
            principal_id, attempt_number, room_id, request_id, session_id,
            participants, status, publication, entry_key, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 'starting', 'pending', $12, $13, $13)
         RETURNING *`,
        [
          attemptId,
          input.gameId,
          input.releaseId,
          input.modeId,
          input.challengeDate,
          input.principalId,
          attemptNumber,
          input.roomId,
          input.requestId,
          input.sessionId,
          JSON.stringify(input.participants),
          entryKeyFor(input.gameId, input.challengeDate, attemptId),
          now,
        ],
      );
      await client.query(
        `INSERT INTO ${REQUESTS_TABLE}
           (game_id, challenge_date, principal_id, request_id, attempt_id, created_at)
         VALUES ($1, $2, $3, $4, $5::uuid, $6)`,
        [
          input.gameId,
          input.challengeDate,
          input.principalId,
          input.requestId,
          attemptId,
          now,
        ],
      );
      await client.query('COMMIT');
      if (!inserted.rows[0]) throw new Error('DAILY_ATTEMPT_MISSING');
      return rowAttempt(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async getAttemptByPrincipal(
    gameId: string,
    challengeDate: string,
    principalId: string,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt.* FROM ${ATTEMPTS_TABLE} AS attempt
       JOIN ${SNAPSHOTS_TABLE} AS snapshot
         ON snapshot.game_id = attempt.game_id
        AND snapshot.challenge_date = attempt.challenge_date
        AND snapshot.release_id = attempt.release_id
        AND snapshot.mode_id = attempt.mode_id
       WHERE attempt.game_id = $1
         AND attempt.challenge_date = $2
         AND attempt.principal_id = $3
       ORDER BY CASE WHEN attempt.status IN ('starting', 'started') THEN 0 ELSE 1 END,
                attempt.attempt_number DESC LIMIT 1`,
      [gameId, challengeDate, principalId],
    );
    return result.rows[0] ? rowAttempt(result.rows[0]) : null;
  }

  public async getActiveAttempt(
    gameId: string,
    challengeDate: string,
    principalId: string,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt.* FROM ${ATTEMPTS_TABLE} AS attempt
       JOIN ${SNAPSHOTS_TABLE} AS snapshot
         ON snapshot.game_id = attempt.game_id
        AND snapshot.challenge_date = attempt.challenge_date
        AND snapshot.release_id = attempt.release_id
        AND snapshot.mode_id = attempt.mode_id
       WHERE attempt.game_id = $1
         AND attempt.challenge_date = $2
         AND attempt.principal_id = $3
         AND attempt.status IN ('starting', 'started')
       ORDER BY attempt.attempt_number DESC LIMIT 1`,
      [gameId, challengeDate, principalId],
    );
    return result.rows[0] ? rowAttempt(result.rows[0]) : null;
  }

  public async getLatestAttempt(
    gameId: string,
    challengeDate: string,
    principalId: string,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt.* FROM ${ATTEMPTS_TABLE} AS attempt
       JOIN ${SNAPSHOTS_TABLE} AS snapshot
         ON snapshot.game_id = attempt.game_id
        AND snapshot.challenge_date = attempt.challenge_date
        AND snapshot.release_id = attempt.release_id
        AND snapshot.mode_id = attempt.mode_id
       WHERE attempt.game_id = $1
         AND attempt.challenge_date = $2
         AND attempt.principal_id = $3
       ORDER BY attempt.attempt_number DESC LIMIT 1`,
      [gameId, challengeDate, principalId],
    );
    return result.rows[0] ? rowAttempt(result.rows[0]) : null;
  }

  public async listAttempts(
    gameId: string,
    challengeDate: string,
    principalId: string,
  ): Promise<readonly DailyChallengeAttemptRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt.* FROM ${ATTEMPTS_TABLE} AS attempt
       JOIN ${SNAPSHOTS_TABLE} AS snapshot
         ON snapshot.game_id = attempt.game_id
        AND snapshot.challenge_date = attempt.challenge_date
        AND snapshot.release_id = attempt.release_id
        AND snapshot.mode_id = attempt.mode_id
       WHERE attempt.game_id = $1
         AND attempt.challenge_date = $2
         AND attempt.principal_id = $3
       ORDER BY attempt.attempt_number ASC`,
      [gameId, challengeDate, principalId],
    );
    return result.rows.map(rowAttempt);
  }

  public async getAttemptByRequest(
    gameId: string,
    principalId: string,
    requestId: string,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt.*
         FROM ${REQUESTS_TABLE} AS request
         JOIN ${ATTEMPTS_TABLE} AS attempt
           ON attempt.attempt_id = request.attempt_id
         JOIN ${SNAPSHOTS_TABLE} AS snapshot
           ON snapshot.game_id = attempt.game_id
          AND snapshot.challenge_date = attempt.challenge_date
          AND snapshot.release_id = attempt.release_id
          AND snapshot.mode_id = attempt.mode_id
        WHERE request.game_id = $1
          AND request.principal_id = $2
          AND request.request_id = $3
        LIMIT 1`,
      [gameId, principalId, requestId],
    );
    return result.rows[0] ? rowAttempt(result.rows[0]) : null;
  }

  public async getAttemptBySession(
    sessionId: string,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${ATTEMPTS_TABLE} WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0] ? rowAttempt(result.rows[0]) : null;
  }

  /**
   * Returns a narrowly eligible public daily replay for an authenticated
   * audience grant. Ranking is computed over all eligible rows before the
   * viewer/publication filter is applied.
   */
  public async getReplayEligibility(
    sessionId: string,
    viewerPrincipalId: string,
  ): Promise<DailyChallengeReplayEligibility | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `WITH eligible AS (
         SELECT attempt.*,
                snapshot.eligibility_cutoff_at,
                snapshot.finalized_at
           FROM ${ATTEMPTS_TABLE} AS attempt
           JOIN ${SNAPSHOTS_TABLE} AS snapshot
             ON snapshot.game_id = attempt.game_id
            AND snapshot.challenge_date = attempt.challenge_date
            AND snapshot.release_id = attempt.release_id
            AND snapshot.mode_id = attempt.mode_id
          WHERE attempt.status = 'completed'
            AND attempt.score IS NOT NULL
            AND attempt.completed_at IS NOT NULL
            AND attempt.publication IN ('public', 'anonymous')
            AND snapshot.finalized_at IS NOT NULL
            AND snapshot.eligibility_cutoff_at IS NOT NULL
            AND attempt.completed_at <= snapshot.eligibility_cutoff_at
       ), ranked AS (
         SELECT eligible.*,
                'overall'::text AS board,
                RANK() OVER (
                  PARTITION BY eligible.game_id, eligible.challenge_date
                  ORDER BY eligible.score DESC
                ) AS board_rank
           FROM eligible
         UNION ALL
         SELECT eligible.*,
                'firstLook'::text AS board,
                RANK() OVER (
                  PARTITION BY eligible.game_id, eligible.challenge_date
                  ORDER BY eligible.score DESC
                ) AS board_rank
           FROM eligible
          WHERE eligible.attempt_number = 1
       )
       SELECT ranked.*
         FROM ranked
        WHERE ranked.session_id = $1
          AND ranked.board_rank <= 3
          AND (ranked.publication = 'public' OR ranked.principal_id = $2)
        ORDER BY CASE WHEN ranked.board = 'firstLook' THEN 0 ELSE 1 END,
                 ranked.board_rank
        LIMIT 1`,
      [sessionId, viewerPrincipalId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const attempt = rowAttempt(row);
    const snapshot = await this.getSnapshot(
      attempt.gameId,
      attempt.challengeDate,
    );
    if (!snapshot) return null;
    return { attempt, snapshot };
  }

  public async markStarted(
    attemptId: string,
    _startId: string,
    startedAt = new Date(),
  ): Promise<DailyChallengeAttemptRecord> {
    const updated = await this.pool.query<Record<string, unknown>>(
      `UPDATE ${ATTEMPTS_TABLE}
          SET status = CASE
                WHEN status IN ('completed', 'abandoned') THEN status
                ELSE 'started'
              END,
              started_at = COALESCE(started_at, $2), updated_at = $2
        WHERE attempt_id = $1::uuid
        RETURNING *`,
      [attemptId, startedAt],
    );
    if (!updated.rows[0]) throw new Error('DAILY_ATTEMPT_NOT_FOUND');
    return rowAttempt(updated.rows[0]);
  }

  public async completeAttempt(
    input: CompleteDailyChallengeAttemptInput,
  ): Promise<DailyChallengeAttemptRecord | null> {
    const completedAt = input.completedAt ?? new Date();
    const digest =
      input.resultDigest ?? completionDigest(input.score, input.result);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${ATTEMPTS_TABLE}
         WHERE session_id = $1 FOR UPDATE`,
        [input.sessionId],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      if (row.status === 'completed') {
        if (!sameCompletion(row, input.score, input.result, digest)) {
          await client.query('ROLLBACK');
          throw new Error('DAILY_COMPLETION_CONFLICT');
        }
        await client.query('COMMIT');
        return rowAttempt(row);
      }
      if (row.status === 'abandoned') {
        await client.query('ROLLBACK');
        throw new Error('DAILY_ATTEMPT_ABANDONED');
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${ATTEMPTS_TABLE}
            SET status = 'completed', score = $2, result = $3::jsonb,
                completion_digest = $4, publication = 'pending',
                auto_publish_at = $5::timestamptz + interval '5 minutes',
                publication_selected_at = NULL, published_at = NULL,
                completed_at = $5, updated_at = $5
          WHERE attempt_id = $1::uuid
          RETURNING *`,
        [
          row.attempt_id,
          input.score,
          input.result === undefined ? null : JSON.stringify(input.result),
          digest,
          completedAt,
        ],
      );
      await client.query('COMMIT');
      return updated.rows[0] ? rowAttempt(updated.rows[0]) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async abandonAttempt(
    input: DailyChallengeAbandonInput | string,
    abandonedAt = new Date(),
  ): Promise<DailyChallengeAttemptRecord> {
    const attemptId = typeof input === 'string' ? input : input.attemptId;
    const at =
      typeof input === 'string'
        ? abandonedAt
        : (input.abandonedAt ?? abandonedAt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${ATTEMPTS_TABLE} WHERE attempt_id = $1::uuid FOR UPDATE`,
        [attemptId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('DAILY_ATTEMPT_NOT_FOUND');
      if (row.status === 'completed')
        throw new Error('DAILY_ATTEMPT_COMPLETED');
      if (row.status === 'abandoned') {
        await client.query('COMMIT');
        return rowAttempt(row);
      }
      const updated = await client.query<Record<string, unknown>>(
        `UPDATE ${ATTEMPTS_TABLE}
            SET status = 'abandoned', updated_at = $2
          WHERE attempt_id = $1::uuid
          RETURNING *`,
        [attemptId, at],
      );
      await client.query('COMMIT');
      if (!updated.rows[0]) throw new Error('DAILY_ATTEMPT_NOT_FOUND');
      return rowAttempt(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Publish completed pending attempts whose server-owned delay has elapsed. */
  public async publishDue(
    now = new Date(),
    limit = MAX_LEADERBOARD_LIMIT,
  ): Promise<readonly DailyChallengeAttemptRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<Record<string, unknown>>(
        `WITH due AS (
           SELECT attempt_id
             FROM ${ATTEMPTS_TABLE}
            WHERE status = 'completed'
              AND publication = 'pending'
              AND auto_publish_at IS NOT NULL
              AND auto_publish_at <= $1
            ORDER BY auto_publish_at ASC, attempt_id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE ${ATTEMPTS_TABLE} AS attempt
            SET publication = 'public',
                publication_selected_at = COALESCE(attempt.auto_publish_at, $1),
                published_at = COALESCE(attempt.auto_publish_at, $1),
                updated_at = $1
           FROM due
          WHERE attempt.attempt_id = due.attempt_id
          RETURNING attempt.*`,
        [now, normalizeLimit(limit)],
      );
      await client.query('COMMIT');
      return updated.rows.map(rowAttempt);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async publishAttempt(
    input: DailyChallengePublicationInput,
  ): Promise<DailyChallengeAttemptRecord> {
    const publishedAt = input.publicationSelectedAt ?? new Date();
    const updated = await this.pool.query<Record<string, unknown>>(
      `UPDATE ${ATTEMPTS_TABLE}
          SET publication = $2, publication_selected_at = $3,
              published_at = $3, updated_at = $3
        WHERE attempt_id = $1::uuid AND status = 'completed'
        RETURNING *`,
      [input.attemptId, input.publicationState, publishedAt],
    );
    if (!updated.rows[0]) throw new Error('DAILY_ATTEMPT_NOT_COMPLETED');
    return rowAttempt(updated.rows[0]);
  }

  /** Compatibility name for owner publication controls. */
  public async setPublication(
    input: DailyChallengePublicationInput,
  ): Promise<DailyChallengeAttemptRecord> {
    return this.publishAttempt(input);
  }

  public async listLeaderboard(
    input: DailyChallengeLeaderboardQuery,
  ): Promise<readonly DailyChallengeLeaderboardRecord[]> {
    const board = input.board ?? 'overall';
    if (board === 'grinder') throw new Error('DAILY_SCORE_BOARD_REQUIRED');
    const rows = await this.readEligibleScoreRows(input);
    const selected =
      board === 'firstLook'
        ? rows.filter((row) => Number(row.attempt_number) === 1)
        : rows;
    return scoreEntries(selected, input);
  }

  /** Return the complete SETI-compatible first-look, overall and grinder views. */
  public async listLeaderboards(
    input: DailyChallengeLeaderboardsQuery,
  ): Promise<DailyChallengeLeaderboardsRecord> {
    const rows = await this.readEligibleScoreRows(input);
    const firstLookRows = rows.filter(
      (row) => Number(row.attempt_number) === 1,
    );
    const allBoardRows = { ...input, limit: Number.POSITIVE_INFINITY };
    const firstLookAll = scoreEntries(firstLookRows, allBoardRows);
    const overallAll = scoreEntries(rows, allBoardRows);
    const boardLimit = normalizeLimit(input.limit);
    const firstLook = firstLookAll.slice(0, boardLimit);
    const overall = overallAll.slice(0, boardLimit);
    const grinderRows = await this.readGrinderRows(input);
    const snapshot = await this.getSnapshot(input.gameId, input.challengeDate);
    const grinderAll = grinderEntries(
      grinderRows,
      allBoardRows,
      snapshot?.eligibilityCutoffAt,
    );
    const grinder = grinderAll.slice(0, boardLimit);
    return {
      date: input.challengeDate,
      firstLook: {
        date: input.challengeDate,
        top: firstLook,
        ...(input.principalId
          ? {
              me: firstLookAll.find(
                (entry) => entry.principalId === input.principalId,
              ),
            }
          : {}),
      },
      overall: {
        date: input.challengeDate,
        top: overall,
        ...(input.principalId
          ? {
              me: overallAll
                .filter((entry) => entry.principalId === input.principalId)
                .sort((left, right) => right.score - left.score)[0],
            }
          : {}),
      },
      grinder: {
        date: input.challengeDate,
        top: grinder,
        ...(input.principalId
          ? {
              me: grinderAll.find(
                (entry) => entry.principalId === input.principalId,
              ),
            }
          : {}),
      },
    };
  }

  private async readEligibleScoreRows(
    input: DailyChallengeLeaderboardQuery,
  ): Promise<Record<string, unknown>[]> {
    const snapshot = await this.getSnapshot(input.gameId, input.challengeDate);
    const values: unknown[] = [input.gameId, input.challengeDate];
    const conditions = [
      'attempt.game_id = $1',
      'attempt.challenge_date = $2',
      "attempt.status = 'completed'",
      'attempt.score IS NOT NULL',
      "attempt.publication IN ('public', 'anonymous')",
    ];
    if (input.visibility === 'public') {
      conditions[4] = "attempt.publication = 'public'";
    } else if (input.visibility === 'anonymous') {
      conditions[4] = "attempt.publication = 'anonymous'";
    }
    if (snapshot?.eligibilityCutoffAt) {
      values.push(snapshot.eligibilityCutoffAt);
      conditions.push(`attempt.completed_at <= $${values.length}`);
    }
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt_id, principal_id, attempt_number, session_id, score, result,
              started_at, completed_at, publication, entry_key
         FROM ${ATTEMPTS_TABLE} AS attempt
         JOIN ${SNAPSHOTS_TABLE} AS snapshot
           ON snapshot.game_id = attempt.game_id
          AND snapshot.challenge_date = attempt.challenge_date
          AND snapshot.release_id = attempt.release_id
          AND snapshot.mode_id = attempt.mode_id
        WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return result.rows;
  }

  private async readGrinderRows(
    input: DailyChallengeLeaderboardsQuery,
  ): Promise<Record<string, unknown>[]> {
    const values: unknown[] = [input.gameId, input.challengeDate];
    const conditions = ['attempt.game_id = $1', 'attempt.challenge_date = $2'];
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT attempt_id, principal_id, attempt_number, score,
              completed_at, publication, entry_key, status
         FROM ${ATTEMPTS_TABLE} AS attempt
         JOIN ${SNAPSHOTS_TABLE} AS snapshot
           ON snapshot.game_id = attempt.game_id
          AND snapshot.challenge_date = attempt.challenge_date
          AND snapshot.release_id = attempt.release_id
          AND snapshot.mode_id = attempt.mode_id
        WHERE ${conditions.join(' AND ')}`,
      values,
    );
    return result.rows;
  }

  public async listHistoryDates(
    gameId: string,
    limit = 30,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ challenge_date: unknown }>(
      `SELECT challenge_date FROM ${SNAPSHOTS_TABLE}
       WHERE game_id = $1 ORDER BY challenge_date DESC LIMIT $2`,
      [gameId, normalizeLimit(limit)],
    );
    return result.rows.map((row) => dateOnlyValue(row.challenge_date));
  }

  public async listUnfinalizedSnapshots(
    gameId: string,
    limit = MAX_LEADERBOARD_LIMIT,
  ): Promise<readonly DailyChallengeSnapshotRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SNAPSHOTS_TABLE}
        WHERE game_id = $1 AND finalized_at IS NULL
        ORDER BY challenge_date ASC LIMIT $2`,
      [gameId, normalizeLimit(limit)],
    );
    return result.rows.map(rowSnapshot);
  }

  /** Bounded reward-maintenance queue for finalized snapshots not yet settled. */
  public async listPendingRewardSnapshots(
    gameId: string,
    limit = 100,
  ): Promise<readonly DailyChallengeSnapshotRecord[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SNAPSHOTS_TABLE}
        WHERE game_id = $1
          AND finalized_at IS NOT NULL
          AND reward_policy IS NOT NULL
          AND rewards_settled_at IS NULL
        ORDER BY challenge_date ASC
        LIMIT $2`,
      [gameId, normalizeLimit(limit)],
    );
    return result.rows.map(rowSnapshot);
  }

  /** Atomically finalizes due snapshots using their already-frozen cutoff. */
  public async finalizeDue(
    now: Date,
    gameId: string,
  ): Promise<readonly DailyChallengeSnapshotRecord[]> {
    const due = await this.pool.query<{
      challenge_date: unknown;
    }>(
      `SELECT challenge_date FROM ${SNAPSHOTS_TABLE}
        WHERE game_id = $1
          AND finalized_at IS NULL
          AND eligibility_cutoff_at IS NOT NULL
          AND eligibility_cutoff_at <= $2
        ORDER BY challenge_date ASC`,
      [gameId, now],
    );
    const finalized: DailyChallengeSnapshotRecord[] = [];
    for (const row of due.rows) {
      finalized.push(
        await this.finalizeSnapshot({
          gameId,
          challengeDate: dateOnlyValue(row.challenge_date),
          finalizedAt: now,
        }),
      );
    }
    return finalized;
  }

  private async lock(client: PoolClient, key: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, ${DAILY_LOCK_SALT}))`,
      [key],
    );
  }

  private async readSettings(
    client: PoolClient,
    gameId: string,
    releaseId: string,
  ): Promise<DailyChallengeSettingsRecord | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${SETTINGS_TABLE} WHERE game_id = $1 AND release_id = $2`,
      [gameId, releaseId],
    );
    return result.rows[0] ? rowSettings(result.rows[0]) : null;
  }

  private async buildRewardPlan(
    client: PoolClient,
    row: Record<string, unknown>,
  ): Promise<DailyChallengeRewardPlan | null> {
    const existingPlan =
      row.reward_plan === null || row.reward_plan === undefined
        ? undefined
        : jsonValue(row.reward_plan);
    if (existingPlan !== undefined) {
      assertDailyChallengeRewardPlan(existingPlan);
      return existingPlan;
    }
    const rawPolicy =
      row.reward_policy === null || row.reward_policy === undefined
        ? undefined
        : jsonValue(row.reward_policy);
    if (rawPolicy === undefined) return null;
    assertDailyChallengeRewardPolicy(rawPolicy);
    if (
      row.eligibility_cutoff_at === null ||
      row.eligibility_cutoff_at === undefined
    )
      throw new Error('DAILY_SNAPSHOT_CUTOFF_MISSING');
    const gameId = String(row.game_id);
    const releaseId = String(row.release_id);
    const modeId = String(row.mode_id);
    const challengeDate = dateOnlyValue(row.challenge_date);
    const cutoff = dateValue(row.eligibility_cutoff_at);
    const attempts = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${ATTEMPTS_TABLE}
        WHERE game_id = $1
          AND challenge_date = $2
          AND release_id = $4
          AND mode_id = $5
          AND status = 'completed'
          AND score IS NOT NULL
          AND completed_at IS NOT NULL
          AND completed_at <= $3
        ORDER BY principal_id ASC, attempt_number ASC,
                 completed_at ASC, attempt_id ASC`,
      [gameId, challengeDate, cutoff, releaseId, modeId],
    );
    return calculateDailyChallengeRewardPlan({
      gameId,
      challengeDate,
      eligibilityCutoffAt: cutoff,
      policy: rawPolicy,
      attempts: attempts.rows.map(rowAttempt),
    });
  }
}
