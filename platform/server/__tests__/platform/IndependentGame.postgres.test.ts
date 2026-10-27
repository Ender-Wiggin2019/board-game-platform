import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  contractError,
  type GameServiceDescription,
  type JsonValue,
  type MatchAdmission,
  type PlatformRoom,
} from '@board-game/contracts';
import {
  HttpFactIngressClient,
  HttpFactIngressServer,
  type PlatformIdentityReference,
  PostgresAdmissionStore,
  PostgresInboxStore,
  PostgresSessionDirectory,
  type ResolvedIdentity,
} from '@board-game/core';
import { RemoteBackendAdapter } from '@board-game/host';
import { defineGame, type GameModule } from '@board-game/sdk';
import {
  createGameServerRunner,
  defineGameServer,
  type GameServerRunner,
} from '@board-game/server';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
} from '@board-game/storage';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import {
  type GameAccessPolicy,
  PlatformApplicationRuntime,
} from '@/platform/PlatformApplicationRuntime.js';

const platformUrl = process.env.BGP_PLATFORM_TEST_DATABASE_URL;
const gameUrl = process.env.BGP_GAME_TEST_DATABASE_URL;
const suite = platformUrl && gameUrl ? describe : describe.skip;
const platformId = 'independent-test';
const serviceToken = 'independent-game-test-service-token-32-characters';
const factToken = 'independent-game-test-fact-token-32-characters';
const reference = { principalId: 'player1', authSessionId: 'test-auth' };
const runFile = promisify(execFile);

