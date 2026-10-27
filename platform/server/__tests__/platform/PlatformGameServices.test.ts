import type {
  GameResult,
  GameServiceDescription,
  JsonValue,
  MatchAdmission,
  SessionRoute,
} from '@board-game/contracts';
import type { InboxEnvelope, RatingPolicy } from '@board-game/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  type GameCapabilityRegistration,
  type GameCompletionInput,
  type GameRatingWriteRequest,
} from '@/platform/capabilities/index.js';
import type {
  PlatformApplicationRuntime,
  RemoteDailyChallengeReleaseInput,
} from '@/platform/PlatformApplicationRuntime.js';
import { PlatformGameServices } from '@/platform/PlatformGameServices.js';

const participants = [
  { principalId: 'player-a', seatId: 'seat-a' },
  { principalId: 'player-b', seatId: 'seat-b' },
] as const;

type CapturedConsumer = {
  readonly name: string;
  readonly handler: (envelope: InboxEnvelope) => Promise<void>;
  readonly gameId?: string;
};

function metadata() {
  return {
    gameId: 'brass',
    name: 'BRASS',
    description: 'Industrial network building.',
    themeId: 'brass',
  } as const;
}

function registration(
  releaseId: string,
  settle: (request: GameRatingWriteRequest) => Promise<JsonValue | null>,
): GameCapabilityRegistration {
  const policyVersion = `rating-${releaseId}`;
  const progressionPolicyVersion = `progression-${releaseId}`;
  return {
    metadata: metadata(),
    releaseId,
    capabilities: ['rating'],
    policyVersions: [
      { kind: 'rating', version: policyVersion },
      { kind: 'progression', version: progressionPolicyVersion },
    ],
    assets: [],
    rating: {
      policyVersion,
      progressionPolicyVersion,
      settle,
    },
  };
}

function ratingPolicy(releaseId: string): RatingPolicy {
  return {
    policyVersion: `rating-${releaseId}`,
    progressionPolicyVersion: `progression-${releaseId}`,
    initialState: () => ({}),
    calculate: () => [],
  };
}

function completed(
  releaseId: string,
  includeBot = false,
  modeId = 'ranked-multiplayer',
): {
  admission: MatchAdmission;
  completion: GameCompletionInput;
  envelope: InboxEnvelope;
} {
  const route: SessionRoute = {
    gameId: 'brass',
    modeId,
    sessionId: `session-${releaseId}`,
    releaseId,
    backendBindingId: 'brass-backend',
    storageBindingId: 'brass-storage',
    ownershipEpoch: 'epoch-1',
  };
  const bot = {
    principalId: `bot:${releaseId}:one`,
    seatId: `bot:${releaseId}:seat:one`,
    controller: 'bot' as const,
  };
  const completionParticipants = includeBot
    ? [...participants, bot]
    : participants;
  const rankGroups = [
    { teams: [{ participantIds: ['player-a'], score: 20 }] },
    { teams: [{ participantIds: ['player-b'], score: 10 }] },
  ];
  if (includeBot)
    rankGroups.push({
      teams: [{ participantIds: [bot.principalId], score: 0 }],
    });
  const result: GameResult = {
    kind: 'competitive',
    rankGroups,
  };
  const admission: MatchAdmission = {
    id: `admission-${releaseId}`,
    route,
    participants: completionParticipants,
    visibility: 'private',
    rating: {
      poolId: '*',
      policyVersion: `rating-${releaseId}`,
      progressionPolicyVersion: `progression-${releaseId}`,
      seasonId: null,
    },
    validityPolicyVersion: 'brass-validity-v1',
    createdAt: 1,
  };
  return {
    admission,
    completion: {
      route,
      admission,
      result,
      resultRevision: 1,
      occurredAt: 100,
    },
    envelope: {
      envelopeKey: `host:completed-${releaseId}`,
      producerId: 'brass-host',
      eventId: `completed-${releaseId}`,
      sessionId: route.sessionId,
      kind: 'SessionCompleted',
      schemaVersion: 1,
      sourceRelease: releaseId,
      payload: { result, resultRevision: 1, endedAt: 100 },
      digest: `digest-${releaseId}`,
      receivedAt: 100,
    },
  };
}

