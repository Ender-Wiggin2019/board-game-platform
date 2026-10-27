import { type ChildProcess, spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GameServiceDescription,
  ReleaseManifest,
} from '@board-game/contracts';
import {
  HttpFactIngressServer,
  PostgresAdmissionStore,
  PostgresInboxStore,
  PostgresSessionDirectory,
  type TrustedFactIngestorLike,
} from '@board-game/core';
import { RemoteBackendAdapter } from '@board-game/host';
import {
  HttpAuthorizationVersionClient,
  issuePlayerCredential,
  PostgresAuthorizationVersionStore,
} from '@board-game/server';
import { PostgresStorageDriver } from '@board-game/storage';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PostgresCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import {
  type GameAccessPolicy,
  PlatformApplicationRuntime,
} from '@/platform/PlatformApplicationRuntime.js';
import { PostgresReleaseRegistryStore } from '@/platform/releases/store.js';

const platformUrl = process.env.BGP_PLATFORM_TEST_DATABASE_URL;
const gameUrl = process.env.BGP_GAME_TEST_DATABASE_URL;
const suite = platformUrl && gameUrl ? describe : describe.skip;
const fixturePath = fileURLToPath(
  new URL('../fixtures/independent-game-process.mjs', import.meta.url),
);
const processCwd = fileURLToPath(
  new URL('../../../../common/server', import.meta.url),
);
const platformId = 'independent-process-platform';
const principalId = 'process-player';
const audience = 'independent-process-player';
const serviceTokens = {
  v1: 'independent-process-v1-service-token-0123456789',
  v2: 'independent-process-v2-service-token-0123456789',
  peer: 'independent-process-peer-service-token-0123456789',
};
const factTokens = {
  v1: 'independent-process-v1-fact-token-0123456789',
  v2: 'independent-process-v2-fact-token-0123456789',
  peer: 'independent-process-peer-fact-token-0123456789',
};

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
  name: 'independent-process.setup',
  version: 1,
  schema: {
    type: 'object' as const,
    additionalProperties: false,
  },
};

type FixtureName = keyof typeof serviceTokens;

interface FixtureSpec {
  readonly name: FixtureName;
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly port: number;
  readonly playerPort?: number;
  readonly authorizationPort?: number;
  readonly authorizationSchema?: string;
  readonly delayFile?: string;
}

interface RunningFixture extends FixtureSpec {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly endpoint: string;
  readonly playerEndpoint?: string;
  readonly authorizationEndpoint?: string;
}

interface PlatformHarness {
  readonly runtime: PlatformApplicationRuntime;
  readonly storage: PostgresStorageDriver;
  readonly releaseStore: PostgresReleaseRegistryStore;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port missing');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      last = error;
    }
    await sleep(50);
  }
  if (last instanceof Error) throw last;
  throw new Error('condition did not become true before timeout');
}

