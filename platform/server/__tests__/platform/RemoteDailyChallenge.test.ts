import type {
  BackendPort,
  GameServiceDescription,
  MatchAdmission,
  Participant,
} from '@board-game/contracts';
import { BackendTransportError } from '@board-game/host';
import { describe, expect, it, vi } from 'vitest';
import { createRemoteDailyChallengeRegistration } from '@/platform/daily-challenge/remote.js';
import { PlatformDailyChallengeService } from '@/platform/daily-challenge/service.js';

const route = {
  gameId: 'remote-game',
  modeId: 'daily',
  sessionId: 'daily-session',
  releaseId: 'remote-v1',
  backendBindingId: 'remote-backend',
  storageBindingId: 'remote-storage',
  ownershipEpoch: 'remote-epoch',
} as const;

const description = {
  schemaVersion: 1,
  platformId: 'platform',
  gameId: route.gameId,
  releaseId: route.releaseId,
  backendBindingId: route.backendBindingId,
  storageBindingId: route.storageBindingId,
  ownershipEpoch: route.ownershipEpoch,
  metadata: {
    gameId: route.gameId,
    name: 'Remote game',
    description: 'Remote game fixture.',
    themeId: 'remote',
  },
  modes: [
    {
      id: route.modeId,
      entry: 'room' as const,
      minPlayers: 2,
      maxPlayers: 2,
      history: 'summary-and-replay' as const,
      platformRating: false,
      concurrency: 'revision' as const,
    },
  ],
  setupSchema: {
    name: 'setup',
    version: 1,
    schema: { type: 'object' as const },
  },
  dailyChallenge: {
    modeId: route.modeId,
    playerCount: 2,
    settingsSchema: {
      name: 'daily.settings',
      version: 1,
      schema: {
        type: 'object' as const,
        properties: { preset: { type: 'string' as const } },
        required: ['preset'],
        additionalProperties: false,
      },
    },
    defaultSettings: { preset: 'standard' },
    operations: [
      'validateSettings',
      'publicSettings',
      'prepare',
      'validateSetup',
      'participants',
      'score',
    ] as const,
  },
} as unknown as GameServiceDescription;

const participants: readonly Participant[] = [
  { principalId: 'player-1', seatId: 'seat-1' },
  { principalId: 'player-2', seatId: 'seat-2' },
];

describe('remote daily challenge adapter', () => {
  it('does not call the remote service while registering metadata', () => {
    const backend = {
      dailyChallenge: vi.fn(),
    } as unknown as Pick<BackendPort, 'dailyChallenge'>;
    const registration = createRemoteDailyChallengeRegistration({
      backend,
      description,
    });
    const platform = {
      game: vi.fn(() => ({ releaseId: route.releaseId })),
      registerFactConsumer: vi.fn(),
      registerRecoveryHook: vi.fn(),
    } as never;
    const service = new PlatformDailyChallengeService(platform, {} as never);

    service.register(registration);

    expect(backend.dailyChallenge).not.toHaveBeenCalled();
  });

  it('maps every registration hook to the authenticated backend RPC', async () => {
    const calls: string[] = [];
    const backend = {
      dailyChallenge: vi.fn(async (request) => {
        calls.push(request.operation);
        switch (request.operation) {
          case 'validateSettings':
          case 'validateSetup':
            return { operation: request.operation, accepted: true };
          case 'publicSettings':
            return {
              operation: request.operation,
              publicSettings: { preset: 'standard' },
            };
          case 'prepare':
            return {
              operation: request.operation,
              seed: `seed:${request.challengeDate}`,
              setup: { playerCount: 2 },
              publicSettings: { rivalDifficulty: 3 },
            };
          case 'participants':
            return { operation: request.operation, participants };
          case 'score':
            return { operation: request.operation, score: { score: 7 } };
        }
      }),
    } as unknown as Pick<BackendPort, 'dailyChallenge'>;
    const registration = createRemoteDailyChallengeRegistration({
      backend,
      description,
    });

    await registration.settings.validateAsync?.({ preset: 'standard' });
    await expect(
      registration.publicSettings?.({ preset: 'standard' }),
    ).resolves.toEqual({ preset: 'standard' });
    await expect(
      registration.prepare?.('2026-10-26', { preset: 'standard' }),
    ).resolves.toEqual({
      seed: 'seed:2026-10-26',
      setup: { playerCount: 2 },
      publicSettings: { rivalDifficulty: 3 },
    });
    await registration.validateSetup({ playerCount: 2 });
    await expect(
      registration.participants({
        principalId: 'player-1',
        attemptId: 'attempt-1',
        sessionId: route.sessionId,
        challengeDate: '2026-10-26',
        setup: { playerCount: 2 },
        settings: { preset: 'standard' },
      }),
    ).resolves.toEqual(participants);
    const admission: MatchAdmission = {
      id: 'admission-1',
      route,
      participants,
      visibility: 'private',
      rating: null,
      validityPolicyVersion: 'daily-v1',
      createdAt: 1,
    };
    await expect(
      registration.score(
        { kind: 'solo', participantIds: ['player-1'], outcome: 'completed' },
        admission,
      ),
    ).resolves.toEqual({ score: 7 });
    expect(calls).toEqual([
      'validateSettings',
      'publicSettings',
      'prepare',
      'validateSetup',
      'participants',
      'score',
    ]);
    expect(backend.dailyChallenge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: 'score',
        route,
      }),
    );
  });

  it('maps remote network and timeout failures to retryable unavailability', async () => {
    const backend = {
      dailyChallenge: vi
        .fn()
        .mockRejectedValueOnce(new BackendTransportError('NETWORK'))
        .mockRejectedValueOnce(new BackendTransportError('TIMEOUT')),
    } as unknown as Pick<BackendPort, 'dailyChallenge'>;
    const registration = createRemoteDailyChallengeRegistration({
      backend,
      description,
    });

    await expect(
      registration.settings.validateAsync?.({ preset: 'standard' }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_READY',
        messageKey: 'platform.daily.unavailable',
        retryable: true,
      },
    });
    await expect(
      registration.prepare?.('2026-10-26', { preset: 'standard' }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_READY',
        messageKey: 'platform.daily.unavailable',
        retryable: true,
      },
    });
  });
});
