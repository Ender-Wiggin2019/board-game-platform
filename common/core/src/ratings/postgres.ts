import { Pool, type PoolConfig } from 'pg';
import { RatingError } from './errors.js';
import {
  assertJson,
  assertPositiveInteger,
  assertString,
  assertTimestamp,
  clone,
  equalJson,
  validateParticipantSettlement,
  validateSettlementDraft,
  validateSettlementRecord,
  validateState,
} from './invariants.js';
import {
  assertSchemaName,
  DEFAULT_RATING_SCHEMA,
  migrationStatements,
  tableName,
} from './migration.js';
import type {
  RatingSettlementRecord,
  RatingSettlementTransaction,
  RatingState,
  RatingStatePage,
  RatingStore,
  RatingStoreCapabilities,
} from './types.js';

type Row = Record<string, unknown>;

export interface PostgresRatingOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Must be a validated identifier; SQL never changes search_path. */
  readonly schema?: string;
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new RatingError('DATABASE_ERROR', `rating row has invalid ${key}`);
  return value;
}

function rowNumber(row: Row, key: string, positive = false): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || (positive ? value < 1 : value < 0))
    throw new RatingError('DATABASE_ERROR', `rating row has invalid ${key}`);
  return value;
}

function rowRankingScore(row: Row): number | undefined {
  if (row.ranking_score === null || row.ranking_score === undefined)
    return undefined;
  const value = Number(row.ranking_score);
  if (!Number.isFinite(value))
    throw new RatingError(
      'DATABASE_ERROR',
      'rating row has invalid ranking_score',
    );
  return value;
}

function rankingCursor(score: number, participantId: string): string {
  return JSON.stringify([score, participantId]);
}

function parseRankingCursor(cursor: string): {
  score: number;
  participantId: string;
} {
  assertString(cursor, 'cursor');
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating ranking cursor is invalid',
    );
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'number' ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'string' ||
    value[1].length === 0
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating ranking cursor is invalid',
    );
  return { score: value[0], participantId: value[1] };
}

function rowTimestamp(row: Row, key: string): number {
  const value = Number(row[key]);
  assertTimestamp(value, key);
  return value;
}

function rowJson(
  row: Row,
  key: string,
  maxBytes: number,
): import('@board-game/contracts').JsonValue {
  const value = row[key];
  assertJson(value, `rating row ${key}`, maxBytes);
  return clone(value);
}

function rowToState(row: Row): RatingState {
  const state: RatingState = {
    poolId: rowString(row, 'pool_id'),
    participantId: rowString(row, 'participant_id'),
    policyVersion: rowString(row, 'policy_version'),
    progressionPolicyVersion: rowString(row, 'progression_policy_version'),
    initial: rowJson(row, 'initial_state', 64 * 1024),
    value: rowJson(row, 'state', 64 * 1024),
    ...(rowRankingScore(row) !== undefined
      ? { rankingScore: rowRankingScore(row) }
      : {}),
    updatedSequence: rowNumber(row, 'updated_sequence', true),
  };
  validateState(state, 64 * 1024);
  return state;
}

function rowToSettlement(row: Row): RatingSettlementRecord {
  const record: RatingSettlementRecord = {
    poolId: rowString(row, 'pool_id'),
    sessionId: rowString(row, 'session_id'),
    resultRevision: rowNumber(row, 'result_revision', true),
    digest: rowString(row, 'digest'),
    occurredAt: rowTimestamp(row, 'occurred_at'),
    sequence: rowNumber(row, 'sequence', true),
    policyVersion: rowString(row, 'policy_version'),
    progressionPolicyVersion: rowString(row, 'progression_policy_version'),
    seasonId:
      row.season_id === null || row.season_id === undefined
        ? null
        : rowString(row, 'season_id'),
    route: rowJson(
      row,
      'route',
      64 * 1024,
    ) as unknown as RatingSettlementRecord['route'],
    result: rowJson(
      row,
      'result',
      256 * 1024,
    ) as unknown as RatingSettlementRecord['result'],
    participants: rowJson(
      row,
      'participants',
      256 * 1024,
    ) as unknown as RatingSettlementRecord['participants'],
  };
  if (!Array.isArray(record.participants) || record.participants.length === 0)
    throw new RatingError(
      'DATABASE_ERROR',
      'rating settlement participants are invalid',
    );
  for (const participant of record.participants)
    validateParticipantSettlement(participant, 64 * 1024);
  validateSettlementRecord(record);
  return clone(record);
}

