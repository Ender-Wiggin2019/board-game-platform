import type {
  GameResult,
  GameServiceDescription,
  MatchAdmission,
  Participant,
  PublicStartStatus,
  ReleaseManifest,
} from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import { PlatformDailyChallengeService } from '@/platform/daily-challenge/service.js';
import type {
  DailyChallengeAttemptRecord,
  DailyChallengeRegistration,
  DailyChallengeSettingsRecord,
  DailyChallengeSnapshotRecord,
} from '@/platform/daily-challenge/types.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import {
  MemoryReleaseRegistryStore,
  ReleaseRegistry,
} from '@/platform/releases/index.js';

const participants: readonly Participant[] = [
  { principalId: 'player-1', seatId: 'seat-1' },
  {
    principalId: 'player-2',
    seatId: 'seat-2',
    controller: 'ai',
    controllerId: 'daily-test',
  },
];

const status: PublicStartStatus = {
  startId: 'start-1',
  sessionId: 'session-1',
  roomId: 'daily:brass:r1:2026-10-26:player-1',
  state: 'active',
  route: {
    gameId: 'brass',
    modeId: 'daily',
    sessionId: 'session-1',
    releaseId: 'r1',
    backendBindingId: 'brass-backend',
    storageBindingId: 'brass-storage',
    ownershipEpoch: 'brass-epoch',
  },
};

const dailyMode = {
  id: 'daily',
  entry: 'room' as const,
  minPlayers: 2,
  maxPlayers: 2,
  history: 'summary-and-replay' as const,
  platformRating: false,
  concurrency: 'revision' as const,
};

function dailyReleaseDefinition(
  releaseId: string,
  backendBindingId: string,
  storageBindingId: string,
  ownershipEpoch: string,
): {
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
} {
  const service: GameServiceDescription = {
    schemaVersion: 1,
    platformId: 'daily-platform',
    gameId: 'brass',
    releaseId,
    backendBindingId,
    storageBindingId,
    ownershipEpoch,
    metadata: {
      gameId: 'brass',
      name: 'Brass',
      description: 'Daily release fixture.',
      themeId: 'brass',
    },
    modes: [dailyMode],
    setupSchema: {
      name: 'daily.setup',
      version: 1,
      schema: { type: 'object' },
    },
    dailyChallenge: {
      modeId: 'daily',
      playerCount: 2,
      settingsSchema: {
        name: 'daily.settings',
        version: 1,
        schema: {
          type: 'object',
          properties: { preset: { type: 'string' } },
          required: ['preset'],
          additionalProperties: false,
        },
      },
      defaultSettings: { preset: 'standard' },
      operations: [
        'validateSettings',
        'prepare',
        'validateSetup',
        'participants',
        'score',
      ],
    },
  };
  return {
    service,
    manifest: {
      manifestVersion: '1.0',
      gameId: 'brass',
      releaseId,
      displayVersion: releaseId,
      publisherId: 'daily-test',
      integration: {
        profile: 'legacy-service-v1',
        protocolMajor: 1,
        requiredFeatures: [],
      },
      artifacts: {
        client: {
          artifactId: `${releaseId}-client`,
          digest: `sha256:${'1'.repeat(64)}`,
        },
        server: {
          artifactId: `${releaseId}-server`,
          digest: `sha256:${'2'.repeat(64)}`,
        },
        publicAssets: {
          artifactId: `${releaseId}-assets`,
          digest: `sha256:${'3'.repeat(64)}`,
        },
      },
      versions: {
        ruleset: '1',
        content: '1',
        stateSchema: 1,
        viewSchema: 1,
        commandSchema: 1,
        resultSchema: 1,
        eventSchema: 1,
      },
      capabilities: { minPlayers: 2, maxPlayers: 2, features: [] },
      modes: [dailyMode],
      presentation: {
        mount: 'platform-route',
        layoutProfile: 'daily',
        locales: ['en'],
      },
      budgetProfile: 'daily-test',
    },
  };
}