function testPlatform() {
  const messageWrites: unknown[] = [];
  const accountChanges = vi.fn();
  const consumers: CapturedConsumer[] = [];
  const setRemoteDailyChallengeReleaseHook = vi.fn();
  const statisticsQuery = vi.fn(
    async (): Promise<{
      rows: Record<string, string>[];
    }> => ({
      rows: [
        {
          total_sessions: '9',
          active_sessions: '2',
          paused_sessions: '1',
          suspended_sessions: '1',
          completed_sessions: '4',
          cancelled_sessions: '1',
        },
      ],
    }),
  );
  const admissionStore = {
    getAdmission: vi.fn(),
  };
  const db = {
    insert: () => ({
      values: (value: unknown) => {
        messageWrites.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: 'message-id' }],
          }),
        };
      },
    }),
  } as unknown as NodePgDatabase;
  const currentGame = {
    releaseId: 'current-release',
    metadata: metadata(),
  };
  const registerFactConsumer = vi.fn(
    (
      name: string,
      handler: (envelope: InboxEnvelope) => Promise<void>,
      gameId?: string,
    ) => {
      consumers.push({ name, handler, ...(gameId ? { gameId } : {}) });
    },
  );
  const platform = {
    options: { db, pool: { query: statisticsQuery } as unknown as Pool },
    admissionStore,
    game: vi.fn(() => currentGame),
    releaseGame: vi.fn((_gameId: string, releaseId: string) => ({
      ...currentGame,
      releaseId,
    })),
    registerRecoveryHook: vi.fn(),
    setRemoteDailyChallengeReleaseHook,
    registerFactConsumer,
    notifyAccountsChanged: accountChanges,
  } as unknown as PlatformApplicationRuntime;
  return {
    platform,
    services: new PlatformGameServices(platform),
    consumers,
    admissionStore,
    messageWrites,
    accountChanges,
    statisticsQuery,
    setRemoteDailyChallengeReleaseHook,
  };
}

