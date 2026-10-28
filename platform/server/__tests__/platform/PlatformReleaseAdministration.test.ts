import type {
  GameServiceDescription,
  ReleaseManifest,
} from '@board-game/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES_KEY } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformReleaseAdministration } from '@/platform/PlatformReleaseAdministration.js';
import { PlatformReleaseController } from '@/platform/PlatformReleaseController.js';
import {
  type DesiredGameInstallation,
  MemoryReleaseRegistryStore,
  ReleaseRegistry,
} from '@/platform/releases/index.js';

const platformId = 'admin-platform';
const gameId = 'admin-game';
const releaseId = 'admin-release';
const bindingId = 'admin-binding';
const mode = {
  id: 'solo',
  entry: 'direct-solo' as const,
  minPlayers: 1,
  maxPlayers: 1,
  history: 'summary-and-replay' as const,
  platformRating: false,
  concurrency: 'revision' as const,
};
const setupSchema = {
  name: 'admin.setup',
  version: 1,
  schema: { type: 'object' as const, additionalProperties: false },
};

function fixture() {
  const service: GameServiceDescription = {
    schemaVersion: 1,
    platformId,
    gameId,
    releaseId,
    backendBindingId: bindingId,
    storageBindingId: 'admin-storage',
    ownershipEpoch: 'admin-epoch',
    metadata: {
      gameId,
      name: 'Admin game',
      description: 'A release administration fixture.',
      themeId: 'admin',
    },
    modes: [mode],
    setupSchema,
  };
  const manifest: ReleaseManifest = {
    manifestVersion: '1.1',
    gameId,
    releaseId,
    displayVersion: '1.1.0',
    publisherId: 'admin-publisher',
    integration: {
      profile: 'legacy-service-v1',
      protocolMajor: 1,
      requiredFeatures: [],
    },
    artifacts: {
      client: { artifactId: 'client', digest: `sha256:${'1'.repeat(64)}` },
      server: { artifactId: 'server', digest: `sha256:${'2'.repeat(64)}` },
      publicAssets: {
        artifactId: 'assets',
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
    modes: [mode],
    presentation: {
      mount: 'platform-route',
      layoutProfile: 'admin',
      locales: ['en'],
    },
    budgetProfile: 'test',
    clientRuntime: {
      abiVersion: 'board-game-react18-v1',
      format: 'esm',
      entry: 'main.js',
      exportName: 'Game',
      styles: [],
      shared: [],
    },
  };
  return { service, manifest };
}

function runtime(
  store: MemoryReleaseRegistryStore,
  desiredGameInstallations?: readonly DesiredGameInstallation[],
) {
  const registry = new ReleaseRegistry(store);
  return {
    options: {
      platformId,
      allowInsecureLocalhost: false,
      desiredGameInstallations,
    },
    releaseRegistry: registry,
    readyRemoteBinding: vi.fn(),
    refreshRemoteBindingMetadata: vi.fn(),
    switchRemoteChannel: vi.fn(),
    catalog: vi.fn(() => []),
    sessions: {
      descriptor: vi.fn(),
    },
    replaySessions: {
      descriptor: vi.fn(),
    },
  } as unknown as PlatformApplicationRuntime;
}

async function ready(store: MemoryReleaseRegistryStore) {
  const registry = new ReleaseRegistry(store);
  const release = await registry.getRelease(platformId, gameId, releaseId);
  const binding = await registry.getBinding(platformId, bindingId);
  if (!release || !binding) throw new Error('fixture not registered');
  return registry.readyBinding(platformId, bindingId, {
    probe: async () => ({
      probeId: 'probe',
      checkedAt: 1,
      protocol: {
        major: 1,
        minor: 0,
        serviceDigest: release.serviceDigest,
        service: release.service,
      },
      storage: { bindingId: 'admin-storage', schemaVersion: 'storage-v1' },
    }),
  });
}

describe('PlatformReleaseAdministration', () => {
  it('keeps endpoint replacement behind the admin capabilities guard', () => {
    const method = PlatformReleaseController.prototype.updateBindingEndpoints;
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toContain(RolesGuard);
    expect(Reflect.getMetadata(CAPABILITIES_KEY, method)).toEqual([
      ECapability.ADMIN_ACCESS,
      ECapability.GAME_MODIFY_ANY,
    ]);
  });

  it('updates staged endpoints through strict CAS and blocks stale or active bindings', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const administration = new PlatformReleaseAdministration(platform);
    const { manifest, service } = fixture();
    const registered = await administration.registerStaged({
      manifest,
      service,
      approvedFeatures: [],
      approvedModes: ['solo'],
      binding: {
        deployment: 'external',
        controlEndpoint: 'https://control.example.test',
        playerEndpoint: 'https://player.example.test',
        authorizationEndpoint: 'https://authorization.example.test',
        clientArtifactBaseUrl: 'https://cdn.example.test/assets/',
        serviceCredentialRef: 'secret-ref',
      },
    });
    const update = (expectedRevision: number) => ({
      expectedRevision,
      controlEndpoint: 'https://control-v2.example.test',
      playerEndpoint: 'https://player-v2.example.test',
      clientArtifactBaseUrl: 'https://cdn-v2.example.test/assets/',
      serviceCredentialRef: 'secret-ref-v2',
    });

    const changed = await administration.updateBindingEndpoints(
      bindingId,
      update(registered.binding.revision),
    );
    expect(changed).toMatchObject({
      status: 'staged',
      revision: registered.binding.revision + 1,
      controlEndpoint: 'https://control-v2.example.test',
      playerEndpoint: 'https://player-v2.example.test',
      authorizationEndpoint: 'https://authorization.example.test',
      clientArtifactBaseUrl: 'https://cdn-v2.example.test/assets/',
      serviceCredentialRef: 'secret-ref-v2',
    });
    expect(changed.readiness).toBeUndefined();
    expect(platform.refreshRemoteBindingMetadata).toHaveBeenCalledWith(changed);

    await expect(
      administration.updateBindingEndpoints(
        bindingId,
        update(registered.binding.revision),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    await expect(
      Promise.resolve().then(() =>
        administration.updateBindingEndpoints(bindingId, {
          ...update(changed.revision),
          unknown: true,
        }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });

    const readyBinding = await ready(store);
    const registry = new ReleaseRegistry(store);
    await registry.compareAndSwapChannel({
      platformId,
      gameId,
      modeId: mode.id,
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: bindingId,
      operationId: 'endpoint-active-channel',
    });
    await expect(
      administration.updateBindingEndpoints(
        bindingId,
        update(readyBinding.revision),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
  });

  it('exports configured intent, current channels and deduplicated history without changing either source', async () => {
    const store = new MemoryReleaseRegistryStore();
    const administration = new PlatformReleaseAdministration(runtime(store));
    const { manifest, service } = fixture();
    await administration.registerStaged({
      manifest,
      service,
      approvedFeatures: [],
      approvedModes: ['solo'],
      binding: {
        deployment: 'external',
        controlEndpoint: 'https://control.example.test',
        playerEndpoint: 'https://player.example.test',
        clientArtifactBaseUrl: 'https://cdn.example.test/assets/',
        serviceCredentialRef: 'secret-ref',
      },
    });
    await ready(store);
    const operation = {
      platformId,
      gameId,
      modeId: mode.id,
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: bindingId,
      operationId: 'reconciliation-switch',
    };
    const channel = await store.compareAndSwapChannel(operation);
    await store.compareAndSwapChannel(operation);
    const baseline = await administration.reconciliation();
    expect(baseline).toMatchObject({
      desiredConfigured: false,
      desired: [],
      differences: [],
      actual: { channels: [channel] },
      channelHistory: [channel],
    });
    const expected: DesiredGameInstallation = {
      gameId,
      releaseId,
      enabled: true,
      deployment: 'external',
    };
    const cases = [
      { desired: [expected], kinds: [] },
      { desired: [], kinds: ['unconfigured-active-channel'] },
      {
        desired: [{ ...expected, enabled: false }],
        kinds: ['disabled-active-channel'],
      },
      {
        desired: [{ ...expected, deployment: 'managed' as const }],
        kinds: ['missing-ready-binding', 'deployment-mismatch'],
      },
      {
        desired: [{ ...expected, releaseId: 'not-registered' }],
        kinds: ['missing-release', 'missing-ready-binding'],
      },
    ];
    for (const item of cases) {
      const comparison = new PlatformReleaseAdministration(
        runtime(store, item.desired),
      );
      const report = await comparison.reconciliation();
      expect(report.desiredConfigured).toBe(true);
      expect(report.desired).toEqual(item.desired);
      expect(report.differences.map((difference) => difference.kind)).toEqual(
        item.kinds,
      );
      expect(report.actual).toEqual(baseline.actual);
      expect(report.channelHistory).toEqual(baseline.channelHistory);
    }
  });

  it('keeps staged registration strict and hides credential refs from public catalog/locator', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const administration = new PlatformReleaseAdministration(platform);
    const { manifest, service } = fixture();
    const registered = await administration.registerStaged({
      manifest,
      service,
      approvedFeatures: [],
      approvedModes: ['solo'],
      binding: {
        deployment: 'external',
        controlEndpoint: 'https://control.example.test',
        playerEndpoint: 'https://player.example.test',
        authorizationEndpoint: 'https://authorization.example.test',
        clientArtifactBaseUrl: 'https://cdn.example.test/assets/',
        serviceCredentialRef: 'secret-ref',
      },
    });
    expect(registered.binding.status).toBe('staged');
    expect(registered.binding.authorizationEndpoint).toBe(
      'https://authorization.example.test',
    );
    await expect(
      administration.registerStaged({
        manifest,
        service,
        approvedFeatures: [],
        approvedModes: ['solo'],
        binding: {
          deployment: 'external',
          controlEndpoint: 'https://control.example.test',
          playerEndpoint: 'https://player.example.test',
          clientArtifactBaseUrl: 'https://cdn.example.test/assets/',
          serviceCredentialRef: 'secret-ref',
          token: 'must-reject',
        },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });

    await ready(store);
    const catalog = await administration.catalog();
    expect(catalog).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain('secret-ref');
    const registry = new ReleaseRegistry(store);
    await registry.compareAndSwapChannel({
      platformId,
      gameId,
      modeId: mode.id,
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: bindingId,
      operationId: 'catalog-shape',
    });
    await expect(administration.platformCatalog()).resolves.toEqual([
      {
        gameId,
        releaseId,
        mode,
        metadata: service.metadata,
      },
    ]);
    const locator = await administration.clientLocator(
      gameId,
      releaseId,
      bindingId,
    );
    expect(locator.baseUrl).toMatch(
      new RegExp(`/${gameId}/${releaseId}/${'1'.repeat(64)}/$`),
    );
    expect(locator.runtime.entry).toBe('main.js');
    await expect(
      administration.serviceDescription(gameId, releaseId, bindingId),
    ).resolves.toMatchObject({
      gameId,
      releaseId,
      backendBindingId: bindingId,
      storageBindingId: 'admin-storage',
      ownershipEpoch: 'admin-epoch',
    });
    await expect(
      administration.serviceDescription(gameId, releaseId, 'other-binding'),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('authorizes immutable pinned client artifacts through read-only replay access', async () => {
    const store = new MemoryReleaseRegistryStore();
    const platform = runtime(store);
    const administration = new PlatformReleaseAdministration(platform);
    const { manifest, service } = fixture();
    await administration.registerStaged({
      manifest,
      service,
      approvedFeatures: [],
      approvedModes: ['solo'],
      binding: {
        deployment: 'external',
        controlEndpoint: 'https://control.example.test',
        playerEndpoint: 'https://player.example.test',
        clientArtifactBaseUrl: 'https://cdn.example.test/assets/',
        serviceCredentialRef: 'secret-ref',
      },
    });
    await ready(store);
    const descriptor = {
      route: {
        gameId,
        releaseId,
        backendBindingId: bindingId,
        storageBindingId: 'admin-storage',
        ownershipEpoch: 'admin-epoch',
        modeId: 'solo',
        sessionId: 'session-1',
      },
    };
    const sessions = platform.replaySessions as unknown as {
      descriptor: ReturnType<typeof vi.fn>;
    };
    sessions.descriptor.mockResolvedValue(descriptor);
    await expect(
      administration.sessionClientLocator(
        { principalId: 'player', authSessionId: 'auth' },
        'session-1',
      ),
    ).resolves.toMatchObject({
      gameId,
      releaseId,
      clientDigest: `sha256:${'1'.repeat(64)}`,
    });
    expect(sessions.descriptor).toHaveBeenCalledWith(
      { principalId: 'player', authSessionId: 'auth' },
      'session-1',
    );
    expect(platform.sessions.descriptor).not.toHaveBeenCalled();
    await administration.drain(bindingId);
    await administration.retain(bindingId);
    await expect(
      administration.clientLocator(gameId, releaseId, bindingId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
    await expect(
      administration.sessionClientLocator(
        { principalId: 'player', authSessionId: 'auth' },
        'session-1',
      ),
    ).resolves.toMatchObject({ releaseId });
    sessions.descriptor.mockRejectedValue(new Error('replay denied'));
    await expect(
      administration.sessionClientLocator(
        { principalId: 'stranger', authSessionId: 'auth' },
        'session-1',
      ),
    ).rejects.toThrow('replay denied');
  });
});
