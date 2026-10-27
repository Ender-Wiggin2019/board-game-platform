import type {
  MatchAdmission,
  PlatformCompletionRecord,
  SessionRoute,
} from '@board-game/contracts';
import {
  MemoryAwardStore,
  MemoryEntitlementStore,
  MemoryRatingStore,
  RatingSettlementService,
} from '@board-game/core';
import { describe, expect, it, vi } from 'vitest';
import {
  GameCapabilityRegistry,
  GameCapabilityService,
  MemoryGameAchievementStore,
} from '@/platform/capabilities/index.js';
import type { GameCapabilityServiceOptions } from '@/platform/capabilities/types.js';
import {
  assertRemoteSettlementPolicyBundle,
  createRemoteRatingPolicy,
  createRemoteSettlementHandler,
  type RemoteSettlementPolicyBundle,
} from '@/platform/remote-settlement.js';

const bundle: RemoteSettlementPolicyBundle = {
  schemaVersion: 1,
  gameId: 'remote-game',
  releaseId: 'remote-release',
  approvedModes: ['ranked'],
  rating: {
    poolId: 'remote-ranked',
    policyVersion: 'remote-rating-v1',
    progressionPolicyVersion: 'remote-stars-v1',
    algorithm: 'trueskill-stars-v1',
    parameters: {
      mu: 25,
      sigma: 25 / 3,
      beta: 5,
      tau: 0.1,
      drawProbability: 0.1,
      minDelta: 1e-6,
    },
    stars: {
      rewards: { '2': [1, -1], '3': [1, 0, -1], '4': [2, 1, 0, -1] },
      legendThreshold: 73,
      legendQualifyingGames: 10,
    },
  },
  rewards: {
    definitionVersion: 'remote-rewards-v1',
    asset: 'remote-credits',
    quantities: [100, 50, 25, 10],
    excludeControllers: ['ai', 'automa', 'hotseat', 'bot'],
  },
  achievements: {
    definitionVersion: 'remote-achievements-v1',
    definitions: [
      {
        achievementId: 'first-game',
        title: 'First',
        description: 'First game',
        tier: 'first-game',
        target: 1,
      },
      {
        achievementId: 'winner',
        title: 'Winner',
        description: 'Win',
        tier: 'winner',
        target: 1,
      },
      {
        achievementId: 'veteran',
        title: 'Veteran',
        description: 'Ten games',
        tier: 'veteran',
        target: 10,
      },
    ],
    winnerAchievementId: 'winner',
    excludeControllers: ['ai', 'automa', 'hotseat', 'bot'],
  },
  messages: {
    completion: {
      templateId: 'completion',
      title: 'Done',
      body: 'The game is complete.',
      actionLabel: 'View',
      actionPath: '/game/{sessionId}/end',
    },
  },
};

const route: SessionRoute = {
  gameId: bundle.gameId,
  modeId: 'ranked',
  sessionId: 'remote-session',
  releaseId: bundle.releaseId,
  backendBindingId: 'remote-backend',
  storageBindingId: 'remote-storage',
  ownershipEpoch: 'remote-epoch',
};

const admission: MatchAdmission = {
  id: 'remote-admission',
  route,
  participants: [
    { principalId: 'player-a', seatId: 'seat-a' },
    { principalId: 'player-b', seatId: 'seat-b' },
  ],
  visibility: 'private',
  rating: {
    poolId: bundle.rating.poolId,
    policyVersion: bundle.rating.policyVersion,
    progressionPolicyVersion: bundle.rating.progressionPolicyVersion,
    seasonId: null,
  },
  validityPolicyVersion: 'remote-validity-v1',
  createdAt: 1,
};

