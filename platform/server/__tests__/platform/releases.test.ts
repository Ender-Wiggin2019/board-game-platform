import { randomUUID } from 'node:crypto';
import type {
  GameServiceDescription,
  ReleaseManifest,
} from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryReleaseRegistryStore,
  PostgresReleaseRegistryStore,
  type ReleaseBindingRecord,
  type ReleaseRecord,
  ReleaseRegistry,
  ReleaseRegistryError,
} from '@/platform/releases/index.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

const mode = {
  id: 'standard',
  entry: 'room' as const,
  minPlayers: 2,
  maxPlayers: 4,
  history: 'summary-and-replay' as const,
  platformRating: true,
  concurrency: 'revision' as const,
};

const setupSchema = {
  name: 'release-test.setup',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: { seed: { type: 'string' as const } },
    required: ['seed'],
    additionalProperties: false,
  },
};

function makeRelease(
  releaseId: string,
  backendBindingId: string,
  storageBindingId: string,
  ownershipEpoch: string,
): {
  readonly manifest: ReleaseManifest;
  readonly service: GameServiceDescription;
} {
  const manifest: ReleaseManifest = {
    manifestVersion: '1.0',
    gameId: 'release-test-game',
    releaseId,
    displayVersion: releaseId,
    publisherId: 'release-test-publisher',
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
    capabilities: {
      minPlayers: 2,
      maxPlayers: 4,
      features: ['replay'],
    },
    modes: [mode],
    presentation: {
      mount: 'platform-route',
      layoutProfile: 'default',
      locales: ['en'],
    },
    budgetProfile: 'standard',
  };
  const service: GameServiceDescription = {
    schemaVersion: 1,
    platformId: 'release-test-platform',
    gameId: manifest.gameId,
    releaseId,
    backendBindingId,
    storageBindingId,
    ownershipEpoch,
    metadata: {
      gameId: manifest.gameId,
      name: 'Release test game',
      description: 'A bounded release registry test fixture.',
      themeId: 'release-test',
    },
    modes: [mode],
    setupSchema,
  };
  return { manifest, service };
}

function bindingInput(
  release: ReleaseRecord,
  bindingId = release.service.backendBindingId,
) {
  return {
    platformId: release.platformId,
    gameId: release.gameId,
    releaseId: release.releaseId,
    backendBindingId: bindingId,
    storageBindingId: release.service.storageBindingId,
    ownershipEpoch: release.service.ownershipEpoch,
    deployment: 'external' as const,
    controlEndpoint: `control-${bindingId}`,
    playerEndpoint: `player-${bindingId}`,
    authorizationEndpoint: `authorization-${bindingId}`,
    clientArtifactBaseUrl: `assets-${bindingId}`,
    serviceCredentialRef: `credential-${bindingId}`,
    now: 10,
  };
}

function readiness(
  release: ReleaseRecord,
  binding: ReleaseBindingRecord,
  checkedAt = 20,
) {
  return {
    probeId: `probe-${binding.backendBindingId}`,
    checkedAt,
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
  };
}

async function installReady(
  registry: ReleaseRegistry,
  releaseId: string,
  bindingId: string,
  storageId: string,
  epoch: string,
): Promise<{
  readonly release: ReleaseRecord;
  readonly binding: ReleaseBindingRecord;
}> {
  const definition = makeRelease(releaseId, bindingId, storageId, epoch);
  const release = await registry.registerRelease({
    platformId: 'release-test-platform',
    ...definition,
    approvedFeatures: ['replay'],
    approvedModes: ['standard'],
    now: 10,
  });
  await registry.registerBinding(bindingInput(release));
  const ready = await registry.readyBinding(
    'release-test-platform',
    bindingId,
    {
      probe: async ({ release: probedRelease, binding: probedBinding }) =>
        readiness(probedRelease, probedBinding),
    },
  );
  return { release, binding: ready };
}

