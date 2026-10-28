import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GameRuntimeConfiguration,
  GameServiceDescription,
  SessionRoute,
} from '@board-game/contracts';
import { RemoteBackendAdapter } from '@board-game/host';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConfiguredGameProcess,
  createGameServerRunner,
  defineGameServer,
  type GameServerRunner,
  HttpAuthorizationVersionClient,
  issuePlayerCredential,
  readGameProcessConfiguration,
  resolveGameProcessSecret,
  runGameServer,
} from '../src/index.js';

const directories: string[] = [];
const runners: GameServerRunner[] = [];
const token = 'configured-game-service-test-token-with-enough-entropy';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const configuration: GameRuntimeConfiguration = {
  schemaVersion: 1,
  gameId: sequentialTurnFixture.gameId,
  releaseId: sequentialTurnFixture.releaseId,
  environment: 'development',
  binding: {
    backendBindingId: 'process-backend',
    storageBindingId: 'process-storage',
    ownershipEpoch: '1',
  },
  storage: { driver: 'memory', namespace: 'configured_game' },
  replay: {
    enabled: true,
    source: 'game-storage',
    retentionPolicy: 'standard',
    archive: 'disabled',
  },
  platformConnection: {
    platformId: 'process-platform',
    issuer: 'process-platform',
    audience: 'players',
    apiUrlEnv: 'FACT_URL',
    verificationKeysRef: 'env:PLAYER_KEY',
    serviceCredentialRef: 'env:SERVICE_TOKEN',
    serviceTokenExpiresAtEnv: 'SERVICE_EXPIRY',
  },
  transport: {
    host: '127.0.0.1',
    controlPort: 0,
    playerPort: 0,
    authorizationPort: 0,
    allowedOrigins: ['http://localhost:5173'],
  },
};
async function fixture(value = configuration) {
  const directory = await mkdtemp(join(tmpdir(), 'bgp-configured-game-'));
  directories.push(directory);
  const path = join(directory, 'runtime.json');
  await writeFile(path, JSON.stringify(value));
  const env = {
    GAME_RUNTIME_CONFIG: path,
    NODE_ENV: 'test',
    FACT_URL: 'http://127.0.0.1:9',
    GAME_ALLOW_INSECURE_LOCALHOST: 'true',
    PLAYER_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    SERVICE_TOKEN: token,
    SERVICE_EXPIRY: String(Date.now() + 60_000),
  };
  return { directory, path, env };
}
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('configured game process', () => {
  it('applies explicit env overrides without accepting an accidental development production process', async () => {
    const input = await fixture();
    const loaded = await readGameProcessConfiguration({
      env: { ...input.env, GAME_RELEASE_ID: 'r2', GAME_PORT: '4100' },
    });
    expect(loaded.configuration.releaseId).toBe('r2');
    expect(loaded.configuration.transport?.controlPort).toBe(4100);
    await expect(
      readGameProcessConfiguration({
        env: { ...input.env, NODE_ENV: 'production' },
      }),
    ).rejects.toThrow('GAME_PROCESS_DEVELOPMENT_CONFIG_IN_PRODUCTION');
  });
  it('reads referenced secret files and rejects symlinks outside the secrets directory', async () => {
    const input = await fixture();
    await mkdir(join(input.directory, 'secrets'));
    await writeFile(join(input.directory, 'secrets', 'service'), token);
    await symlink(
      join(input.directory, 'runtime.json'),
      join(input.directory, 'secrets', 'escape'),
    );
    await expect(
      resolveGameProcessSecret('secrets/service', input.directory),
    ).resolves.toBe(token);
    await expect(
      resolveGameProcessSecret('secrets/escape', input.directory),
    ).rejects.toThrow('GAME_PROCESS_SECRET_REFERENCE_INVALID');
  });
  it('opens an explicit statistics pool and derives a stable namespace', async () => {
    const input = await fixture({
      ...configuration,
      statisticsStorage: {
        driver: 'postgres',
        urlEnv: 'STATISTICS_DATABASE_URL',
        namespace: 'configured_game_statistics',
      },
    });
    const process = await createConfiguredGameProcess({
      env: {
        ...input.env,
        STATISTICS_DATABASE_URL:
          'postgres://statistics:statistics@127.0.0.1:1/statistics',
      },
      describe: (identity): GameServiceDescription => ({
        ...identity,
        schemaVersion: 1,
        metadata: {
          gameId: identity.gameId,
          name: 'Configured fixture',
          description: 'Statistics pool fixture',
          themeId: 'fixture',
        },
        modes: sequentialTurnFixture.modes,
        setupSchema: sequentialTurnFixture.schemas.setup,
      }),
      createRunner: (options, resources) => {
        expect(resources.statisticsNamespace).toBe(
          'configured_game_statistics',
        );
        expect(resources.statisticsPool).toBeDefined();
        return createGameServerRunner({
          ...options,
          definition: defineGameServer({
            manifest: {
              gameId: options.description.gameId,
              releaseId: options.description.releaseId,
            },
            module: { ...sequentialTurnFixture, turn: () => null },
            services: {},
          }),
        });
      },
    });
    runners.push(process.runner);
  });
  it('runs the real Host over separate control, authorization and signed player listeners', async () => {
    const input = await fixture();
    const process = await createConfiguredGameProcess({
      env: input.env,
      describe: (identity): GameServiceDescription => ({
        ...identity,
        schemaVersion: 1,
        metadata: {
          gameId: identity.gameId,
          name: 'Configured fixture',
          description: 'Real Host process test',
          themeId: 'fixture',
        },
        modes: sequentialTurnFixture.modes,
        setupSchema: sequentialTurnFixture.schemas.setup,
      }),
      createRunner: (options) =>
        createGameServerRunner({
          ...options,
          definition: defineGameServer({
            manifest: {
              gameId: options.description.gameId,
              releaseId: options.description.releaseId,
            },
            module: { ...sequentialTurnFixture, turn: () => null },
            services: {},
          }),
        }),
    });
    runners.push(process.runner);
    await runGameServer(process.runner);
    const ports = [
      process.runner.transportAddress?.port,
      process.runner.playerTransportAddress?.port,
      process.runner.authorizationTransportAddress?.port,
    ];
    expect(ports.every((port) => typeof port === 'number' && port > 0)).toBe(
      true,
    );
    expect(new Set(ports).size).toBe(3);
    const backend = new RemoteBackendAdapter({
      baseUrl: `http://127.0.0.1:${ports[0]}`,
      serviceToken: token,
      allowInsecureLocalhost: true,
    });
    const route: SessionRoute = {
      ...(configuration.binding as NonNullable<
        GameRuntimeConfiguration['binding']
      >),
      gameId: configuration.gameId,
      releaseId: configuration.releaseId,
      modeId: 'sequential',
      sessionId: 'configured-session',
    };
    const request = {
      protocolVersion: 1 as const,
      route,
      accessContext: {
        principalId: 'p1',
        authEpoch: '1',
        scopes: ['session:create', 'session:view', 'session:command'],
      },
    };
    await backend.createSession({
      ...request,
      startId: 'configured-start',
      startGeneration: 0,
      setup: { target: 1 },
      seed: 'fixed',
      participants: [
        { principalId: 'p1', seatId: 'seat-1' },
        { principalId: 'p2', seatId: 'seat-2' },
      ],
    });
    await backend.activateSession({ ...request, startId: 'configured-start' });
    const authorization = new HttpAuthorizationVersionClient({
      baseUrl: `http://127.0.0.1:${ports[2]}`,
      token,
      platformId: 'process-platform',
      allowInsecureLocalhost: true,
    });
    await authorization.advance({
      authenticatedPlatformId: 'process-platform',
      platformId: 'process-platform',
      sessionId: route.sessionId,
      route,
      principalId: 'p1',
      seatId: 'seat-1',
      scopes: ['session:view', 'session:command'],
      authEpoch: '1',
      authorizationRevision: 1,
    });
    const playerToken = issuePlayerCredential({
      privateKey,
      platformId: 'process-platform',
      audience: 'players',
      route,
      principalId: 'p1',
      seatId: 'seat-1',
      scopes: ['session:view', 'session:command'],
      authEpoch: '1',
      authorizationRevision: 1,
      now: Date.now(),
    });
    const viewResponse = await fetch(
      `http://127.0.0.1:${ports[1]}/v1/getPlayerView`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${playerToken}`,
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          request: { protocolVersion: 1, route },
        }),
      },
    );
    expect(viewResponse.status).toBe(200);
    const view = (await viewResponse.json()).response;
    expect(view.payload.you.seatId).toBe('seat-1');
    const commandResponse = await fetch(
      `http://127.0.0.1:${ports[1]}/v1/submitCommand`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${playerToken}`,
          'content-type': 'application/json',
          origin: 'http://localhost:5173',
        },
        body: JSON.stringify({
          protocolVersion: 1,
          request: {
            protocolVersion: 1,
            route,
            commandId: 'configured-claim',
            command: { type: 'claim' },
            precondition: { kind: 'revision', expectedRevision: view.revision },
          },
        }),
      },
    );
    expect(commandResponse.status).toBe(200);
    expect((await commandResponse.json()).response.receipt.status).toBe(
      'accepted',
    );
    await expect(backend.getStatus(request)).resolves.toMatchObject({
      status: 'completed',
    });
  });
});