async function installReadyDailyRelease(
  registry: ReleaseRegistry,
  releaseId: string,
  backendBindingId: string,
  storageBindingId: string,
  ownershipEpoch: string,
): Promise<void> {
  const definition = dailyReleaseDefinition(
    releaseId,
    backendBindingId,
    storageBindingId,
    ownershipEpoch,
  );
  const release = await registry.registerRelease({
    platformId: 'daily-platform',
    ...definition,
    approvedFeatures: [],
    approvedModes: ['daily'],
  });
  await registry.registerBinding({
    platformId: 'daily-platform',
    gameId: 'brass',
    releaseId,
    backendBindingId,
    storageBindingId,
    ownershipEpoch,
    deployment: 'external',
    controlEndpoint: `control-${releaseId}`,
    playerEndpoint: `player-${releaseId}`,
    clientArtifactBaseUrl: `assets-${releaseId}`,
    serviceCredentialRef: `credential-${releaseId}`,
  });
  await registry.readyBinding('daily-platform', backendBindingId, {
    probe: async ({ binding }) => ({
      probeId: `probe-${releaseId}`,
      checkedAt: 1,
      protocol: {
        major: 1,
        minor: 0,
        serviceDigest: release.serviceDigest,
        service: release.service,
      },
      storage: {
        bindingId: binding.storageBindingId,
        schemaVersion: 'storage-v1',
      },
    }),
  });
}

function registration(): DailyChallengeRegistration {
  return {
    gameId: 'brass',
    releaseId: 'r1',
    modeId: 'daily',
    playerCount: participants.length,
    settings: {
      defaults: { preset: 'standard' },
      validate: (settings) => {
        const record =
          settings && typeof settings === 'object' && !Array.isArray(settings)
            ? (settings as Record<string, unknown>)
            : null;
        if (
          !record ||
          !Object.hasOwn(record, 'preset') ||
          record.preset !== 'standard'
        )
          throw new Error('invalid settings');
      },
    },
    seedForDate: (date) => `seed:${date}`,
    setupForDate: () => ({ target: 4 }),
    validateSetup: (setup) => {
      const record =
        setup && typeof setup === 'object' && !Array.isArray(setup)
          ? (setup as Record<string, unknown>)
          : null;
      if (!record || !Object.hasOwn(record, 'target') || record.target !== 4)
        throw new Error('invalid setup');
    },
    participants: () => participants,
    score: (result: GameResult) =>
      result.kind === 'competitive' ? { score: 7, result } : null,
  };
}

function snapshot(): DailyChallengeSnapshotRecord {
  return {
    gameId: 'brass',
    releaseId: 'r1',
    modeId: 'daily',
    challengeDate: '2026-10-26',
    seed: 'seed:2026-10-26',
    setup: { target: 4 },
    settings: { preset: 'standard' },
    settingsRevision: 1,
    createdAt: '2026-10-26T00:00:00.000Z',
  };
}

function attempt(overrides: Partial<DailyChallengeAttemptRecord> = {}) {
  return {
    attemptId: 'attempt-1',
    gameId: 'brass',
    releaseId: 'r1',
    modeId: 'daily',
    challengeDate: '2026-10-26',
    principalId: 'player-1',
    roomId: status.roomId,
    requestId: status.roomId,
    attemptNumber: 1,
    publicationState: 'pending' as const,
    sessionId: status.sessionId,
    participants,
    status: 'starting' as const,
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...overrides,
  } satisfies DailyChallengeAttemptRecord;
}

function admission(): MatchAdmission {
  return {
    id: 'daily-admission-1',
    route: status.route,
    participants,
    visibility: 'public',
    rating: null,
    validityPolicyVersion: 'daily-validity-v1',
    createdAt: 1,
  };
}

function factEnvelope(
  kind: 'SessionCompleted' | 'SessionControlled',
  payload: Record<string, unknown>,
  overrides: Partial<{
    aggregateSequence: number;
    occurredAt: number;
  }> = {},
) {
  return {
    envelopeKey: `daily-fact-${kind}`,
    producerId: `game:${status.route.gameId}:session:${status.sessionId}`,
    eventId: `daily-event-${kind}`,
    sessionId: status.sessionId,
    kind,
    schemaVersion: 1,
    sourceRelease: status.route.releaseId,
    ...(overrides.aggregateSequence === undefined
      ? {}
      : { aggregateSequence: overrides.aggregateSequence }),
    ...(overrides.occurredAt === undefined
      ? {}
      : { occurredAt: overrides.occurredAt }),
    payload,
    digest: `sha256:${'1'.repeat(64)}`,
    receivedAt: 200,
  } as const;
}