async function spawnFixture(
  spec: FixtureSpec,
  databaseUrl: string,
  factEndpoint: string,
  publicKeyBase64?: string,
): Promise<RunningFixture> {
  const child = spawn(process.execPath, [fixturePath], {
    cwd: processCwd,
    env: {
      ...process.env,
      BGP_FIXTURE_GAME_ID: spec.gameId,
      BGP_FIXTURE_NAME: spec.name,
      BGP_FIXTURE_RELEASE_ID: spec.releaseId,
      BGP_FIXTURE_PLATFORM_ID: platformId,
      BGP_FIXTURE_DATABASE_URL: databaseUrl,
      BGP_FIXTURE_STORAGE_SCHEMA: spec.storageBindingId,
      BGP_FIXTURE_AUTHORIZATION_SCHEMA:
        spec.authorizationSchema ?? `auth_${spec.storageBindingId}`,
      BGP_FIXTURE_BACKEND_BINDING_ID: spec.backendBindingId,
      BGP_FIXTURE_STORAGE_BINDING_ID: spec.storageBindingId,
      BGP_FIXTURE_OWNERSHIP_EPOCH: spec.ownershipEpoch,
      BGP_FIXTURE_SERVICE_TOKEN: serviceTokens[spec.name],
      BGP_FIXTURE_AUTHORIZATION_TOKEN: serviceTokens[spec.name],
      BGP_FIXTURE_FACT_ENDPOINT: factEndpoint,
      BGP_FIXTURE_FACT_TOKEN: factTokens[spec.name],
      BGP_FIXTURE_PORT: String(spec.port),
      ...(spec.playerPort === undefined
        ? {}
        : { BGP_FIXTURE_PLAYER_PORT: String(spec.playerPort) }),
      ...(spec.authorizationPort === undefined
        ? {}
        : {
            BGP_FIXTURE_AUTHORIZATION_PORT: String(spec.authorizationPort),
          }),
      ...(publicKeyBase64 === undefined
        ? {}
        : {
            BGP_FIXTURE_PLAYER_AUDIENCE: audience,
            BGP_FIXTURE_PLAYER_PUBLIC_KEY_B64: publicKeyBase64,
          }),
      ...(spec.delayFile === undefined
        ? {}
        : { BGP_FIXTURE_DELAY_FILE: spec.delayFile }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });
  return new Promise<RunningFixture>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`fixture startup timed out: ${stderr}`));
    }, 15_000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(`fixture exited before ready (${code ?? signal}): ${stderr}`),
      );
    });
    child.stdout.on('data', (chunk) => {
      output = `${output}${String(chunk)}`;
      for (const line of output.split('\n').slice(0, -1)) {
        try {
          const ready = JSON.parse(line);
          if (ready.ready !== true) continue;
          settled = true;
          clearTimeout(timeout);
          resolve({
            ...spec,
            child,
            pid: child.pid ?? 0,
            endpoint: `http://127.0.0.1:${ready.port}`,
            ...(ready.playerPort === undefined
              ? {}
              : {
                  playerEndpoint: `http://127.0.0.1:${ready.playerPort}`,
                }),
            ...(ready.authorizationPort === undefined
              ? {}
              : {
                  authorizationEndpoint: `http://127.0.0.1:${ready.authorizationPort}`,
                }),
          });
          return;
        } catch {
          // The fixture emits one JSON readiness line; partial chunks are buffered.
        }
      }
      output = output.slice(output.lastIndexOf('\n') + 1);
    });
  });
}

async function killFixture(fixture: RunningFixture): Promise<void> {
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null)
    return;
  const exited = once(fixture.child, 'exit');
  fixture.child.kill('SIGKILL');
  await Promise.race([
    exited.then(() => undefined),
    sleep(5_000).then(() => {
      throw new Error(`fixture ${fixture.gameId} did not exit`);
    }),
  ]);
}

function descriptionFor(spec: FixtureSpec): GameServiceDescription {
  return {
    schemaVersion: 1,
    platformId,
    gameId: spec.gameId,
    releaseId: spec.releaseId,
    backendBindingId: spec.backendBindingId,
    storageBindingId: spec.storageBindingId,
    ownershipEpoch: spec.ownershipEpoch,
    metadata: {
      gameId: spec.gameId,
      name: `Independent ${spec.name}`,
      description: 'Independent process acceptance fixture',
      themeId: 'independent-process',
    },
    modes: [mode],
    setupSchema,
    replay: {
      manifestQuery: { type: 'manifest', eventLimit: 200 },
      framesQueryType: 'frames',
    },
  };
}

