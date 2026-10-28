import type {
  AchievementCollection,
  GameStatisticsServiceRequest,
  MatchAdmission,
  SessionRoute,
} from '@board-game/contracts';
import { MemoryAwardStore, MemoryEntitlementStore } from '@board-game/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type GameAchievementWriteRequest,
  type GameCapabilityRegistration,
  GameCapabilityRegistry,
  GameCapabilityService,
  type GameCompletionContext,
  type GameCompletionInput,
} from '@/platform/capabilities/index.js';

const participants = [
  { principalId: 'player-a', seatId: 'seat-a' },
  { principalId: 'player-b', seatId: 'seat-b' },
] as const;

function route(
  gameId = 'brass',
  releaseId = 'brass-v1',
  sessionId = 'session-1',
): SessionRoute {
  return {
    gameId,
    modeId: 'ranked',
    sessionId,
    releaseId,
    backendBindingId: 'backend-1',
    storageBindingId: 'storage-1',
    ownershipEpoch: 'epoch-1',
  };
}

function admission(sessionRoute: SessionRoute): MatchAdmission {
  return {
    id: `admission-${sessionRoute.sessionId}`,
    route: sessionRoute,
    participants,
    visibility: 'private',
    rating: {
      poolId: 'brass:ranked',
      policyVersion: 'brass-rating-v1',
      progressionPolicyVersion: 'brass-progression-v1',
      seasonId: null,
    },
    validityPolicyVersion: 'brass-validity-v1',
    createdAt: 1,
  };
}

function result() {
  return {
    kind: 'competitive' as const,
    rankGroups: [
      { teams: [{ participantIds: ['player-a'] }] },
      { teams: [{ participantIds: ['player-b'] }] },
    ],
  };
}

function walletRegistration(
  gameId: string,
  releaseId: string,
): GameCapabilityRegistration {
  return {
    metadata: {
      gameId,
      name: gameId.toUpperCase(),
      description: 'A registered game',
      themeId: `${gameId}-theme`,
    },
    releaseId,
    capabilities: ['wallet'],
    policyVersions: [],
    assets: [{ asset: 'coin', kind: 'currency' }],
  };
}

function brassRegistration(options: {
  consume: (request: GameAchievementWriteRequest) => Promise<void>;
  createAwards: (context: GameCompletionContext) => readonly [
    {
      principalId: string;
      awardId: string;
      tier: string;
      rewards: readonly [{ rewardId: string; asset: string; quantity: number }];
    },
  ];
  settle: (
    context: GameCompletionContext & {
      policyVersion: string;
      progressionPolicyVersion: string;
    },
  ) => Promise<{ settled: boolean }>;
}): GameCapabilityRegistration {
  const achievements: AchievementCollection = {
    gameId: 'brass',
    principalId: 'player-a',
    definitionVersion: 'brass-achievements-v1',
    items: [],
  };
  return {
    metadata: {
      gameId: 'brass',
      name: 'Brass',
      description: 'Industrial strategy',
      themeId: 'brass-dark',
    },
    releaseId: 'brass-v1',
    capabilities: [
      'achievements',
      'rewards',
      'wallet',
      'rating',
      'rankings',
      'profile',
    ],
    policyVersions: [
      { kind: 'rating', version: 'brass-rating-v1' },
      { kind: 'progression', version: 'brass-progression-v1' },
      { kind: 'achievement', version: 'brass-achievements-v1' },
      { kind: 'reward', version: 'brass-rewards-v1' },
    ],
    assets: [{ asset: 'coin', kind: 'currency', label: 'Coin' }],
    achievements: {
      definitionVersion: 'brass-achievements-v1',
      consume: options.consume,
      read: async (principalId) => ({ ...achievements, principalId }),
    },
    rewards: {
      definitionVersion: 'brass-rewards-v1',
      createAwards: options.createAwards,
    },
    rating: {
      policyVersion: 'brass-rating-v1',
      progressionPolicyVersion: 'brass-progression-v1',
      settle: options.settle,
    },
    rankings: {
      read: async (principalId) => ({
        gameId: 'brass',
        poolId: 'brass:ranked',
        policyVersion: 'brass-rating-v1',
        progressionPolicyVersion: 'brass-progression-v1',
        entries: [
          {
            principalId: principalId ?? 'player-a',
            rank: 1,
            rating: { score: 1 },
          },
        ],
      }),
    },
    profile: {
      read: async () => ({ displayName: 'Player A', stats: { wins: 1 } }),
    },
  };
}

