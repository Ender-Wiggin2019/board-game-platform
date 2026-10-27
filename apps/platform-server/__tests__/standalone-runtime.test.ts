import type {
  GameServiceDescription,
  SessionRoute,
} from '@board-game/contracts';
import type { PlatformApplicationRuntime } from '@board-platform/server/platform/PlatformApplicationRuntime.js';
import type {
  ReleaseBindingRecord,
  ReleaseRecord,
} from '@board-platform/server/platform/releases/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StandalonePlatformConfig } from '../src/config.js';
import {
  createStandaloneRemoteRuntime,
  StandaloneFactIngressLifecycle,
} from '../src/standalone-runtime.js';

const token = 'standalone-fact-token-012345678901234567890123';
const route: SessionRoute = {
  gameId: 'game',
  modeId: 'standard',
  sessionId: 'session',
  releaseId: 'release',
  backendBindingId: 'binding',
  storageBindingId: 'storage',
  ownershipEpoch: 'epoch',
};

describe('standalone platform default fact ingress', () => {
  const previous = process.env.BGP_TEST_FACT_TOKEN;
  afterEach(() => {
    if (previous === undefined) delete process.env.BGP_TEST_FACT_TOKEN;
    else process.env.BGP_TEST_FACT_TOKEN = previous;
  });

  it('starts an authenticated listener from secret references and closes it', async () => {
    process.env.BGP_TEST_FACT_TOKEN = token;
    const ingest = vi.fn().mockResolvedValue({
      envelopeKey: 'session:event',
      producerId: 'producer',
      eventId: 'event',
      digest: 'sha256:digest',
    });
    const runtime = {
      factReceiver: { ingest },
    } as unknown as PlatformApplicationRuntime;
    const config = {
      platformId: 'platform',
      factIngressCredentials: [
        {
          tokenRef: 'env:BGP_TEST_FACT_TOKEN',
          source: {
            gameId: route.gameId,
            releaseId: route.releaseId,
            backendBindingId: route.backendBindingId,
            ownershipEpoch: route.ownershipEpoch,
          },
        },
      ],
      factIngressHost: '127.0.0.1',
    } as unknown as StandalonePlatformConfig;
    const lifecycle = new StandaloneFactIngressLifecycle(runtime, config);
    await lifecycle.onApplicationBootstrap();
    const address = lifecycle.listeningAddress;
    expect(address?.port).toBeGreaterThan(0);
    const response = await fetch(`http://127.0.0.1:${address?.port}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        platformId: 'platform',
        deliveries: [
          {
            route,
            fact: {
              producerId: 'producer',
              eventId: 'event',
              kind: 'SessionCompleted',
              schemaVersion: 1,
              sourceRelease: route.releaseId,
              payload: {},
            },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith({
      source: {
        gameId: route.gameId,
        releaseId: route.releaseId,
        backendBindingId: route.backendBindingId,
        ownershipEpoch: route.ownershipEpoch,
      },
      route,
      fact: expect.any(Object),
    });
    await lifecycle.beforeApplicationShutdown();
    await expect(
      fetch(`http://127.0.0.1:${address?.port}/v1/facts`),
    ).rejects.toThrow();
  });

  it('refreshes ready registry bindings without restarting the listener', async () => {
    const dynamicToken = 'dynamic-fact-token-012345678901234567890123';
    const binding = {
      platformId: 'platform',
      backendBindingId: route.backendBindingId,
      gameId: route.gameId,
      releaseId: route.releaseId,
      storageBindingId: route.storageBindingId,
      ownershipEpoch: route.ownershipEpoch,
      deployment: 'external',
      controlEndpoint: 'https://control.example.test',
      playerEndpoint: 'https://player.example.test',
      clientArtifactBaseUrl: 'https://client.example.test',
      serviceCredentialRef: 'secrets/fact-binding',
      status: 'ready',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as ReleaseBindingRecord;
    let bindings: readonly ReleaseBindingRecord[] = [];
    const ingest = vi.fn().mockResolvedValue({
      envelopeKey: 'session:event',
      producerId: 'producer',
      eventId: 'event',
      digest: 'sha256:digest',
    });
    const runtime = {
      factReceiver: { ingest },
      releaseRegistry: {
        listBindings: vi.fn(async () => bindings),
      },
    } as unknown as PlatformApplicationRuntime;
    const resolveCredential = vi.fn().mockResolvedValue(dynamicToken);
    const config = {
      platformId: 'platform',
      factIngressHost: '127.0.0.1',
    } as unknown as StandalonePlatformConfig;
    const lifecycle = new StandaloneFactIngressLifecycle(
      runtime,
      config,
      resolveCredential,
    );
    await lifecycle.onApplicationBootstrap();
    expect(lifecycle.listeningAddress).toBeUndefined();

    bindings = [binding];
    await lifecycle.refreshNow();
    const address = lifecycle.listeningAddress;
    expect(address?.port).toBeGreaterThan(0);
    expect(resolveCredential).toHaveBeenCalledWith(
      'secrets/fact-binding',
      binding,
    );
    expect(lifecycle.status.lastSuccess).toEqual(expect.any(Number));
    expect(lifecycle.status.lastError).toBeNull();

    const response = await fetch(`http://127.0.0.1:${address?.port}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${dynamicToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        platformId: 'platform',
        deliveries: [
          {
            route,
            fact: {
              producerId: 'producer',
              eventId: 'event',
              kind: 'SessionCompleted',
              schemaVersion: 1,
              sourceRelease: route.releaseId,
              payload: {},
            },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith({
      source: {
        gameId: route.gameId,
        releaseId: route.releaseId,
        backendBindingId: route.backendBindingId,
        ownershipEpoch: route.ownershipEpoch,
      },
      route,
      fact: expect.any(Object),
    });
    await lifecycle.beforeApplicationShutdown();
  });

  it('exposes sanitized credential refresh failures for readiness', async () => {
    const binding = {
      platformId: 'platform',
      backendBindingId: 'binding-status',
      gameId: 'game',
      releaseId: 'release',
      storageBindingId: 'storage',
      ownershipEpoch: 'epoch',
      deployment: 'external',
      controlEndpoint: 'https://control.example.test',
      playerEndpoint: 'https://player.example.test',
      clientArtifactBaseUrl: 'https://client.example.test',
      serviceCredentialRef: 'secrets/fact-status',
      status: 'ready',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as ReleaseBindingRecord;
    const runtime = {
      factReceiver: { ingest: vi.fn() },
      releaseRegistry: { listBindings: async () => [binding] },
    } as unknown as PlatformApplicationRuntime;
    const lifecycle = new StandaloneFactIngressLifecycle(
      runtime,
      { platformId: 'platform' } as unknown as StandalonePlatformConfig,
      async () => {
        throw new Error('secret-ref token-value must not escape');
      },
    );
    await expect(lifecycle.onApplicationBootstrap()).rejects.toThrow(
      'platform fact ingress refresh failed',
    );
    expect(lifecycle.status.lastError).toMatchObject({
      code: 'CREDENTIAL_RESOLUTION_FAILED',
    });
    expect(JSON.stringify(lifecycle.status)).not.toContain('token-value');
    await lifecycle.beforeApplicationShutdown();
  });
});

describe('standalone remote policy capacity declarations', () => {
  it('passes the release room capacity declaration through unchanged', async () => {
    const service = {
      setupSchema: {
        schema: { type: 'object', properties: {} },
      },
      roomCapacity: {
        playerCountPath: ['options', 'playerCount'],
        defaultPlayerCount: 2,
      },
    } as unknown as GameServiceDescription;
    const release = {
      service,
      manifest: { modes: [] },
      approvedModes: [],
    } as unknown as ReleaseRecord;
    const runtime = createStandaloneRemoteRuntime(
      { platformId: 'platform' } as StandalonePlatformConfig,
      {} as never,
    );
    expect(
      (await runtime.resolvePolicy(release, {} as ReleaseBindingRecord))
        .roomCapacity,
    ).toEqual(service.roomCapacity);
  });
});
