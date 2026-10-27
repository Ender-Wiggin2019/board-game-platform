import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { HttpFactIngressClient } from '@board-game/core';
import { defineGame } from '@board-game/sdk';
import {
  createGameServerRunner,
  defineGameServer,
  PostgresAuthorizationVersionStore,
} from '@board-game/server';
import { PostgresStorageDriver } from '@board-game/storage';
import { Pool } from 'pg';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const gameId = required('BGP_FIXTURE_GAME_ID');
const fixtureName = required('BGP_FIXTURE_NAME');
const releaseId = required('BGP_FIXTURE_RELEASE_ID');
const platformId = required('BGP_FIXTURE_PLATFORM_ID');
const databaseUrl = required('BGP_FIXTURE_DATABASE_URL');
const storageSchema = required('BGP_FIXTURE_STORAGE_SCHEMA');
const authorizationSchema = required('BGP_FIXTURE_AUTHORIZATION_SCHEMA');
const backendBindingId = required('BGP_FIXTURE_BACKEND_BINDING_ID');
const storageBindingId = required('BGP_FIXTURE_STORAGE_BINDING_ID');
const ownershipEpoch = required('BGP_FIXTURE_OWNERSHIP_EPOCH');
const serviceToken = required('BGP_FIXTURE_SERVICE_TOKEN');
const authorizationToken =
  process.env.BGP_FIXTURE_AUTHORIZATION_TOKEN?.trim() || serviceToken;
const factEndpoint = required('BGP_FIXTURE_FACT_ENDPOINT');
const factToken = required('BGP_FIXTURE_FACT_TOKEN');
const host = process.env.BGP_FIXTURE_HOST?.trim() || '127.0.0.1';
const port = Number(required('BGP_FIXTURE_PORT'));
const playerPort = Number(process.env.BGP_FIXTURE_PLAYER_PORT || '0');
const authorizationPort = Number(
  process.env.BGP_FIXTURE_AUTHORIZATION_PORT || '0',
);
const audience = process.env.BGP_FIXTURE_PLAYER_AUDIENCE?.trim();
const publicKeyBase64 = process.env.BGP_FIXTURE_PLAYER_PUBLIC_KEY_B64;
const delayFile = process.env.BGP_FIXTURE_DELAY_FILE?.trim();

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('BGP_FIXTURE_PORT is invalid');
if (
  !Number.isSafeInteger(authorizationPort) ||
  authorizationPort < 0 ||
  authorizationPort > 65_535
)
  throw new Error('BGP_FIXTURE_AUTHORIZATION_PORT is invalid');

const routeFor = (sessionId, modeId = 'solo') => ({
  gameId,
  modeId,
  sessionId,
  releaseId,
  backendBindingId,
  storageBindingId,
  ownershipEpoch,
});

const schema = {
  name: 'independent-process.setup',
  version: 1,
  schema: { type: 'object', additionalProperties: false },
};

const module = defineGame({
  gameId,
  releaseId,
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
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
  schemas: { setup: schema, command: schema, query: schema, result: schema },
  rules: {
    create: (_setup, context) => ({
      count: 0,
      owner: context.participants[0]?.principalId || 'missing',
    }),
    execute: (state) => ({
      ok: true,
      state: { ...state, count: state.count + 1 },
      events: [{ count: state.count + 1 }],
    }),
    project: (state, viewer) => ({
      count: state.count,
      owner: viewer.principalId === state.owner,
    }),
    projectEvent: (event) => event,
    query: (state, query) => {
      if (query.type === 'manifest')
        return { frames: state.count + 1, releaseId };
      if (query.type === 'frames')
        return {
          frames: Array.from({ length: state.count + 1 }, (_, count) => ({
            count,
          })).slice(query.from || 0, (query.from || 0) + (query.limit || 10)),
        };
      throw new Error('fixture.query');
    },
    encode: (state) => ({ ...state }),
    decode: (saved) => saved,
  },
  turn: (state, context) =>
    state.count >= 2
      ? null
      : {
          id: `turn-${state.count}`,
          mode: 'sequential',
          activeSeatIds: context.participants.slice(0, 1).map((p) => p.seatId),
        },
  summarize: (state) => ({ count: state.count }),
  completion: (state) => ({ finished: state.count >= 2 }),
  result: (state) => ({
    kind: 'solo',
    participantIds: [state.owner],
    outcome: 'completed',
    score: state.count,
  }),
  collectFacts: () => [],
});

