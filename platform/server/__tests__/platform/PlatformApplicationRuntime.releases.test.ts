import type {
  GameServiceDescription,
  JsonValue,
  MatchAdmission,
  PlatformRoom,
  ReleaseManifest,
} from '@board-game/contracts';
import {
  MemoryAdmissionStore,
  MemoryInboxStore,
  MemorySessionDirectory,
  type ResolvedIdentity,
  type StartOperation,
} from '@board-game/core';
import {
  GameHost,
  GameRegistry,
  HttpHostTransport,
  RemoteBackendAdapter,
} from '@board-game/host';
import { defineGame, type GameModule } from '@board-game/sdk';
import { MemoryStorageDriver } from '@board-game/storage';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import type {
  GameAccessPolicy,
  RemoteReadinessProbeInput,
} from '@/platform/PlatformApplicationRuntime.js';
import { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformReleaseAdministration } from '@/platform/PlatformReleaseAdministration.js';
import {
  MemoryReleaseRegistryStore,
  ReleaseRegistry,
} from '@/platform/releases/index.js';

type State = { readonly count: number; readonly owner: string };
const platformId = 'remote-release-platform';
const gameId = 'remote-release-game';
const serviceToken = 'remote-release-test-service-token-32-characters';
const reference = {
  principalId: 'remote-player',
  authSessionId: 'remote-auth',
};

const setupSchema = {
  name: 'remote-release.setup',
  version: 1,
  schema: { type: 'object' as const, additionalProperties: false },
};

