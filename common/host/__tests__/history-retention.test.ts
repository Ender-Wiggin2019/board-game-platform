import { randomUUID } from 'node:crypto';
import type { BackendPort, CreateSessionRequest } from '@board-game/contracts';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EmbeddedBackendAdapter,
  GameHost,
  GameRegistry,
  HttpHostTransport,
  RemoteBackendAdapter,
} from '../src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(['embedded', 'remote'] as const)(
  'Host history retirement through %s',
  (transport) => {
    for (const kind of ['memory', 'postgres'] as const) {
      const run =
        kind === 'postgres' && !process.env.BGP_TEST_DATABASE_URL
          ? it.skip
          : it;
      run(
        `fences cleanup and preserves terminal recovery data in ${kind}`,
        async () => {
          let storage: StorageDriver;
          if (kind === 'memory') storage = new MemoryStorageDriver();
          else {
            const pool = new Pool({
              connectionString: process.env.BGP_TEST_DATABASE_URL,
            });
            const schema = `history_${randomUUID().replaceAll('-', '')}`;
            cleanups.push(async () => {
              await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
              await pool.end();
            });
            const store = new PostgresStorageDriver({ pool, schema });
            await store.migrate();
            storage = store;
          }
          const scopes = [
            'session:create',
            'session:control',
            'session:command',
            'session:view',
            'session:history:retire',
          ];
          const accessContext = {
            principalId: 'alice',
            authEpoch: 'test',
            scopes,
          };
          const host = new GameHost({
            registry: new GameRegistry().register(sequentialTurnFixture),
            storage,
            backendBindingId: 'host',
            storageBindingId: 'store',
            authorize: async () => undefined,
          });
          let backend: BackendPort = new EmbeddedBackendAdapter(host);
          if (transport === 'remote') {
            const serviceToken = 'history-retention-test-token-0123456789';
            const server = new HttpHostTransport({
              backend: host,
              allowedGameIds: [sequentialTurnFixture.gameId],
              allowedScopes: scopes,
              serviceToken,
              tokenExpiresAt: Date.now() + 60_000,
              port: 0,
            });
            const address = await server.listen();
            cleanups.push(() => server.close());
            backend = new RemoteBackendAdapter({
              baseUrl: `http://127.0.0.1:${address.port}`,
              serviceToken,
              allowInsecureLocalhost: true,
            });
          }
          const creation: CreateSessionRequest = {
            protocolVersion: 1,
            accessContext,
            route: {
              gameId: sequentialTurnFixture.gameId,
              modeId: 'sequential',
              releaseId: sequentialTurnFixture.releaseId,
              sessionId: randomUUID(),
              backendBindingId: 'host',
              storageBindingId: 'store',
              ownershipEpoch: '1',
            },
            startId: randomUUID(),
            startGeneration: 0,
            participants: [
              { principalId: 'alice', seatId: 'a' },
              { principalId: 'bob', seatId: 'b' },
            ],
            setup: { target: 1 },
            seed: 'history',
          };
          await backend.createSession(creation);
          const request = {
            protocolVersion: 1 as const,
            accessContext,
            route: creation.route,
          };
          await backend.activateSession({
            ...request,
            startId: creation.startId,
          });
          const retire = backend.retireSessionHistory?.bind(backend);
          if (!retire) throw new Error('Missing retirement port');
          await expect(
            retire({ ...request, expectedRevision: 1 }),
          ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
          const command = {
            ...request,
            commandId: randomUUID(),
            precondition: { kind: 'revision' as const, expectedRevision: 1 },
            command: { type: 'claim' },
          };
          await backend.submitCommand(command);
          const before = await backend.getSessionSummary(request);
          expect(before).toMatchObject({
            status: 'completed',
            historyAvailable: true,
          });
          const receipts = await storage.getReceipt(
            creation.route.sessionId,
            command.commandId,
          );
          const outbox = await storage.readOutboxBatch({ limit: 100 });
          await expect(
            retire({ ...request, expectedRevision: before.sourceRevision - 1 }),
          ).rejects.toMatchObject({ envelope: { code: 'STALE_REVISION' } });
          await expect(
            retire({
              ...request,
              accessContext: { ...accessContext, scopes: ['session:view'] },
              expectedRevision: before.sourceRevision,
            }),
          ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
          const purged = await retire({
            ...request,
            expectedRevision: before.sourceRevision,
          });
          expect(purged).toEqual({ ...before, historyAvailable: false });
          expect(
            await retire({
              ...request,
              expectedRevision: before.sourceRevision,
            }),
          ).toEqual(purged);
          const head = await storage.getHead(creation.route.sessionId);
          expect(head?.encodedState).toBeNull();
          expect(head?.revision).toBe(before.sourceRevision);
          expect(
            await storage.getReceipt(
              creation.route.sessionId,
              command.commandId,
            ),
          ).toEqual(receipts);
          expect(await storage.readOutboxBatch({ limit: 100 })).toEqual(outbox);
          expect((await backend.submitCommand(command)).receipt.status).toBe(
            'duplicate',
          );
        },
      );
    }
  },
);