function asRatingError(error: unknown): RatingError {
  if (error instanceof RatingError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000')
    return new RatingError(
      'MIGRATION_REQUIRED',
      'rating schema has not been migrated',
      false,
    );
  if (code === '40001' || code === '40P01')
    return new RatingError(
      'DATABASE_ERROR',
      'rating transaction was aborted',
      true,
    );
  if (code === '23505')
    return new RatingError(
      'IDEMPOTENCY_CONFLICT',
      'rating settlement conflicts with an existing record',
      false,
    );
  return new RatingError(
    'DATABASE_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

/** Durable rating ledger with explicit migrations and a row lock per pool. */
export class PostgresRatingStore implements RatingStore {
  readonly capabilities: RatingStoreCapabilities = {
    durable: true,
    serializableTransactions: true,
    boundedReads: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PostgresRatingOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_RATING_SCHEMA;
    assertSchemaName(this.schema);
    if (normalized.pool) {
      this.pool = normalized.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...normalized.poolConfig,
        connectionString:
          normalized.connectionString ??
          normalized.poolConfig?.connectionString,
      });
      this.ownsPool = true;
    }
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of migrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asRatingError(error);
    } finally {
      client.release();
    }
  }

  async getSettlement(
    sessionId: string,
    resultRevision: number,
  ): Promise<RatingSettlementRecord | null> {
    assertString(sessionId, 'sessionId');
    assertPositiveInteger(resultRevision, 'resultRevision');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'settlements')} WHERE session_id = $1 AND result_revision = $2`,
        [sessionId, resultRevision],
      );
      return result.rows[0] ? rowToSettlement(result.rows[0] as Row) : null;
    } catch (error) {
      throw asRatingError(error);
    }
  }

  async getRating(
    poolId: string,
    participantId: string,
  ): Promise<RatingState | null> {
    assertString(poolId, 'poolId');
    assertString(participantId, 'participantId');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'ratings')} WHERE pool_id = $1 AND participant_id = $2`,
        [poolId, participantId],
      );
      return result.rows[0] ? rowToState(result.rows[0] as Row) : null;
    } catch (error) {
      throw asRatingError(error);
    }
  }

  async list(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage> {
    assertString(poolId, 'poolId');
    assertPositiveInteger(limit, 'limit');
    if (limit > 100)
      throw new RatingError(
        'INVALID_ARGUMENT',
        'rating list limit must be at most 100',
      );
    if (cursor !== undefined) assertString(cursor, 'cursor');
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'ratings')}
         WHERE pool_id = $1 AND ($2::text IS NULL OR participant_id > $2)
         ORDER BY participant_id ASC
         LIMIT $3`,
        [poolId, cursor ?? null, limit + 1],
      );
      const rows = result.rows as Row[];
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToState);
      return {
        items,
        nextCursor: hasMore ? (items.at(-1)?.participantId ?? null) : null,
      };
    } catch (error) {
      throw asRatingError(error);
    }
  }

  async listByRanking(
    poolId: string,
    limit: number,
    cursor?: string,
  ): Promise<RatingStatePage> {
    assertString(poolId, 'poolId');
    assertPositiveInteger(limit, 'limit');
    if (limit > 100)
      throw new RatingError(
        'INVALID_ARGUMENT',
        'rating list limit must be at most 100',
      );
    const parsed =
      cursor === undefined ? undefined : parseRankingCursor(cursor);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'ratings')}
         WHERE pool_id = $1 AND ranking_score IS NOT NULL
           AND ($2::double precision IS NULL OR ranking_score < $2 OR (ranking_score = $2 AND participant_id > $3))
         ORDER BY ranking_score DESC, participant_id ASC
         LIMIT $4`,
        [
          poolId,
          parsed?.score ?? null,
          parsed?.participantId ?? null,
          limit + 1,
        ],
      );
      const rows = result.rows as Row[];
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToState);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          hasMore && last?.rankingScore !== undefined
            ? rankingCursor(last.rankingScore, last.participantId)
            : null,
      };
    } catch (error) {
      throw asRatingError(error);
    }
  }

  async getRankedPosition(
    poolId: string,
    participantId: string,
  ): Promise<number | null> {
    assertString(poolId, 'poolId');
    assertString(participantId, 'participantId');
    try {
      const current = await this.pool.query(
        `SELECT ranking_score FROM ${tableName(this.schema, 'ratings')} WHERE pool_id = $1 AND participant_id = $2`,
        [poolId, participantId],
      );
      if (!current.rows[0] || current.rows[0].ranking_score === null)
        return null;
      const score = Number(current.rows[0].ranking_score);
      if (!Number.isFinite(score))
        throw new RatingError(
          'DATABASE_ERROR',
          'rating row has invalid ranking_score',
        );
      const ahead = await this.pool.query(
        `SELECT count(*)::integer AS count FROM ${tableName(this.schema, 'ratings')}
         WHERE pool_id = $1 AND ranking_score IS NOT NULL
           AND (ranking_score > $2 OR (ranking_score = $2 AND participant_id < $3))`,
        [poolId, score, participantId],
      );
      return Number(ahead.rows[0]?.count ?? 0) + 1;
    } catch (error) {
      throw asRatingError(error);
    }
  }

  async transaction<Result>(
    poolId: string,
    work: (tx: RatingSettlementTransaction) => Promise<Result>,
  ): Promise<Result> {
    assertString(poolId, 'poolId');
    if (typeof work !== 'function')
      throw new RatingError(
        'INVALID_ARGUMENT',
        'transaction callback must be a function',
      );
    const client = await this.pool.connect();
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;
      const sequences = tableName(this.schema, 'pool_sequences');
      await client.query(
        `INSERT INTO ${sequences} (pool_id, next_sequence) VALUES ($1, 0) ON CONFLICT (pool_id) DO NOTHING`,
        [poolId],
      );
      const lockResult = await client.query(
        `SELECT next_sequence FROM ${sequences} WHERE pool_id = $1 FOR UPDATE`,
        [poolId],
      );
      if (!lockResult.rows[0])
        throw new RatingError(
          'DATABASE_ERROR',
          'rating pool lock row is missing',
        );
      let nextSequence = rowNumber(lockResult.rows[0] as Row, 'next_sequence');
      let committed = false;
      const assertOpen = (): void => {
        if (!open)
          throw new RatingError(
            'DATABASE_ERROR',
            'rating transaction is closed',
            false,
          );
      };
      const tx: RatingSettlementTransaction = {
        getSettlement: async (sessionId, resultRevision) => {
          assertOpen();
          assertString(sessionId, 'sessionId');
          assertPositiveInteger(resultRevision, 'resultRevision');
          const result = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'settlements')} WHERE session_id = $1 AND result_revision = $2`,
            [sessionId, resultRevision],
          );
          return result.rows[0] ? rowToSettlement(result.rows[0] as Row) : null;
        },
        getState: async (participantId) => {
          assertOpen();
          assertString(participantId, 'participantId');
          const result = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'ratings')} WHERE pool_id = $1 AND participant_id = $2 FOR SHARE`,
            [poolId, participantId],
          );
          return result.rows[0] ? rowToState(result.rows[0] as Row) : null;
        },
        commitSettlement: async (draft, states) => {
          assertOpen();
          if (committed)
            throw new RatingError(
              'INVALID_ARGUMENT',
              'rating transaction already committed',
            );
          validateSettlementDraft(draft);
          if (draft.poolId !== poolId)
            throw new RatingError(
              'INVALID_ARGUMENT',
              'settlement pool does not match transaction',
            );
          if (
            !Array.isArray(states) ||
            states.length !== draft.participants.length
          )
            throw new RatingError(
              'INVALID_ARGUMENT',
              'rating state coverage does not match settlement',
            );
          const sequence = nextSequence + 1;
          assertPositiveInteger(sequence, 'settlement.sequence');
          const participantIds = new Set<string>();
          for (const participant of draft.participants)
            validateParticipantSettlement(participant, 64 * 1024);
          for (const state of states) {
            const candidate: RatingState = {
              ...state,
              updatedSequence: sequence,
            };
            validateState(candidate, 64 * 1024);
            if (state.poolId !== poolId)
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state does not match settlement',
              );
            if (participantIds.has(state.participantId))
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state contains duplicate participant',
              );
            participantIds.add(state.participantId);
            const settlementParticipant = draft.participants.find(
              (participant) =>
                participant.participantId === state.participantId,
            );
            if (
              !settlementParticipant ||
              !equalJson(settlementParticipant.initial, state.initial) ||
              !equalJson(settlementParticipant.after, state.value)
            )
              throw new RatingError(
                'INVALID_ARGUMENT',
                'rating state does not match settlement',
              );
          }
          if (participantIds.size !== draft.participants.length)
            throw new RatingError(
              'INVALID_ARGUMENT',
              'rating state coverage is incomplete',
            );
          const existing = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'settlements')} WHERE session_id = $1 AND result_revision = $2 FOR SHARE`,
            [draft.sessionId, draft.resultRevision],
          );
          if (existing.rows[0])
            throw new RatingError(
              'IDEMPOTENCY_CONFLICT',
              'settlement already exists',
              false,
            );
          const record: RatingSettlementRecord = { ...clone(draft), sequence };
          validateSettlementRecord(record);
          await client.query(
            `UPDATE ${sequences} SET next_sequence = $2 WHERE pool_id = $1`,
            [poolId, sequence],
          );
          const ratings = tableName(this.schema, 'ratings');
          for (const state of states) {
            await client.query(
              `INSERT INTO ${ratings} (pool_id, participant_id, policy_version, progression_policy_version, initial_state, state, ranking_score, updated_sequence)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
               ON CONFLICT (pool_id, participant_id)
               DO UPDATE SET policy_version = EXCLUDED.policy_version,
                 progression_policy_version = EXCLUDED.progression_policy_version,
                 initial_state = EXCLUDED.initial_state,
                 state = EXCLUDED.state,
                 ranking_score = EXCLUDED.ranking_score,
                 updated_sequence = EXCLUDED.updated_sequence`,
              [
                poolId,
                state.participantId,
                state.policyVersion,
                state.progressionPolicyVersion,
                JSON.stringify(state.initial),
                JSON.stringify(state.value),
                state.rankingScore ?? null,
                sequence,
              ],
            );
          }
          const settlements = tableName(this.schema, 'settlements');
          await client.query(
            `INSERT INTO ${settlements} (pool_id, session_id, result_revision, digest, occurred_at, sequence, policy_version, progression_policy_version, season_id, route, result, participants)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)`,
            [
              draft.poolId,
              draft.sessionId,
              draft.resultRevision,
              draft.digest,
              draft.occurredAt,
              sequence,
              draft.policyVersion,
              draft.progressionPolicyVersion,
              draft.seasonId,
              JSON.stringify(draft.route),
              JSON.stringify(draft.result),
              JSON.stringify(draft.participants),
            ],
          );
          nextSequence = sequence;
          committed = true;
          return clone(record);
        },
      };
      const result = await work(tx);
      open = false;
      await client.query('COMMIT');
      return clone(result);
    } catch (error) {
      open = false;
      await client.query('ROLLBACK').catch(() => undefined);
      throw asRatingError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}