function platformFixture() {
  const registerFactConsumer = vi.fn();
  const publicNames = vi.fn(
    async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `Name ${id}`])),
  );
  const getStart = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue(status);
  const recoverStart = vi.fn().mockResolvedValue(status);
  const createMatchedSession = vi.fn().mockResolvedValue(status);
  const platform = {
    game: vi.fn(() => ({ releaseId: 'r1' })),
    registerFactConsumer,
    registerRecoveryHook: vi.fn(),
    accountIdentity: () => ({
      publicNames,
    }),
    admissionStore: {
      getStart,
      getAdmission: vi.fn(),
    },
    admission: {
      createMatchedSession,
      recoverStart,
    },
  } as unknown as PlatformApplicationRuntime;
  const store = {
    finalizeDue: vi.fn().mockResolvedValue(undefined),
    publishDue: vi.fn().mockResolvedValue([]),
    listAttempts: vi.fn().mockResolvedValue([]),
    listHistoryDates: vi.fn().mockResolvedValue(['2026-10-26']),
    listLeaderboards: vi.fn().mockResolvedValue({
      date: '2026-10-26',
      firstLook: { date: '2026-10-26', top: [] },
      overall: { date: '2026-10-26', top: [] },
      grinder: { date: '2026-10-26', top: [] },
    }),
    getAttemptByRequest: vi.fn().mockResolvedValue(null),
    getActiveAttempt: vi.fn().mockResolvedValue(null),
    getAttemptBySession: vi.fn().mockResolvedValue(null),
    getReplayEligibility: vi.fn().mockResolvedValue(null),
    publishAttempt: vi.fn(),
    abandonAttempt: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue(null),
    getSettings: vi
      .fn<
        (
          gameId: string,
          releaseId: string,
        ) => Promise<DailyChallengeSettingsRecord | null>
      >()
      .mockResolvedValue(null),
    ensureSnapshot: vi.fn().mockResolvedValue(snapshot()),
    getAttemptByPrincipal: vi.fn().mockResolvedValue(null),
    reserveAttempt: vi
      .fn()
      .mockResolvedValueOnce(attempt())
      .mockResolvedValue(
        attempt({
          status: 'started',
          startedAt: '2026-10-26T00:00:00.000Z',
        }),
      ),
    markStarted: vi.fn().mockResolvedValue(attempt({ status: 'started' })),
    completeAttempt: vi
      .fn()
      .mockResolvedValue(attempt({ status: 'completed', score: 7 })),
    updateSettings: vi.fn().mockResolvedValue({
      gameId: 'brass',
      releaseId: 'r1',
      settings: { preset: 'standard' },
      revision: 2,
      updatedAt: '2026-10-26T00:00:00.000Z',
    } satisfies DailyChallengeSettingsRecord),
  };
  const service = new PlatformDailyChallengeService(platform, {} as never);
  Object.defineProperty(service, 'store', { value: store });
  return {
    service,
    platform,
    store,
    createMatchedSession,
    recoverStart,
    registerFactConsumer,
    publicNames,
  };
}