function completion(sessionRoute = route()): GameCompletionInput {
  return {
    route: sessionRoute,
    admission: admission(sessionRoute),
    result: result(),
    resultRevision: 1,
    occurredAt: 100,
    achievementSources: [
      {
        principalId: 'player-a',
        facts: [{ metric: 'game-completed', value: 1 }],
      },
    ],
  };
}

describe('GameCapabilityRegistry', () => {
  it('keeps exact game/release registrations and emits JSON-only catalog entries', () => {
    const registry = new GameCapabilityRegistry();
    registry.register(walletRegistration('brass', 'brass-v1'));
    expect(registry.get('brass', 'brass-v1')).toMatchObject({
      metadata: { gameId: 'brass' },
      releaseId: 'brass-v1',
      capabilities: ['wallet'],
    });
    expect(registry.get('brass', 'missing')).toBeNull();
    expect(registry.list()).toHaveLength(1);
    expect(() => registry.resolve('brass', 'missing')).toThrow();
    expect(() =>
      registry.register(walletRegistration('brass', 'brass-v1')),
    ).toThrow();
  });

  it('rejects duplicate policy pins and unregistered reward capabilities', () => {
    const registry = new GameCapabilityRegistry();
    expect(() =>
      registry.register({
        ...walletRegistration('brass', 'brass-v1'),
        policyVersions: [
          { kind: 'reward', version: 'v1' },
          { kind: 'reward', version: 'v1' },
        ],
      }),
    ).toThrow();
    expect(() =>
      registry.register({
        ...walletRegistration('brass', 'brass-v2'),
        capabilities: ['wallet', 'rewards'],
      }),
    ).toThrow();
  });
});

