import type { PlatformRoom, SessionRoute } from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryAdmissionStore } from '../src/admission/memory.js';
import { PostgresAdmissionStore } from '../src/admission/postgres.js';
import type {
  AdmissionStore,
  RoomTransaction,
  StartOperation,
} from '../src/admission/types.js';

let createdAt = 1;

function route(sessionId: string): SessionRoute {
  return {
    gameId: 'fixture-game',
    modeId: 'fixture-mode',
    sessionId,
    releaseId: 'fixture-release',
    backendBindingId: 'fixture-backend',
    storageBindingId: 'fixture-storage',
    ownershipEpoch: 'fixture-epoch',
  };
}

function room(id: string): PlatformRoom {
  return {
    id,
    ownerId: 'owner',
    gameId: 'fixture-game',
    modeId: 'fixture-mode',
    releaseId: 'fixture-release',
    visibility: 'public',
    setup: { difficulty: 'normal' },
    members: [{ principalId: 'owner', seatId: `seat-${id}`, ready: true }],
    revision: 0,
    startGeneration: 0,
    status: 'open',
  };
}

function roomWith(id: string, overrides: Partial<PlatformRoom>): PlatformRoom {
  return { ...room(id), ...overrides };
}

function startFor(roomValue: PlatformRoom, sessionId: string): StartOperation {
  const sessionRoute = route(sessionId);
  const participants = roomValue.members.map(
    ({ ready: _ready, ...member }) => member,
  );
  return {
    startId: `start-${roomValue.id}`,
    sessionId,
    roomId: roomValue.id,
    state: 'creating',
    route: sessionRoute,
    requestId: `request-${roomValue.id}`,
    requestDigest: `digest-${roomValue.id}`,
    initiatedBy: roomValue.ownerId,
    startGeneration: roomValue.startGeneration,
    setup: roomValue.setup,
    seed: `seed-${roomValue.id}`,
    admission: {
      id: `admission-${roomValue.id}`,
      route: sessionRoute,
      visibility: roomValue.visibility,
      participants,
      rating: null,
      validityPolicyVersion: 'fixture-policy-v1',
      createdAt: createdAt++,
    },
  };
}

async function createRoom(store: AdmissionStore, id: string): Promise<void> {
  await store.createRoom(room(id));
}

async function installCreating(
  store: AdmissionStore,
  roomId: string,
  sessionId = `session-${roomId}`,
): Promise<StartOperation> {
  return store.transaction(roomId, async (tx) => {
    const current = tx.getRoom();
    const nextRoom: PlatformRoom = {
      ...current,
      status: 'starting',
      revision: current.revision + 1,
      startGeneration: current.startGeneration + 1,
      route: route(sessionId),
    };
    tx.setRoom(nextRoom);
    const nextStart = startFor(nextRoom, sessionId);
    tx.setStart(nextStart);
    return nextStart;
  });
}

async function moveStart(
  store: AdmissionStore,
  roomId: string,
  state: 'activating' | 'active' | 'cancelling',
): Promise<void> {
  await store.transaction(roomId, async (tx) => {
    const currentStart = tx.getStart();
    if (!currentStart) throw new Error('fixture start missing');
    if (state === 'active') {
      const currentRoom = tx.getRoom();
      tx.setRoom({
        ...currentRoom,
        status: 'started',
        revision: currentRoom.revision + 1,
      });
    }
    tx.setStart({ ...currentStart, state });
  });
}

type StoreFactory = () => Promise<AdmissionStore>;

