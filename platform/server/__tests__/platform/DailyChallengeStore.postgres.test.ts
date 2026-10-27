import { randomUUID } from 'node:crypto';
import type { Participant } from '@board-game/contracts';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDailyChallengeStore } from '@/platform/daily-challenge/store.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

let pool: Pool;
let store: PostgresDailyChallengeStore;
const gameIds = new Set<string>();
const date = '2026-10-26';
const participants: readonly Participant[] = [
  { principalId: 'player-a', seatId: 'human' },
];
const rewardPolicy = {
  modeId: 'daily-challenge',
  definitionVersion: 'seti-daily-challenge-points-v1',
  asset: 'interstellar-points',
  tiers: [
    { percent: 5, quantity: 10 },
    { percent: 10, quantity: 5 },
    { percent: 20, quantity: 3 },
  ],
  participationQuantity: 1,
  sourceKeyPrefix: 'interstellar:daily',
} as const;

function input(
  gameId: string,
  principalId: string,
  suffix: string,
  now = new Date('2026-10-26T12:00:00.000Z'),
) {
  return {
    gameId,
    releaseId: 'daily-release-v1',
    modeId: 'daily-challenge',
    challengeDate: date,
    principalId,
    roomId: `daily:${gameId}:${principalId}`,
    requestId: `request:${suffix}`,
    sessionId: `session:${suffix}:${randomUUID()}`,
    participants,
    now,
  } as const;
}