function completion(): PlatformCompletionRecord {
  return {
    platformId: 'platform-1',
    admissionId: admission.id,
    route,
    sessionId: route.sessionId,
    status: 'completed',
    resultSchemaVersion: 1,
    resultRevision: 1,
    sourceRevision: 4,
    digest: 'sha256:completion',
    participants: admission.participants,
    validityPolicyVersion: admission.validityPolicyVersion,
    rating: admission.rating,
    endedAt: 100,
    result: {
      kind: 'competitive',
      rankGroups: [
        { teams: [{ participantIds: ['player-a'], score: 20 }] },
        { teams: [{ participantIds: ['player-b'], score: 10 }] },
      ],
    },
    processingState: 'received',
    attempts: 1,
    receivedAt: 100,
    updatedAt: 100,
  };
}

function makeHandler() {
  const registry = new GameCapabilityRegistry();
  const achievements = new MemoryGameAchievementStore();
  const ratings = new MemoryRatingStore();
  const awards = new MemoryAwardStore();
  const entitlements = new MemoryEntitlementStore();
  const ratingPolicy = createRemoteRatingPolicy(bundle);
  const capabilityOptions: GameCapabilityServiceOptions = {
    registry,
    awards,
    entitlements,
    ratings: new RatingSettlementService({
      store: ratings,
      admissions: { getAdmission: async () => admission },
      policies: {
        get: (policyVersion, progressionPolicyVersion) =>
          policyVersion === bundle.rating.policyVersion &&
          progressionPolicyVersion === bundle.rating.progressionPolicyVersion
            ? ratingPolicy
            : null,
      },
    }),
  };
  const capabilities = new GameCapabilityService(capabilityOptions);
  const publish = vi.fn(async () => undefined);
  const handler = createRemoteSettlementHandler({
    bundle,
    approval: {
      gameId: bundle.gameId,
      releaseId: bundle.releaseId,
      approvedModes: ['ranked'],
      approvedPolicyVersions: [
        { kind: 'rating', version: bundle.rating.policyVersion },
        {
          kind: 'progression',
          version: bundle.rating.progressionPolicyVersion,
        },
        { kind: 'reward', version: bundle.rewards.definitionVersion },
        { kind: 'achievement', version: bundle.achievements.definitionVersion },
      ],
    },
    metadata: {
      gameId: bundle.gameId,
      name: 'Remote game',
      description: 'Remote game',
      themeId: 'remote',
    },
    services: { achievements, ratings, capabilities, messages: { publish } },
  });
  registry.register(handler.registration);
  return { handler, ratings, achievements, publish };
}