function registerStoreSuite(
  name: string,
  factory: StoreFactory,
  beforeEachStore?: () => Promise<void>,
): void {
  describe(name, () => {
    let store: AdmissionStore;

    beforeEach(async () => {
      store = await factory();
      await beforeEachStore?.();
    });

    it('clones rooms, starts, and admissions on reads', async () => {
      await createRoom(store, 'clone-room');
      const start = await installCreating(store, 'clone-room');

      const readRoom = await store.getRoom('clone-room');
      const readStart = await store.getStart('clone-room');
      const readStartBySession = await store.getStartBySession(start.sessionId);
      const readAdmission = await store.getAdmission(start.sessionId);
      if (!readRoom || !readStart || !readStartBySession || !readAdmission)
        throw new Error('fixture read missing');
      (readRoom as unknown as { setup: unknown }).setup = { changed: true };
      (
        readStart.admission.participants[0] as { principalId: string }
      ).principalId = 'changed';
      (
        readStartBySession.admission.participants[0] as { principalId: string }
      ).principalId = 'changed-by-session';
      (readAdmission.participants[0] as { principalId: string }).principalId =
        'changed-again';

      expect((await store.getRoom('clone-room'))?.setup).toEqual({
        difficulty: 'normal',
      });
      expect(
        (await store.getStart('clone-room'))?.admission.participants[0],
      ).toEqual({
        principalId: 'owner',
        seatId: 'seat-clone-room',
      });
      expect(
        (await store.getAdmission(start.sessionId))?.participants[0],
      ).toEqual({
        principalId: 'owner',
        seatId: 'seat-clone-room',
      });
      expect(
        (await store.getStartBySession(start.sessionId))?.admission
          .participants[0],
      ).toEqual({
        principalId: 'owner',
        seatId: 'seat-clone-room',
      });
    });

    it('returns a cloned admission map for a bounded batch lookup', async () => {
      await createRoom(store, 'batch-room-a');
      await createRoom(store, 'batch-room-b');
      const first = await installCreating(store, 'batch-room-a');
      const second = await installCreating(store, 'batch-room-b');

      const admissions = await store.getAdmissions([
        first.sessionId,
        'missing-session',
        second.sessionId,
      ]);

      expect([...admissions.keys()]).toEqual([
        first.sessionId,
        second.sessionId,
      ]);
      expect(admissions.get(first.sessionId)).toEqual(first.admission);
      const mutable = admissions.get(first.sessionId) as unknown as {
        participants: { principalId: string }[];
      };
      const participant = mutable.participants[0];
      if (!participant) throw new Error('batch admission participant missing');
      participant.principalId = 'changed';
      expect(
        (await store.getAdmission(first.sessionId))?.participants[0],
      ).toEqual({
        principalId: 'owner',
        seatId: 'seat-batch-room-a',
      });
      expect(await store.getAdmissions([])).toEqual(new Map());
    });

    it('rolls back room and start changes when the transaction throws', async () => {
      await createRoom(store, 'rollback-room');
      await expect(
        store.transaction('rollback-room', async (tx) => {
          const current = tx.getRoom();
          tx.setRoom({ ...current, revision: current.revision + 1 });
          throw new Error('abort fixture transaction');
        }),
      ).rejects.toThrow('abort fixture transaction');

      expect(await store.getRoom('rollback-room')).toEqual(
        room('rollback-room'),
      );
      expect(await store.getStart('rollback-room')).toBeNull();
    });

    it('serializes concurrent starts for one room', async () => {
      await createRoom(store, 'serial-room');
      const attempt = async (sessionId: string) =>
        store.transaction('serial-room', async (tx) => {
          const existing = tx.getStart();
          if (existing) return existing.startId;
          await new Promise((resolve) => setTimeout(resolve, 5));
          const current = tx.getRoom();
          const nextRoom: PlatformRoom = {
            ...current,
            status: 'starting',
            revision: current.revision + 1,
            startGeneration: current.startGeneration + 1,
            route: route(sessionId),
          };
          tx.setRoom(nextRoom);
          const nextStart = startFor(nextRoom, sessionId);
          tx.setStart(nextStart);
          return nextStart.startId;
        });

      const results = await Promise.all([
        attempt('serial-session-a'),
        attempt('serial-session-b'),
      ]);
      expect(new Set(results)).toHaveLength(1);
      expect(await store.getStart('serial-room')).not.toBeNull();
    });

    it('rejects the same session in two different rooms', async () => {
      await createRoom(store, 'unique-room-a');
      await createRoom(store, 'unique-room-b');
      const results = await Promise.allSettled([
        installCreating(store, 'unique-room-a', 'same-session'),
        installCreating(store, 'unique-room-b', 'same-session'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(await store.getAdmission('same-session')).not.toBeNull();
    });

    it('closes transaction handles after completion', async () => {
      await createRoom(store, 'handle-room');
      let handle: RoomTransaction | undefined;
      await store.transaction('handle-room', async (tx) => {
        handle = tx;
        return undefined;
      });
      if (!handle) throw new Error('fixture transaction handle missing');
      const transactionHandle = handle;
      expect(() => transactionHandle.getRoom()).toThrow(
        'platform.transaction.closed',
      );
      expect(() => transactionHandle.getStart()).toThrow(
        'platform.transaction.closed',
      );
    });

    it('returns only bounded pending starts', async () => {
      await createRoom(store, 'pending-room-a');
      await createRoom(store, 'pending-room-b');
      await createRoom(store, 'pending-room-c');
      await installCreating(store, 'pending-room-a');
      await installCreating(store, 'pending-room-b');
      await installCreating(store, 'pending-room-c');
      await moveStart(store, 'pending-room-b', 'activating');
      await moveStart(store, 'pending-room-b', 'active');
      await moveStart(store, 'pending-room-c', 'cancelling');

      const pending = await store.listPending(1);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.roomId).toBe('pending-room-a');
      expect(await store.listPending(1_000)).toHaveLength(2);
      await expect(store.listPending(0)).rejects.toThrow(
        'platform.admission.pending_limit',
      );
    });

    it("lists public open rooms and the caller's memberships only", async () => {
      await createRoom(store, 'a-public-open');
      await store.createRoom(
        roomWith('b-private-other', {
          ownerId: 'other',
          visibility: 'private',
          members: [
            { principalId: 'other', seatId: 'seat-other', ready: false },
          ],
        }),
      );
      await store.createRoom(
        roomWith('c-private-member', {
          ownerId: 'other',
          visibility: 'private',
          members: [
            { principalId: 'other', seatId: 'seat-other', ready: false },
            { principalId: 'viewer', seatId: 'seat-viewer', ready: false },
          ],
        }),
      );
      await store.createRoom(
        roomWith('d-closed-member', {
          ownerId: 'other',
          visibility: 'private',
          status: 'closed',
          members: [
            { principalId: 'other', seatId: 'seat-other', ready: false },
            {
              principalId: 'viewer',
              seatId: 'seat-viewer-closed',
              ready: false,
            },
          ],
        }),
      );
      await store.createRoom(
        roomWith('direct:private-member', {
          ownerId: 'viewer',
          visibility: 'private',
          members: [
            { principalId: 'viewer', seatId: 'seat-direct', ready: true },
          ],
        }),
      );

      const result = await store.listRooms({ principalId: 'viewer' });
      expect(result.rooms.map((candidate) => candidate.id)).toEqual([
        'a-public-open',
        'c-private-member',
        'd-closed-member',
      ]);

      const mutable = result.rooms[0] as unknown as {
        setup: Record<string, string>;
      };
      mutable.setup.difficulty = 'changed';
      expect((await store.getRoom('a-public-open'))?.setup).toEqual({
        difficulty: 'normal',
      });
    });

    it('paginates by stable room id and applies the game filter', async () => {
      await createRoom(store, 'a-game-one');
      await createRoom(store, 'b-game-one');
      await createRoom(store, 'c-game-one');
      await store.createRoom(roomWith('d-game-two', { gameId: 'other-game' }));

      const first = await store.listRooms({
        principalId: 'viewer',
        gameId: 'fixture-game',
        limit: 2,
      });
      expect(first.rooms.map((candidate) => candidate.id)).toEqual([
        'a-game-one',
        'b-game-one',
      ]);
      expect(first.nextCursor).toBe('b-game-one');

      const second = await store.listRooms({
        principalId: 'viewer',
        gameId: 'fixture-game',
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.rooms.map((candidate) => candidate.id)).toEqual([
        'c-game-one',
      ]);
      expect(second.nextCursor).toBeUndefined();
    });

    it('filters lifecycle status before applying pagination', async () => {
      await store.createRoom(
        roomWith('a-closed-member', {
          ownerId: 'viewer',
          status: 'closed',
          members: [{ principalId: 'viewer', seatId: 'seat-a', ready: false }],
        }),
      );
      await createRoom(store, 'b-open');
      await createRoom(store, 'c-open');

      const first = await store.listRooms({
        principalId: 'viewer',
        status: 'open',
        limit: 1,
      });
      expect(first.rooms.map((candidate) => candidate.id)).toEqual(['b-open']);
      expect(first.nextCursor).toBe('b-open');

      const second = await store.listRooms({
        principalId: 'viewer',
        status: 'open',
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.rooms.map((candidate) => candidate.id)).toEqual(['c-open']);
      expect(second.nextCursor).toBeUndefined();
    });

    it('rejects room list limits outside the bounded range', async () => {
      await expect(
        store.listRooms({ principalId: 'viewer', limit: 0 }),
      ).rejects.toThrow('platform.admission.room_limit');
      await expect(
        store.listRooms({ principalId: 'viewer', limit: 101 }),
      ).rejects.toThrow('platform.admission.room_limit');
    });
  });
}

registerStoreSuite(
  'MemoryAdmissionStore',
  async () => new MemoryAdmissionStore(),
);

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('PostgresAdmissionStore', () => {
  let pool: Pool | undefined;
  let store: PostgresAdmissionStore;
  const schema = `bgp_admission_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresAdmissionStore({ pool, schema });
    await store.migrate();
    await store.validateSchema();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('fixture pool missing');
    await pool.query(
      `TRUNCATE "${schema}"."starts", "${schema}"."rooms" CASCADE`,
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  registerStoreSuite(
    'durable behavior',
    async () => store,
    async () => undefined,
  );

  it('finds admission after a store instance is recreated', async () => {
    await createRoom(store, 'restart-room');
    const start = await installCreating(
      store,
      'restart-room',
      'restart-session',
    );
    await store.close();
    const restarted = new PostgresAdmissionStore({ pool, schema });
    expect(await restarted.getStart('restart-room')).toEqual(start);
    expect(await restarted.getStartBySession('restart-session')).toEqual(start);
    expect(await restarted.getAdmission('restart-session')).toEqual(
      start.admission,
    );
    await restarted.close();
  });
});