describe('GameCapabilityService', () => {
  it('runs achievement, core award/entitlement delivery and pinned rating adapters', async () => {
    const consumed: GameAchievementWriteRequest[] = [];
    const consume = vi.fn(async (request: GameAchievementWriteRequest) => {
      consumed.push(request);
    });
    const createAwards = vi.fn(
      () =>
        [
          {
            principalId: 'player-a',
            awardId: 'winner',
            tier: 'gold',
            rewards: [{ rewardId: 'coin', asset: 'coin', quantity: 2 }],
          },
        ] as const,
    );
    const settle = vi.fn(async () => ({ settled: true }));
    const registry = new GameCapabilityRegistry();
    registry.register(brassRegistration({ consume, createAwards, settle }));
    const awards = new MemoryAwardStore({ now: () => 100 });
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    const service = new GameCapabilityService({
      registry,
      awards,
      entitlements,
    });

    const outcome = await service.complete(completion());
    expect(outcome).toMatchObject({
      gameId: 'brass',
      releaseId: 'brass-v1',
      sessionId: 'session-1',
      resultRevision: 1,
      achievementProcessed: true,
      rating: { settled: true },
    });
    expect(outcome.rewards[0]).toMatchObject({
      principalId: 'player-a',
      tier: 'gold',
      sourceRecordId: expect.stringContaining(
        'revision:1:definition:brass-rewards-v1',
      ),
    });
    expect(consumed[0]?.sourceRecordId).toContain(
      'revision:1:definition:brass-achievements-v1',
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId: 'brass',
        policyVersion: 'brass-rating-v1',
        progressionPolicyVersion: 'brass-progression-v1',
      }),
    );
    expect(
      await entitlements.getBalance({
        namespace: 'brass',
        principalId: 'player-a',
        asset: 'coin',
      }),
    ).toMatchObject({ granted: 2, available: 2 });

    await service.complete(completion());
    expect(
      await entitlements.getBalance({
        namespace: 'brass',
        principalId: 'player-a',
        asset: 'coin',
      }),
    ).toMatchObject({ granted: 2, available: 2 });
  });

  it('keeps wallets isolated by game namespace and composes profile DTOs', async () => {
    const registry = new GameCapabilityRegistry();
    registry.register(walletRegistration('brass', 'brass-v1'));
    registry.register(walletRegistration('seti', 'seti-v1'));
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    await entitlements.grant({
      namespace: 'brass',
      sourceRecordId: 'brass:session:1',
      principalId: 'player-a',
      asset: 'coin',
      quantity: 2,
    });
    await entitlements.grant({
      namespace: 'seti',
      sourceRecordId: 'seti:session:1',
      principalId: 'player-a',
      asset: 'coin',
      quantity: 9,
    });
    const service = new GameCapabilityService({ registry, entitlements });
    await expect(
      service.getWallet('brass', 'brass-v1', 'player-a'),
    ).resolves.toMatchObject({
      assets: [{ asset: 'coin', granted: 2 }],
    });
    await expect(
      service.getWallet('seti', 'seti-v1', 'player-a'),
    ).resolves.toMatchObject({
      assets: [{ asset: 'coin', granted: 9 }],
    });
  });

  it('validates release-pinned statistics operation and payload schemas', async () => {
    const requestSchema = {
      name: 'statistics.query',
      version: 1,
      maxBytes: 1024,
      schema: {
        type: 'object' as const,
        properties: { range: { type: 'string' as const } },
        required: ['range'],
        additionalProperties: false,
      },
    };
    const responseSchema = {
      name: 'statistics.response',
      version: 1,
      maxBytes: 1024,
      schema: {
        type: 'object' as const,
        properties: { total: { type: 'integer' as const, minimum: 0 } },
        required: ['total'],
        additionalProperties: false,
      },
    };
    const query = vi.fn(async (_request: GameStatisticsServiceRequest) => ({
      operation: 'personalSummary',
      audience: 'self' as const,
      payload: { total: 3 },
    }));
    const registry = new GameCapabilityRegistry();
    registry.register({
      metadata: {
        gameId: 'seti',
        name: 'SETI',
        description: 'Statistics fixture',
        themeId: 'seti',
      },
      releaseId: 'seti-v1',
      capabilities: ['statistics'],
      policyVersions: [],
      assets: [],
      statistics: {
        description: {
          protocolVersion: 1,
          operations: [
            {
              key: 'personalSummary',
              audience: 'self',
              requestSchema,
              responseSchema,
            },
          ],
        },
        query,
      },
    });
    const service = new GameCapabilityService({ registry });
    const request: GameStatisticsServiceRequest = {
      protocolVersion: 1,
      route: {
        gameId: 'seti',
        releaseId: 'seti-v1',
        backendBindingId: 'seti-backend',
        storageBindingId: 'seti-storage',
        ownershipEpoch: 'seti-epoch',
      },
      operation: 'personalSummary',
      audience: 'self',
      accessContext: {
        principalId: 'player-a',
        authEpoch: 'epoch-1',
        scopes: ['statistics:read'],
      },
      query: { range: '30d' },
    };
    await expect(
      service.queryStatistics('seti', 'seti-v1', request),
    ).resolves.toEqual({
      operation: 'personalSummary',
      audience: 'self',
      payload: { total: 3 },
    });
    await expect(
      service.queryStatistics('seti', 'seti-v1', {
        ...request,
        query: { range: 30 },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'SCHEMA_VALIDATION_FAILED' },
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