postgresSuite('PostgresDailyChallengeStore', () => {
  beforeAll(async () => {
    const { Pool: PgPool } = await import('pg');
    pool = new PgPool({ connectionString: databaseUrl });
    store = new PostgresDailyChallengeStore(pool);
    await store.migrate();
    await store.migrate();
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

  it('allows multiple attempts but serializes one active attempt and replays request IDs', async () => {
    const gameId = `daily-store-concurrent-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-concurrent',
      setup: {},
    });
    const [first, second] = await Promise.all([
      store.reserveAttempt(input(gameId, 'player-a', 'first')),
      store.reserveAttempt(input(gameId, 'player-a', 'second')),
    ]);
    expect(first.attemptId).toBe(second.attemptId);
    expect(first.attemptNumber).toBe(1);
    expect(first.status).toBe('starting');

    await store.markStarted(first.attemptId, 'start-1');
    const replay = await store.reserveAttempt({
      ...input(gameId, 'player-a', 'first'),
      attemptId: randomUUID(),
      sessionId: `different-session:${randomUUID()}`,
    });
    expect(replay.attemptId).toBe(first.attemptId);
    const crossDateReplay = await store.reserveAttempt({
      ...input(gameId, 'player-a', 'second'),
      challengeDate: '2026-10-27',
      attemptId: randomUUID(),
      sessionId: `late-session:${randomUUID()}`,
    });
    expect(crossDateReplay.attemptId).toBe(first.attemptId);
    expect(
      (await store.getAttemptByRequest(gameId, 'player-a', 'request:second'))
        ?.attemptId,
    ).toBe(first.attemptId);

    await store.abandonAttempt(first.attemptId);
    const secondAttempt = await store.reserveAttempt(
      input(gameId, 'player-a', 'third'),
    );
    expect(secondAttempt.attemptNumber).toBe(2);
    expect(secondAttempt.status).toBe('starting');

    const rows = await pool.query(
      'SELECT attempt_number, status FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1 ORDER BY attempt_number',
      [gameId],
    );
    expect(rows.rows).toEqual([
      { attempt_number: 1, status: 'abandoned' },
      { attempt_number: 2, status: 'starting' },
    ]);
  });

  it('serializes settings across adjacent snapshot dates', async () => {
    const gameId = `daily-store-settings-lock-${randomUUID()}`;
    gameIds.add(gameId);
    const nextDate = '2026-10-27';
    const [first, second] = await Promise.all([
      store.ensureSnapshot({
        gameId,
        releaseId: 'daily-release-v1',
        modeId: 'daily-challenge',
        challengeDate: date,
        defaults: { preset: 'standard' },
        seed: 'seed-settings-a',
        setup: { date },
        eligibilityCutoffAt: new Date('2026-10-27T03:00:00.000Z'),
      }),
      store.ensureSnapshot({
        gameId,
        releaseId: 'daily-release-v1',
        modeId: 'daily-challenge',
        challengeDate: nextDate,
        defaults: { preset: 'standard' },
        seed: 'seed-settings-b',
        setup: { nextDate },
        eligibilityCutoffAt: new Date('2026-10-28T03:00:00.000Z'),
      }),
    ]);
    expect(first.settingsRevision).toBe(1);
    expect(second.settingsRevision).toBe(1);
    expect(
      (await store.getSettings(gameId, 'daily-release-v1'))?.revision,
    ).toBe(1);
    const [updatedA, updatedB] = await Promise.all([
      store.updateSettings({
        gameId,
        releaseId: 'daily-release-v1',
        challengeDate: date,
        settings: { preset: 'updated-a' },
        defaults: { preset: 'standard' },
      }),
      store.updateSettings({
        gameId,
        releaseId: 'daily-release-v1',
        challengeDate: nextDate,
        settings: { preset: 'updated-b' },
        defaults: { preset: 'standard' },
      }),
    ]);
    expect(new Set([updatedA.revision, updatedB.revision])).toEqual(
      new Set([2, 3]),
    );
    expect(
      (await store.getSettings(gameId, 'daily-release-v1'))?.revision,
    ).toBe(3);
    const snapshots = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "board_platform_daily"."challenge_snapshots" WHERE game_id = $1',
      [gameId],
    );
    expect(snapshots.rows[0]?.count).toBe(2);
  });

  it('serializes the same request across adjacent dates', async () => {
    const gameId = `daily-store-request-cross-date-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-request-cross-date',
      setup: {},
    });
    const firstInput = input(gameId, 'player-a', 'cross-date');
    const secondInput = {
      ...firstInput,
      challengeDate: '2026-10-27',
      sessionId: `session:cross-date-next:${randomUUID()}`,
    };
    const [first, second] = await Promise.all([
      store.reserveAttempt(firstInput),
      store.reserveAttempt(secondInput),
    ]);
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.challengeDate).toBe(first.challengeDate);
    const rows = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1',
      [gameId],
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('rejects an attempt whose release or mode does not match the frozen snapshot', async () => {
    const gameId = `daily-store-snapshot-route-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-snapshot-route',
      setup: {},
    });

    await expect(
      store.reserveAttempt({
        ...input(gameId, 'player-a', 'wrong-release'),
        releaseId: 'daily-release-v2',
      }),
    ).rejects.toThrow('DAILY_ATTEMPT_SNAPSHOT_ROUTE_CONFLICT');
    await expect(
      store.reserveAttempt({
        ...input(gameId, 'player-a', 'wrong-mode'),
        modeId: 'daily-other-mode',
      }),
    ).rejects.toThrow('DAILY_ATTEMPT_SNAPSHOT_ROUTE_CONFLICT');
  });

  it('keeps completion idempotent, rejects digest conflicts, and supports the three boards', async () => {
    const gameId = `daily-store-boards-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: { preset: 'standard' },
      seed: 'seed-1',
      setup: { playerCount: 1 },
    });

    async function finish(
      principalId: string,
      suffix: string,
      score: number,
      completedAt: string,
    ) {
      const reserved = await store.reserveAttempt(
        input(gameId, principalId, suffix),
      );
      await store.markStarted(reserved.attemptId, `start:${suffix}`);
      return store.completeAttempt({
        sessionId: reserved.sessionId as string,
        score,
        result: { score },
        completedAt: new Date(completedAt),
      });
    }

    const first = await finish(
      'player-a',
      'a1',
      10,
      '2026-10-26T12:01:00.000Z',
    );
    expect(first?.publicationState).toBe('pending');
    const repeated = await store.completeAttempt({
      sessionId: first?.sessionId as string,
      score: 10,
      result: { score: 10 },
      completedAt: new Date('2026-10-26T12:02:00.000Z'),
    });
    expect(repeated?.attemptId).toBe(first?.attemptId);
    await expect(
      store.completeAttempt({
        sessionId: first?.sessionId as string,
        score: 10,
        result: { score: 10 },
        resultDigest: 'different-source-digest',
      }),
    ).rejects.toThrow('DAILY_COMPLETION_CONFLICT');
    await expect(
      store.completeAttempt({
        sessionId: first?.sessionId as string,
        score: 11,
        result: { score: 11 },
      }),
    ).rejects.toThrow('DAILY_COMPLETION_CONFLICT');

    await store.publishAttempt({
      attemptId: first?.attemptId as string,
      publicationState: 'anonymous',
    });
    const second = await finish(
      'player-a',
      'a2',
      30,
      '2026-10-26T12:03:00.000Z',
    );
    const third = await finish(
      'player-b',
      'b1',
      30,
      '2026-10-26T12:04:00.000Z',
    );
    await store.publishAttempt({
      attemptId: second?.attemptId as string,
      publicationState: 'public',
    });
    await store.publishAttempt({
      attemptId: third?.attemptId as string,
      publicationState: 'public',
    });
    const autoPending = await finish(
      'player-c',
      'c1',
      5,
      '2026-10-26T12:05:00.000Z',
    );
    const autoPublished = await store.publishDue(
      new Date('2026-10-26T12:11:00.000Z'),
    );
    expect(autoPublished.map((row) => row.attemptId)).toContain(
      autoPending?.attemptId,
    );
    expect(
      autoPublished.find((row) => row.attemptId === autoPending?.attemptId)
        ?.publicationState,
    ).toBe('public');

    const firstBoard = await store.listLeaderboard({
      gameId,
      challengeDate: date,
      board: 'firstLook',
    });
    expect(firstBoard.map((row) => [row.principalId, row.score])).toEqual([
      ['player-b', 30],
      ['player-a', 10],
      ['player-c', 5],
    ]);
    const overallBoard = await store.listLeaderboard({
      gameId,
      challengeDate: date,
      board: 'overall',
    });
    expect(overallBoard.map((row) => [row.principalId, row.score])).toEqual([
      ['player-a', 30],
      ['player-b', 30],
      ['player-a', 10],
      ['player-c', 5],
    ]);
    const attemptsBoard = await store.listLeaderboard({
      gameId,
      challengeDate: date,
      board: 'overall',
    });
    expect(attemptsBoard).toHaveLength(4);
    expect(new Set(attemptsBoard.map((row) => row.entryKey)).size).toBe(4);
    const anonymous = await store.listLeaderboard({
      gameId,
      challengeDate: date,
      board: 'overall',
      visibility: 'anonymous',
    });
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]?.entryKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(anonymous[0]?.principalId).toBe('player-a');

    const boards = await store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId: 'player-a',
    });
    expect(boards.firstLook.top.map((row) => row.score)).toEqual([30, 10, 5]);
    expect(boards.overall.me?.score).toBe(30);
    expect(boards.grinder.me).toMatchObject({
      attemptCount: 2,
      completedCount: 2,
      bestScore: 30,
    });
    const persistedAttemptKeys = await pool.query<{ entry_key: string }>(
      'SELECT entry_key FROM "board_platform_daily"."challenge_attempts" WHERE game_id = $1 AND principal_id = $2 ORDER BY attempt_number',
      [gameId, 'player-a'],
    );
    expect(persistedAttemptKeys.rows.map((row) => row.entry_key)).toContain(
      boards.grinder.me?.entryKey,
    );
    const limited = await store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId: 'player-c',
      limit: 1,
    });
    expect(limited.overall.top).toHaveLength(1);
    expect(limited.overall.me).toMatchObject({
      principalId: 'player-c',
      rank: 4,
      score: 5,
    });
    const limitedGrinder = await store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId: 'player-b',
      limit: 1,
    });
    expect(limitedGrinder.grinder.top).toHaveLength(1);
    expect(limitedGrinder.grinder.me).toMatchObject({
      principalId: 'player-b',
      rank: 2,
    });
  });

  it('counts a late attempt for grinder activity without making it eligible', async () => {
    const gameId = `daily-store-cutoff-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-cutoff',
      setup: {},
      eligibilityCutoffAt: new Date('2026-10-27T03:00:00.000Z'),
    });
    async function finish(suffix: string, score: number, completedAt: string) {
      const reserved = await store.reserveAttempt(
        input(gameId, 'player-a', suffix),
      );
      await store.markStarted(reserved.attemptId, `start:${suffix}`);
      const completed = await store.completeAttempt({
        sessionId: reserved.sessionId as string,
        score,
        result: { score },
        completedAt: new Date(completedAt),
      });
      await store.publishAttempt({
        attemptId: completed?.attemptId as string,
        publicationState: 'public',
      });
    }
    await finish('before-cutoff', 20, '2026-10-27T02:59:00.000Z');
    await finish('after-cutoff', 99, '2026-10-27T04:00:00.000Z');
    const boards = await store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId: 'player-a',
    });
    expect(boards.overall.top.map((entry) => entry.score)).toEqual([20]);
    expect(boards.grinder.me).toMatchObject({
      attemptCount: 2,
      completedCount: 1,
      bestScore: 20,
    });
  });

  it('freezes cutoff/finalizedAt and rejects a conflicting finalization', async () => {
    const gameId = `daily-store-finalize-${randomUUID()}`;
    gameIds.add(gameId);
    const snapshot = await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-finalize',
      setup: {},
      publicSettings: { label: 'safe' },
      eligibilityCutoffAt: new Date('2026-10-27T03:00:00.000Z'),
    });
    expect(snapshot.publicSettings).toEqual({ label: 'safe' });
    const cutoff = new Date('2026-10-27T03:00:00.000Z');
    const finalized = await store.finalizeSnapshot({
      gameId,
      challengeDate: date,
      eligibilityCutoffAt: cutoff,
      finalizedAt: new Date('2026-10-27T03:01:00.000Z'),
    });
    expect(finalized.eligibilityCutoffAt).toBe(cutoff.toISOString());
    expect(finalized.finalizedAt).toBe('2026-10-27T03:01:00.000Z');
    await expect(
      store.finalizeSnapshot({
        gameId,
        challengeDate: date,
        eligibilityCutoffAt: new Date('2026-10-27T04:00:00.000Z'),
      }),
    ).rejects.toThrow('DAILY_SNAPSHOT_FINALIZE_CONFLICT');
  });

  it('gates replay eligibility by finalized cutoff, score rank and anonymous ownership', async () => {
    const gameId = `daily-store-replay-eligibility-${randomUUID()}`;
    gameIds.add(gameId);
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: 'daily-challenge',
      challengeDate: date,
      defaults: {},
      seed: 'seed-replay',
      setup: {},
      eligibilityCutoffAt: new Date('2026-10-27T03:00:00.000Z'),
      publicSettings: { preset: 'safe' },
    });

    async function finish(
      principalId: string,
      suffix: string,
      score: number,
      publicationState: 'public' | 'anonymous',
    ) {
      const reserved = await store.reserveAttempt(
        input(gameId, principalId, suffix),
      );
      await store.markStarted(reserved.attemptId, `start:${suffix}`);
      const completed = await store.completeAttempt({
        sessionId: reserved.sessionId as string,
        score,
        result: { score },
        completedAt: new Date('2026-10-26T12:00:00.000Z'),
      });
      if (!completed) throw new Error('DAILY_REPLAY_COMPLETION_MISSING');
      const published = await store.publishAttempt({
        attemptId: completed.attemptId,
        publicationState,
      });
      return published;
    }

    const highest = await finish('player-high', 'replay-high', 100, 'public');
    const second = await finish('player-second', 'replay-second', 90, 'public');
    const tied = await finish('player-tied', 'replay-tied', 90, 'public');
    const ownerFirst = await finish(
      'player-owner',
      'replay-owner-first',
      1,
      'public',
    );
    const ownerOverall = await finish(
      'player-owner',
      'replay-owner-second',
      95,
      'anonymous',
    );
    const late = await store.reserveAttempt(
      input(gameId, 'player-late', 'replay-late'),
    );
    await store.markStarted(late.attemptId, 'start:replay-late');
    const lateCompleted = await store.completeAttempt({
      sessionId: late.sessionId as string,
      score: 999,
      result: { score: 999 },
      completedAt: new Date('2026-10-27T04:00:00.000Z'),
    });
    if (!lateCompleted) throw new Error('DAILY_REPLAY_LATE_COMPLETION_MISSING');
    await store.publishAttempt({
      attemptId: lateCompleted.attemptId,
      publicationState: 'public',
    });
    await store.finalizeSnapshot({
      gameId,
      challengeDate: date,
      finalizedAt: new Date('2026-10-27T03:01:00.000Z'),
    });

    const boards = await store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId: 'player-owner',
    });
    expect(boards.overall.top.map((entry) => entry.score)).toEqual([
      100, 95, 90, 90, 1,
    ]);
    expect(
      boards.overall.top.find((entry) => entry.score === 95)?.sessionId,
    ).toBe(ownerOverall.sessionId);
    expect(ownerFirst.sessionId).not.toBe(ownerOverall.sessionId);
    expect(second.sessionId).toBeTruthy();
    expect(tied.sessionId).toBeTruthy();

    const ownerReplay = await store.getReplayEligibility(
      ownerOverall.sessionId as string,
      'player-owner',
    );
    expect(ownerReplay?.attempt.attemptId).toBe(ownerOverall.attemptId);
    expect(ownerReplay?.snapshot.publicSettings).toEqual({ preset: 'safe' });
    await expect(
      store.getReplayEligibility(
        ownerOverall.sessionId as string,
        'another-player',
      ),
    ).resolves.toBeNull();
    await expect(
      store.getReplayEligibility(highest.sessionId as string, 'another-player'),
    ).resolves.toMatchObject({ attempt: { attemptId: highest.attemptId } });
    await expect(
      store.getReplayEligibility(tied.sessionId as string, 'another-player'),
    ).resolves.toMatchObject({ attempt: { attemptId: tied.attemptId } });
    await expect(
      store.getReplayEligibility(
        ownerFirst.sessionId as string,
        'player-owner',
      ),
    ).resolves.toBeNull();
    await expect(
      store.getReplayEligibility(late.sessionId as string, 'another-player'),
    ).resolves.toBeNull();
  });

  it('freezes daily reward plans before late completion and marks them idempotently', async () => {
    const gameId = `daily-store-reward-plan-${randomUUID()}`;
    gameIds.add(gameId);
    const cutoff = new Date('2026-10-27T03:00:00.000Z');
    await store.ensureSnapshot({
      gameId,
      releaseId: 'daily-release-v1',
      modeId: rewardPolicy.modeId,
      challengeDate: date,
      defaults: {},
      seed: 'seed-reward-plan',
      setup: {},
      rewardPolicy,
      eligibilityCutoffAt: cutoff,
    });

    async function finish(principalId: string, suffix: string, score: number) {
      const reserved = await store.reserveAttempt(
        input(gameId, principalId, suffix),
      );
      await store.markStarted(reserved.attemptId, `start:${suffix}`);
      await store.completeAttempt({
        sessionId: reserved.sessionId as string,
        score,
        completedAt: new Date('2026-10-26T12:00:00.000Z'),
      });
    }

    await finish('player-a', 'reward-a', 100);
    await finish('player-b', 'reward-b', 90);
    const finalized = await store.finalizeSnapshot({
      gameId,
      challengeDate: date,
      finalizedAt: new Date('2026-10-27T03:01:00.000Z'),
    });
    expect(finalized.rewardPolicy).toEqual(rewardPolicy);
    expect(finalized.rewardPlan?.awards).toHaveLength(2);
    const planDigest = finalized.rewardPlan?.digest;
    if (!planDigest) throw new Error('DAILY_REWARD_PLAN_DIGEST_MISSING');

    const late = await store.reserveAttempt(
      input(gameId, 'player-a', 'reward-late'),
    );
    await store.markStarted(late.attemptId, 'start:reward-late');
    await store.completeAttempt({
      sessionId: late.sessionId as string,
      score: 999,
      completedAt: new Date('2026-10-27T04:00:00.000Z'),
    });
    await expect(store.getSnapshot(gameId, date)).resolves.toMatchObject({
      rewardPlan: { digest: planDigest },
    });
    await expect(
      store.listPendingRewardSnapshots(gameId),
    ).resolves.toHaveLength(1);
    const settled = await store.markRewardsSettled({
      gameId,
      challengeDate: date,
      planDigest,
      settledAt: new Date('2026-10-27T03:02:00.000Z'),
    });
    expect(settled.rewardsSettledAt).toBe('2026-10-27T03:02:00.000Z');
    await expect(
      store.markRewardsSettled({
        gameId,
        challengeDate: date,
        planDigest,
        settledAt: new Date('2026-10-27T03:03:00.000Z'),
      }),
    ).resolves.toMatchObject({
      rewardsSettledAt: '2026-10-27T03:02:00.000Z',
    });
    await expect(store.listPendingRewardSnapshots(gameId)).resolves.toEqual([]);
  });
});