function moduleFor(
  releaseId: string,
  modes: GameServiceDescription['modes'] = [
    {
      id: 'solo',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
): GameModule<
  State,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue
> {
  const module: GameModule<
    State,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue
  > = {
    gameId,
    releaseId,
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes,
    schemas: {
      setup: setupSchema,
      command: setupSchema,
      result: setupSchema,
    },
    rules: {
      create: (_setup, context) => ({
        count: 0,
        owner: context.participants[0]?.principalId ?? 'missing',
      }),
      execute: (state) => ({
        ok: true,
        state: { ...state, count: state.count + 1 },
        events: [{ count: state.count + 1 }],
      }),
      project: (state) => ({ count: state.count }),
      projectEvent: (event) => event,
      encode: (state) => ({ ...state }),
      decode: (saved) => saved as State,
    },
    summarize: (state) => ({ count: state.count }),
    turn: (state, { participants }) =>
      state.count >= 1
        ? null
        : {
            id: `turn-${state.count}`,
            mode: 'sequential',
            activeSeatIds: participants.slice(0, 1).map((seat) => seat.seatId),
          },
    completion: (state) => ({ finished: state.count >= 1 }),
    result: (state) => ({
      kind: 'solo',
      participantIds: [state.owner],
      outcome: 'completed',
    }),
    collectFacts: () => [],
  };
  return defineGame(module);
}

function manifestFor(
  releaseId: string,
  modes: ReleaseManifest['modes'],
): ReleaseManifest {
  return {
    manifestVersion: '1.0',
    gameId,
    releaseId,
    displayVersion: releaseId,
    publisherId: 'remote-release-publisher',
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
    capabilities: { minPlayers: 1, maxPlayers: 1, features: [] },
    modes,
    presentation: {
      mount: 'platform-route',
      layoutProfile: 'remote-release',
      locales: ['en'],
    },
    budgetProfile: 'test',
  };
}

function policy(): GameAccessPolicy {
  return {
    authorize: async (identity: ResolvedIdentity, admission: MatchAdmission) =>
      admission.participants.some(
        (participant) => participant.principalId === identity.principalId,
      ),
    accessScopes: async () => ['session:view', 'session:command'],
    authorizeRoom: async () => true,
    authorizeRoomInvite: async () => true,
    freezeParticipants: async (room: PlatformRoom) =>
      room.members.map(({ principalId, seatId }) => ({ principalId, seatId })),
    authorizeHost: async () => undefined,
    adminAccess: async () => {
      throw new Error('not used');
    },
    diagnosticAccess: async () => {
      throw new Error('not used');
    },
    startAccess: async (operation: StartOperation) => ({
      principalId: operation.initiatedBy,
      scopes: ['session:create', 'session:control'],
      authEpoch: 'remote-release-auth',
    }),
    systemAccess: async () => ({
      principalId: 'remote-release-system',
      scopes: ['session:system'],
      authEpoch: 'remote-release-system',
    }),
  };
}

function descriptionFor(
  releaseId: string,
  backendBindingId: string,
  storageBindingId: string,
  modes: GameServiceDescription['modes'],
): GameServiceDescription {
  return {
    schemaVersion: 1,
    platformId,
    gameId,
    releaseId,
    backendBindingId,
    storageBindingId,
    ownershipEpoch: releaseId,
    metadata: {
      gameId,
      name: `Remote ${releaseId}`,
      description: 'A remote release coexistence fixture.',
      themeId: 'remote-release',
    },
    modes,
    setupSchema,
  };
}

interface RemoteFixture {
  readonly description: GameServiceDescription;
  readonly manifest: ReleaseManifest;
  readonly backend: RemoteBackendAdapter;
  readonly host: GameHost;
  readonly transport: HttpHostTransport;
  readonly storage: MemoryStorageDriver;
  readonly endpoint: string;
}

async function remoteFixture(
  releaseId: string,
  backendBindingId: string,
  storageBindingId: string,
  modes?: GameServiceDescription['modes'],
): Promise<RemoteFixture> {
  const module = moduleFor(releaseId, modes);
  const storage = new MemoryStorageDriver();
  const host = new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId,
    storageBindingId,
    authorize: async () => undefined,
  });
  const description = descriptionFor(
    releaseId,
    backendBindingId,
    storageBindingId,
    module.modes,
  );
  const describe = host.describe.bind(host);
  vi.spyOn(host, 'describe').mockImplementation(async (request) => ({
    ...(await describe(request)),
    features: ['runtime-description-v1'],
    service: description,
  }));
  const transport = new HttpHostTransport({
    backend: host,
    serviceToken,
    allowedGameIds: [gameId],
    allowedScopes: [
      'session:create',
      'session:control',
      'session:view',
      'session:command',
    ],
    tokenExpiresAt: Date.now() + 60_000,
    host: '127.0.0.1',
  });
  const address = await transport.listen();
  const endpoint = `http://127.0.0.1:${address.port}`;
  const backend = new RemoteBackendAdapter({
    baseUrl: endpoint,
    serviceToken,
    allowInsecureLocalhost: true,
  });
  return {
    description,
    manifest: manifestFor(releaseId, module.modes),
    backend,
    host,
    transport,
    storage,
    endpoint,
  };
}

function runtime(
  store: MemoryReleaseRegistryStore,
  admissionStore = new MemoryAdmissionStore(),
  completionStore = new MemoryCompletionRecordStore({
    platformId,
    admission: admissionStore,
  }),
): PlatformApplicationRuntime {
  const platform = new PlatformApplicationRuntime({
    platformId,
    db: {} as NodePgDatabase,
    pool: {} as Pool,
    storage: new MemoryStorageDriver(),
    admissionStore,
    inbox: new MemoryInboxStore(),
    directory: new MemorySessionDirectory({
      admission: admissionStore,
      retentionResolver: () => 'summary-and-replay',
    }),
    completionStore,
    releaseRegistry: store,
    remoteRuntime: {
      resolvePolicy: () => ({
        identity: policy(),
        policy: { rating: null, validityPolicyVersion: 'remote-release-v1' },
      }),
      resolveCredential: () => ({
        serviceToken,
        allowInsecureLocalhost: true,
      }),
      probeReadiness: async ({
        release,
        binding,
        ready,
      }: RemoteReadinessProbeInput) => ({
        probeId: `remote-probe-${binding.backendBindingId}`,
        checkedAt: Date.now(),
        protocol: {
          major: ready.protocolMajor,
          minor: ready.protocolMinor,
          serviceDigest: release.serviceDigest,
          service:
            ready.service ??
            (() => {
              throw new Error('runtime service description missing');
            })(),
        },
        storage: {
          bindingId: binding.storageBindingId,
          schemaVersion: 'memory-storage-v1',
        },
      }),
    },
  });
  vi.spyOn(platform.identity, 'resolve').mockResolvedValue({
    principalId: reference.principalId,
    authEpoch: 'remote-release-auth',
    active: true,
  });
  vi.spyOn(platform.identity, 'resolveCurrent').mockResolvedValue({
    account: {
      id: reference.principalId,
      accountStatus: 'active',
      sessionVersion: 1,
      permissionVersion: 1,
      role: 'player',
      navigatorGrantedAt: null,
      navigatorExpiresAt: null,
    },
    identity: {
      principalId: reference.principalId,
      authEpoch: 'remote-release-auth',
      active: true,
    },
  });
  return platform;
}