function manifestFor(spec: FixtureSpec): ReleaseManifest {
  return {
    manifestVersion: '1.0',
    gameId: spec.gameId,
    releaseId: spec.releaseId,
    displayVersion: spec.releaseId,
    publisherId: 'independent-process-publisher',
    integration: {
      profile: 'legacy-service-v1',
      protocolMajor: 1,
      requiredFeatures: ['runtime-description-v1'],
    },
    artifacts: {
      client: {
        artifactId: `${spec.releaseId}-client`,
        digest: `sha256:${'1'.repeat(64)}`,
      },
      server: {
        artifactId: `${spec.releaseId}-server`,
        digest: `sha256:${'2'.repeat(64)}`,
      },
      publicAssets: {
        artifactId: `${spec.releaseId}-assets`,
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
      minPlayers: 1,
      maxPlayers: 1,
      features: ['replay'],
    },
    modes: [mode],
    presentation: {
      mount: 'platform-route',
      layoutProfile: 'default',
      locales: ['en'],
    },
    budgetProfile: 'independent-process',
  };
}

const gamePolicy: GameAccessPolicy = {
  authorize: async (identity, admission) =>
    admission.participants.some(
      (participant) => participant.principalId === identity.principalId,
    ),
  authorizeRoom: async (principal, room) => room.ownerId === principal,
  authorizeRoomInvite: async () => false,
  freezeParticipants: async (room) =>
    room.members.map(({ principalId: id, seatId }) => ({
      principalId: id,
      seatId,
    })),
  accessScopes: async () => ['session:view', 'session:command'],
  startAccess: async () => ({
    principalId: 'platform:start',
    scopes: ['session:create', 'session:control'],
    authEpoch: 'start-epoch',
  }),
  systemAccess: async () => ({
    principalId: 'platform:system',
    scopes: ['session:system'],
    authEpoch: 'system-epoch',
  }),
  authorizeHost: async () => undefined,
  adminAccess: async () => {
    throw new Error('not used by process fixture');
  },
  diagnosticAccess: async () => {
    throw new Error('not used by process fixture');
  },
};

function createPlatformHarness(
  platformPool: Pool,
  platformStorage: PostgresStorageDriver,
  admission: PostgresAdmissionStore,
  inbox: PostgresInboxStore,
  directory: PostgresSessionDirectory,
  completions: PostgresCompletionRecordStore,
  releaseStore: PostgresReleaseRegistryStore,
  serviceTokenByCredential: ReadonlyMap<string, string>,
): PlatformHarness {
  const runtime = new PlatformApplicationRuntime({
    platformId,
    db: drizzle(platformPool) as NodePgDatabase,
    pool: platformPool,
    storage: platformStorage,
    admissionStore: admission,
    inbox,
    directory,
    completionStore: completions,
    releaseRegistry: releaseStore,
    remoteRuntime: {
      resolvePolicy: (release) => ({
        identity: gamePolicy,
        policy: { rating: null, validityPolicyVersion: 'process-v1' },
        publicModes: release.approvedModes,
      }),
      resolveCredential: async (_release, binding) => {
        const token = serviceTokenByCredential.get(
          binding.serviceCredentialRef,
        );
        if (!token) throw new Error('fixture service credential missing');
        return {
          serviceToken: token,
          allowInsecureLocalhost: true,
          timeoutMs: binding.backendBindingId.includes('v2') ? 250 : 1_000,
        };
      },
      probeReadiness: async ({ release, binding, backend, ready }) => {
        const described = await backend.describe({ protocolVersion: 1 });
        if (!described.service)
          throw new Error('independent service description missing');
        void ready;
        return {
          probeId: `process-probe-${binding.backendBindingId}`,
          checkedAt: Date.now(),
          protocol: {
            major: described.protocolMajor,
            minor: described.protocolMinor,
            serviceDigest: release.serviceDigest,
            service: described.service,
          },
          storage: {
            bindingId: binding.storageBindingId,
            schemaVersion: 'postgres-storage-v1',
          },
        };
      },
    },
  });
  vi.spyOn(runtime.identity, 'resolve').mockImplementation(
    async (reference) => ({
      principalId: reference.principalId,
      authEpoch: 'account-epoch',
      active: true,
    }),
  );
  return { runtime, storage: platformStorage, releaseStore };
}

async function registerFixture(
  runtime: PlatformApplicationRuntime,
  spec: FixtureSpec,
  running: RunningFixture,
  timeoutMs: number,
): Promise<void> {
  const description = descriptionFor(spec);
  const backend = new RemoteBackendAdapter({
    baseUrl: running.endpoint,
    serviceToken: serviceTokens[spec.name],
    allowInsecureLocalhost: true,
    timeoutMs,
  });
  await runtime.registerRemoteGame({
    description,
    backend,
    identity: gamePolicy,
    policy: { rating: null, validityPolicyVersion: 'process-v1' },
    manifest: manifestFor(spec),
    approvedFeatures: ['replay'],
    approvedModes: ['solo'],
    binding: {
      deployment: 'external',
      controlEndpoint: running.endpoint,
      playerEndpoint: running.playerEndpoint ?? running.endpoint,
      ...(running.authorizationEndpoint === undefined
        ? {}
        : { authorizationEndpoint: running.authorizationEndpoint }),
      clientArtifactBaseUrl: `${running.endpoint}/assets`,
      serviceCredentialRef: `credential-${spec.name}`,
    },
  });
}

async function playerPost(
  endpoint: string,
  token: string,
  request: unknown,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const requestWithProtocol = {
    ...(request as Record<string, unknown>),
    protocolVersion: 1,
  };
  const response = await fetch(`${endpoint}/v1/submitCommand`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocolVersion: 1, request: requestWithProtocol }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

suite('independent game processes with separate Postgres owners', () => {
  let temporaryRoot: string | undefined;
  const children: RunningFixture[] = [];
  let factIngress: HttpFactIngressServer | undefined;
  let platformPool: Pool | undefined;
  let gamePool: Pool | undefined;

  afterAll(async () => {
    await Promise.all(children.map((child) => killFixture(child)));
    await factIngress?.close();
    await platformPool?.end();
    await gamePool?.end();
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('keeps releases, processes, credentials, facts and results independent across faults', async () => {
    if (!platformUrl || !gameUrl)
      throw new Error('explicit independent-game database URLs are required');
    const platformAddress = new URL(platformUrl);
    const gameAddress = new URL(gameUrl);
    expect(platformAddress.username).not.toBe(gameAddress.username);
    expect(platformAddress.pathname).not.toBe(gameAddress.pathname);

    temporaryRoot = await mkdtemp(join(tmpdir(), 'bgp-independent-process-'));
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const delayFile = join(temporaryRoot, 'v2-delay-ms');
    await writeFile(delayFile, '0', 'utf8');
    const admissionSchema = `process_admission_${suffix}`;
    const inboxSchema = `process_inbox_${suffix}`;
    const directorySchema = `process_directory_${suffix}`;
    const completionSchema = `process_completion_${suffix}`;
    const releaseSchema = `process_release_${suffix}`;
    const platformStorageSchema = `process_storage_${suffix}`;
    const v1: FixtureSpec = {
      name: 'v1',
      gameId: 'independent-counter',
      releaseId: 'counter-v1',
      backendBindingId: 'counter-v1-binding',
      storageBindingId: `counter_v1_storage_${suffix}`,
      ownershipEpoch: 'counter-v1-epoch',
      port: await freePort(),
      playerPort: await freePort(),
      authorizationPort: await freePort(),
      authorizationSchema: `process_auth_${suffix}`,
    };
    const v2: FixtureSpec = {
      name: 'v2',
      gameId: v1.gameId,
      releaseId: 'counter-v2',
      backendBindingId: 'counter-v2-binding',
      storageBindingId: `counter_v2_storage_${suffix}`,
      ownershipEpoch: 'counter-v2-epoch',
      port: await freePort(),
      delayFile,
    };
    const peer: FixtureSpec = {
      name: 'peer',
      gameId: 'independent-peer',
      releaseId: 'peer-v1',
      backendBindingId: 'peer-v1-binding',
      storageBindingId: `peer_v1_storage_${suffix}`,
      ownershipEpoch: 'peer-v1-epoch',
      port: await freePort(),
    };

    platformPool = new Pool({ connectionString: platformUrl });
    gamePool = new Pool({ connectionString: gameUrl });
    const platformStorage = new PostgresStorageDriver({
      pool: platformPool,
      schema: platformStorageSchema,
    });
    const admission = new PostgresAdmissionStore({
      pool: platformPool,
      schema: admissionSchema,
    });
    const inbox = new PostgresInboxStore({
      pool: platformPool,
      schema: inboxSchema,
    });
    const directory = new PostgresSessionDirectory({
      pool: platformPool,
      schema: directorySchema,
      admission,
      retentionResolver: () => 'summary-and-replay',
    });
    const completions = new PostgresCompletionRecordStore({
      pool: platformPool,
      schema: completionSchema,
      platformId,
      admission,
    });
    const releaseStore = new PostgresReleaseRegistryStore(platformPool, {
      schema: releaseSchema,
    });
    const authStore = new PostgresAuthorizationVersionStore({
      pool: gamePool,
      schema: v1.authorizationSchema,
    });
    await Promise.all([
      platformStorage.migrate(),
      admission.migrate(),
      inbox.migrate(),
      directory.migrate(),
      completions.migrate(),
      releaseStore.migrate(),
      authStore.migrate(),
    ]);

    const serviceTokenByCredential = new Map([
      ['credential-v1', serviceTokens.v1],
      ['credential-v2', serviceTokens.v2],
      ['credential-peer', serviceTokens.peer],
    ]);
    let activeRuntime = createPlatformHarness(
      platformPool,
      platformStorage,
      admission,
      inbox,
      directory,
      completions,
      releaseStore,
      serviceTokenByCredential,
    ).runtime;
    let dropCompletionAck = false;
    const receiver: TrustedFactIngestorLike = {
      ingest: async (delivery) => {
        const ack = await activeRuntime.factReceiver.ingest(delivery);
        if (dropCompletionAck && delivery.fact.kind === 'SessionCompleted')
          throw new Error('test intentionally drops the HTTP acknowledgement');
        return ack;
      },
    };
    const sources = [v1, v2, peer].map((spec) => ({
      gameId: spec.gameId,
      releaseId: spec.releaseId,
      backendBindingId: spec.backendBindingId,
      ownershipEpoch: spec.ownershipEpoch,
    }));
    factIngress = new HttpFactIngressServer({
      receiver,
      credentials: [
        { token: factTokens.v1, platformId, source: sources[0] },
        { token: factTokens.v2, platformId, source: sources[1] },
        { token: factTokens.peer, platformId, source: sources[2] },
      ],
      host: '127.0.0.1',
    });
    const factAddress = await factIngress.listen();
    const factEndpoint = `http://127.0.0.1:${factAddress.port}`;
    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' });
    const privateKey = keyPair.privateKey;
    const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

    const v1Process = await spawnFixture(
      v1,
      gameUrl,
      factEndpoint,
      publicKeyBase64,
    );
    children.push(v1Process);
    const v2Process = await spawnFixture(v2, gameUrl, factEndpoint);
    children.push(v2Process);
    const peerProcess = await spawnFixture(peer, gameUrl, factEndpoint);
    children.push(peerProcess);
    expect(peerProcess.pid).toBeGreaterThan(0);
    const peerPid = peerProcess.pid;
    const platformPid = process.pid;

    await registerFixture(activeRuntime, v1, v1Process, 1_000);
    await registerFixture(activeRuntime, v2, v2Process, 250);
    await registerFixture(activeRuntime, peer, peerProcess, 1_000);

    const reference = { principalId, authSessionId: 'process-auth' };
    const switchChannel = (
      gameId: string,
      expectedRevision: number,
      targetBackendBindingId: string,
      operationId: string,
    ) =>
      activeRuntime.switchRemoteChannel({
        platformId,
        gameId,
        modeId: mode.id,
        channel: 'stable',
        expectedRevision,
        targetBackendBindingId,
        operationId,
      });

    await switchChannel(v1.gameId, 0, v1.backendBindingId, 'channel-v1');
    await switchChannel(peer.gameId, 0, peer.backendBindingId, 'channel-peer');
    const first = await activeRuntime.createDirectSessionFromChannel(
      principalId,
      {
        gameId: v1.gameId,
        modeId: mode.id,
        channel: 'stable',
        setup: {},
        seed: 'process-seed-v1',
        requestId: 'process-start-v1',
      },
    );
    expect(first.route.releaseId).toBe(v1.releaseId);
    const firstView = await activeRuntime.views.view(
      reference,
      first.sessionId,
    );
    const firstCommand = {
      commandId: 'process-command-1',
      precondition: {
        kind: 'revision' as const,
        expectedRevision: firstView.revision,
      },
      command: {},
    };
    const firstAccepted = await activeRuntime.sessions.command(
      reference,
      first.sessionId,
      firstCommand,
    );
    const firstDuplicate = await activeRuntime.sessions.command(
      reference,
      first.sessionId,
      firstCommand,
    );
    expect(firstAccepted.receipt.status).toBe('accepted');
    expect(firstDuplicate.receipt.status).toBe('duplicate');

    await switchChannel(v1.gameId, 1, v2.backendBindingId, 'channel-v2');
    const second = await activeRuntime.createDirectSessionFromChannel(
      principalId,
      {
        gameId: v1.gameId,
        modeId: mode.id,
        channel: 'stable',
        setup: {},
        requestId: 'process-start-v2',
      },
    );
    expect(second.route.releaseId).toBe(v2.releaseId);
    await switchChannel(v1.gameId, 2, v1.backendBindingId, 'channel-rollback');
    const third = await activeRuntime.createDirectSessionFromChannel(
      principalId,
      {
        gameId: v1.gameId,
        modeId: mode.id,
        channel: 'stable',
        setup: {},
        requestId: 'process-start-v1-after-rollback',
      },
    );
    expect(third.route.releaseId).toBe(v1.releaseId);
    expect(
      (await activeRuntime.views.view(reference, first.sessionId)).payload,
    ).toMatchObject({
      count: 1,
    });

    const peerSession = await activeRuntime.createDirectSessionFromChannel(
      principalId,
      {
        gameId: peer.gameId,
        modeId: mode.id,
        channel: 'stable',
        setup: {},
        requestId: 'process-start-peer',
      },
    );
    expect(peerSession.route.gameId).toBe(peer.gameId);
    const secondView = await activeRuntime.views.view(
      reference,
      second.sessionId,
    );
    const secondFirstCommand = await activeRuntime.sessions.command(
      reference,
      second.sessionId,
      {
        commandId: 'process-v2-command-1',
        precondition: {
          kind: 'revision',
          expectedRevision: secondView.revision,
        },
        command: {},
      },
    );
    dropCompletionAck = true;
    await activeRuntime.sessions.command(reference, second.sessionId, {
      commandId: 'process-v2-command-2',
      precondition: {
        kind: 'revision',
        expectedRevision: secondFirstCommand.receipt.persistedRevision ?? 0,
      },
      command: {},
    });
    await eventually(
      async () => {
        await activeRuntime.recoverOnce();
        const record = await completions.get(platformId, second.sessionId);
        if (record) return record;
        throw new Error('v2 completion fact has not reached the platform');
      },
      (record) => record !== null,
    );
    dropCompletionAck = false;
    await eventually(
      async () => {
        await activeRuntime.recoverOnce();
        return completions.get(platformId, second.sessionId);
      },
      (record) => record?.processingState === 'settled',
    );

    await writeFile(delayFile, '2_000', 'utf8');
    const slowStarted = Date.now();
    const slowView = activeRuntime.views
      .view(reference, second.sessionId)
      .then(() => {
        throw new Error('slow v2 request unexpectedly completed');
      })
      .catch((error) => error);
    const peerView = activeRuntime.views.view(reference, peerSession.sessionId);
    const [slowFailure, peerResult] = await Promise.all([slowView, peerView]);
    await writeFile(delayFile, '0', 'utf8');
    expect(slowFailure).toBeInstanceOf(Error);
    expect(Date.now() - slowStarted).toBeLessThan(2_000);
    expect(peerResult.gameId).toBe(peer.gameId);
    expect(() => process.kill(peerPid, 0)).not.toThrow();

    await killFixture(v1Process);
    expect(() => process.kill(peerPid, 0)).not.toThrow();
    const connectionFailureStarted = Date.now();
    await expect(
      activeRuntime.views.view(reference, first.sessionId),
    ).rejects.toBeDefined();
    expect(Date.now() - connectionFailureStarted).toBeLessThan(2_000);
    expect(process.pid).toBe(platformPid);

    const restartedV1 = await spawnFixture(
      v1,
      gameUrl,
      factEndpoint,
      publicKeyBase64,
    );
    children.push(restartedV1);
    const restartedRuntime = createPlatformHarness(
      platformPool,
      platformStorage,
      admission,
      inbox,
      directory,
      completions,
      releaseStore,
      serviceTokenByCredential,
    ).runtime;
    activeRuntime = restartedRuntime;
    const restored = await activeRuntime.restoreRemoteGames();
    expect(restored.map((game) => `${game.gameId}:${game.releaseId}`)).toEqual(
      expect.arrayContaining([
        `${v1.gameId}:${v1.releaseId}`,
        `${v1.gameId}:${v2.releaseId}`,
        `${peer.gameId}:${peer.releaseId}`,
      ]),
    );
    expect(
      (await activeRuntime.views.view(reference, first.sessionId)).payload,
    ).toMatchObject({
      count: 1,
    });
    expect(() => process.kill(peerPid, 0)).not.toThrow();

    const firstAdmission = await activeRuntime.admissionStore.getAdmission(
      first.sessionId,
    );
    if (!firstAdmission) throw new Error('first admission missing');
    const seatId = firstAdmission.participants[0]?.seatId;
    if (!seatId || !restartedV1.playerEndpoint)
      throw new Error('player endpoint or seat missing');
    const persistedBinding = await releaseStore.getBinding(
      platformId,
      v1.backendBindingId,
    );
    if (!persistedBinding?.authorizationEndpoint)
      throw new Error('authorization endpoint binding is missing');
    const authorizationSync = new HttpAuthorizationVersionClient({
      baseUrl: persistedBinding.authorizationEndpoint,
      token: serviceTokens.v1,
      platformId,
      allowInsecureLocalhost: true,
    });
    const syncAuthorization = (record: {
      readonly platformId: string;
      readonly sessionId: string;
      readonly principalId: string;
      readonly route: typeof firstAdmission.route;
      readonly seatId?: string;
      readonly scopes: readonly string[];
      readonly authEpoch: string;
      readonly authorizationRevision: number;
    }) => ({
      platformId: record.platformId,
      sessionId: record.sessionId,
      principalId: record.principalId,
      route: record.route,
      ...(record.seatId === undefined ? {} : { seatId: record.seatId }),
      scopes: [...record.scopes],
      authEpoch: record.authEpoch,
      authorizationRevision: record.authorizationRevision,
      authenticatedPlatformId: platformId,
    });
    const firstAuthorization = await authStore.advance({
      authenticatedPlatformId: platformId,
      platformId,
      sessionId: first.sessionId,
      principalId,
      route: firstAdmission.route,
      seatId,
      scopes: ['session:view', 'session:command'],
      authEpoch: 'player-epoch-1',
      authorizationRevision: 1,
    });
    try {
      await authorizationSync.advance(syncAuthorization(firstAuthorization));
    } catch (error) {
      throw new Error(
        `authorization sync failed: ${
          error instanceof Error
            ? `${error.name}:${String((error as { code?: unknown }).code)}:${error.message}`
            : String(error)
        }`,
        { cause: error },
      );
    }
    const issuedAt = Date.now();
    const playerToken = issuePlayerCredential({
      privateKey,
      platformId,
      audience,
      route: firstAdmission.route,
      principalId,
      seatId,
      scopes: ['session:view', 'session:command'],
      authEpoch: 'player-epoch-1',
      authorizationRevision: 1,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    });
    const commandView = await activeRuntime.views.view(
      reference,
      first.sessionId,
    );
    await factIngress.close();
    factIngress = undefined;
    const offlineResult = await playerPost(
      restartedV1.playerEndpoint,
      playerToken,
      {
        route: firstAdmission.route,
        commandId: 'player-offline-completion',
        precondition: {
          kind: 'revision',
          expectedRevision: commandView.revision,
        },
        command: {},
      },
    );
    expect(offlineResult.status, JSON.stringify(offlineResult.body)).toBe(200);
    expect(
      (offlineResult.body.response as { receipt?: { status?: string } }).receipt
        ?.status,
    ).toBe('accepted');
    const spoofedRoute = {
      ...firstAdmission.route,
      releaseId: v2.releaseId,
      backendBindingId: v2.backendBindingId,
      storageBindingId: v2.storageBindingId,
      ownershipEpoch: v2.ownershipEpoch,
    };
    await expect(
      playerPost(restartedV1.playerEndpoint, playerToken, {
        route: spoofedRoute,
        commandId: 'spoofed-route-command',
        precondition: {
          kind: 'revision',
          expectedRevision: commandView.revision,
        },
        command: {},
      }),
    ).resolves.toMatchObject({ status: 403 });
    const expired = issuePlayerCredential({
      privateKey,
      platformId,
      audience,
      route: firstAdmission.route,
      principalId,
      seatId,
      scopes: ['session:view', 'session:command'],
      authEpoch: 'player-epoch-1',
      authorizationRevision: 1,
      issuedAt: 1,
      expiresAt: 2,
    });
    await expect(
      playerPost(restartedV1.playerEndpoint, expired, {
        route: firstAdmission.route,
        commandId: 'expired-command',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: {},
      }),
    ).resolves.toMatchObject({ status: 401 });
    const secondAuthorization = await authStore.advance({
      authenticatedPlatformId: platformId,
      platformId,
      sessionId: first.sessionId,
      principalId,
      route: firstAdmission.route,
      seatId,
      scopes: ['session:view', 'session:command'],
      authEpoch: 'player-epoch-2',
      authorizationRevision: 2,
    });
    await authorizationSync.advance(syncAuthorization(secondAuthorization));
    await expect(
      playerPost(restartedV1.playerEndpoint, playerToken, {
        route: firstAdmission.route,
        commandId: 'revoked-command',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: {},
      }),
    ).resolves.toMatchObject({ status: 403 });

    const restartedFactIngress = new HttpFactIngressServer({
      receiver,
      credentials: [
        { token: factTokens.v1, platformId, source: sources[0] },
        { token: factTokens.v2, platformId, source: sources[1] },
        { token: factTokens.peer, platformId, source: sources[2] },
      ],
      host: '127.0.0.1',
      port: factAddress.port,
    });
    factIngress = restartedFactIngress;
    await restartedFactIngress.listen();
    await killFixture(restartedV1);
    const finalV1 = await spawnFixture(
      v1,
      gameUrl,
      factEndpoint,
      publicKeyBase64,
    );
    children.push(finalV1);
    await eventually(
      async () => {
        await activeRuntime.recoverOnce();
        return completions.get(platformId, first.sessionId);
      },
      (record) => record?.processingState === 'settled',
    );
    const completion = (await activeRuntime.results.getCompletion(
      reference,
      first.sessionId,
    )) as { readonly result?: unknown };
    expect(completion).toMatchObject({
      status: 'completed',
      result: { kind: 'solo', score: 2 },
    });
    await killFixture(finalV1);
    const offlineCompletion = (await activeRuntime.results.getCompletion(
      reference,
      first.sessionId,
    )) as { readonly result?: unknown };
    expect(offlineCompletion.result).toEqual(completion.result);

    const spoofedBody = {
      protocolVersion: 1,
      platformId,
      deliveries: [
        {
          source: sources[1],
          route: firstAdmission.route,
          fact: {
            producerId: 'spoof-producer',
            eventId: 'spoof-event',
            kind: 'SessionSummaryChanged',
            schemaVersion: 1,
            sourceRelease: firstAdmission.route.releaseId,
            payload: { summary: { count: 2 }, status: 'completed' },
          },
        },
      ],
    };
    const spoofResponse = await fetch(`${factEndpoint}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${factTokens.v1}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(spoofedBody),
    });
    expect(spoofResponse.status).toBe(400);
    const mismatchResponse = await fetch(`${factEndpoint}/v1/facts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${factTokens.v2}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        protocolVersion: 1,
        platformId,
        deliveries: [
          {
            route: firstAdmission.route,
            fact: {
              producerId: 'mismatch-producer',
              eventId: 'mismatch-event',
              kind: 'SessionSummaryChanged',
              schemaVersion: 1,
              sourceRelease: firstAdmission.route.releaseId,
              payload: { summary: { count: 2 }, status: 'completed' },
            },
          },
        ],
      }),
    });
    expect(mismatchResponse.status).toBe(200);
    expect(
      ((await mismatchResponse.json()) as { errors?: { code?: string }[] })
        .errors?.[0]?.code,
    ).toBe('SOURCE_UNAUTHORIZED');
  }, 90_000);
});
