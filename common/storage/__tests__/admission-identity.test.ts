import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type SessionHead,
  type StorageDriver,
} from '../src/index.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(['memory', ...(databaseUrl ? ['postgres'] : [])])(
  'admission storage identity (%s)',
  (driver) => {
    async function storage(): Promise<StorageDriver> {
      if (driver === 'memory') return new MemoryStorageDriver();
      const schema = `storage_admission_test_${randomUUID().replaceAll('-', '')}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const store = new PostgresStorageDriver({ pool, schema });
      await store.migrate();
      cleanups.push(async () => {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      });
      return store;
    }

    function head(
      sessionId = randomUUID(),
      status: SessionHead['status'] = 'suspended',
    ): SessionHead {
      return {
        route: {
          gameId: 'game',
          modeId: 'standard',
          sessionId,
          releaseId: 'release-1',
          backendBindingId: 'backend-1',
          storageBindingId: 'storage-1',
          ownershipEpoch: 'epoch-1',
        },
        startId: 'start-1',
        startGeneration: 4,
        startDigest: 'digest-1',
        status,
        revision: status === 'cancelled' ? 1 : 0,
        encodedState: status === 'cancelled' ? null : { turn: 0 },
        schemaVersion: 1,
        participants: [
          {
            principalId: 'player-1',
            seatId: 'seat-1',
            controller: 'ai',
            controllerId: 'policy-v1',
            controllerOptions: { temperature: 0 },
          },
        ],
        summary: { turn: 0 },
        logicalTime: 0,
        eventSequence: 0,
      };
    }

    it('fences generation and the complete frozen participant identity', async () => {
      const store = await storage();
      const initial = head();
      await store.createSession(initial);
      await expect(
        store.createSession({ ...initial, startGeneration: 5 }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_SESSION' });
      await expect(
        store.createSession({
          ...initial,
          participants: [
            {
              ...initial.participants[0],
              controllerOptions: { temperature: 1 },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_SESSION' });
      expect(await store.getHead(initial.route.sessionId)).toMatchObject({
        startGeneration: 4,
        participants: initial.participants,
      });
    });

    it('retains cancelled heads as retry tombstones after terminal cleanup', async () => {
      const store = await storage();
      const initial = head(randomUUID(), 'cancelled');
      await store.createSession(initial);
      await store.clearTerminalSession(initial.route.sessionId);
      await expect(store.createSession(initial)).resolves.toMatchObject({
        status: 'cancelled',
        startId: initial.startId,
        startGeneration: initial.startGeneration,
      });
      expect(await store.getHead(initial.route.sessionId)).toMatchObject({
        status: 'cancelled',
        encodedState: null,
      });
    });
  },
);
