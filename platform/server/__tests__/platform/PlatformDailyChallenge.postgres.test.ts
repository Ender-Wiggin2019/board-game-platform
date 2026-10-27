import { randomUUID } from 'node:crypto';
import type {
  GameResult,
  MatchAdmission,
  Participant,
  PublicStartStatus,
  SessionRoute,
} from '@board-game/contracts';
import type { InboxEnvelope } from '@board-game/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDailyChallengeService } from '@/platform/daily-challenge/service.js';
import type { DailyChallengeRegistration } from '@/platform/daily-challenge/types.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

type StartInput = {
  readonly roomId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  readonly participants: readonly Participant[];
  readonly policy: { readonly validityPolicyVersion: string };
};

type Harness = {
  currentRelease: string;
  readonly starts: Map<string, PublicStartStatus>;
  readonly admissions: Map<string, MatchAdmission>;
  readonly handlers: Array<(envelope: InboxEnvelope) => Promise<void>>;
  createCalls: number;
};

const gameIds = new Set<string>();
let pool: Pool;

function platform(harness: Harness): PlatformApplicationRuntime {
  return {
    game: () => ({ releaseId: harness.currentRelease }),
    registerRecoveryHook: () => undefined,
    registerFactConsumer: (
      _name: string,
      handler: (envelope: InboxEnvelope) => Promise<void>,
    ) => {
      harness.handlers.push(handler);
    },
    admissionStore: {
      getStart: async (roomId: string) => harness.starts.get(roomId) ?? null,
      getAdmission: async (sessionId: string) =>
        harness.admissions.get(sessionId) ?? null,
    },
    admission: {
      createMatchedSession: async (input: StartInput) => {
        const existing = harness.starts.get(input.roomId);
        if (existing) return existing;
        harness.createCalls += 1;
        const route: SessionRoute = {
          gameId: input.gameId,
          modeId: input.modeId,
          sessionId: input.sessionId,
          releaseId: input.releaseId,
          backendBindingId: 'daily-postgres-test',
          storageBindingId: 'daily-postgres-test',
          ownershipEpoch: 'daily-postgres-test-epoch',
        };
        const status: PublicStartStatus = {
          startId: `start:${input.sessionId}`,
          sessionId: input.sessionId,
          roomId: input.roomId,
          state: 'active',
          route,
        };
        harness.starts.set(input.roomId, status);
        harness.admissions.set(input.sessionId, {
          id: `admission:${input.sessionId}`,
          route,
          participants: input.participants,
          visibility: 'private',
          rating: null,
          validityPolicyVersion: input.policy.validityPolicyVersion,
          createdAt: 1,
        });
        return status;
      },
      recoverStart: async (roomId: string) => {
        const status = harness.starts.get(roomId);
        if (!status) throw new Error('DAILY_TEST_START_MISSING');
        return status;
      },
    },
    accountIdentity: () => ({
      publicNames: async (principalIds: readonly string[]) =>
        new Map(principalIds.map((principalId) => [principalId, principalId])),
    }),
  } as unknown as PlatformApplicationRuntime;
}

function registration(
  gameId: string,
  releaseId: string,
  options: { readonly timezone?: string } = {},
): DailyChallengeRegistration {
  const aiPrincipalId = `ai:${gameId}`;
  return {
    gameId,
    releaseId,
    modeId: 'daily-challenge',
    playerCount: 2,
    timezone: options.timezone ?? 'UTC',
    validityPolicyVersion: 'daily-postgres-test-v1',
    settings: {
      defaults: { preset: 'standard' },
      validate: (settings) => {
        if (
          !settings ||
          typeof settings !== 'object' ||
          Array.isArray(settings) ||
          (settings as { preset?: unknown }).preset !== 'standard'
        )
          throw new Error('DAILY_TEST_SETTINGS_INVALID');
      },
    },
    seedForDate: (challengeDate) => `daily:${releaseId}:${challengeDate}`,
    setupForDate: () => ({ playerCount: 2 }),
    validateSetup: (setup) => {
      if (
        !setup ||
        typeof setup !== 'object' ||
        Array.isArray(setup) ||
        (setup as { playerCount?: unknown }).playerCount !== 2
      )
        throw new Error('DAILY_TEST_SETUP_INVALID');
    },
    participants: ({ principalId, settings }) => {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings))
        throw new Error('DAILY_TEST_SETTINGS_INVALID');
      return [
        { principalId, seatId: 'human' },
        {
          principalId: aiPrincipalId,
          seatId: 'ai',
          controller: 'ai',
          controllerId: 'daily-test-ai-v1',
          controllerOptions: { preset: 'standard' },
        },
      ];
    },
    score: (result) => {
      if (result.kind !== 'competitive') return null;
      return {
        score: result.rankGroups[0]?.teams[0]?.score ?? 0,
        result,
      };
    },
  };
}

function harness(): Harness {
  return {
    currentRelease: 'release-1',
    starts: new Map(),
    admissions: new Map(),
    handlers: [],
    createCalls: 0,
  };
}