const description = {
  schemaVersion: 1,
  platformId,
  gameId,
  releaseId,
  backendBindingId,
  storageBindingId,
  ownershipEpoch,
  metadata: {
    gameId,
    name: `Independent ${fixtureName}`,
    description: 'Independent process acceptance fixture',
    themeId: 'independent-process',
  },
  modes: module.modes,
  setupSchema: module.schemas.setup,
  replay: {
    manifestQuery: { type: 'manifest', eventLimit: 200 },
    framesQueryType: 'frames',
  },
};

const definition = defineGameServer({
  manifest: { gameId, releaseId },
  module,
  services: {
    replay: {
      queries: {
        manifest: (eventLimit) => ({ type: 'manifest', eventLimit }),
        frames: (from, limit) => ({ type: 'frames', from, limit }),
      },
    },
  },
});

const pool = new Pool({ connectionString: databaseUrl });
const storage = new PostgresStorageDriver({ pool, schema: storageSchema });
await storage.migrate();

const authorizationStore = new PostgresAuthorizationVersionStore({
  pool,
  schema: authorizationSchema,
});
await authorizationStore.migrate();

const factReceiver = new HttpFactIngressClient({
  baseUrl: factEndpoint,
  token: factToken,
  platformId,
  allowInsecureLocalhost: true,
  timeoutMs: 1_000,
});

const runner = createGameServerRunner({
  mode: 'production',
  definition,
  storage,
  description,
  authorize: async () => {
    const rawDelay = delayFile
      ? await readFile(delayFile, 'utf8').catch(() => '')
      : process.env.BGP_FIXTURE_DELAY_MS || '';
    const delayMs = Number(rawDelay.trim());
    if (Number.isFinite(delayMs) && delayMs > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delayMs, 30_000)),
      );
  },
  systemAccess: async () => ({
    principalId: 'fixture:system',
    scopes: ['session:system'],
    authEpoch: 'fixture',
  }),
  factReceiver,
  transport: {
    serviceToken,
    allowedScopes: [
      'session:create',
      'session:control',
      'session:view',
      'session:command',
    ],
    tokenExpiresAt: Date.now() + 60 * 60 * 1_000,
    host,
    port,
    timeoutMs: 1_000,
  },
  ...(audience && publicKeyBase64
    ? {
        playerTransport: {
          publicKey: Buffer.from(publicKeyBase64, 'base64').toString('utf8'),
          platformId,
          audience,
          authorizationStore,
          host,
          port: playerPort,
          allowedOrigins: [],
        },
        authorizationTransport: {
          credentials: [{ token: authorizationToken, platformId }],
          host,
          port: authorizationPort,
        },
      }
    : {}),
});

const recoveryTimer = setInterval(() => {
  void runner.recoverOnce().catch((error) => {
    process.stderr.write(
      `recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}, 100);
recoveryTimer.unref();

const close = async () => {
  clearInterval(recoveryTimer);
  await runner.close().catch(() => undefined);
  await authorizationStore.close();
  await pool.end();
};

process.once('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});
process.once('SIGINT', () => {
  void close().finally(() => process.exit(0));
});

const address = await runner.start();
if (!address) throw new Error('fixture transport did not start');
process.stdout.write(
  `${JSON.stringify({
    ready: true,
    pid: process.pid,
    gameId,
    releaseId,
    port: address.port,
    playerPort: runner.playerTransportAddress?.port,
    authorizationPort: runner.authorizationTransportAddress?.port,
    routeFor: routeFor('fixture'),
  })}\n`,
);