async function exerciseRegistry(
  store: MemoryReleaseRegistryStore | PostgresReleaseRegistryStore,
) {
  const registry = new ReleaseRegistry(store);
  const v1 = await installReady(
    registry,
    'release-v1',
    'binding-v1',
    'storage-v1',
    'epoch-v1',
  );
  expect(v1.binding.authorizationEndpoint).toBe('authorization-binding-v1');
  await installReady(
    registry,
    'release-v2',
    'binding-v2',
    'storage-v2',
    'epoch-v2',
  );

  const first = await registry.compareAndSwapChannel({
    platformId: 'release-test-platform',
    gameId: 'release-test-game',
    modeId: 'standard',
    channel: 'stable',
    expectedRevision: 0,
    targetBackendBindingId: 'binding-v1',
    operationId: 'channel-op-v1',
    now: 30,
  });
  expect(first.targetBackendBindingId).toBe('binding-v1');
  expect(
    await registry.compareAndSwapChannel({
      platformId: 'release-test-platform',
      gameId: 'release-test-game',
      modeId: 'standard',
      channel: 'stable',
      expectedRevision: 0,
      targetBackendBindingId: 'binding-v1',
      operationId: 'channel-op-v1',
      now: 31,
    }),
  ).toEqual(first);
  await expect(
    registry.compareAndSwapChannel({
      platformId: 'release-test-platform',
      gameId: 'release-test-game',
      modeId: 'standard',
      channel: 'stable',
      expectedRevision: 1,
      targetBackendBindingId: 'binding-v2',
      operationId: 'channel-op-v1',
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });

  const second = await registry.compareAndSwapChannel({
    platformId: 'release-test-platform',
    gameId: 'release-test-game',
    modeId: 'standard',
    channel: 'stable',
    expectedRevision: 1,
    targetBackendBindingId: 'binding-v2',
    operationId: 'channel-op-v2',
    now: 32,
  });
  expect(second.targetBackendBindingId).toBe('binding-v2');
  expect(first.targetBackendBindingId).toBe('binding-v1');

  const rollback = await registry.compareAndSwapChannel({
    platformId: 'release-test-platform',
    gameId: 'release-test-game',
    modeId: 'standard',
    channel: 'stable',
    expectedRevision: 2,
    targetBackendBindingId: 'binding-v1',
    operationId: 'channel-op-rollback',
    now: 33,
  });
  expect(rollback.targetBackendBindingId).toBe('binding-v1');
  expect(rollback.releaseId).toBe(v1.release.releaseId);
  expect(rollback.storageBindingId).toBe(v1.binding.storageBindingId);
  expect(rollback.ownershipEpoch).toBe(v1.binding.ownershipEpoch);
  expect(await registry.listChannels('release-test-platform')).toEqual([
    rollback,
  ]);
  expect(await registry.listChannelHistory('release-test-platform')).toEqual([
    rollback,
    second,
    first,
  ]);
  expect(await registry.listChannelHistory('release-test-platform', 1)).toEqual(
    [rollback],
  );
  expect(await registry.listChannels('other-platform')).toEqual([]);
  expect(await registry.listChannelHistory('other-platform')).toEqual([]);
  await expect(
    registry.listChannelHistory('release-test-platform', 101),
  ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

  await expect(
    registry.drainBinding({
      platformId: 'release-test-platform',
      backendBindingId: 'binding-v1',
    }),
  ).rejects.toMatchObject({ code: 'ACTIVE_CHANNEL' });

  await registry.compareAndSwapChannel({
    platformId: 'release-test-platform',
    gameId: 'release-test-game',
    modeId: 'standard',
    channel: 'stable',
    expectedRevision: 3,
    targetBackendBindingId: 'binding-v2',
    operationId: 'channel-op-v2-again',
  });
  const drained = await registry.drainBinding({
    platformId: 'release-test-platform',
    backendBindingId: 'binding-v1',
  });
  expect(drained.status).toBe('draining');
  await expect(
    registry.retireBinding(
      {
        platformId: 'release-test-platform',
        backendBindingId: 'binding-v1',
      },
      {
        probe: async () => ({
          checkedAt: 40,
          usage: { activeSessions: 1, pendingFacts: 0, settlementBacklog: 0 },
          replay: {
            status: 'replacement-ready' as const,
            replacementBindingId: 'binding-v2',
            originalClient: 'passed' as const,
          },
        }),
      },
    ),
  ).rejects.toMatchObject({ code: 'RETIRE_BLOCKED' });
  await expect(
    registry.retireBinding(
      {
        platformId: 'release-test-platform',
        backendBindingId: 'binding-v1',
      },
      {
        probe: async () => ({
          checkedAt: 41,
          usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
          replay: {
            status: 'replacement-ready' as const,
            replacementBindingId: 'binding-v2',
            originalClient: 'passed' as const,
          },
        }),
      },
    ),
  ).rejects.toMatchObject({
    code: 'RETIRE_BLOCKED',
    message: expect.stringContaining(
      'replacement replay routing is unavailable',
    ),
  });
  const retired = await registry.retireBinding(
    {
      platformId: 'release-test-platform',
      backendBindingId: 'binding-v1',
    },
    {
      probe: async () => ({
        checkedAt: 42,
        usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
        replay: {
          status: 'expired' as const,
          originalClient: 'expired' as const,
        },
      }),
    },
  );
  expect(retired.status).toBe('retired');
  await expect(
    registry.updateBindingEndpoints({
      platformId: 'release-test-platform',
      backendBindingId: 'binding-v1',
      expectedRevision: retired.revision,
      controlEndpoint: 'new-control',
      playerEndpoint: 'new-player',
      clientArtifactBaseUrl: 'new-assets',
      serviceCredentialRef: 'new-credential',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  await expect(
    registry.compareAndSwapChannel({
      platformId: 'release-test-platform',
      gameId: 'release-test-game',
      modeId: 'standard',
      channel: 'stable',
      expectedRevision: 4,
      targetBackendBindingId: 'binding-v1',
      operationId: 'channel-op-retired',
    }),
  ).rejects.toMatchObject({ code: 'NOT_READY' });
}

describe('ReleaseRegistry memory', () => {
  it('retains an immutable JSON settlement bundle and explicit policy approval', async () => {
    const store = new MemoryReleaseRegistryStore();
    const registry = new ReleaseRegistry(store);
    const definition = makeRelease(
      'release-policy',
      'binding-policy',
      'storage-policy',
      'epoch-policy',
    );
    const policyBundle = {
      schemaVersion: 1,
      gameId: 'release-test-game',
      releaseId: 'release-policy',
      approvedModes: ['standard'],
      rating: { policyVersion: 'rating-v1' },
    } as const;
    const release = await registry.registerRelease({
      platformId: 'release-test-platform',
      ...definition,
      approvedFeatures: ['replay'],
      approvedModes: ['standard'],
      policyBundle,
      approvedPolicyVersions: [{ kind: 'rating', version: 'rating-v1' }],
      now: 1,
    });
    expect(release.policyBundle).toEqual(policyBundle);
    expect(release.policyBundleDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(release.approvedPolicyVersions).toEqual([
      { kind: 'rating', version: 'rating-v1' },
    ]);
    await expect(
      registry.registerRelease({
        platformId: 'release-test-platform',
        ...definition,
        approvedFeatures: ['replay'],
        approvedModes: ['standard'],
        policyBundle: { ...policyBundle, releaseId: 'different' },
        approvedPolicyVersions: [{ kind: 'rating', version: 'rating-v1' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const restored = await store.getRelease(
      'release-test-platform',
      'release-test-game',
      'release-policy',
    );
    expect(restored?.policyBundle).toEqual(policyBundle);
  });

  it('registers immutable releases and requires explicit external readiness', async () => {
    const registry = new ReleaseRegistry(new MemoryReleaseRegistryStore());
    const definition = makeRelease(
      'release-v1',
      'binding-v1',
      'storage-v1',
      'epoch-v1',
    );
    const release = await registry.registerRelease({
      platformId: 'release-test-platform',
      ...definition,
      approvedFeatures: ['replay'],
      approvedModes: ['standard'],
      now: 1,
    });
    await expect(
      registry.registerRelease({
        platformId: 'release-test-platform',
        ...definition,
        approvedFeatures: [],
        approvedModes: ['standard'],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const staged = await registry.registerBinding(bindingInput(release));
    expect(staged.status).toBe('staged');
    await expect(
      registry.compareAndSwapChannel({
        platformId: release.platformId,
        gameId: release.gameId,
        modeId: 'standard',
        channel: 'stable',
        expectedRevision: 0,
        targetBackendBindingId: staged.backendBindingId,
        operationId: 'not-ready',
      }),
    ).rejects.toMatchObject({ code: 'NOT_READY' });
    const changed = await registry.updateBindingEndpoints({
      platformId: release.platformId,
      backendBindingId: staged.backendBindingId,
      expectedRevision: staged.revision,
      controlEndpoint: 'control-new',
      playerEndpoint: staged.playerEndpoint,
      clientArtifactBaseUrl: staged.clientArtifactBaseUrl,
      serviceCredentialRef: staged.serviceCredentialRef,
    });
    expect(changed.backendBindingId).toBe(staged.backendBindingId);
    expect(changed.status).toBe('staged');
    expect(changed.authorizationEndpoint).toBe(staged.authorizationEndpoint);
  });

  it('switches and rolls back channels, preserving route pins and idempotency', async () => {
    await exerciseRegistry(new MemoryReleaseRegistryStore());
  });

  it('rejects retired bindings from reactivation', async () => {
    const registry = new ReleaseRegistry(new MemoryReleaseRegistryStore());
    const v1 = await installReady(
      registry,
      'release-v1',
      'binding-v1',
      'storage-v1',
      'epoch-v1',
    );
    await registry.drainBinding({
      platformId: v1.release.platformId,
      backendBindingId: v1.binding.backendBindingId,
    });
    const retained = await registry.retainBinding({
      platformId: v1.release.platformId,
      backendBindingId: v1.binding.backendBindingId,
    });
    expect(retained.status).toBe('retained');
    const retired = await registry.retireBinding(
      {
        platformId: v1.release.platformId,
        backendBindingId: v1.binding.backendBindingId,
      },
      {
        probe: async () => ({
          checkedAt: 50,
          usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
          replay: {
            status: 'expired' as const,
            originalClient: 'expired' as const,
          },
        }),
      },
    );
    expect(retired.status).toBe('retired');
    await expect(
      registry.readyBinding(
        v1.release.platformId,
        v1.binding.backendBindingId,
        {
          probe: async ({ release, binding }) => readiness(release, binding),
        },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('blocks every durable retirement dependency and requires replay retention', async () => {
    const blockers = [
      'activeSessions',
      'pendingFacts',
      'settlementBacklog',
    ] as const;

    for (const blockedField of blockers) {
      const registry = new ReleaseRegistry(new MemoryReleaseRegistryStore());
      const v1 = await installReady(
        registry,
        'release-v1',
        'binding-v1',
        'storage-v1',
        'epoch-v1',
      );
      const v2 = await installReady(
        registry,
        'release-v2',
        'binding-v2',
        'storage-v2',
        'epoch-v2',
      );
      await registry.compareAndSwapChannel({
        platformId: v1.release.platformId,
        gameId: v1.release.gameId,
        modeId: 'standard',
        channel: 'stable',
        expectedRevision: 0,
        targetBackendBindingId: v1.binding.backendBindingId,
        operationId: `retirement-channel-v1-${blockedField}`,
      });
      await registry.compareAndSwapChannel({
        platformId: v1.release.platformId,
        gameId: v1.release.gameId,
        modeId: 'standard',
        channel: 'stable',
        expectedRevision: 1,
        targetBackendBindingId: v2.binding.backendBindingId,
        operationId: `retirement-channel-v2-${blockedField}`,
      });
      await registry.drainBinding({
        platformId: v1.release.platformId,
        backendBindingId: v1.binding.backendBindingId,
      });

      await expect(
        registry.retireBinding(
          {
            platformId: v1.release.platformId,
            backendBindingId: v1.binding.backendBindingId,
          },
          {
            probe: async () => ({
              checkedAt: 50,
              usage: {
                activeSessions: blockedField === 'activeSessions' ? 1 : 0,
                pendingFacts: blockedField === 'pendingFacts' ? 1 : 0,
                settlementBacklog: blockedField === 'settlementBacklog' ? 1 : 0,
              },
              replay: {
                status: 'replacement-ready' as const,
                replacementBindingId: v2.binding.backendBindingId,
                originalClient: 'passed' as const,
              },
            }),
          },
        ),
      ).rejects.toMatchObject({ code: 'RETIRE_BLOCKED' });
    }

    const registry = new ReleaseRegistry(new MemoryReleaseRegistryStore());
    const v1 = await installReady(
      registry,
      'release-v1',
      'binding-v1',
      'storage-v1',
      'epoch-v1',
    );
    await registry.drainBinding({
      platformId: v1.release.platformId,
      backendBindingId: v1.binding.backendBindingId,
    });
    await expect(
      registry.retireBinding(
        {
          platformId: v1.release.platformId,
          backendBindingId: v1.binding.backendBindingId,
        },
        {
          probe: async () => ({
            checkedAt: 51,
            usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
            replay: {
              status: 'replacement-ready' as const,
              replacementBindingId: 'missing-replacement',
              originalClient: 'passed' as const,
            },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'RETIRE_BLOCKED' });
    const expired = await registry.retireBinding(
      {
        platformId: v1.release.platformId,
        backendBindingId: v1.binding.backendBindingId,
      },
      {
        probe: async () => ({
          checkedAt: 52,
          usage: { activeSessions: 0, pendingFacts: 0, settlementBacklog: 0 },
          replay: {
            status: 'expired' as const,
            originalClient: 'expired' as const,
          },
        }),
      },
    );
    expect(expired.status).toBe('retired');
  });
});

postgresSuite('PostgresReleaseRegistryStore', () => {
  const schema = `release_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: Pool;
  let store: PostgresReleaseRegistryStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresReleaseRegistryStore(pool, { schema });
    await store.migrate();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('persists atomic v1/v2 switching, duplicate operations and safe retirement', async () => {
    await exerciseRegistry(store);
  });

  it('serializes same-schema migrations and preserves v1/v2 reads', async () => {
    const migrationSchema = `release_migration_${process.pid}_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)}`;
    const firstStore = new PostgresReleaseRegistryStore(pool, {
      schema: migrationSchema,
    });
    const secondStore = new PostgresReleaseRegistryStore(pool, {
      schema: migrationSchema,
    });
    try {
      await Promise.all([firstStore.migrate(), secondStore.migrate()]);
      const firstRegistry = new ReleaseRegistry(firstStore);
      const secondRegistry = new ReleaseRegistry(secondStore);
      const v1 = await installReady(
        firstRegistry,
        'migration-v1',
        'migration-binding-v1',
        'migration-storage-v1',
        'migration-epoch-v1',
      );
      await installReady(
        secondRegistry,
        'migration-v2',
        'migration-binding-v2',
        'migration-storage-v2',
        'migration-epoch-v2',
      );
      expect(
        await firstRegistry.getRelease(
          v1.release.platformId,
          v1.release.gameId,
          v1.release.releaseId,
        ),
      ).toMatchObject({ releaseId: 'migration-v1' });
      expect(
        await secondRegistry.listReleases(v1.release.platformId),
      ).toHaveLength(2);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
    }
  });
});

describe('ReleaseRegistryError', () => {
  it('keeps stable error codes for callers', () => {
    const error = new ReleaseRegistryError('NOT_READY', 'not ready');
    expect(error.code).toBe('NOT_READY');
    expect(error.retryable).toBe(false);
  });
});
