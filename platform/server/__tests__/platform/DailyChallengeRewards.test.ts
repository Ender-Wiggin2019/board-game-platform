import { randomUUID } from 'node:crypto';
import {
  AwardRewardRunner,
  MemoryAwardStore,
  MemoryEntitlementStore,
} from '@board-game/core';
import { describe, expect, it } from 'vitest';
import {
  assertDailyChallengeRewardPlan,
  calculateDailyChallengeRewardPlan,
  DailyChallengeRewardRunner,
} from '@/platform/daily-challenge/rewards.js';
import type {
  DailyChallengeAttemptRecord,
  DailyChallengeRewardPolicy,
} from '@/platform/daily-challenge/types.js';

const policy: DailyChallengeRewardPolicy = {
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
};

function attempt(
  principalId: string,
  attemptNumber: number,
  score: number,
  options: Partial<DailyChallengeAttemptRecord> = {},
): DailyChallengeAttemptRecord {
  const attemptId = options.attemptId ?? randomUUID();
  return {
    attemptId,
    gameId: 'seti',
    releaseId: 'seti-v1',
    modeId: 'daily-challenge',
    challengeDate: '2026-10-26',
    attemptNumber,
    principalId,
    roomId: `room:${attemptId}`,
    requestId: `request:${attemptId}`,
    sessionId: `session:${attemptId}`,
    participants: [],
    status: 'completed',
    score,
    publicationState: 'pending',
    completedAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T12:00:00.000Z',
    ...options,
  };
}

describe('daily challenge rewards', () => {
  it('matches SETI first-look/overall max awards, ties and pending publications', () => {
    const attempts = [
      attempt('player-01', 1, 100),
      attempt('player-02', 1, 90, { publicationState: 'anonymous' }),
      attempt('player-03', 1, 90),
      attempt('player-04', 1, 80),
      attempt('player-05', 1, 80),
      attempt('player-06', 1, 70),
      attempt('player-07', 1, 60),
      attempt('player-08', 1, 50),
      attempt('player-09', 1, 40),
      attempt('player-10', 1, 30),
      attempt('player-10', 2, 110),
      attempt('late', 1, 999, {
        completedAt: '2026-10-27T04:00:00.000Z',
      }),
      attempt('abandoned', 1, 1000, { status: 'abandoned' }),
    ];
    const plan = calculateDailyChallengeRewardPlan({
      gameId: 'seti',
      challengeDate: '2026-10-26',
      eligibilityCutoffAt: '2026-10-27T03:00:00.000Z',
      policy,
      attempts,
    });
    expect(
      plan.awards.map((award) => [award.principalId, award.quantity]),
    ).toEqual([
      ['player-01', 10],
      ['player-02', 3],
      ['player-03', 3],
      ['player-04', 1],
      ['player-05', 1],
      ['player-06', 1],
      ['player-07', 1],
      ['player-08', 1],
      ['player-09', 1],
      ['player-10', 10],
    ]);
    expect(
      plan.awards.every(
        (award) => award.awardId === 'interstellar:daily:2026-10-26',
      ),
    ).toBe(true);
    expect(plan.awards.some((award) => award.principalId === 'late')).toBe(
      false,
    );
    expect(plan.awards.some((award) => award.principalId === 'abandoned')).toBe(
      false,
    );
    expect(() => assertDailyChallengeRewardPlan(plan)).not.toThrow();
  });

  it('retries partial award delivery without double granting entitlements', async () => {
    const plan = calculateDailyChallengeRewardPlan({
      gameId: 'seti',
      challengeDate: '2026-10-26',
      eligibilityCutoffAt: '2026-10-27T03:00:00.000Z',
      policy,
      attempts: [attempt('player-01', 1, 100), attempt('player-02', 1, 80)],
    });
    let now = 1_000;
    const awards = new MemoryAwardStore({ now: () => now });
    const entitlements = new MemoryEntitlementStore();
    const originalGrant = entitlements.grant.bind(entitlements);
    let failOnce = true;
    const delivery = new AwardRewardRunner({
      awards,
      entitlements: {
        grant: async (input) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('temporary entitlement failure');
          }
          return originalGrant(input);
        },
      },
    });
    const runner = new DailyChallengeRewardRunner({
      awards,
      delivery,
      now: () => now,
    });

    await expect(runner.settle(plan)).rejects.toThrow(
      'temporary entitlement failure',
    );
    now += 60_000;
    await runner.settle(plan);
    await runner.settle(plan);

    for (const principalId of ['player-01', 'player-02']) {
      await expect(
        entitlements.getBalance({
          namespace: 'seti',
          principalId,
          asset: 'interstellar-points',
        }),
      ).resolves.toMatchObject({ granted: expect.any(Number) });
      const balance = await entitlements.getBalance({
        namespace: 'seti',
        principalId,
        asset: 'interstellar-points',
      });
      expect(balance.granted).toBeGreaterThan(0);
      expect(balance.granted).toBe(balance.available);
    }
  });

  it('does not infer plan delivery from truncated unrelated pending rows', async () => {
    let now = 10_000;
    const awards = new MemoryAwardStore({ now: () => now });
    const noiseRewards = (start: number, count: number) =>
      Array.from({ length: count }, (_, offset) => ({
        rewardId: `noise-points-${start + offset}`,
        namespace: 'seti',
        asset: 'noise-points',
        quantity: 1,
      }));
    for (const [index, rewards] of [
      [0, noiseRewards(0, 1_000)],
      [1, noiseRewards(1_000, 1_000)],
      [2, noiseRewards(2_000, 1)],
    ] as const) {
      await awards.grantAward({
        namespace: 'seti',
        principalId: 'player-01',
        awardId: `unrelated-${index}`,
        tier: 'noise',
        definitionVersion: 'noise-v1',
        sourceRecordId: `noise:${index}`,
        rewards,
        createdAt: index + 1,
      });
    }
    const plan = calculateDailyChallengeRewardPlan({
      gameId: 'seti',
      challengeDate: '2026-10-26',
      eligibilityCutoffAt: '2026-10-27T03:00:00.000Z',
      policy,
      attempts: [attempt('player-01', 1, 100)],
    });
    const entitlements = new MemoryEntitlementStore();
    const delivery = new AwardRewardRunner({ awards, entitlements });
    const runner = new DailyChallengeRewardRunner({
      awards,
      delivery,
      now: () => now,
    });

    // The first bounded delivery batch cannot reach the plan reward. An old
    // principal-scoped list could miss it behind the 1,001 unrelated rows.
    await expect(runner.settle(plan)).rejects.toThrow(
      'DAILY_REWARD_DELIVERY_PENDING',
    );
    await delivery.deliverPending({
      limit: 1_000,
      namespace: 'seti',
      now,
    });
    await expect(runner.settle(plan)).resolves.toMatchObject({
      planDigest: plan.digest,
    });
    const balance = await entitlements.getBalance({
      namespace: 'seti',
      principalId: 'player-01',
      asset: 'interstellar-points',
    });
    expect(balance.granted).toBe(10);
  }, 30_000);

  it('rejects policy and plan mutations', () => {
    expect(() =>
      calculateDailyChallengeRewardPlan({
        gameId: 'seti',
        challengeDate: '2026-10-26',
        eligibilityCutoffAt: '2026-10-27T03:00:00.000Z',
        policy: {
          ...policy,
          tiers: [
            { percent: 10, quantity: 5 },
            { percent: 5, quantity: 10 },
          ],
        },
        attempts: [],
      }),
    ).toThrow('DAILY_REWARD_TIERS_ORDER_INVALID');
  });
});