function serviceFor(
  gameId: string,
  releaseId = 'release-1',
  options: { readonly timezone?: string } = {},
) {
  const state = harness();
  state.currentRelease = releaseId;
  const service = new PlatformDailyChallengeService(platform(state), pool);
  service.register(registration(gameId, releaseId, options));
  gameIds.add(gameId);
  return { service, state };
}

function completedEnvelope(
  state: Harness,
  releaseId: string,
  sessionId: string,
  principalId: string,
): InboxEnvelope {
  const admission = state.admissions.get(sessionId);
  if (!admission) throw new Error('DAILY_TEST_ADMISSION_MISSING');
  const ai = admission.participants.find(
    (participant) => participant.controller === 'ai',
  );
  if (!ai) throw new Error('DAILY_TEST_AI_MISSING');
  const result: GameResult = {
    kind: 'competitive',
    rankGroups: [
      { teams: [{ participantIds: [principalId], score: 42 }] },
      { teams: [{ participantIds: [ai.principalId], score: 10 }] },
    ],
  };
  return {
    envelopeKey: `daily-test:${sessionId}:completed`,
    producerId: 'daily-test-host',
    eventId: `completed:${sessionId}`,
    sessionId,
    kind: 'SessionCompleted',
    schemaVersion: 1,
    sourceRelease: releaseId,
    aggregateSequence: 1,
    payload: {
      result,
      resultRevision: 1,
      endedAt: Date.parse('2026-10-26T12:05:00.000Z'),
    },
    digest: `digest:${sessionId}`,
    receivedAt: Date.parse('2026-10-26T12:05:00.000Z'),
  };
}