/** Only called for this test's random schemas in the explicitly supplied test databases. */
async function restoreTestBackup(
  pool: Pool,
  databaseUrl: string,
  schemas: readonly string[],
): Promise<void> {
  const binaryDirectory = process.env.BGP_POSTGRES_BIN;
  if (!binaryDirectory)
    throw new Error('BGP_POSTGRES_BIN is required for backup verification');
  const directory = await mkdtemp(join(tmpdir(), 'bgp-backup-test-'));
  const archive = join(directory, 'backup.dump');
  const tableDigests = async () => {
    const tables = await pool.query<{ schemaname: string; tablename: string }>(
      'SELECT schemaname, tablename FROM pg_tables WHERE schemaname = ANY($1::text[]) ORDER BY schemaname, tablename',
      [schemas],
    );
    const result = [];
    for (const { schemaname, tablename } of tables.rows) {
      const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const rows = await pool.query<{ payload: string }>(
        `SELECT row_to_json(row)::text AS payload FROM ${quoted(schemaname)}.${quoted(tablename)} AS row`,
      );
      result.push({
        table: `${schemaname}.${tablename}`,
        count: rows.rowCount,
        digest: createHash('sha256')
          .update(JSON.stringify(rows.rows.map((row) => row.payload).sort()))
          .digest('hex'),
      });
    }
    return result;
  };
  try {
    const before = await tableDigests();
    expect(before.length).toBeGreaterThan(0);
    await runFile(join(binaryDirectory, 'pg_dump'), [
      '--format=custom',
      '--no-owner',
      '--no-acl',
      '--file',
      archive,
      '--dbname',
      databaseUrl,
      ...schemas.flatMap((schema) => ['--schema', schema]),
    ]);
    for (const schema of schemas) {
      if (
        !/^(admission|inbox|directory|completion|game)_[a-f0-9]{10}$/u.test(
          schema,
        )
      )
        throw new Error(
          'Refusing to replace a schema outside this test fixture',
        );
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await runFile(join(binaryDirectory, 'pg_restore'), [
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--dbname',
      databaseUrl,
      archive,
    ]);
    expect(await tableDigests()).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type State = { count: number; owner: string; secret: string };
const schema = {
  name: 'counter.object',
  version: 1,
  schema: { type: 'object' as const, additionalProperties: true },
};
const game: GameModule<
  State,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue
> = defineGame<
  State,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue,
  JsonValue
>({
  gameId: 'independent-counter',
  releaseId: 'counter-v1',
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
      owner: context.participants[0]?.principalId ?? 'missing',
      secret: 'never-in-platform-result',
    }),
    execute: (state) => ({
      ok: true,
      state: { ...state, count: state.count + 1 },
      events: [{ count: state.count + 1 }],
    }),
    project: (state, viewer) => ({
      count: state.count,
      ...(viewer.principalId === state.owner ? { secret: state.secret } : {}),
    }),
    projectEvent: (event) => event,
    query: (state, query): JsonValue => {
      const request = query as { type: string; from?: number; limit?: number };
      if (request.type === 'manifest')
        return { frames: state.count + 1, releaseId: 'counter-v1' };
      if (request.type === 'frames')
        return {
          frames: Array.from({ length: state.count + 1 }, (_, count) => ({
            count,
          })).slice(
            request.from ?? 0,
            (request.from ?? 0) + (request.limit ?? 10),
          ),
        };
      throw contractError('INVALID_REQUEST', 'counter.query');
    },
    encode: (state) => ({ ...state }),
    decode: (saved) => saved as State,
  },
  turn: (state, context) =>
    state.count >= 2
      ? null
      : {
          id: `turn-${state.count}`,
          mode: 'sequential',
          activeSeatIds: context.participants
            .slice(0, 1)
            .map((participant) => participant.seatId),
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
const description: GameServiceDescription = {
  schemaVersion: 1,
  platformId,
  gameId: game.gameId,
  releaseId: game.releaseId,
  backendBindingId: 'counter-backend-v1',
  storageBindingId: 'counter-storage',
  ownershipEpoch: '1',
  metadata: {
    gameId: game.gameId,
    name: 'Counter',
    description: 'Independent protocol fixture',
    themeId: 'counter',
  },
  modes: game.modes,
  setupSchema: game.schemas.setup,
  replay: {
    manifestQuery: { type: 'manifest', eventLimit: 200 },
    framesQueryType: 'frames',
  },
};
const policy: GameAccessPolicy = {
  authorize: async (identity: ResolvedIdentity, admission: MatchAdmission) =>
    admission.participants.some(
      (participant) => participant.principalId === identity.principalId,
    ),
  authorizeRoom: async (principalId: string, room: PlatformRoom) =>
    room.ownerId === principalId,
  authorizeRoomInvite: async () => false,
  freezeParticipants: async (room) =>
    room.members.map(({ principalId, seatId }) => ({ principalId, seatId })),
  accessScopes: async () => ['session:view', 'session:command'],
  startAccess: async () => ({
    principalId: 'platform:admission',
    scopes: ['session:create', 'session:control'],
    authEpoch: '1',
  }),
  systemAccess: async () => ({
    principalId: 'game:scheduler',
    scopes: ['session:system'],
    authEpoch: '1',
  }),
  authorizeHost: async () => undefined,
  adminAccess: async () => {
    throw new Error('Not used by fixture');
  },
  diagnosticAccess: async () => {
    throw new Error('Not used by fixture');
  },
};

suite('independent game over HTTP with separate database owners', () => {
  it('recovers game state and queued facts, then serves durable results with the game offline', async () => {
    if (!platformUrl || !gameUrl)
      throw new Error('Both explicit test database URLs are required');
    const platformAddress = new URL(platformUrl);
    const gameAddress = new URL(gameUrl);
    expect(platformAddress.pathname).not.toBe(gameAddress.pathname);
    expect(platformAddress.username).not.toBe(gameAddress.username);
    const platformPool = new Pool({ connectionString: platformUrl });
    const gamePool = new Pool({ connectionString: gameUrl });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const admission = new PostgresAdmissionStore({
      pool: platformPool,
      schema: `admission_${suffix}`,
    });
    const inbox = new PostgresInboxStore({
      pool: platformPool,
      schema: `inbox_${suffix}`,
    });
    const directory = new PostgresSessionDirectory({
      pool: platformPool,
      schema: `directory_${suffix}`,
      admission,
      retentionResolver: () => 'summary-and-replay',
    });
    const completions = new PostgresCompletionRecordStore({
      pool: platformPool,
      schema: `completion_${suffix}`,
      platformId,
      admission,
    });
    const storage = new PostgresStorageDriver({
      pool: gamePool,
      schema: `game_${suffix}`,
    });
    let runner: GameServerRunner | undefined;
    let ingress: HttpFactIngressServer | undefined;
    let now = Date.now();
    try {
      await admission.migrate();
      await inbox.migrate();
      await directory.migrate();
      await completions.migrate();
      await storage.migrate();
      for (const [from, to] of [
        [platformAddress, gameAddress],
        [gameAddress, platformAddress],
      ] as const) {
        const forbiddenUrl = new URL(to);
        forbiddenUrl.username = from.username;
        const forbidden = new Pool({
          connectionString: forbiddenUrl.toString(),
          connectionTimeoutMillis: 1_000,
        });
        try {
          await expect(forbidden.query('SELECT 1')).rejects.toMatchObject({
            code: '42501',
          });
        } finally {
          await forbidden.end();
        }
      }
      const platform = new PlatformApplicationRuntime({
        platformId,
        db: {} as NodePgDatabase,
        pool: platformPool,
        storage: new MemoryStorageDriver(),
        admissionStore: admission,
        inbox,
        directory,
        completionStore: completions,
      });
      vi.spyOn(platform.identity, 'resolve').mockImplementation(
        async (identity: PlatformIdentityReference) => ({
          principalId: identity.principalId,
          authEpoch: '1',
          active: true,
        }),
      );
      const source = {
        gameId: game.gameId,
        releaseId: game.releaseId,
        backendBindingId: description.backendBindingId,
        ownershipEpoch: description.ownershipEpoch,
      };
      ingress = new HttpFactIngressServer({
        receiver: platform.factReceiver,
        credentials: [{ token: factToken, platformId, source }],
      });
      const factAddress = await ingress.listen();
      const receiver = new HttpFactIngressClient({
        baseUrl: `http://127.0.0.1:${factAddress.port}`,
        platformId,
        token: factToken,
        allowInsecureLocalhost: true,
      });
      const definition = defineGameServer({
        manifest: { gameId: game.gameId, releaseId: game.releaseId },
        module: game,
        services: {
          replay: {
            queries: {
              manifest: (eventLimit) => ({ type: 'manifest', eventLimit }),
              frames: (from, limit) => ({ type: 'frames', from, limit }),
            },
          },
        },
      });
      const createRunner = (port = 0) =>
        createGameServerRunner({
          definition,
          storage,
          description,
          authorize: async () => undefined,
          systemAccess: policy.systemAccess,
          factReceiver: receiver,
          now: () => now,
          transport: {
            serviceToken,
            allowedScopes: [
              'session:create',
              'session:control',
              'session:view',
              'session:command',
            ],
            tokenExpiresAt: Date.now() + 60_000,
            host: '127.0.0.1',
            port,
          },
        });
      runner = createRunner();
      const address = await runner.start();
      if (!address) throw new Error('Game HTTP listener missing');
      const backend = new RemoteBackendAdapter({
        baseUrl: `http://127.0.0.1:${address.port}`,
        serviceToken,
        allowInsecureLocalhost: true,
        timeoutMs: 1_000,
      });
      await platform.registerRemoteGame({
        description,
        backend,
        identity: policy,
        policy: { rating: null, validityPolicyVersion: 'test-v1' },
      });
      const start = await platform.admission.createDirectSession(
        reference.principalId,
        {
          gameId: game.gameId,
          releaseId: game.releaseId,
          modeId: 'solo',
          setup: {},
          seed: 'fixed-seed',
          requestId: 'start-counter',
        },
      );
      const first = await platform.views.view(reference, start.sessionId);
      await platform.sessions.command(reference, start.sessionId, {
        commandId: 'step-1',
        precondition: { kind: 'revision', expectedRevision: first.revision },
        command: {},
      });
      await runner.close();
      runner = createRunner(address.port);
      await runner.start();
      const recovered = await platform.views.view(reference, start.sessionId);
      expect(recovered.payload).toMatchObject({ count: 1 });
      await ingress.close();
      const finish = {
        commandId: 'step-2',
        precondition: {
          kind: 'revision' as const,
          expectedRevision: recovered.revision,
        },
        command: {},
      };
      await platform.sessions.command(reference, start.sessionId, finish);
      expect(
        (await platform.sessions.command(reference, start.sessionId, finish))
          .receipt.status,
      ).toBe('duplicate');
      expect((await runner.recoverOnce()).outbox?.failed).toBeGreaterThan(0);
      expect(await completions.get(platformId, start.sessionId)).toBeNull();
      if (process.env.BGP_BACKUP_RESTORE_TEST === '1') {
        await runner.close();
        await restoreTestBackup(platformPool, platformUrl, [
          `admission_${suffix}`,
          `inbox_${suffix}`,
          `directory_${suffix}`,
          `completion_${suffix}`,
        ]);
        await restoreTestBackup(gamePool, gameUrl, [`game_${suffix}`]);
        runner = createRunner(address.port);
        await runner.start();
      }
      // Resume the same receiver address; the persisted game outbox retries its original facts.
      ingress = new HttpFactIngressServer({
        receiver: platform.factReceiver,
        credentials: [{ token: factToken, platformId, source }],
        port: factAddress.port,
      });
      await ingress.listen();
      now += 60_000;
      expect((await runner.recoverOnce()).outbox?.failed).toBe(0);
      const recoveredPlatform = await platform.recoverOnce();
      expect(
        recoveredPlatform.consumers.every((report) => report.failed === 0),
      ).toBe(true);
      const completed = await completions.get(platformId, start.sessionId);
      expect(completed?.processingState).toBe('settled');
      expect((await directory.getSession(start.sessionId))?.status).toBe(
        'completed',
      );
      expect(JSON.stringify(completed)).not.toContain(
        'never-in-platform-result',
      );
      expect(await platform.storage.getHead(start.sessionId)).toBeNull();
      const replay = await platform.results.getReplayFrames(
        reference,
        start.sessionId,
        0,
        10,
      );
      expect(replay).toMatchObject({
        chunk: { frames: [{ count: 0 }, { count: 1 }, { count: 2 }] },
      });
      await runner.close();
      if (process.env.BGP_BACKUP_RESTORE_TEST === '1') {
        await restoreTestBackup(platformPool, platformUrl, [
          `admission_${suffix}`,
          `inbox_${suffix}`,
          `directory_${suffix}`,
          `completion_${suffix}`,
        ]);
        await platform.recoverOnce();
        expect(
          (await completions.get(platformId, start.sessionId))?.processingState,
        ).toBe('settled');
      }
      const offlineResult = await platform.results.getCompletion(
        reference,
        start.sessionId,
      );
      expect(offlineResult).toMatchObject({
        status: 'completed',
        result: { kind: 'solo', score: 2 },
      });
      await expect(
        platform.results.getCompletion(
          { ...reference, principalId: 'stranger' },
          start.sessionId,
        ),
      ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
      expect((await runner.backend.ready({ protocolVersion: 1 })).ready).toBe(
        false,
      );
      const platformTables = await platformPool.query(
        'SELECT table_schema FROM information_schema.tables WHERE table_schema LIKE $1',
        ['game_%'],
      );
      expect(platformTables.rows).toEqual([]);
    } finally {
      await runner?.close();
      await ingress?.close();
      for (const [pool, schemas] of [
        [
          platformPool,
          [
            `admission_${suffix}`,
            `inbox_${suffix}`,
            `directory_${suffix}`,
            `completion_${suffix}`,
          ],
        ],
        [gamePool, [`game_${suffix}`]],
      ] as const)
        for (const namespace of schemas)
          await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await platformPool.end();
      await gamePool.end();
    }
  }, 60_000);
});