describe('PlatformGameServices retained releases', () => {
  it('registers approved remote daily metadata without RPC and uses the current exact-release backend', async () => {
    const fixture = testPlatform();
    const oldRpc = vi.fn(async () => ({
      operation: 'prepare' as const,
      seed: 'old-endpoint',
      setup: {},
    }));
    const newRpc = vi.fn(async () => ({
      operation: 'prepare' as const,
      seed: 'new-endpoint',
      setup: {},
    }));
    let backend = { dailyChallenge: oldRpc };
    vi.mocked(fixture.platform.releaseGame).mockImplementation(
      (_gameId, releaseId) =>
        ({ metadata: metadata(), releaseId, backend }) as never,
    );
    const hook = fixture.setRemoteDailyChallengeReleaseHook.mock
      .calls[0]?.[0] as (input: RemoteDailyChallengeReleaseInput) => void;
    const input: RemoteDailyChallengeReleaseInput = {
      gameId: 'brass',
      releaseId: 'current-release',
      approvedModes: [],
      service: {
        schemaVersion: 1,
        platformId: 'daily-platform',
        gameId: 'brass',
        releaseId: 'current-release',
        backendBindingId: 'brass-backend',
        storageBindingId: 'brass-storage',
        ownershipEpoch: 'epoch-1',
        metadata: metadata(),
        modes: [
          {
            id: 'daily',
            entry: 'direct-solo',
            minPlayers: 1,
            maxPlayers: 1,
            history: 'summary-and-replay',
            platformRating: false,
            concurrency: 'revision',
          },
        ],
        setupSchema: {
          name: 'daily-setup',
          version: 1,
          schema: { type: 'object' },
        },
        dailyChallenge: {
          modeId: 'daily',
          playerCount: 1,
          settingsSchema: {
            name: 'daily-settings',
            version: 1,
            schema: { type: 'object' },
          },
          defaultSettings: {},
          operations: [
            'validateSettings',
            'prepare',
            'validateSetup',
            'participants',
            'score',
          ],
        },
      } satisfies GameServiceDescription,
    };
    hook(input);
    expect(
      await fixture.services.dailyChallenges.getRegistration('brass'),
    ).toBeNull();
    hook({ ...input, approvedModes: ['daily'] });
    hook({ ...input, approvedModes: ['daily'] });
    expect(oldRpc).not.toHaveBeenCalled();
    expect(fixture.consumers).toHaveLength(1);
    const daily =
      await fixture.services.dailyChallenges.getRegistration('brass');
    await expect(daily?.prepare?.('2026-10-27', {})).resolves.toMatchObject({
      seed: 'old-endpoint',
    });
    backend = { dailyChallenge: newRpc };
    await expect(daily?.prepare?.('2026-10-28', {})).resolves.toMatchObject({
      seed: 'new-endpoint',
    });
    expect(newRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ releaseId: 'current-release' }),
      }),
    );
  });

  it('provides bounded directory statistics when a game omits a custom adapter', async () => {
    const fixture = testPlatform();
    fixture.services.register(registration('current-release', vi.fn()));

    await expect(
      fixture.services.capabilities.getStatistics('brass', 'current-release'),
    ).resolves.toEqual({
      gameId: 'brass',
      releaseId: 'current-release',
      totalSessions: 9,
      activeSessions: 2,
      pausedSessions: 1,
      suspendedSessions: 1,
      completedSessions: 4,
      cancelledSessions: 1,
    });
    expect(fixture.statisticsQuery).toHaveBeenCalledWith(
      expect.stringContaining('count(*) FILTER'),
      ['brass', 'current-release'],
    );
  });

  it('adds account statistics only when the account has played sessions', async () => {
    const fixture = testPlatform();
    fixture.statisticsQuery
      .mockResolvedValueOnce({
        rows: [
          {
            total_sessions: '9',
            active_sessions: '2',
            paused_sessions: '1',
            suspended_sessions: '1',
            completed_sessions: '4',
            cancelled_sessions: '1',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            played_sessions: '2',
            completed_sessions: '1',
            wins: '1',
          },
        ],
      });
    fixture.services.register(registration('current-release', vi.fn()));

    await expect(
      fixture.services.capabilities.getStatistics(
        'brass',
        'current-release',
        'player-a',
      ),
    ).resolves.toEqual({
      gameId: 'brass',
      releaseId: 'current-release',
      totalSessions: 9,
      activeSessions: 2,
      pausedSessions: 1,
      suspendedSessions: 1,
      completedSessions: 4,
      cancelledSessions: 1,
      playedSessions: 2,
      playerCompletedSessions: 1,
      wins: 1,
    });
    expect(fixture.statisticsQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('jsonb_array_elements(participants)'),
      ['brass', 'current-release', 'player-a'],
    );
  });

  it('preserves a game-specific statistics adapter', async () => {
    const fixture = testPlatform();
    fixture.services.register({
      ...registration('current-release', vi.fn()),
      statistics: { read: async () => ({ customMetric: 7 }) },
    });

    await expect(
      fixture.services.capabilities.getStatistics('brass', 'current-release'),
    ).resolves.toEqual({ customMetric: 7 });
    expect(fixture.statisticsQuery).not.toHaveBeenCalled();
  });

  it('skips account settlement for automated rosters but notifies human accounts', async () => {
    const currentSettle = vi.fn(async () => ({ release: 'current' }));
    const retainedSettle = vi.fn(async () => ({ release: 'retained' }));
    const fixture = testPlatform();
    const current = registration('current-release', currentSettle);
    fixture.services.register(current, {
      ratingPolicies: [ratingPolicy('current-release')],
      settleCompletions: true,
      messages: {
        completion: () => ({
          title: { kind: 'literal', text: 'BRASS complete' },
          body: { kind: 'literal', text: 'The game is complete.' },
          action: { label: 'View game', href: '/game/session/end' },
        }),
      },
      completionMessage: {
        templateId: 'completion',
        payload: (completion) => ({
          gameId: completion.route.gameId,
          releaseId: completion.route.releaseId,
        }),
      },
    });
    fixture.services.registerRetainedRelease(
      registration('retained-release', retainedSettle),
      [ratingPolicy('retained-release')],
    );

    const completedGame = completed('retained-release', true);
    fixture.admissionStore.getAdmission.mockResolvedValue(
      completedGame.admission,
    );
    expect(fixture.consumers).toHaveLength(1);
    await fixture.consumers[0].handler(completedGame.envelope);

    expect(retainedSettle).not.toHaveBeenCalled();
    expect(currentSettle).not.toHaveBeenCalled();
    expect(fixture.messageWrites).toHaveLength(2);
    expect(fixture.accountChanges).toHaveBeenCalledTimes(2);
    expect(fixture.accountChanges).toHaveBeenNthCalledWith(1, ['player-a']);
    expect(fixture.accountChanges).toHaveBeenNthCalledWith(2, ['player-b']);
    expect(
      fixture.services.registry.resolve('brass', 'retained-release'),
    ).toBeDefined();
  });

  it('skips every shared settlement ledger for a daily challenge mode', async () => {
    const settle = vi.fn(async () => ({ release: 'current' }));
    const fixture = testPlatform();
    fixture.services.register(
      {
        ...registration('current-release', settle),
        dailyChallenge: {
          gameId: 'brass',
          releaseId: 'current-release',
          modeId: 'daily-challenge',
          playerCount: 2,
          settings: { defaults: {}, validate: () => undefined },
          seedForDate: (date) => date,
          setupForDate: () => ({}),
          validateSetup: () => undefined,
          participants: () => participants,
          score: () => ({ score: 1 }),
        },
      },
      {
        ratingPolicies: [ratingPolicy('current-release')],
        settleCompletions: true,
      },
    );
    const completedGame = completed(
      'current-release',
      false,
      'daily-challenge',
    );
    fixture.admissionStore.getAdmission.mockResolvedValue(
      completedGame.admission,
    );
    const consumer = fixture.consumers.find((item) =>
      item.name.includes(':capabilities:'),
    );
    if (!consumer) throw new Error('CAPABILITY_CONSUMER_MISSING');

    await consumer.handler(completedGame.envelope);

    expect(settle).not.toHaveBeenCalled();
  });

  it('does not settle a daily completion from a retained release', async () => {
    const settle = vi.fn(async () => ({ release: 'current' }));
    const fixture = testPlatform();
    fixture.services.register(registration('current-release', settle), {
      ratingPolicies: [ratingPolicy('current-release')],
      settleCompletions: true,
    });
    fixture.services.registerRetainedRelease({
      ...registration('retained-release', vi.fn()),
      dailyChallenge: {
        gameId: 'brass',
        releaseId: 'retained-release',
        modeId: 'daily-challenge',
        playerCount: 2,
        settings: { defaults: {}, validate: () => undefined },
        seedForDate: (date) => date,
        setupForDate: () => ({}),
        validateSetup: () => undefined,
        participants: () => participants,
        score: () => ({ score: 1 }),
      },
    });
    const completedGame = completed(
      'retained-release',
      false,
      'daily-challenge',
    );
    fixture.admissionStore.getAdmission.mockResolvedValue(
      completedGame.admission,
    );

    await fixture.consumers[0].handler(completedGame.envelope);

    expect(settle).not.toHaveBeenCalled();
  });

  it('fails closed before retained registration and rejects policy duplicates without mutating the registry', async () => {
    const currentSettle = vi.fn(async () => ({ release: 'current' }));
    const fixture = testPlatform();
    fixture.services.register(registration('current-release', currentSettle), {
      ratingPolicies: [ratingPolicy('current-release')],
      settleCompletions: true,
    });
    const completedGame = completed('retained-release');
    await expect(
      fixture.services.capabilities.complete(completedGame.completion),
    ).rejects.toThrow('platform.game.registration.missing');

    expect(() =>
      fixture.services.registerRetainedRelease(
        registration(
          'retained-release',
          vi.fn(async () => null),
        ),
        [ratingPolicy('current-release'), ratingPolicy('current-release')],
      ),
    ).toThrow('platform.game.rating_policy_registered');
    expect(
      fixture.services.registry.get('brass', 'retained-release'),
    ).toBeNull();

    fixture.services.registerRetainedRelease(
      registration(
        'retained-release',
        vi.fn(async () => null),
      ),
      [ratingPolicy('retained-release')],
    );
    expect(
      fixture.services.registry.get('brass', 'retained-release'),
    ).not.toBeNull();
  });

  it('deduplicates a hotseat completion notification by controlling account and skips settlement', async () => {
    const settle = vi.fn(async () => ({ release: 'current' }));
    const fixture = testPlatform();
    fixture.services.register(registration('current-release', settle), {
      ratingPolicies: [ratingPolicy('current-release')],
      settleCompletions: true,
      messages: {
        completion: () => ({
          title: { kind: 'literal', text: 'BRASS complete' },
          body: { kind: 'literal', text: 'The game is complete.' },
          action: { label: 'View game', href: '/game/session/end' },
        }),
      },
      completionMessage: {
        templateId: 'completion',
        payload: (completion) => ({
          gameId: completion.route.gameId,
          releaseId: completion.route.releaseId,
        }),
      },
    });
    const base = completed('current-release');
    const hotseat = {
      principalId: 'hotseat:brass:one',
      seatId: 'hotseat:brass:seat:one',
      controller: 'hotseat' as const,
      controlledBy: 'player-a',
    };
    const admission = {
      ...base.admission,
      participants: [...base.admission.participants, hotseat],
    };
    const result = {
      kind: 'competitive' as const,
      rankGroups: [
        { teams: [{ participantIds: ['player-a'], score: 20 }] },
        { teams: [{ participantIds: ['player-b'], score: 10 }] },
        { teams: [{ participantIds: [hotseat.principalId], score: 0 }] },
      ],
    };
    const envelope = {
      ...base.envelope,
      payload: { result, resultRevision: 1, endedAt: 100 },
    };
    fixture.admissionStore.getAdmission.mockResolvedValue(admission);
    await fixture.consumers[0]?.handler(envelope);

    expect(settle).not.toHaveBeenCalled();
    expect(fixture.messageWrites).toHaveLength(2);
    expect(
      fixture.messageWrites.map(
        (value) => (value as { recipientUserId: string }).recipientUserId,
      ),
    ).toEqual(['player-a', 'player-b']);
  });

  it('requires the current game capability before retaining an older release', () => {
    const fixture = testPlatform();
    expect(() =>
      fixture.services.registerRetainedRelease(
        registration(
          'retained-release',
          vi.fn(async () => null),
        ),
      ),
    ).toThrow('platform.game.registration.current_missing');
    expect(fixture.services.registry.list()).toHaveLength(0);
  });
});