describe('PlatformDailyChallengeService', () => {
  it('reuses one account attempt and matched session for repeated starts', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());

    const first = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    const second = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );

    expect(first.start).toEqual(second.start);
    expect(first.attempt.attemptId).toBe(second.attempt.attemptId);
    expect(fixture.createMatchedSession).toHaveBeenCalledTimes(1);
    expect(fixture.createMatchedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: 'seed:2026-10-26',
        setup: { target: 4 },
        participants,
        policy: {
          rating: null,
          validityPolicyVersion: 'brass-daily-challenge-v1',
        },
      }),
    );
  });

  it('freezes the authoritative human display name while preserving game AI profiles across retries', async () => {
    const fixture = platformFixture();
    const gameParticipants: readonly Participant[] = [
      {
        principalId: 'player-1',
        seatId: 'seat-1',
        publicProfile: {
          displayName: 'game-provided-name',
          appearance: { color: 'amber' },
        },
      },
      {
        principalId: 'player-2',
        seatId: 'seat-2',
        controller: 'ai',
        controllerId: 'daily-test',
        publicProfile: { displayName: 'game-owned-ai' },
      },
    ];
    const daily = registration();
    fixture.service.register({
      ...daily,
      participants: () => gameParticipants,
    });
    let stored: DailyChallengeAttemptRecord | undefined;
    fixture.store.reserveAttempt.mockReset();
    fixture.store.reserveAttempt.mockImplementation(async (input) => {
      stored ??= attempt({
        participants: input.participants,
        status: 'started',
      });
      return stored;
    });
    fixture.store.markStarted.mockImplementation(async () => {
      if (!stored) throw new Error('daily attempt was not reserved');
      return stored;
    });
    fixture.publicNames
      .mockResolvedValueOnce(new Map([['player-1', 'Authoritative Human']]))
      .mockResolvedValue(new Map([['player-1', 'Changed Later']]));

    const first = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    const second = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );

    const frozen = [
      {
        ...gameParticipants[0],
        publicProfile: {
          displayName: 'Authoritative Human',
          appearance: { color: 'amber' },
        },
      },
      gameParticipants[1],
    ];
    expect(stored?.participants).toEqual(frozen);
    expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(fixture.createMatchedSession).toHaveBeenCalledTimes(1);
    expect(fixture.createMatchedSession).toHaveBeenCalledWith(
      expect.objectContaining({ participants: frozen }),
    );
  });

  it('recovers a durable admission start after createMatchedSession loses its reply', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    fixture.createMatchedSession.mockRejectedValueOnce(new Error('lost reply'));

    await expect(
      fixture.service.start(
        'brass',
        'player-1',
        new Date('2026-10-26T12:00:00.000Z'),
      ),
    ).rejects.toThrow('lost reply');

    const retry = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    expect(retry.start).toMatchObject({
      startId: status.startId,
      sessionId: status.sessionId,
      roomId: status.roomId,
      state: 'active',
    });
    expect(fixture.recoverStart).toHaveBeenCalledWith(status.roomId);
  });

  it('freezes today before applying a settings update for future dates', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());

    await fixture.service.updateSettings('brass', {
      settings: { preset: 'standard' },
      expectedRevision: 1,
    });

    expect(fixture.store.ensureSnapshot).toHaveBeenCalledBefore(
      fixture.store.updateSettings,
    );
    expect(fixture.store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        settings: { preset: 'standard' },
      }),
    );
  });

  it('reuses the date snapshot release across a current release change', async () => {
    const fixture = platformFixture();
    fixture.platform.game = vi.fn(
      () =>
        ({ releaseId: 'r2' }) as ReturnType<PlatformApplicationRuntime['game']>,
    );
    fixture.service.register(registration());
    fixture.service.register({ ...registration(), releaseId: 'r2' });
    fixture.store.getSnapshot.mockResolvedValue({
      ...snapshot(),
      releaseId: 'r1',
    });

    const response = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );

    expect(response.challenge.releaseId).toBe('r1');
    expect(fixture.store.ensureSnapshot).not.toHaveBeenCalled();
    expect(fixture.registerFactConsumer).toHaveBeenCalledTimes(1);
  });

  it('uses the current release for a new date without rewriting the frozen date', async () => {
    const fixture = platformFixture();
    fixture.platform.game = vi.fn(
      () =>
        ({ releaseId: 'r2' }) as ReturnType<PlatformApplicationRuntime['game']>,
    );
    fixture.service.register(registration());
    fixture.service.register({ ...registration(), releaseId: 'r2' });
    fixture.store.getSnapshot.mockImplementation(async (_gameId, date) =>
      date === '2026-10-26' ? { ...snapshot(), releaseId: 'r1' } : null,
    );
    fixture.store.ensureSnapshot.mockResolvedValue({
      ...snapshot(),
      releaseId: 'r2',
      challengeDate: '2026-10-27',
      seed: 'seed:2026-10-27',
    });

    const response = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-27T12:00:00.000Z'),
    );

    expect(response.challenge.releaseId).toBe('r2');
    expect(response.challenge.challengeDate).toBe('2026-10-27');
    expect(fixture.store.ensureSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.store.ensureSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseId: 'r2',
        challengeDate: '2026-10-27',
      }),
    );
  });

  it('follows the ready stable daily channel for new dates while pinning an existing snapshot', async () => {
    const store = new MemoryReleaseRegistryStore();
    const registry = new ReleaseRegistry(store);
    await installReadyDailyRelease(
      registry,
      'r1',
      'daily-binding-r1',
      'daily-storage-r1',
      'daily-epoch-r1',
    );
    await installReadyDailyRelease(
      registry,
      'r2',
      'daily-binding-r2',
      'daily-storage-r2',
      'daily-epoch-r2',
    );
    await registry.compareAndSwapChannel({
      platformId: 'daily-platform',
      gameId: 'brass',
      modeId: 'daily',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: 'daily-binding-r1',
      operationId: 'daily-channel-r1',
    });

    const fixture = platformFixture();
    Object.assign(fixture.platform, {
      options: { platformId: 'daily-platform' },
      releaseRegistry: registry,
    });
    fixture.service.register(registration());
    fixture.service.register({ ...registration(), releaseId: 'r2' });
    fixture.store.getSnapshot.mockImplementation(async (_gameId, date) =>
      date === '2026-10-26' ? { ...snapshot(), releaseId: 'r1' } : null,
    );
    fixture.store.ensureSnapshot.mockResolvedValue({
      ...snapshot(),
      releaseId: 'r2',
      challengeDate: '2026-10-27',
      seed: 'seed:2026-10-27',
    });

    const frozen = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00.000Z'),
    );
    expect(frozen.challenge.releaseId).toBe('r1');

    await registry.compareAndSwapChannel({
      platformId: 'daily-platform',
      gameId: 'brass',
      modeId: 'daily',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: 'daily-binding-r2',
      operationId: 'daily-channel-r2',
    });
    const sameDate = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-26T18:00:00.000Z'),
    );
    expect(sameDate.challenge.releaseId).toBe('r1');

    const newDate = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-27T12:00:00.000Z'),
    );
    expect(newDate.challenge.releaseId).toBe('r2');
    expect(fixture.store.ensureSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseId: 'r2',
        challengeDate: '2026-10-27',
      }),
    );
  });

  it('fails closed when the frozen snapshot release is unavailable', async () => {
    const fixture = platformFixture();
    fixture.platform.game = vi.fn(
      () =>
        ({ releaseId: 'r2' }) as ReturnType<PlatformApplicationRuntime['game']>,
    );
    fixture.service.register({ ...registration(), releaseId: 'r2' });
    fixture.store.getSnapshot.mockResolvedValue({
      ...snapshot(),
      releaseId: 'r1',
    });

    await expect(
      fixture.service.getToday(
        'brass',
        'player-1',
        new Date('2026-10-26T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({
        code: 'NOT_READY',
        messageKey: 'platform.daily.snapshot_release_unavailable',
      }),
    });
  });

  it('returns all owned attempts and distinguishes the active and latest attempt', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    fixture.store.listAttempts.mockResolvedValue([
      attempt({ status: 'completed', score: 10 }),
      attempt({ attemptId: 'attempt-2', attemptNumber: 2, status: 'started' }),
    ]);

    const today = await fixture.service.getToday(
      'brass',
      'player-1',
      new Date('2026-10-26T12:00:00Z'),
    );
    expect(today.attemptCount).toBe(2);
    expect(today.activeAttempt?.attemptNumber).toBe(2);
    expect(today.latestAttempt?.attemptNumber).toBe(2);
    expect(today.attempts.map((entry) => entry.attemptNumber)).toEqual([1, 2]);
    expect(today.nextRefreshAt).toBe('2026-10-26T23:59:00.000Z');
  });

  it('recovers the same request after refresh without invoking game preparation', async () => {
    const fixture = platformFixture();
    const daily = registration();
    const prepareParticipants = vi.fn(daily.participants);
    fixture.service.register({ ...daily, participants: prepareParticipants });
    fixture.store.getAttemptByRequest.mockResolvedValue(
      attempt({ status: 'completed', score: 10 }),
    );
    fixture.store.getSnapshot.mockResolvedValue(snapshot());
    vi.mocked(fixture.platform.admissionStore.getStart)
      .mockReset()
      .mockResolvedValue(status as never);

    const response = await fixture.service.start(
      'brass',
      'player-1',
      new Date('2026-10-27T12:00:00Z'),
      'retry-1',
    );
    expect(response.challenge.challengeDate).toBe('2026-10-26');
    expect(response.attempt.status).toBe('completed');
    expect(prepareParticipants).not.toHaveBeenCalled();
    expect(fixture.store.reserveAttempt).not.toHaveBeenCalled();
    expect(fixture.store.markStarted).not.toHaveBeenCalled();
  });

  it('omits identity, session and game result data from anonymous boards', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    fixture.store.getSnapshot.mockResolvedValue(snapshot());
    const entry = {
      rank: 1,
      entryKey: 'opaque-entry',
      principalId: 'other-player',
      displayName: 'Private name',
      publicationState: 'anonymous',
      sessionId: 'private-session',
      attemptNumber: 1,
      score: 80,
      result: { participantIds: ['other-player'] },
      completedAt: '2026-10-26T12:00:00.000Z',
    };
    fixture.store.listLeaderboards.mockResolvedValue({
      date: '2026-10-26',
      firstLook: { date: '2026-10-26', top: [entry] },
      overall: { date: '2026-10-26', top: [entry] },
      grinder: {
        date: '2026-10-26',
        top: [{ ...entry, attemptCount: 2, completedCount: 1 }],
      },
    });
    const boards = await fixture.service.getLeaderboards(
      'brass',
      'player-1',
      '2026-10-26',
    );
    expect(boards.firstLook.top[0]).toMatchObject({
      displayName: 'player',
      score: 80,
    });
    expect(JSON.stringify(boards)).not.toMatch(
      /other-player|private-session|Private name|participantIds/,
    );
  });

  it('allows only the attempt owner to publish a completed attempt', async () => {
    const fixture = platformFixture();
    fixture.store.getAttemptBySession.mockResolvedValue(
      attempt({ status: 'completed' }),
    );
    await expect(
      fixture.service.updatePublication('brass', 'stranger', status.sessionId, {
        publicationState: 'public',
      }),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'NOT_FOUND' }),
    });
    expect(fixture.store.publishAttempt).not.toHaveBeenCalled();
    fixture.store.publishAttempt.mockResolvedValue(
      attempt({ status: 'completed', publicationState: 'anonymous' }),
    );
    const published = await fixture.service.updatePublication(
      'brass',
      'player-1',
      status.sessionId,
      { publicationState: 'anonymous' },
    );
    expect(published.publicationState).toBe('anonymous');
  });

  it('grants daily replay only when eligibility and the authoritative replay route agree', async () => {
    const fixture = platformFixture();
    const replayRef = {
      platformId: 'daily-platform',
      gameId: 'brass',
      sessionId: status.sessionId,
      replayId: 'opaque-replay-id',
      releaseId: 'r1',
      storageBindingId: status.route.storageBindingId,
      formatVersion: 1,
    };
    const completion = { status: 'completed', route: status.route, replayRef };
    const get = vi.fn().mockResolvedValue(completion);
    Object.assign(fixture.platform, {
      options: { platformId: 'daily-platform' },
      completionStore: { get },
    });
    expect(await fixture.service.canReplay(status.route, 'spectator')).toBe(
      false,
    );
    fixture.store.getReplayEligibility.mockResolvedValue({
      attempt: attempt({ status: 'completed', publicationState: 'public' }),
      snapshot: snapshot(),
    });
    expect(await fixture.service.canReplay(status.route, 'spectator')).toBe(
      true,
    );
    expect(fixture.store.getReplayEligibility).toHaveBeenLastCalledWith(
      status.sessionId,
      'spectator',
    );
    for (const route of [
      { ...status.route, releaseId: 'r2' },
      { ...status.route, backendBindingId: 'different-backend' },
      { ...status.route, ownershipEpoch: 'different-owner' },
    ])
      expect(await fixture.service.canReplay(route, 'spectator')).toBe(false);
    get.mockResolvedValue({
      ...completion,
      replayRef: { ...replayRef, storageBindingId: 'different-storage' },
    });
    expect(await fixture.service.canReplay(status.route, 'spectator')).toBe(
      false,
    );
    get.mockResolvedValue({ ...completion, status: 'cancelled' });
    expect(await fixture.service.canReplay(status.route, 'spectator')).toBe(
      false,
    );
  });

  it('registers one recovery hook per game to publish and finalize without page traffic', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    fixture.service.register({ ...registration(), releaseId: 'r2' });
    const registerRecovery = vi.mocked(fixture.platform.registerRecoveryHook);
    expect(registerRecovery).toHaveBeenCalledTimes(1);
    const recover = registerRecovery.mock.calls[0]?.[1];
    expect(recover).toBeTypeOf('function');
    await recover?.();
    expect(fixture.store.finalizeDue).toHaveBeenCalledWith(
      expect.any(Date),
      'brass',
    );
    expect(fixture.store.publishDue).toHaveBeenCalledWith(expect.any(Date));
  });

  it('never recreates a terminal attempt whose admission record is missing', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    fixture.store.getAttemptByRequest.mockResolvedValue(
      attempt({ status: 'abandoned' }),
    );
    fixture.store.getSnapshot.mockResolvedValue(snapshot());
    await expect(
      fixture.service.start(
        'brass',
        'player-1',
        new Date('2026-10-26T12:00:00Z'),
        'cancelled-request',
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'CONFLICT' }),
    });
    expect(fixture.createMatchedSession).not.toHaveBeenCalled();
  });

  it('enforces game entitlement for a new daily attempt', async () => {
    const fixture = platformFixture();
    fixture.service.register(registration());
    Object.assign(fixture.platform, {
      gameAccess: { allows: vi.fn().mockResolvedValue(false) },
    });
    await expect(
      fixture.service.start(
        'brass',
        'player-1',
        new Date('2026-10-26T12:00:00Z'),
      ),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'FORBIDDEN' }),
    });
    expect(fixture.store.reserveAttempt).not.toHaveBeenCalled();
  });

  it('uses the canonical completion store and rejects a result revision above one', async () => {
    const fixture = platformFixture();
    const completionStore = new MemoryCompletionRecordStore({
      platformId: 'daily-platform',
    });
    Object.assign(fixture.platform, {
      options: { platformId: 'daily-platform' },
      completionStore,
    });
    fixture.service.register(registration());
    fixture.store.getAttemptBySession.mockResolvedValue(attempt());
    vi.mocked(fixture.platform.admissionStore.getAdmission).mockResolvedValue(
      admission(),
    );
    const consume = fixture.registerFactConsumer.mock.calls[0]?.[1];
    if (!consume) throw new Error('daily completion consumer missing');

    await expect(
      consume(
        factEnvelope(
          'SessionCompleted',
          {
            result: {
              kind: 'cooperative',
              participantIds: ['player-1', 'player-2'],
              outcome: 'won',
            },
            resultRevision: 2,
            endedAt: 100,
          },
          { aggregateSequence: 4 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_ALLOWED' });
    expect(fixture.store.completeAttempt).not.toHaveBeenCalled();
  });

  it('uses the canonical completion store and rejects a cancellation without source revision', async () => {
    const fixture = platformFixture();
    const completionStore = new MemoryCompletionRecordStore({
      platformId: 'daily-platform',
    });
    Object.assign(fixture.platform, {
      options: { platformId: 'daily-platform' },
      completionStore,
    });
    fixture.service.register(registration());
    fixture.store.getAttemptBySession.mockResolvedValue(attempt());
    vi.mocked(fixture.platform.admissionStore.getAdmission).mockResolvedValue(
      admission(),
    );
    const consume = fixture.registerFactConsumer.mock.calls[0]?.[1];
    if (!consume) throw new Error('daily completion consumer missing');

    await expect(
      consume(
        factEnvelope('SessionControlled', {
          action: 'cancel',
          status: 'cancelled',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fixture.store.abandonAttempt).not.toHaveBeenCalled();
  });
});
