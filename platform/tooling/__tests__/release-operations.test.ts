import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GameServiceDescription,
  ReleaseManifest,
} from '@board-game/contracts';
import { packRelease } from '@board-game/tooling/release';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createReleaseOperations,
  HttpPlatformOperationsClient,
  HttpReleaseArtifactPublisher,
  type PlatformOperationsRequest,
  type PlatformOperationsTransport,
  type RegisterStagedReleasePayload,
  stableReleaseOperationId,
} from '../src/release-operations.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function stagedPayload(): RegisterStagedReleasePayload {
  return {
    manifest: {} as ReleaseManifest,
    service: {} as GameServiceDescription,
    approvedFeatures: ['results'],
    approvedModes: ['standard'],
    binding: {
      deployment: 'external',
      controlEndpoint: 'https://game.example.test/control',
      playerEndpoint: 'https://game.example.test/player',
      clientArtifactBaseUrl: 'https://game.example.test/client/',
      serviceCredentialRef: 'secrets/game-service',
    },
  };
}

function releaseManifest(): ReleaseManifest {
  return {
    manifestVersion: '1.0',
    gameId: 'example',
    releaseId: 'example-v1',
    displayVersion: '1.0.0',
    publisherId: 'publisher',
    integration: {
      profile: 'legacy-service-v1',
      protocolMajor: 1,
      requiredFeatures: [],
    },
    artifacts: {
      client: { artifactId: 'client', digest: `sha256:${'0'.repeat(64)}` },
      server: { artifactId: 'server', digest: `sha256:${'0'.repeat(64)}` },
      publicAssets: {
        artifactId: 'public-assets',
        digest: `sha256:${'0'.repeat(64)}`,
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
    capabilities: { minPlayers: 1, maxPlayers: 2, features: [] },
    modes: [
      {
        id: 'standard',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'progress-only',
        platformRating: false,
        concurrency: 'revision',
      },
    ],
    presentation: {
      mount: 'platform-route',
      layoutProfile: 'default',
      locales: ['en'],
    },
    budgetProfile: 'default',
  };
}

describe('release operations', () => {
  it('uses stable operation ids and keeps dry-run side-effect free', async () => {
    const requestMock = vi.fn(
      async <T>(_input: PlatformOperationsRequest): Promise<T> =>
        ({ accepted: true }) as unknown as T,
    );
    const transport: PlatformOperationsTransport = {
      request: requestMock as unknown as PlatformOperationsTransport['request'],
    };
    const operations = createReleaseOperations({
      platformId: 'platform',
      transport,
    });
    const payload = stagedPayload();
    const first = stableReleaseOperationId({
      platformId: 'platform',
      action: 'register',
      identity: { z: 1, a: 2 },
    });
    const second = stableReleaseOperationId({
      platformId: 'platform',
      action: 'register',
      identity: { a: 2, z: 1 },
    });
    expect(first).toBe(second);
    expect(first).toMatch(/^bgp-register-[a-f0-9]{32}$/u);

    const preview = await operations.register({ ...payload, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.request?.path).toBe('/platform/admin/releases');
    expect(transport.request).not.toHaveBeenCalled();
    await expect(
      operations.register({
        ...payload,
        binding: { ...payload.binding, serviceCredentialRef: 'plain-secret' },
        dryRun: true,
      }),
    ).rejects.toThrow('env: or secrets/ reference');
  });

  it('maps register, readiness, activation, rollback and drain to strict admin routes', async () => {
    const calls: unknown[] = [];
    const requestMock = vi.fn(
      async <T>(input: PlatformOperationsRequest): Promise<T> => {
        calls.push(input);
        return { accepted: true } as unknown as T;
      },
    );
    const transport: PlatformOperationsTransport = {
      request: requestMock as unknown as PlatformOperationsTransport['request'],
    };
    const operations = createReleaseOperations({
      platformId: 'platform',
      transport,
    });
    await operations.register(stagedPayload());
    await operations.ready({ backendBindingId: 'binding' });
    await operations.activate({ backendBindingId: 'binding' });
    await operations.rollback({
      gameId: 'example',
      modeId: 'standard',
      channel: 'stable',
      expectedRevision: 3,
      targetBackendBindingId: 'old-binding',
    });
    await operations.drain({ backendBindingId: 'binding' });

    expect(calls).toHaveLength(5);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/platform/admin/releases',
      body: stagedPayload(),
    });
    expect(calls[1]).toMatchObject({
      path: '/platform/admin/releases/bindings/binding/ready',
      body: {},
    });
    expect(calls[2]).toMatchObject({
      path: '/platform/admin/releases/bindings/binding/activate',
      body: {},
    });
    expect(calls[3]).toMatchObject({
      path: '/platform/admin/releases/channels/switch',
      body: {
        gameId: 'example',
        modeId: 'standard',
        channel: 'stable',
        expectedRevision: 3,
        targetBackendBindingId: 'old-binding',
      },
    });
    expect(
      (calls[3] as { body: { operationId: string } }).body.operationId,
    ).toBe((calls[3] as { operationId: string }).operationId);
    expect(calls[4]).toMatchObject({
      path: '/platform/admin/releases/bindings/binding/drain',
      body: {},
    });
    for (const call of calls)
      expect((call as { operationId: string }).operationId).toMatch(
        /^bgp-(?:register|ready|activate|rollback|drain)-[a-f0-9]{32}$/u,
      );
  });

  it('verifies packed releases before publishing and never publishes in dry-run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-release-operations-'));
    workspaces.push(root);
    const sources = {
      client: join(root, 'client'),
      server: join(root, 'server'),
      publicAssets: join(root, 'public-assets'),
    };
    await Promise.all(
      Object.values(sources).map((directory) => mkdir(directory)),
    );
    await Promise.all(
      Object.entries(sources).map(([key, directory]) =>
        writeFile(join(directory, `${key}.txt`), key),
      ),
    );
    const packed = join(root, 'packed');
    await packRelease(releaseManifest(), sources, packed);
    const publisher = {
      publish: vi.fn(async () => ({ uri: 'artifact://example-v1' })),
    };
    const operations = createReleaseOperations({
      platformId: 'platform',
      publisher,
    });
    const preview = await operations.publish({
      releaseDirectory: packed,
      dryRun: true,
    });
    expect(preview.release).toMatchObject({
      gameId: 'example',
      releaseId: 'example-v1',
    });
    expect(publisher.publish).not.toHaveBeenCalled();
    const result = await operations.publish({ releaseDirectory: packed });
    expect(result.result).toEqual({ uri: 'artifact://example-v1' });
    expect(publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        releaseDirectory: packed,
        operationId: result.operationId,
      }),
    );
  });

  it('uploads every packed object at immutable digest paths and accepts only same-byte 409 retries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-release-store-'));
    workspaces.push(root);
    const sources = {
      client: join(root, 'client'),
      server: join(root, 'server'),
      publicAssets: join(root, 'public-assets'),
    };
    await Promise.all(
      Object.values(sources).map((directory) => mkdir(directory)),
    );
    await writeFile(
      join(sources.client, 'entry.js'),
      'export const mount = () => {};',
    );
    await writeFile(join(sources.client, 'theme.css'), '.game { color: red; }');
    await Promise.all(
      Object.entries(sources).map(([key, directory]) =>
        writeFile(join(directory, `${key}.txt`), key),
      ),
    );
    const packed = join(root, 'packed');
    const packedManifest = await packRelease(
      releaseManifest(),
      sources,
      packed,
    );
    const objects = new Map<string, Buffer>();
    const headersByPath = new Map<
      string,
      { contentType: unknown; visibility: unknown }
    >();
    const server = createServer((request, response) => {
      const key = request.url ?? '/';
      if (request.method === 'GET') {
        const bytes = objects.get(key);
        if (!bytes) {
          response.statusCode = 404;
          response.end();
        } else {
          response.statusCode = 200;
          response.end(bytes);
        }
        return;
      }
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (objects.has(key)) response.statusCode = 409;
        else {
          objects.set(key, bytes);
          headersByPath.set(key, {
            contentType: request.headers['content-type'],
            visibility: request.headers['x-bgp-artifact-visibility'],
          });
          response.statusCode = 201;
        }
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const previous = process.env.BGP_TEST_RELEASE_STORE_TOKEN;
    process.env.BGP_TEST_RELEASE_STORE_TOKEN = 'store-token';
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('no address');
      const publisher = new HttpReleaseArtifactPublisher({
        baseUrl: `http://127.0.0.1:${address.port}/objects`,
        tokenRef: 'env:BGP_TEST_RELEASE_STORE_TOKEN',
        allowInsecureLocalhost: true,
      });
      const input = {
        releaseDirectory: packed,
        manifest: packedManifest,
        operationId: 'bgp-publish-test',
      };
      const first = await publisher.publish(input);
      expect(first.objects.uploaded).toBeGreaterThan(0);
      expect(first.manifestUrl).toContain(`/example/example-v1/`);
      const publicRoot = `${first.clientArtifactBaseUrl}example/example-v1/${packedManifest.artifacts.client.digest.slice(7)}/`;
      const jsPath = new URL('client/entry.js', publicRoot).pathname;
      const cssPath = new URL('client/theme.css', publicRoot).pathname;
      expect(objects.get(jsPath)?.toString()).toContain('export const mount');
      expect(headersByPath.get(jsPath)).toEqual({
        contentType: 'text/javascript',
        visibility: 'public',
      });
      expect(headersByPath.get(cssPath)).toEqual({
        contentType: 'text/css',
        visibility: 'public',
      });
      const privatePath = [...objects.keys()].find((path) =>
        path.endsWith('/server/server.txt'),
      );
      expect(privatePath).toMatch(/^\/objects\/private\//u);
      expect(headersByPath.get(privatePath as string)?.visibility).toBe(
        'private',
      );
      expect(
        [...objects.keys()].some(
          (path) => path.includes('/public/') && path.endsWith('/server.txt'),
        ),
      ).toBe(false);
      const second = await publisher.publish(input);
      expect(second.objects.uploaded).toBe(0);
      expect(second.objects.reused).toBe(first.objects.uploaded);
      const firstPath = objects.keys().next().value;
      if (typeof firstPath !== 'string') throw new Error('no uploaded object');
      objects.set(firstPath, Buffer.from('tampered'));
      await expect(publisher.publish(input)).rejects.toThrow(
        'immutable conflict',
      );
    } finally {
      if (previous === undefined)
        delete process.env.BGP_TEST_RELEASE_STORE_TOKEN;
      else process.env.BGP_TEST_RELEASE_STORE_TOKEN = previous;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('plans only target-service up --no-deps and invokes no executor during dry-run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-deploy-operations-'));
    workspaces.push(root);
    const image = `registry.example/platform@sha256:${'0'.repeat(64)}`;
    const gameImage = `registry.example/example@sha256:${'1'.repeat(64)}`;
    const config = {
      schemaVersion: 1,
      platform: {
        id: 'platform',
        image,
        databaseUrlEnv: 'PLATFORM_DATABASE_URL',
        features: {},
      },
      games: {
        example: {
          enabled: true,
          release: 'example-v1',
          manifestRef: 'missing-release.json',
          runtime: {
            schemaVersion: 1,
            gameId: 'example',
            releaseId: 'example-v1',
            environment: 'production',
            storage: {
              driver: 'postgres',
              urlEnv: 'GAME_DATABASE_URL',
              namespace: 'example',
            },
            replay: {
              enabled: true,
              source: 'game-storage',
              retentionPolicy: 'standard',
              archive: 'disabled',
            },
            platformConnection: {
              platformId: 'platform',
              apiUrlEnv: 'PLATFORM_API_URL',
              issuer: 'platform',
              verificationKeysRef: 'env:PLATFORM_VERIFICATION_KEYS',
              serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
              audience: 'example-v1',
              serviceTokenExpiresAtEnv: 'GAME_SERVICE_TOKEN_EXPIRES_AT_MS',
              factCredentialRef: 'env:GAME_FACT_CREDENTIAL',
              authorizationCredentialRef: 'env:GAME_AUTHORIZATION_CREDENTIAL',
            },
            binding: {
              backendBindingId: 'example-v1-backend',
              storageBindingId: 'example-v1-storage',
              ownershipEpoch: '1',
            },
            transport: {
              host: '0.0.0.0',
              controlPort: 3000,
              playerPort: 3001,
              authorizationPort: 3002,
              allowedOrigins: [],
            },
          },
          deployment: {
            kind: 'managed',
            adapter: 'compose',
            image: gameImage,
            runtimeConfig: 'runtime/example-v1.json',
          },
          approvedCapabilities: ['results'],
        },
      },
    };
    const lock = {
      schemaVersion: 1,
      platform: { id: 'platform', image },
      games: {
        example: {
          release: 'example-v1',
          manifestRef: 'missing-release.json',
          image: gameImage,
          sourceSha: `sha256:${'2'.repeat(64)}`,
          artifacts: {
            client: `sha256:${'3'.repeat(64)}`,
            server: `sha256:${'4'.repeat(64)}`,
            publicAssets: `sha256:${'5'.repeat(64)}`,
          },
        },
      },
    };
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(
      join(root, 'runtime/example-v1.json'),
      JSON.stringify(config.games.example.runtime),
    );
    await writeFile(join(root, 'platform.config.json'), JSON.stringify(config));
    await writeFile(join(root, 'games.lock.json'), JSON.stringify(lock));
    const executor = { run: vi.fn(async () => ({ started: true })) };
    const operations = createReleaseOperations({
      platformId: 'platform',
      composeExecutor: executor,
    });
    const preview = await operations.deploy({
      workspaceRoot: root,
      targetGameId: 'example',
      dryRun: true,
    });
    expect(preview.plan?.command).toEqual([
      'docker',
      'compose',
      '--project-name',
      'bgp-platform',
      '-f',
      `deployments/${preview.plan?.targetService}.compose.yaml`,
      'up',
      '--detach',
      '--no-deps',
      preview.plan?.targetService,
    ]);
    expect(preview.plan?.command).not.toContain('down');
    expect(executor.run).not.toHaveBeenCalled();
    const result = await operations.deploy({
      workspaceRoot: root,
      targetGameId: 'example',
    });
    expect(result.result).toEqual({ started: true });
    expect(executor.run).toHaveBeenCalledWith({
      plan: expect.objectContaining({
        targetService: preview.plan?.targetService,
      }),
      operationId: result.operationId,
    });
  });
});

describe('HTTP release operations transport', () => {
  it('sends the stable operation id as an audit header without changing strict bodies', async () => {
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            path: request.url,
            operationId: request.headers['x-bgp-operation-id'],
            body: JSON.parse(body),
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('no address');
      const client = new HttpPlatformOperationsClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: 'admin-token',
        allowInsecureLocalhost: true,
      });
      await expect(
        client.request({
          method: 'POST',
          path: '/platform/admin/releases/bindings/binding/ready',
          body: {},
          operationId: 'bgp-ready-operation',
        }),
      ).resolves.toEqual({
        path: '/platform/admin/releases/bindings/binding/ready',
        operationId: 'bgp-ready-operation',
        body: {},
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