postgresSuite('daily challenges with PostgreSQL persistence', () => {
  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: databaseUrl });
    const { dailyChallengeMigrationStatements } = await import(
      '@/platform/daily-challenge/store.js'
    );
    for (const statement of dailyChallengeMigrationStatements())
      await pool.query(statement);
  });

  afterAll(async () => {
    const ids = [...gameIds];
    if (ids.length) {
      await pool.query(
        'DELETE FROM "board_platform_daily"."challenge_attempt_requests" WHERE game_id = ANY($1::text[])',
        [ids],
      );
      await pool.query(
        'DELETE FROM "board_platform_daily"."challenge_attempts" WHERE game_id = ANY($1::text[])',
        [ids],
      );
      await pool.query(
        'DELETE FROM "board_platform_daily"."challenge_snapshots" WHERE game_id = ANY($1::text[])',
        [ids],
      );
      await pool.query(
        'DELETE FROM "board_platform_daily"."challenge_settings" WHERE game_id = ANY($1::text[])',
        [ids],
      );
    }
    await pool.end();
  });

  it('serializes concurrent starts into one attempt and one session', async () => {
    const gameId = `daily-concurrent-${randomUUID()}`;
    const { service, state } = serviceFor(gameId);
    const now = new Date('2026-10-26T12:00:00.000Z');
    const [first, second] = await Promise.all([
      service.start(gameId, 'player-1', now),
      service.start(gameId, 'player-1', now),
    ]);

    expect(first.start).toEqual(second.start);
    expect(first.attempt.attemptId).toBe(second.attempt.attemptId);
    expect(state.createCalls).toBe(1);
    const attempts = await pool.query(
      'SELECT count(*)::int AS count FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1',
      [gameId],
    );
    expect(attempts.rows[0]?.count).toBe(1);
    const frozen = await pool.query<{
      participants: Array<{
        principalId: string;
        publicProfile?: { displayName?: string };
      }>;
    }>(
      'SELECT participants FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1',
      [gameId],
    );
    expect(frozen.rows[0]?.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          principalId: 'player-1',
          publicProfile: expect.objectContaining({ displayName: 'player-1' }),
        }),
      ]),
    );
  });

  it('rejects a stale settings revision and keeps the today snapshot immutable', async () => {
    const gameId = `daily-settings-${randomUUID()}`;
    const { service } = serviceFor(gameId);
    const now = new Date('2026-10-26T12:00:00.000Z');
    await service.updateSettings(
      gameId,
      {
        expectedRevision: 1,
        settings: { preset: 'standard' },
      },
      now,
    );
    await expect(
      service.updateSettings(
        gameId,
        {
          expectedRevision: 1,
          settings: { preset: 'standard' },
        },
        now,
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'STALE_REVISION' }),
    });
    const snapshot = await service.getToday(gameId, 'player-1', now);
    expect(snapshot.challenge.settingsRevision).toBe(1);
  });

  it('uses the local 23:59 refresh and rejects an invalid clock value', async () => {
    const gameId = `daily-boundary-${randomUUID()}`;
    const { service } = serviceFor(gameId, 'release-1', {
      timezone: 'America/Los_Angeles',
    });
    const beforeMidnight = await service.getToday(
      gameId,
      'player-1',
      new Date('2026-10-27T06:58:59.999Z'),
    );
    const afterMidnight = await service.getToday(
      gameId,
      'player-1',
      new Date('2026-10-27T06:59:00.000Z'),
    );
    expect(beforeMidnight.challenge.challengeDate).toBe('2026-10-26');
    expect(afterMidnight.challenge.challengeDate).toBe('2026-10-27');
    await expect(
      service.getToday(gameId, 'player-1', new Date(Number.NaN)),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    });
  });

  it('reads historical boards without inventing a past snapshot', async () => {
    const gameId = `daily-leaderboard-date-${randomUUID()}`;
    const { service } = serviceFor(gameId);
    const now = new Date('2026-10-26T12:00:00.000Z');

    await expect(
      service.leaderboard(gameId, now, '2026-10-26'),
    ).resolves.toMatchObject({ challengeDate: '2026-10-26', entries: [] });
    await expect(
      service.leaderboard(gameId, now, '2026-10-25'),
    ).resolves.toMatchObject({ challengeDate: '2026-10-25', entries: [] });
    await expect(
      service.leaderboard(gameId, now, '2026-02-31'),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    });
    const snapshots = await pool.query(
      'SELECT count(*)::int AS count FROM "board_platform_daily"."challenge_snapshots" WHERE game_id = $1',
      [gameId],
    );
    expect(snapshots.rows[0]?.count).toBe(1);
  });

  it('retains the frozen release and attempt after a same-day release change', async () => {
    const gameId = `daily-release-${randomUUID()}`;
    const state = harness();
    const platformRuntime = platform(state);
    const service = new PlatformDailyChallengeService(platformRuntime, pool);
    service.register(registration(gameId, 'release-1'));
    service.register(registration(gameId, 'release-2'));
    gameIds.add(gameId);
    const now = new Date('2026-10-26T12:00:00.000Z');
    const first = await service.start(gameId, 'player-1', now);
    state.currentRelease = 'release-2';
    const second = await service.start(gameId, 'player-1', now);

    expect(first.challenge.releaseId).toBe('release-1');
    expect(second.challenge.releaseId).toBe('release-1');
    expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(state.createCalls).toBe(1);
    const rows = await pool.query(
      'SELECT release_id FROM "board_platform_daily"."challenge_snapshots" WHERE game_id = $1',
      [gameId],
    );
    expect(rows.rows).toEqual([{ release_id: 'release-1' }]);
  });

  it('writes the leaderboard once and replays completion after a new service starts', async () => {
    const gameId = `daily-recovery-${randomUUID()}`;
    const first = serviceFor(gameId);
    const started = await first.service.start(
      gameId,
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    const envelope = completedEnvelope(
      first.state,
      'release-1',
      started.start.sessionId,
      'player-1',
    );
    const firstHandler = first.state.handlers.at(-1);
    if (!firstHandler) throw new Error('DAILY_TEST_CONSUMER_MISSING');
    await firstHandler(envelope);
    await firstHandler(envelope);

    const restartedService = new PlatformDailyChallengeService(
      platform(first.state),
      pool,
    );
    restartedService.register(registration(gameId, 'release-1'));
    const recoveryHandler = first.state.handlers.at(-1);
    if (!recoveryHandler)
      throw new Error('DAILY_TEST_RECOVERY_CONSUMER_MISSING');
    await recoveryHandler(envelope);
    const leaderboard = await restartedService.leaderboard(
      gameId,
      new Date('2026-10-26T12:10:00.000Z'),
    );
    expect(leaderboard.entries).toHaveLength(1);
    expect(leaderboard.entries?.[0]).toMatchObject({
      rank: 1,
      displayName: 'player-1',
      score: 42,
    });
    const attempts = await pool.query(
      'SELECT status, score FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1',
      [gameId],
    );
    expect(attempts.rows).toEqual([{ status: 'completed', score: 42 }]);
  });

  it('rejects a completion whose admission has another account or session route', async () => {
    const gameId = `daily-completion-fence-${randomUUID()}`;
    const { service, state } = serviceFor(gameId);
    const started = await service.start(
      gameId,
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    const sessionId = started.start.sessionId;
    const admission = state.admissions.get(sessionId);
    if (!admission) throw new Error('DAILY_TEST_ADMISSION_MISSING');
    const envelope = completedEnvelope(
      state,
      'release-1',
      sessionId,
      'player-1',
    );
    const handler = state.handlers.at(-1);
    if (!handler) throw new Error('DAILY_TEST_CONSUMER_MISSING');

    state.admissions.set(sessionId, {
      ...admission,
      participants: [
        ...admission.participants,
        { principalId: 'other-account', seatId: 'other-seat' },
      ],
    });
    await expect(handler(envelope)).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    });

    state.admissions.set(sessionId, {
      ...admission,
      route: { ...admission.route, sessionId: 'different-session' },
    });
    await expect(handler(envelope)).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    });
    const leaderboard = await service.leaderboard(
      gameId,
      new Date('2026-10-26T12:00:00.000Z'),
    );
    expect(leaderboard.entries).toHaveLength(0);
  });
});
