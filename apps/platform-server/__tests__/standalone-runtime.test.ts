import {
  chmod,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  createStandaloneServiceCredentialResolver,
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

const bindingFor = (
  candidate: SessionRoute,
  serviceCredentialRef: string,
  revision = 1,
): ReleaseBindingRecord =>
  ({
    platformId: 'platform',
    backendBindingId: candidate.backendBindingId,
    gameId: candidate.gameId,
    releaseId: candidate.releaseId,
    storageBindingId: candidate.storageBindingId,
    ownershipEpoch: candidate.ownershipEpoch,
    deployment: 'external',
    controlEndpoint: 'https://control.example.test',
    playerEndpoint: 'https://player.example.test',
    clientArtifactBaseUrl: 'https://client.example.test',
    serviceCredentialRef,
    status: 'ready',
    revision,
    createdAt: 1,
    updatedAt: 1,
  }) as unknown as ReleaseBindingRecord;

describe('standalone service credential resolver', () => {
  it('keeps env compatibility and reads atomic local files safely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bgp-service-credentials-'));
    const outside = await mkdtemp(join(tmpdir(), 'bgp-service-outside-'));
    const file = join(directory, 'v1');
    const outsideFile = join(outside, 'outside');
    const tokenA = 'local-service-token-a-012345678901234567890';
    const tokenB = 'local-service-token-b-012345678901234567890';
    try {
      await writeFile(file, `${tokenA}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      const resolveCredential =
        createStandaloneServiceCredentialResolver(directory);
      await expect(
        resolveCredential('secrets/v1', {} as ReleaseBindingRecord),
      ).resolves.toBe(tokenA);

      const replacement = join(directory, '.v1.tmp');
      await writeFile(replacement, `${tokenB}\n`, { mode: 0o600 });
      await chmod(replacement, 0o600);
      await rename(replacement, file);
      await expect(
        resolveCredential('secrets/v1', {} as ReleaseBindingRecord),
      ).resolves.toBe(tokenB);

      await expect(
        resolveCredential('secrets/v1/extra', {} as ReleaseBindingRecord),
      ).rejects.toThrow('unsupported');
      await expect(
        resolveCredential('secrets/../outside', {} as ReleaseBindingRecord),
      ).rejects.toThrow('unsupported');

      await chmod(file, 0o644);
      await expect(
        resolveCredential('secrets/v1', {} as ReleaseBindingRecord),
      ).rejects.toThrow('unsafe permissions');
      await chmod(file, 0o600);

      await writeFile(outsideFile, tokenA, { mode: 0o600 });
      await chmod(outsideFile, 0o600);
      await rm(file);
      await symlink(outsideFile, file);
      let error: unknown;
      try {
        await resolveCredential('secrets/v1', {} as ReleaseBindingRecord);
      } catch (value) {
        error = value;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(tokenA);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

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

  it('adds and rotates local-file binding credentials without replacing the listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bgp-service-credentials-'));
    const tokenA = 'local-binding-token-a-012345678901234567890';
    const tokenB = 'local-binding-token-b-012345678901234567890';
    const tokenC = 'local-binding-token-c-012345678901234567890';
    const routeTwo: SessionRoute = {
      ...route,
      gameId: 'game-two',
      sessionId: 'session-two',
      releaseId: 'release-two',
      backendBindingId: 'binding-two',
      storageBindingId: 'storage-two',
      ownershipEpoch: 'epoch-two',
    };
    const fileOne = join(directory, 'v1');
    const fileTwo = join(directory, 'v2');
    await writeFile(fileOne, tokenA, { mode: 0o600 });
    await writeFile(fileTwo, tokenB, { mode: 0o600 });
    await chmod(fileOne, 0o600);
    await chmod(fileTwo, 0o600);
    const bindingOne = bindingFor(route, 'secrets/v1');
    const bindingTwo = bindingFor(routeTwo, 'secrets/v2');
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
    const lifecycle = new StandaloneFactIngressLifecycle(runtime, {
      platformId: 'platform',
      factIngressHost: '127.0.0.1',
      serviceCredentialDirectory: directory,
    } as unknown as StandalonePlatformConfig);
    const sendFact = async (accessToken: string, candidate: SessionRoute) =>
      fetch(`http://127.0.0.1:${lifecycle.listeningAddress?.port}/v1/facts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          platformId: 'platform',
          deliveries: [
            {
              route: candidate,
              fact: {
                producerId: 'producer',
                eventId: candidate.sessionId,
                kind: 'SessionCompleted',
                schemaVersion: 1,
                sourceRelease: candidate.releaseId,
                payload: {},
              },
            },
          ],
        }),
      });
    try {
      await lifecycle.onApplicationBootstrap();
      bindings = [bindingOne];
      await lifecycle.refreshNow();
      const address = lifecycle.listeningAddress;
      expect(address?.port).toBeGreaterThan(0);

      bindings = [bindingOne, bindingTwo];
      await lifecycle.refreshNow();
      expect(lifecycle.listeningAddress).toEqual(address);
      expect((await sendFact(tokenB, routeTwo)).status).toBe(200);

      const replacement = join(directory, '.v2.tmp');
      await writeFile(replacement, tokenC, { mode: 0o600 });
      await chmod(replacement, 0o600);
      await rename(replacement, fileTwo);
      await lifecycle.refreshNow();
      expect(lifecycle.listeningAddress).toEqual(address);
      expect((await sendFact(tokenC, routeTwo)).status).toBe(200);

      await writeFile(replacement, tokenA, { mode: 0o600 });
      await chmod(replacement, 0o600);
      await rename(replacement, fileTwo);
      await expect(lifecycle.refreshNow()).rejects.toThrow(
        'platform fact ingress refresh failed',
      );
      expect(lifecycle.status.lastError).toMatchObject({
        code: 'CREDENTIAL_CONFLICT',
      });
      expect((await sendFact(tokenC, routeTwo)).status).toBe(200);
    } finally {
      await lifecycle.beforeApplicationShutdown();
      await rm(directory, { recursive: true, force: true });
    }
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
