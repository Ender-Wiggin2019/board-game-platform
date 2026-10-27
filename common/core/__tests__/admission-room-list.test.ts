import type { AccessContext, PlatformRoom } from '@board-game/contracts';
import { GameHost, GameRegistry } from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { AdmissionCoordinator } from '../src/admission/AdmissionCoordinator.js';
import { MemoryAdmissionStore } from '../src/admission/memory.js';

const access: AccessContext = {
  principalId: 'platform',
  authEpoch: 'room-list-test',
  scopes: ['session:create', 'session:control'],
};

function setup() {
  const store = new MemoryAdmissionStore();
  const backend = new GameHost({
    registry: new GameRegistry().register(sequentialTurnFixture),
    storage: new MemoryStorageDriver(),
    backendBindingId: 'room-list-backend',
    storageBindingId: 'room-list-storage',
    authorize: async () => undefined,
  });
  const deniedReads = new Set<string>();
  let id = 0;
  const coordinator = new AdmissionCoordinator({
    store,
    newId: () => `room-list-${++id}`,
    resolveRelease: () => ({
      gameId: sequentialTurnFixture.gameId,
      releaseId: sequentialTurnFixture.releaseId,
      mode: sequentialTurnFixture.modes[0],
      backendBindingId: 'room-list-backend',
      storageBindingId: 'room-list-storage',
      ownershipEpoch: 'room-list-epoch',
      backend,
      validateSetup: () => undefined,
    }),
    resolveBackend: () => backend,
    authorize: async (principalId, room, action) => {
      if (action === 'read') return !deniedReads.has(room.id);
      return room.ownerId === principalId || action === 'create';
    },
    freezePolicy: async () => ({
      rating: null,
      validityPolicyVersion: 'room-list-v1',
    }),
    accessForStart: async () => access,
  });

  async function createRoom(
    principalId: string,
    visibility: PlatformRoom['visibility'],
  ) {
    return coordinator.createRoom(principalId, {
      gameId: sequentialTurnFixture.gameId,
      modeId: sequentialTurnFixture.modes[0].id,
      releaseId: sequentialTurnFixture.releaseId,
      visibility,
      setup: { target: 2 },
    });
  }

  return { coordinator, createRoom, deniedReads, store };
}

describe('admission room discovery', () => {
  it('returns public open rooms and own memberships while hiding private others', async () => {
    const fixture = setup();
    const publicRoom = await fixture.createRoom('bob', 'public');
    await fixture.createRoom('bob', 'private');
    const ownPrivateRoom = await fixture.createRoom('alice', 'private');

    const result = await fixture.coordinator.listRooms('alice');

    expect(result.rooms.map((room) => room.id)).toEqual([
      publicRoom.id,
      ownPrivateRoom.id,
    ]);
  });

  it('applies current read authorization to store candidates', async () => {
    const fixture = setup();
    const publicRoom = await fixture.createRoom('bob', 'public');
    const ownPrivateRoom = await fixture.createRoom('alice', 'private');
    fixture.deniedReads.add(publicRoom.id);

    const result = await fixture.coordinator.listRooms('alice');

    expect(result.rooms.map((room) => room.id)).toEqual([ownPrivateRoom.id]);
  });

  it('filters non-open memberships before returning the open-room view', async () => {
    const fixture = setup();
    const publicRoom = await fixture.createRoom('bob', 'public');
    const ownClosedRoom = await fixture.createRoom('alice', 'private');
    await fixture.store.transaction(ownClosedRoom.id, async (tx) => {
      const room = tx.getRoom();
      tx.setRoom({ ...room, revision: room.revision + 1, status: 'closed' });
    });

    const result = await fixture.coordinator.listRooms('alice', {
      status: 'open',
    });

    expect(result.rooms.map((room) => room.id)).toEqual([publicRoom.id]);
  });

  it('keeps pagination bounded while filtering denied candidates', async () => {
    const fixture = setup();
    const first = await fixture.createRoom('bob', 'public');
    const second = await fixture.createRoom('bob', 'public');
    const third = await fixture.createRoom('bob', 'public');
    fixture.deniedReads.add(first.id);

    const page = await fixture.coordinator.listRooms('alice', { limit: 1 });
    expect(page.rooms.map((room) => room.id)).toEqual([second.id]);
    expect(page.nextCursor).toBeDefined();

    const next = await fixture.coordinator.listRooms('alice', {
      limit: 1,
      cursor: page.nextCursor,
    });
    expect(next.rooms.map((room) => room.id)).toEqual([third.id]);
    expect(next.nextCursor).toBeUndefined();
  });

  it('rejects an invalid bounded page size', async () => {
    const fixture = setup();
    await expect(
      fixture.coordinator.listRooms('alice', { limit: 101 }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.admission.room_limit',
      },
    });
  });
});
