import { randomUUID } from 'node:crypto';
import {
  type AccessContext,
  type ControlSessionRequest,
  type CreateSessionRequest,
  type GetStatusRequest,
  type SessionRoute,
} from '@board-game/contracts';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const cleanups: Array<() => Promise<void>> = [];
const viewer: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:view'],
};
const creator: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:create', 'session:view', 'session:control'],
};
const canceller: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:control:cancel'],
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(['memory', ...(databaseUrl ? ['postgres'] : [])])(
  'admission recovery (%s)',
  (driver) => {
    async function storage(): Promise<StorageDriver> {
      if (driver === 'memory') return new MemoryStorageDriver();
      const schema = `host_admission_test_${randomUUID().replaceAll('-', '')}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const store = new PostgresStorageDriver({ pool, schema });
      await store.migrate();
      cleanups.push(async () => {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      });
      return store;
    }

    function host(store: StorageDriver): GameHost {
      return new GameHost({
        registry: new GameRegistry().register(sequentialTurnFixture),
        storage: store,
        backendBindingId: 'backend-1',
        storageBindingId: 'storage-1',
        authorize: async () => undefined,
      });
    }

    function createRequest(): CreateSessionRequest {
      return {
        protocolVersion: 1,
        accessContext: creator,
        startId: randomUUID(),
        startGeneration: 7,
        route: {
          gameId: sequentialTurnFixture.gameId,
          modeId: 'sequential',
          sessionId: randomUUID(),
          releaseId: sequentialTurnFixture.releaseId,
          backendBindingId: 'backend-1',
          storageBindingId: 'storage-1',
          ownershipEpoch: 'epoch-1',
        },
        participants: [
          { principalId: 'alice', seatId: 'seat-1' },
          { principalId: 'bob', seatId: 'seat-2' },
        ],
        setup: { target: 2 },
        seed: 'seed-1',
      };
    }

    function statusRequest(
      route: SessionRoute,
      extra: Pick<GetStatusRequest, 'startId' | 'commandId'> = {},
    ): GetStatusRequest {
      return {
        protocolVersion: 1,
        accessContext: viewer,
        route,
        ...extra,
      };
    }

    it('reports an unobserved start as unknown instead of NOT_FOUND', async () => {
      const store = await storage();
      const route: SessionRoute = {
        gameId: 'missing-game',
        modeId: 'standard',
        sessionId: randomUUID(),
        releaseId: 'release-1',
        backendBindingId: 'backend-1',
        storageBindingId: 'storage-1',
        ownershipEpoch: 'epoch-1',
      };

      await expect(
        host(store).getStatus(statusRequest(route, { startId: 'start-1' })),
      ).resolves.toEqual({
        kind: 'start',
        startId: 'start-1',
        sessionId: route.sessionId,
        status: 'unknown',
      });
      await expect(
        host(store).getStatus(statusRequest(route, { commandId: 'command-1' })),
      ).resolves.toEqual({
        kind: 'command',
        commandId: 'command-1',
        sessionId: route.sessionId,
        status: 'unknown',
      });
    });

    it('retains the generation and cancel tombstone across retries and cleanup', async () => {
      const store = await storage();
      const backend = host(store);
      const request = createRequest();
      await backend.createSession(request);
      expect(
        (await store.getHead(request.route.sessionId))?.startGeneration,
      ).toBe(7);

      const cancel: ControlSessionRequest = {
        protocolVersion: 1,
        accessContext: canceller,
        route: request.route,
        commandId: 'cancel-1',
        expectedRevision: 0,
        action: 'cancel',
      };
      await backend.controlSession(cancel);
      await store.clearTerminalSession(request.route.sessionId);

      await expect(backend.createSession(request)).resolves.toMatchObject({
        status: 'cancelled',
        startId: request.startId,
      });
      await expect(
        backend.activateSession({
          protocolVersion: 1,
          accessContext: creator,
          route: request.route,
          startId: request.startId,
        }),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      expect((await store.getHead(request.route.sessionId))?.status).toBe(
        'cancelled',
      );
    });

    it('replays create and activate after committed responses are lost', async () => {
      const store = await storage();
      const backend = host(store);
      const request = createRequest();
      const createSession = store.createSession.bind(store);
      let loseCreateAck = true;
      store.createSession = async (...args) => {
        const result = await createSession(...args);
        if (loseCreateAck) {
          loseCreateAck = false;
          throw new Error('lost create acknowledgement');
        }
        return result;
      };
      await expect(backend.createSession(request)).rejects.toThrow(
        'lost create acknowledgement',
      );
      await expect(host(store).createSession(request)).resolves.toMatchObject({
        sessionId: request.route.sessionId,
        status: 'suspended',
      });

      const transaction = store.transaction.bind(store);
      let loseActivateAck = true;
      store.transaction = async (...args) => {
        const result = await transaction(...args);
        if (loseActivateAck) {
          loseActivateAck = false;
          throw new Error('lost activate acknowledgement');
        }
        return result;
      };
      const activation = {
        protocolVersion: 1 as const,
        accessContext: creator,
        route: request.route,
        startId: request.startId,
      };
      await expect(backend.activateSession(activation)).rejects.toThrow(
        'lost activate acknowledgement',
      );
      await expect(
        host(store).activateSession(activation),
      ).resolves.toMatchObject({
        sessionId: request.route.sessionId,
        status: 'active',
      });
      expect((await store.getHead(request.route.sessionId))?.status).toBe(
        'active',
      );
    });
  },
);