async function register(
  platform: PlatformApplicationRuntime,
  fixture: RemoteFixture,
  options: {
    readonly policyBundle?: JsonValue;
    readonly approvedPolicyVersions?: readonly {
      readonly kind: 'rating' | 'progression' | 'reward' | 'achievement';
      readonly version: string;
    }[];
  } = {},
) {
  return platform.registerRemoteGame({
    description: fixture.description,
    backend: fixture.backend,
    identity: policy(),
    policy: { rating: null, validityPolicyVersion: 'remote-release-v1' },
    manifest: fixture.manifest,
    approvedFeatures: [],
    approvedModes: fixture.description.modes.map((mode) => mode.id),
    ...(options.policyBundle === undefined
      ? {}
      : { policyBundle: options.policyBundle }),
    ...(options.approvedPolicyVersions === undefined
      ? {}
      : { approvedPolicyVersions: options.approvedPolicyVersions }),
    binding: {
      deployment: 'external',
      controlEndpoint: fixture.endpoint,
      playerEndpoint: fixture.endpoint,
      clientArtifactBaseUrl: `${fixture.endpoint}/assets`,
      serviceCredentialRef: 'remote-release-credential',
    },
  });
}

describe('PlatformApplicationRuntime remote release registry', () => {
  const fixtures: RemoteFixture[] = [];

  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map(async (fixture) => {
        await fixture.transport.close();
        await fixture.host.drain();
        await fixture.storage.close();
      }),
    );
  });

  it('coexists v1/v2 over HTTP, switches, rolls back, and keeps old routes pinned', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const v1 = await remoteFixture(
      'remote-v1',
      'remote-binding-v1',
      'remote-storage-v1',
    );
    const v2 = await remoteFixture(
      'remote-v2',
      'remote-binding-v2',
      'remote-storage-v2',
    );
    fixtures.push(v1, v2);
    await register(platform, v1);
    await register(platform, v2);

    const firstChannel = await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: 'remote-binding-v1',
      operationId: 'remote-channel-v1',
    });
    expect(firstChannel.releaseId).toBe('remote-v1');
    const first = await platform.createDirectSessionFromChannel(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        channel: 'stable',
        setup: {},
        requestId: 'start-v1',
      },
    );
    const firstView = await platform.views.view(reference, first.sessionId);
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: 'remote-binding-v2',
      operationId: 'remote-channel-v2',
    });
    const second = await platform.createDirectSessionFromChannel(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        channel: 'stable',
        setup: {},
        requestId: 'start-v2',
      },
    );
    expect(second.route.releaseId).toBe('remote-v2');
    await platform.sessions.command(reference, first.sessionId, {
      commandId: 'old-v1-command',
      precondition: { kind: 'revision', expectedRevision: firstView.revision },
      command: {},
    });
    expect(
      (await platform.views.view(reference, first.sessionId)).descriptor.route,
    ).toMatchObject({
      releaseId: 'remote-v1',
      backendBindingId: 'remote-binding-v1',
      storageBindingId: 'remote-storage-v1',
      ownershipEpoch: 'remote-v1',
    });
    const rollback = await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 2,
      targetBackendBindingId: 'remote-binding-v1',
      operationId: 'remote-channel-rollback',
    });
    expect(rollback.releaseId).toBe('remote-v1');
    const third = await platform.createDirectSessionFromChannel(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        channel: 'stable',
        setup: {},
        requestId: 'start-v1-rollback',
      },
    );
    expect(third.route.releaseId).toBe('remote-v1');
  });

  it('passes the immutable release policy to the late settlement registrar', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const registerSettlement = vi.fn().mockResolvedValue(undefined);
    const registerDaily = vi.fn();
    platform.setRemoteSettlementReleaseHook(registerSettlement);
    platform.setRemoteDailyChallengeReleaseHook(registerDaily);
    const fixture = await remoteFixture(
      'remote-policy',
      'remote-binding-policy',
      'remote-storage-policy',
    );
    fixtures.push(fixture);
    const policyBundle = {
      schemaVersion: 1,
      gameId,
      releaseId: 'remote-policy',
      approvedModes: ['solo'],
    } as const;
    await register(platform, fixture, { policyBundle });
    expect(registerSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId,
        releaseId: 'remote-policy',
        policyBundle,
      }),
    );
    expect(registerDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        gameId,
        releaseId: 'remote-policy',
        approvedModes: ['solo'],
        service: expect.objectContaining({ releaseId: 'remote-policy' }),
      }),
    );
    const release = await store.getRelease(platformId, gameId, 'remote-policy');
    expect(release?.policyBundle).toEqual(policyBundle);
  });

  it('restores adapters from registry endpoints and resolvers without browser endpoint input', async () => {
    const store = new MemoryReleaseRegistryStore();
    const admissionStore = new MemoryAdmissionStore();
    const firstPlatform = runtime(store, admissionStore);
    const fixture = await remoteFixture(
      'remote-restore',
      'remote-binding-restore',
      'remote-storage-restore',
    );
    fixtures.push(fixture);
    await register(firstPlatform, fixture);
    await firstPlatform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: 'remote-binding-restore',
      operationId: 'remote-channel-restore',
    });

    const restored = runtime(store, admissionStore);
    await expect(restored.restoreRemoteGames()).resolves.toHaveLength(1);
    const session = await restored.createDirectSessionFromChannel(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        channel: 'stable',
        setup: {},
        requestId: 'restored-start',
      },
    );
    expect(session.route.backendBindingId).toBe('remote-binding-restore');
    expect(
      (await restored.views.view(reference, session.sessionId)).payload,
    ).toEqual({ count: 0 });
  });

  it('restores the channel-selected release instead of letting retained binding order win', async () => {
    const store = new MemoryReleaseRegistryStore();
    const firstPlatform = runtime(store);
    const retained = await remoteFixture(
      'retained-release',
      'z-retained-binding',
      'retained-storage',
    );
    const selected = await remoteFixture(
      'selected-release',
      'a-selected-binding',
      'selected-storage',
    );
    fixtures.push(retained, selected);
    await register(firstPlatform, retained);
    await register(firstPlatform, selected);
    await firstPlatform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: selected.description.backendBindingId,
      operationId: 'selected-release-channel',
    });

    const restored = runtime(store);
    await restored.restoreRemoteGames();

    expect(restored.game(gameId).releaseId).toBe('selected-release');
  });

  it('leaves the current projection unchanged when channel CAS rejects', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const first = await remoteFixture(
      'cas-first-release',
      'cas-first-binding',
      'cas-first-storage',
    );
    const second = await remoteFixture(
      'cas-second-release',
      'cas-second-binding',
      'cas-second-storage',
    );
    fixtures.push(first, second);
    await register(platform, first);
    await register(platform, second);
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'cas-first-channel',
    });

    await expect(
      platform.switchRemoteChannel({
        platformId,
        gameId,
        modeId: 'solo',
        channel: 'stable',
        expectedRevision: 0,
        targetBackendBindingId: second.description.backendBindingId,
        operationId: 'cas-rejected-channel',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(platform.game(gameId).releaseId).toBe('cas-first-release');
  });

  it('fails closed while stable mode channels diverge, then restores the converged release', async () => {
    const modes: GameServiceDescription['modes'] = [
      {
        id: 'solo',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'summary-and-replay',
        platformRating: false,
        concurrency: 'revision',
      },
      {
        id: 'arena',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'summary-and-replay',
        platformRating: false,
        concurrency: 'revision',
      },
    ];
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const first = await remoteFixture(
      'multi-release-v1',
      'multi-binding-v1',
      'multi-storage-v1',
      modes,
    );
    const second = await remoteFixture(
      'multi-release-v2',
      'multi-binding-v2',
      'multi-storage-v2',
      modes,
    );
    fixtures.push(first, second);
    await register(platform, first);
    await register(platform, second);

    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'multi-solo-v1',
    });
    expect(platform.game(gameId).releaseId).toBe('multi-release-v1');

    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'arena',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: second.description.backendBindingId,
      operationId: 'multi-arena-v2',
    });
    expect(() => platform.game(gameId)).toThrow('platform.game.unavailable');
    expect(platform.releaseGame(gameId, 'multi-release-v2').releaseId).toBe(
      'multi-release-v2',
    );

    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'arena',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'multi-arena-v1',
    });
    expect(platform.game(gameId).releaseId).toBe('multi-release-v1');
  });

  it('returns a committed CAS while a transient projection read fails, then recovers it', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const first = await remoteFixture(
      'recovery-release-v1',
      'recovery-binding-v1',
      'recovery-storage-v1',
    );
    const second = await remoteFixture(
      'recovery-release-v2',
      'recovery-binding-v2',
      'recovery-storage-v2',
    );
    fixtures.push(first, second);
    await register(platform, first);
    await register(platform, second);
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'recovery-v1',
    });

    vi.spyOn(store, 'listChannels').mockRejectedValueOnce(
      new Error('temporary channel read failure'),
    );
    const committed = await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: second.description.backendBindingId,
      operationId: 'recovery-v2',
    });
    expect(committed.releaseId).toBe('recovery-release-v2');
    expect(() => platform.game(gameId)).toThrow('platform.game.unavailable');

    const recovery = await platform.recoverOnce();
    expect(recovery.maintenance).toContainEqual({
      name: `remote-projection:${gameId}`,
      failed: false,
    });
    expect(platform.game(gameId).releaseId).toBe('recovery-release-v2');
  });

  it('does not let an older deferred projection overwrite a newer channel sync', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const first = await remoteFixture(
      'generation-release-v1',
      'generation-binding-v1',
      'generation-storage-v1',
    );
    const second = await remoteFixture(
      'generation-release-v2',
      'generation-binding-v2',
      'generation-storage-v2',
    );
    fixtures.push(first, second);
    await register(platform, first);
    await register(platform, second);
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'generation-v1',
    });

    const originalListChannels = store.listChannels.bind(store);
    let resolveFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSnapshot: Awaited<
      ReturnType<MemoryReleaseRegistryStore['listChannels']>
    > = [];
    let listCall = 0;
    vi.spyOn(store, 'listChannels').mockImplementation(async (id) => {
      listCall += 1;
      if (listCall === 1) {
        resolveFirstStarted?.();
        await firstGate;
        return firstSnapshot;
      }
      return originalListChannels(id);
    });

    const firstSwitch = platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: second.description.backendBindingId,
      operationId: 'generation-v2',
    });
    await firstStarted;
    firstSnapshot = await originalListChannels(platformId);

    const secondSwitch = await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 2,
      targetBackendBindingId: first.description.backendBindingId,
      operationId: 'generation-v1-rollback',
    });
    expect(secondSwitch.releaseId).toBe('generation-release-v1');
    expect(platform.game(gameId).releaseId).toBe('generation-release-v1');

    releaseFirst?.();
    const firstResult = await firstSwitch;
    expect(firstResult.releaseId).toBe('generation-release-v2');
    expect(platform.game(gameId).releaseId).toBe('generation-release-v1');
  });

  it('runs readiness from the server-owned resolver before activating a staged binding', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const fixture = await remoteFixture(
      'remote-staged',
      'remote-binding-staged',
      'remote-storage-staged',
    );
    fixtures.push(fixture);
    const registry = new ReleaseRegistry(store);
    await registry.registerRelease({
      platformId,
      manifest: fixture.manifest,
      service: fixture.description,
      approvedFeatures: [],
      approvedModes: ['solo'],
    });
    const binding = await registry.registerBinding({
      platformId,
      gameId,
      releaseId: 'remote-staged',
      backendBindingId: fixture.description.backendBindingId,
      storageBindingId: fixture.description.storageBindingId,
      ownershipEpoch: fixture.description.ownershipEpoch,
      deployment: 'external',
      controlEndpoint: fixture.endpoint,
      playerEndpoint: fixture.endpoint,
      clientArtifactBaseUrl: `${fixture.endpoint}/assets`,
      serviceCredentialRef: 'server-owned-credential',
    });
    expect(binding.status).toBe('staged');
    const ready = await platform.readyRemoteBinding(binding.backendBindingId);
    expect(ready.status).toBe('ready');
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: binding.backendBindingId,
      operationId: 'remote-staged-channel',
    });
    const session = await platform.createDirectSessionFromChannel(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        channel: 'stable',
        setup: {},
        requestId: 'remote-staged-start',
      },
    );
    expect(session.route.releaseId).toBe('remote-staged');
    expect(platform.catalog()).toEqual([
      expect.objectContaining({ gameId, releaseId: 'remote-staged' }),
    ]);
  });

  it('restores staged metadata without resolving an unavailable credential', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const fixture = await remoteFixture(
      'remote-staged-offline',
      'remote-binding-staged-offline',
      'remote-storage-staged-offline',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    const binding = await store.getBinding(
      platformId,
      fixture.description.backendBindingId,
    );
    if (!binding) throw new Error('binding was not persisted');
    const staged = await store.updateBindingEndpoints({
      platformId,
      backendBindingId: binding.backendBindingId,
      expectedRevision: binding.revision,
      controlEndpoint: binding.controlEndpoint,
      playerEndpoint: binding.playerEndpoint,
      clientArtifactBaseUrl: binding.clientArtifactBaseUrl,
      serviceCredentialRef: 'env:NEW_KEY',
    });
    expect(staged.status).toBe('staged');
    await fixture.transport.close();

    const restored = runtime(store);
    const restoredRemoteRuntime = restored.options.remoteRuntime;
    if (!restoredRemoteRuntime)
      throw new Error('remote runtime was not configured');
    const resolveCredential = vi.spyOn(
      restoredRemoteRuntime,
      'resolveCredential',
    );
    await expect(restored.restoreRemoteGames()).resolves.toHaveLength(1);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(() =>
      restored.publicModeId(gameId, 'solo', fixture.description.releaseId),
    ).toThrow('platform.mode.entry_unavailable');
  });

  it('fresh-probes an already-ready binding and replaces its adapter', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const fixture = await remoteFixture(
      'remote-ready-refresh',
      'remote-binding-ready-refresh',
      'remote-storage-ready-refresh',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    const before = platform.game(gameId).backend;
    const ready = vi.spyOn(fixture.host, 'ready');
    const platformRemoteRuntime = platform.options.remoteRuntime;
    if (!platformRemoteRuntime)
      throw new Error('remote runtime was not configured');
    const resolveCredential = vi.spyOn(
      platformRemoteRuntime,
      'resolveCredential',
    );

    await expect(
      platform.readyRemoteBinding(fixture.description.backendBindingId),
    ).resolves.toMatchObject({ status: 'ready' });

    expect(ready).toHaveBeenCalledOnce();
    expect(resolveCredential).toHaveBeenCalledOnce();
    expect(platform.game(gameId).backend).not.toBe(before);
  });

  it('replaces the exact-release backend after an endpoint revision is readied', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const oldFixture = await remoteFixture(
      'remote-endpoint',
      'remote-binding-endpoint',
      'remote-storage-endpoint',
    );
    const newFixture = await remoteFixture(
      'remote-endpoint',
      'remote-binding-endpoint',
      'remote-storage-endpoint',
    );
    fixtures.push(oldFixture, newFixture);
    await register(platform, oldFixture);
    const original = await store.getBinding(
      platformId,
      oldFixture.description.backendBindingId,
    );
    if (!original) throw new Error('binding was not persisted');
    const oldCreate = vi.spyOn(oldFixture.host, 'createSession');
    const newCreate = vi.spyOn(newFixture.host, 'createSession');
    const staged = await store.updateBindingEndpoints({
      platformId,
      backendBindingId: original.backendBindingId,
      expectedRevision: original.revision,
      controlEndpoint: newFixture.endpoint,
      playerEndpoint: newFixture.endpoint,
      clientArtifactBaseUrl: `${newFixture.endpoint}/assets`,
      serviceCredentialRef: 'remote-release-credential',
    });
    expect(staged.status).toBe('staged');
    const ready = await platform.readyRemoteBinding(original.backendBindingId);
    expect(ready.status).toBe('ready');
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: original.backendBindingId,
      operationId: 'remote-endpoint-channel',
    });
    await platform.createDirectSessionFromChannel(reference.principalId, {
      gameId,
      modeId: 'solo',
      channel: 'stable',
      setup: {},
      requestId: 'remote-endpoint-start',
    });
    expect(newCreate).toHaveBeenCalled();
    expect(oldCreate).not.toHaveBeenCalled();
  });

  it('restores ready release metadata without probing an offline game', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const fixture = await remoteFixture(
      'remote-offline-restore',
      'remote-binding-offline-restore',
      'remote-storage-offline-restore',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    await platform.switchRemoteChannel({
      platformId,
      gameId,
      modeId: 'solo',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: fixture.description.backendBindingId,
      operationId: 'remote-offline-restore-channel',
    });
    await fixture.transport.close();
    const restored = runtime(store);
    await expect(restored.restoreRemoteGames()).resolves.toHaveLength(1);
    await expect(
      restored.readyRemoteBinding(fixture.description.backendBindingId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
    await expect(
      restored.channelForNewAdmission({
        gameId,
        modeId: 'solo',
        channel: 'stable',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
  });

  it('persists a remote cancellation as a terminal completion record', async () => {
    const store = new MemoryReleaseRegistryStore();
    const admissionStore = new MemoryAdmissionStore();
    const completionStore = new MemoryCompletionRecordStore({
      platformId,
      admission: admissionStore,
    });
    const platform = runtime(store, admissionStore, completionStore);
    const fixture = await remoteFixture(
      'remote-cancel',
      'remote-binding-cancel',
      'remote-storage-cancel',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    const session = await platform.admission.createDirectSession(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        releaseId: 'remote-cancel',
        setup: {},
        requestId: 'remote-cancel-start',
      },
    );
    const admission = await admissionStore.getAdmission(session.sessionId);
    if (!admission) throw new Error('admission was not persisted');
    const source = {
      gameId,
      releaseId: 'remote-cancel',
      backendBindingId: fixture.description.backendBindingId,
      ownershipEpoch: fixture.description.ownershipEpoch,
    };
    const facts = [
      {
        kind: 'SessionCreated',
        payload: { summary: { phase: 'created' } },
        aggregateSequence: 1,
      },
      {
        kind: 'SessionActivated',
        payload: { summary: { phase: 'active' } },
        aggregateSequence: 2,
      },
      {
        kind: 'SessionControlled',
        payload: {
          action: 'cancel',
          principalId: reference.principalId,
          summary: { phase: 'cancelled' },
        },
        aggregateSequence: 3,
      },
    ] as const;
    for (const fact of facts)
      await platform.factReceiver.ingest({
        source,
        route: admission.route,
        fact: {
          producerId: `game:${gameId}:session:${session.sessionId}`,
          eventId: `remote-cancel-${fact.aggregateSequence}`,
          sessionId: session.sessionId,
          kind: fact.kind,
          schemaVersion: 1,
          sourceRelease: 'remote-cancel',
          payload: fact.payload,
          aggregateSequence: fact.aggregateSequence,
          occurredAt: Date.now(),
        },
      });
    await platform.recoverOnce();
    await expect(
      completionStore.get(platformId, session.sessionId),
    ).resolves.toMatchObject({
      status: 'cancelled',
      processingState: 'settled',
    });
    await expect(
      platform.directory.getSession(session.sessionId),
    ).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('does not treat a cancel fact with another status as a completion', async () => {
    const store = new MemoryReleaseRegistryStore();
    const admissionStore = new MemoryAdmissionStore();
    const completionStore = new MemoryCompletionRecordStore({
      platformId,
      admission: admissionStore,
    });
    const platform = runtime(store, admissionStore, completionStore);
    const fixture = await remoteFixture(
      'remote-cancel-status-mismatch',
      'remote-binding-cancel-status-mismatch',
      'remote-storage-cancel-status-mismatch',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    const session = await platform.admission.createDirectSession(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        releaseId: 'remote-cancel-status-mismatch',
        setup: {},
        requestId: 'remote-cancel-status-mismatch-start',
      },
    );
    const admission = await admissionStore.getAdmission(session.sessionId);
    if (!admission) throw new Error('admission was not persisted');
    await platform.factReceiver.ingest({
      source: {
        gameId,
        releaseId: admission.route.releaseId,
        backendBindingId: admission.route.backendBindingId,
        ownershipEpoch: admission.route.ownershipEpoch,
      },
      route: admission.route,
      fact: {
        producerId: `game:${gameId}:session:${session.sessionId}`,
        eventId: 'remote-cancel-status-mismatch',
        sessionId: session.sessionId,
        kind: 'SessionControlled',
        schemaVersion: 1,
        sourceRelease: admission.route.releaseId,
        payload: {
          action: 'cancel',
          status: 'paused',
          principalId: reference.principalId,
        },
        aggregateSequence: 1,
        occurredAt: Date.now(),
      },
    });
    const recovery = await platform.recoverOnce();
    expect(recovery.consumers).toEqual(
      expect.arrayContaining([expect.objectContaining({ failed: 1 })]),
    );
    await expect(
      completionStore.get(platformId, session.sessionId),
    ).resolves.toBeNull();
  });

  it('restores retired metadata and results while keeping live admission offline', async () => {
    const store = new MemoryReleaseRegistryStore();
    const admissionStore = new MemoryAdmissionStore();
    const completionStore = new MemoryCompletionRecordStore({
      platformId,
      admission: admissionStore,
    });
    const platform = runtime(store, admissionStore, completionStore);
    const fixture = await remoteFixture(
      'remote-retired',
      'remote-binding-retired',
      'remote-storage-retired',
    );
    fixtures.push(fixture);
    await register(platform, fixture);
    const session = await platform.admission.createDirectSession(
      reference.principalId,
      {
        gameId,
        modeId: 'solo',
        releaseId: 'remote-retired',
        setup: {},
        requestId: 'remote-retired-start',
      },
    );
    const admission = await admissionStore.getAdmission(session.sessionId);
    if (!admission) throw new Error('admission was not persisted');
    await completionStore.accept({
      platformId,
      admission,
      status: 'completed',
      resultRevision: 1,
      sourceRevision: 1,
      endedAt: Date.now(),
      result: {
        kind: 'solo',
        participantIds: [reference.principalId],
        outcome: 'completed',
      },
    });
    const administration = new PlatformReleaseAdministration(platform);
    await administration.drain(fixture.description.backendBindingId);
    expect(platform.catalog()).toEqual([]);
    await administration.retain(fixture.description.backendBindingId);
    expect(platform.catalog()).toEqual([]);
    await new ReleaseRegistry(store).retireBinding(
      {
        platformId,
        backendBindingId: fixture.description.backendBindingId,
      },
      {
        probe: async () => ({
          checkedAt: Date.now(),
          usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
          replay: { status: 'expired', originalClient: 'expired' },
        }),
      },
    );
    await fixture.transport.close();

    const restored = runtime(store, admissionStore, completionStore);
    await expect(restored.restoreRemoteGames()).resolves.toHaveLength(1);
    await expect(
      restored.results.getCompletion(reference, session.sessionId),
    ).resolves.toMatchObject({
      status: 'completed',
      completion: { route: { releaseId: 'remote-retired' } },
    });
    expect(restored.catalog()).toEqual([]);
    expect(() =>
      restored.publicModeId(gameId, 'solo', 'remote-retired'),
    ).toThrow('platform.mode.entry_unavailable');
  });
});