describe('remote settlement interpreter', () => {
  it('matches the bundled TrueSkill-plus-stars contract', () => {
    const policy = createRemoteRatingPolicy(bundle);
    const updates = policy.calculate({
      previous: {
        'player-a': {
          mu: 25,
          sigma: 25 / 3,
          stars: 9,
          qualifyingGames: 9,
          legend: false,
        },
        'player-b': {
          mu: 25,
          sigma: 25 / 3,
          stars: 9,
          qualifyingGames: 9,
          legend: false,
        },
      },
      ranking: ['player-a', 'player-b'],
      result: completion().result as Extract<
        NonNullable<PlatformCompletionRecord['result']>,
        { kind: 'competitive' }
      >,
      participants: admission.participants,
      admission,
    });
    expect(updates).toMatchObject([
      { participantId: 'player-a', after: { stars: 10, qualifyingGames: 10 } },
      { participantId: 'player-b', after: { stars: 9, qualifyingGames: 10 } },
    ]);
    expect((updates[0]?.after as { mu: number }).mu).toBeCloseTo(
      29.2421915786259,
      10,
    );
  });

  it('requires platform approval and settles through shared stores', async () => {
    expect(() =>
      createRemoteSettlementHandler({
        bundle,
        approval: {
          gameId: bundle.gameId,
          releaseId: bundle.releaseId,
          approvedModes: [],
          approvedPolicyVersions: [],
        },
        metadata: {
          gameId: bundle.gameId,
          name: 'Remote game',
          description: 'Remote game',
          themeId: 'remote',
        },
        services: {} as never,
      }),
    ).toThrow('REMOTE_POLICY_APPROVAL_MODES');

    const { handler, ratings, achievements, publish } = makeHandler();
    await handler.settleCompletion(completion());
    expect(await ratings.getRating(bundle.rating.poolId, 'player-a')).toEqual(
      expect.objectContaining({ participantId: 'player-a' }),
    );
    await expect(
      achievements.read({
        gameId: bundle.gameId,
        principalId: 'player-a',
        definitionVersion: bundle.achievements.definitionVersion,
        definitions: bundle.achievements.definitions,
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ achievementId: 'winner', progress: 1 }),
      ]),
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'remote-session:1',
        principalId: 'player-a',
      }),
    );
  });

  it('merges release-approved public facts once with generated facts', async () => {
    const { handler, achievements } = makeHandler();
    const withPublicFacts: PlatformCompletionRecord = {
      ...completion(),
      achievementSources: [
        {
          principalId: 'player-a',
          facts: [{ achievementId: 'veteran', amount: 1 }],
        },
      ],
    };
    await handler.settleCompletion(withPublicFacts);
    await handler.settleCompletion(withPublicFacts);
    await expect(
      achievements.read({
        gameId: bundle.gameId,
        principalId: 'player-a',
        definitionVersion: bundle.achievements.definitionVersion,
        definitions: bundle.achievements.definitions,
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ achievementId: 'first-game', progress: 1 }),
        expect.objectContaining({ achievementId: 'winner', progress: 1 }),
        // One generated veteran fact plus one public SETI-style fact; the
        // repeated completion must not apply either source a second time.
        expect.objectContaining({ achievementId: 'veteran', progress: 2 }),
      ]),
    });
  });

  it('does not retry non-rated modes absent from the settlement policy', async () => {
    const { handler, ratings, achievements, publish } = makeHandler();
    const nonRated: PlatformCompletionRecord = {
      ...completion(),
      route: { ...route, modeId: 'casual' },
      rating: null,
    };
    await expect(handler.settleCompletion(nonRated)).resolves.toBeUndefined();
    expect(
      await ratings.getRating(bundle.rating.poolId, 'player-a'),
    ).toBeNull();
    await expect(
      achievements.read({
        gameId: bundle.gameId,
        principalId: 'player-a',
        definitionVersion: bundle.achievements.definitionVersion,
        definitions: bundle.achievements.definitions,
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ achievementId: 'first-game', progress: 0 }),
      ]),
    });
    expect(publish).not.toHaveBeenCalled();

    await expect(
      handler.settleCompletion({
        ...nonRated,
        rating: admission.rating,
      }),
    ).rejects.toThrow('platform.remote.policy_route_mismatch');
  });

  it('skips cancelled completion records without settlement side effects', async () => {
    const { handler, ratings, achievements, publish } = makeHandler();
    const { result: _result, ...completed } = completion();
    const cancelled: PlatformCompletionRecord = {
      ...completed,
      status: 'cancelled',
    };
    await expect(handler.settleCompletion(cancelled)).resolves.toBeUndefined();
    expect(
      await ratings.getRating(bundle.rating.poolId, 'player-a'),
    ).toBeNull();
    await expect(
      achievements.read({
        gameId: bundle.gameId,
        principalId: 'player-a',
        definitionVersion: bundle.achievements.definitionVersion,
        definitions: bundle.achievements.definitions,
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ achievementId: 'first-game', progress: 0 }),
      ]),
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects an unknown policy field before registration', () => {
    const invalid = structuredClone(bundle) as RemoteSettlementPolicyBundle & {
      extra?: string;
    };
    invalid.extra = 'must be rejected';
    expect(() => createRemoteRatingPolicy(invalid)).toThrow(
      'REMOTE_POLICY_BUNDLE_FIELDS_INVALID',
    );
  });

  it('registers compatible multi-pool bundles without changing legacy bundles', () => {
    const multi = {
      ...structuredClone(bundle),
      rating: {
        ...bundle.rating,
        policies: [
          {
            poolId: 'remote-arena',
            policyVersion: 'remote-rating-v1',
            progressionPolicyVersion: 'remote-arena-stars-v1',
          },
        ],
      },
    } as RemoteSettlementPolicyBundle;
    const handler = createRemoteSettlementHandler({
      bundle: multi,
      approval: {
        gameId: multi.gameId,
        releaseId: multi.releaseId,
        approvedModes: multi.approvedModes,
        approvedPolicyVersions: [
          { kind: 'rating', version: 'remote-rating-v1' },
          { kind: 'progression', version: 'remote-stars-v1' },
          { kind: 'progression', version: 'remote-arena-stars-v1' },
          { kind: 'reward', version: multi.rewards.definitionVersion },
          {
            kind: 'achievement',
            version: multi.achievements.definitionVersion,
          },
        ],
      },
      metadata: {
        gameId: multi.gameId,
        name: 'Remote game',
        description: 'Remote game',
        themeId: 'remote',
      },
      services: {} as never,
    });
    expect(handler.ratingPolicies).toHaveLength(2);
    expect(handler.registration.rating?.pools).toEqual([
      {
        poolId: 'remote-ranked',
        policyVersion: 'remote-rating-v1',
        progressionPolicyVersion: 'remote-stars-v1',
      },
      {
        poolId: 'remote-arena',
        policyVersion: 'remote-rating-v1',
        progressionPolicyVersion: 'remote-arena-stars-v1',
      },
    ]);
  });

  it('keeps daily reward approval separate from ordinary settlement modes', () => {
    const daily = {
      ...structuredClone(bundle),
      dailyChallengeRewards: {
        modeId: 'daily-challenge',
        definitionVersion: 'daily-reward-v1',
        asset: 'daily-credits',
        tiers: [
          { percent: 5, quantity: 10 },
          { percent: 10, quantity: 5 },
          { percent: 20, quantity: 3 },
        ],
        participationQuantity: 1,
        sourceKeyPrefix: 'remote:daily',
      },
    } satisfies RemoteSettlementPolicyBundle;
    expect(() => assertRemoteSettlementPolicyBundle(daily)).not.toThrow();
    expect(() =>
      createRemoteSettlementHandler({
        bundle: daily,
        approval: {
          gameId: daily.gameId,
          releaseId: daily.releaseId,
          approvedModes: daily.approvedModes,
          approvedPolicyVersions: [
            { kind: 'rating', version: daily.rating.policyVersion },
            {
              kind: 'progression',
              version: daily.rating.progressionPolicyVersion,
            },
            { kind: 'reward', version: daily.rewards.definitionVersion },
            {
              kind: 'achievement',
              version: daily.achievements.definitionVersion,
            },
          ],
        },
        metadata: {
          gameId: daily.gameId,
          name: 'Remote game',
          description: 'Remote game',
          themeId: 'remote',
        },
        services: {} as never,
      }),
    ).toThrow('REMOTE_POLICY_APPROVAL_DAILY_MODE_MISSING');

    const handler = createRemoteSettlementHandler({
      bundle: daily,
      approval: {
        gameId: daily.gameId,
        releaseId: daily.releaseId,
        approvedModes: daily.approvedModes,
        approvedDailyModes: ['daily-challenge'],
        approvedPolicyVersions: [
          { kind: 'rating', version: daily.rating.policyVersion },
          {
            kind: 'progression',
            version: daily.rating.progressionPolicyVersion,
          },
          { kind: 'reward', version: daily.rewards.definitionVersion },
          {
            kind: 'reward',
            version: daily.dailyChallengeRewards.definitionVersion,
          },
          {
            kind: 'achievement',
            version: daily.achievements.definitionVersion,
          },
        ],
      },
      metadata: {
        gameId: daily.gameId,
        name: 'Remote game',
        description: 'Remote game',
        themeId: 'remote',
      },
      services: {} as never,
    });
    expect(handler.registration.policyVersions).toContainEqual({
      kind: 'reward',
      version: 'daily-reward-v1',
    });
    expect(handler.registration.assets.map((asset) => asset.asset)).toEqual([
      bundle.rewards.asset,
      'daily-credits',
    ]);
  });
});
