import type { ModeDefinition, PlatformRoom } from '@board-game/contracts';
import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MemoryAdmissionStore } from '../src/admission/memory.js';
import { PostgresAdmissionStore } from '../src/admission/postgres.js';
import { RoomManagementService } from '../src/rooms/RoomManagementService.js';
import type {
  RoomManagementPolicy,
  RoomManagementStore,
} from '../src/rooms/types.js';

const mode: ModeDefinition = {
  id: 'room-mode',
  entry: 'room',
  minPlayers: 1,
  maxPlayers: 2,
  history: 'summary-and-replay',
  platformRating: false,
  concurrency: 'revision',
};

function fixture(
  store: RoomManagementStore = new MemoryAdmissionStore(),
  options: {
    readonly maxPlayers?: number;
    readonly resolveCapacity?: (room: PlatformRoom) => number;
    readonly createBotProfile?: RoomManagementPolicy['createBotProfile'];
    readonly controllers?: RoomManagementPolicy['controllers'];
    readonly controllerOptions?: RoomManagementPolicy['controllerOptions'];
    readonly authorize?: RoomManagementPolicy['authorize'];
    readonly passwordVerifier?: RoomManagementPolicy['verifyPassword'] | null;
    readonly newId?: () => string;
  } = {},
) {
  let nextId = 0;
  const service = new RoomManagementService(store, {
    resolveMode: (_gameId, modeId, releaseId) => {
      if (modeId !== mode.id || releaseId !== 'release-1')
        throw new Error('mode unavailable');
      return {
        minPlayers: mode.minPlayers,
        maxPlayers: options.maxPlayers ?? mode.maxPlayers,
        entry: mode.entry,
        validateSetup: () => undefined,
      };
    },
    ...(options.resolveCapacity
      ? { resolveCapacity: options.resolveCapacity }
      : {}),
    ...(options.createBotProfile
      ? { createBotProfile: options.createBotProfile }
      : {}),
    ...(options.controllers ? { controllers: options.controllers } : {}),
    ...(options.controllerOptions
      ? { controllerOptions: options.controllerOptions }
      : {}),
    authorize: options.authorize ?? (async () => true),
    authorizeInvite: async () => true,
    hashPassword: async (password) => `hash:${password}`,
    ...(options.passwordVerifier === null
      ? {}
      : {
          verifyPassword:
            options.passwordVerifier ??
            (async (hash: string, password: string) =>
              hash === `hash:${password}`),
        }),
    validateColor: (color, room, principalId) => {
      if (!['green', 'orange', 'purple', 'white'].includes(color))
        throw new Error('invalid color');
      if (
        room.members.some(
          (member) =>
            member.principalId !== principalId &&
            (member.publicProfile?.appearance as { color?: string } | undefined)
              ?.color === color,
        )
      )
        throw new Error('color taken');
      return color;
    },
    newId: options.newId ?? (() => `id-${++nextId}`),
  });
  return { service, store };
}

function createInput(
  overrides: Partial<Parameters<RoomManagementService['createRoom']>[1]> = {},
) {
  return {
    gameId: 'seti',
    modeId: mode.id,
    releaseId: 'release-1',
    visibility: 'private' as const,
    setup: { playerCount: 2 },
    ...overrides,
  };
}

describe('generic room management', () => {
  it('keeps the preset seed in the platform room and creation idempotency boundary', async () => {
    const { service, store } = fixture();
    const input = createInput({
      requestId: 'seeded-room',
      seed: 'daily:brass:1',
    });
    const room = await service.createRoom('owner', input);
    expect(await store.getRoom(room.id)).toMatchObject({
      seed: 'daily:brass:1',
      setup: { playerCount: 2 },
    });
    expect(await service.createRoom('owner', input)).toEqual(room);
    await expect(
      service.createRoom('owner', { ...input, seed: 'different' }),
    ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    for (const seed of ['', ' ', 'invalid\nseed', 'x'.repeat(257)]) {
      await expect(
        service.createRoom('owner', createInput({ seed })),
      ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    }
  });

  it('reports missing room access as not found', async () => {
    const { store } = fixture();
    await expect(store.getRoomAccess('missing-room')).rejects.toMatchObject({
      envelope: { code: 'NOT_FOUND', messageKey: 'platform.room.not_found' },
    });
  });

  it('uses one batched access lookup for a room page', async () => {
    const store = new MemoryAdmissionStore();
    const accessMany = vi.spyOn(store, 'getRoomAccessMany');
    const { service } = fixture(store);
    await service.createRoom('owner', createInput({ visibility: 'public' }));
    await service.createRoom('owner', createInput({ visibility: 'public' }));

    const page = await service.listRooms('viewer');

    expect(page.rooms).toHaveLength(2);
    expect(accessMany).toHaveBeenCalledTimes(1);
    expect(accessMany.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('replays one immutable create intent across concurrent retries and room edits', async () => {
    const { service, store } = fixture();
    const input = createInput({
      requestId: 'room-create-retry-1',
      name: 'Original table',
      password: 'secret',
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => service.createRoom('owner', input)),
    );
    expect(new Set(results.map((room) => room.id)).size).toBe(1);
    const created = results.at(0);
    if (!created) throw new Error('room create result missing');
    const requestId = input.requestId;
    if (!requestId) throw new Error('room create request id missing');
    expect(
      await store.getRoomCreateReceipt('owner', requestId),
    ).not.toHaveProperty('password');

    const changed = await service.renameRoom(
      'owner',
      created.id,
      created.revision,
      'Changed table',
    );
    const replayed = await service.createRoom('owner', input);
    expect(replayed).toMatchObject({
      id: created.id,
      name: 'Changed table',
      revision: changed.revision,
    });
    await expect(
      service.createRoom('owner', { ...input, name: 'Other table' }),
    ).rejects.toMatchObject({
      envelope: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    await expect(
      service.createRoom('owner', { ...input, password: 'wrong' }),
    ).rejects.toMatchObject({
      envelope: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const isolated = await service.createRoom('other', input);
    expect(isolated.id).not.toBe(created.id);
  });

  it('validates request ids and password verification before idempotent creation', async () => {
    const { service } = fixture();
    await expect(
      service.createRoom(
        'owner',
        createInput({ requestId: '   ', password: undefined }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    const withoutVerifier = fixture(new MemoryAdmissionStore(), {
      passwordVerifier: null,
    }).service;
    await expect(
      withoutVerifier.createRoom(
        'owner',
        createInput({ requestId: 'missing-verifier', password: 'secret' }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await expect(
      withoutVerifier.createRoom('owner', createInput({ password: 'secret' })),
    ).resolves.toMatchObject({ ownerId: 'owner' });
  });

  it('keeps credentials private and requires a password for password rooms', async () => {
    const { service } = fixture();
    const created = await service.createRoom(
      'owner',
      createInput({ visibility: 'public', password: 'secret' }),
    );
    expect(created.metadata.passwordProtected).toBe(true);
    expect(JSON.stringify(created)).not.toContain('hash:secret');
    await expect(
      service.joinRoom('guest', created.id, created.revision, {
        password: 'wrong',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    const joined = await service.joinRoom(
      'guest',
      created.id,
      created.revision,
      { password: 'secret' },
    );
    expect(joined.members.map((member) => member.principalId)).toEqual([
      'owner',
      'guest',
    ]);
  });

  it('supports private access grants and counts only reserved seats against capacity', async () => {
    const { service } = fixture();
    let room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'reserved',
      seatId: 'reserved-seat',
    });
    const listed = await service.listRooms('reserved');
    expect(listed.rooms.map((candidate) => candidate.id)).toContain(room.id);
    expect(room.metadata.reservations).toEqual([
      {
        grantId: 'id-3',
        principalId: 'reserved',
        seatId: 'reserved-seat',
        state: 'pending',
      },
    ]);
    await expect(
      service.joinRoom('unreserved', room.id, room.revision),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    room = await service.joinRoom('reserved', room.id, room.revision);
    expect(room.members.at(-1)).toMatchObject({
      principalId: 'reserved',
      seatId: 'reserved-seat',
    });
  });

  it('uses setup capacity consistently for metadata, joins, and seat reservations', async () => {
    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      resolveCapacity: (room) => {
        const setup = room.setup;
        return typeof setup === 'object' &&
          setup !== null &&
          !Array.isArray(setup)
          ? Number((setup as Record<string, unknown>).playerCount)
          : 4;
      },
    });
    let room = await service.createRoom(
      'owner',
      createInput({ setup: { playerCount: 2 }, visibility: 'public' }),
    );
    expect(room.metadata.capacity).toBe(2);
    room = await service.joinRoom('guest', room.id, room.revision);
    await expect(
      service.joinRoom('third', room.id, room.revision),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    await expect(
      service.grantInvite('owner', room.id, room.revision, {
        principalId: 'reserved',
        seatId: 'reserved-seat',
      }),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
  });

  it('adds owner-controlled bot seats with safe identity and preserves bot readiness', async () => {
    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      createBotProfile: (room) => ({
        displayName: `Bot for ${room.name ?? room.id}`,
        gameProfile: { kind: 'fixture-bot' },
      }),
    });
    let room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public', name: 'Bot table' }),
    );
    expect(room.metadata.botsAllowed).toBe(true);
    room = await service.addBot('owner', room.id, room.revision);
    const bot = room.members.at(-1);
    expect(bot).toMatchObject({
      controller: 'bot',
      ready: true,
      publicProfile: {
        displayName: 'Bot for Bot table',
        gameProfile: { kind: 'fixture-bot' },
      },
    });
    expect(bot?.principalId).toMatch(/^bot:/u);
    expect(bot?.seatId).toMatch(/^bot:/u);
    expect(room.ownerId).toBe('owner');
    if (!bot) throw new Error('bot member missing');
    await expect(
      service.ready(bot.principalId, room.id, room.revision, false),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    room = await service.renameRoom('owner', room.id, room.revision, 'Renamed');
    expect(
      room.members.find((member) => member.controller === 'bot'),
    ).toMatchObject({
      ready: true,
    });
    expect(
      room.members.find((member) => member.principalId === 'owner'),
    ).toMatchObject({
      ready: false,
    });
    await expect(
      service.leaveRoom(bot.principalId, room.id, room.revision),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    const kicked = await service.kickMember(
      'owner',
      room.id,
      room.revision,
      bot.principalId,
    );
    expect(kicked.members.some((member) => member.controller === 'bot')).toBe(
      false,
    );
  });

  it('bounds new controlled-seat identities for long room ids', async () => {
    let nextId = 0;
    const longRoomId = `room-${'x'.repeat(300)}`;
    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      controllers: () => ({
        hotseat: true,
        automation: [
          { id: 'fixture.ai', kind: 'ai', label: 'Fixture AI' },
          { id: 'fixture.automa', kind: 'automa', label: 'Fixture Automa' },
        ],
      }),
      controllerOptions: () => ({}),
      newId: () => {
        nextId += 1;
        return nextId === 2 ? longRoomId : `id-${nextId}`;
      },
    });
    let room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    expect(room.id).toBe(longRoomId);

    room = await service.addControlledSeat('owner', room.id, room.revision, {
      kind: 'hotseat',
      displayName: 'Fixture hotseat',
    });
    room = await service.addControlledSeat('owner', room.id, room.revision, {
      kind: 'ai',
      controllerId: 'fixture.ai',
      options: { depth: 1 },
    });
    room = await service.addControlledSeat('owner', room.id, room.revision, {
      kind: 'automa',
      controllerId: 'fixture.automa',
      options: { difficulty: 'normal' },
    });

    const synthetic = room.members.slice(1);
    expect(synthetic).toHaveLength(3);
    expect(new Set(synthetic.map((member) => member.principalId)).size).toBe(3);
    for (const member of synthetic) {
      expect(member.principalId.length).toBeLessThanOrEqual(256);
      expect(member.seatId.length).toBeLessThanOrEqual(256);
      expect(member.principalId).toMatch(/^(hotseat|ai|automa):[a-f0-9]{64}$/u);
      expect(member.seatId).toMatch(/^(hotseat|ai|automa):[a-f0-9]{64}:seat$/u);
    }
  });

  it('derives bot availability from the profile factory and reserves capacity', async () => {
    const unsupported = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      createBotProfile: () => null,
    }).service;
    const unavailable = await unsupported.createRoom('owner', createInput());
    expect(unavailable.metadata.botsAllowed).toBe(false);
    await expect(
      unsupported.addBot('owner', unavailable.id, unavailable.revision),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });

    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 2,
      createBotProfile: () => ({ displayName: 'Fixture bot' }),
    });
    let room = await service.createRoom('owner', createInput());
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'reserved',
      seatId: 'reserved-seat',
    });
    await expect(
      service.addBot('owner', room.id, room.revision),
    ).rejects.toMatchObject({
      envelope: {
        code: 'CONFLICT',
        messageKey: 'platform.room.reserved_capacity',
      },
    });
    expect((await service.getRoom('owner', room.id)).revision).toBe(
      room.revision,
    );
  });

  it('serializes concurrent bot additions against one expected revision', async () => {
    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      createBotProfile: () => ({ displayName: 'Fixture bot' }),
    });
    const room = await service.createRoom('owner', createInput());
    const results = await Promise.allSettled([
      service.addBot('owner', room.id, room.revision),
      service.addBot('owner', room.id, room.revision),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect((await service.getRoom('owner', room.id)).members).toHaveLength(2);
  });

  it('accepts only the exact pending invite and releases a declined seat', async () => {
    const { service, store } = fixture();
    let room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'guest',
      seatId: 'guest-seat',
    });
    const access = await store.getRoomAccess(room.id);
    const grantId = access.grants[0]?.grantId;
    expect(grantId).toBeTruthy();

    await expect(
      service.acceptInvite('outsider', room.id, grantId!),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
    const accepted = await service.acceptInvite('guest', room.id, grantId!);
    expect(accepted.members.map((member) => member.principalId)).toEqual([
      'owner',
      'guest',
    ]);
    expect(accepted.members.at(-1)?.seatId).toBe('guest-seat');
    expect((await store.getRoomAccess(room.id)).grants[0]?.state).toBe(
      'accepted',
    );

    let declining = await service.createRoom(
      'owner-2',
      createInput({ visibility: 'public' }),
    );
    declining = await service.grantInvite(
      'owner-2',
      declining.id,
      declining.revision,
      { principalId: 'reserved', seatId: 'reserved-seat' },
    );
    const decliningAccess = await store.getRoomAccess(declining.id);
    const decliningGrantId = decliningAccess.grants[0]?.grantId;
    const released = await service.declineInvite(
      'reserved',
      declining.id,
      decliningGrantId!,
    );
    expect(released.metadata.reservations).toBeUndefined();
    const next = await service.joinRoom(
      'unreserved',
      declining.id,
      released.revision,
    );
    expect(next.members.map((member) => member.principalId)).toEqual([
      'owner-2',
      'unreserved',
    ]);
  });

  it('rejects duplicate room grants without committing a partial transaction', async () => {
    const { service, store } = fixture();
    const room = await service.createRoom('owner', createInput());

    await expect(
      store.transactionWithAccess(room.id, async (tx) => {
        tx.setGrant({
          grantId: 'grant-1',
          roomId: room.id,
          principalId: 'guest',
          state: 'pending',
        });
        tx.setGrant({
          grantId: 'grant-2',
          roomId: room.id,
          principalId: 'guest',
          state: 'pending',
        });
      }),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    expect(await store.getRoomAccess(room.id)).toEqual({
      security: {},
      grants: [],
    });
  });

  it('lists only authorized open pending invitations with safe room metadata', async () => {
    const { service, store } = fixture();
    let room = await service.createRoom(
      'owner',
      createInput({ name: 'Private table' }),
    );
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'guest',
      seatId: 'guest-seat',
    });

    await expect(service.listInvitations('outsider')).resolves.toEqual({
      items: [],
    });
    const denied = fixture(store, {
      authorize: async () => false,
    }).service;
    await expect(denied.listInvitations('guest')).resolves.toEqual({
      items: [],
    });
    await expect(service.listInvitations('guest')).resolves.toEqual({
      items: [
        {
          grantId: 'id-3',
          roomId: room.id,
          gameId: 'seti',
          modeId: mode.id,
          releaseId: 'release-1',
          roomName: 'Private table',
          ownerId: 'owner',
          reservedSeatId: 'guest-seat',
        },
      ],
    });
    const actions: string[] = [];
    const audited = fixture(store, {
      authorize: async (_principalId, _room, action) => {
        actions.push(action);
        return true;
      },
    }).service;
    await audited.listInvitations('guest');
    expect(actions).toEqual(['read-invitation']);

    const access = await store.getRoomAccess(room.id);
    await service.revokeInvite('owner', room.id, room.revision, 'guest');
    expect(await service.listInvitations('guest')).toEqual({ items: [] });
    expect(access.grants[0]?.state).toBe('pending');

    let closed = await service.createRoom('owner-2', createInput());
    closed = await service.grantInvite('owner-2', closed.id, closed.revision, {
      principalId: 'closed-guest',
    });
    await store.transaction(closed.id, async (tx) => {
      const current = tx.getRoom();
      tx.setRoom({
        ...current,
        status: 'closed',
        revision: current.revision + 1,
      });
    });
    expect(await service.listInvitations('closed-guest')).toEqual({
      items: [],
    });
  });

  it('does not accept a revoked or closed invitation', async () => {
    const { service, store } = fixture();
    let room = await service.createRoom('owner', createInput());
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'guest',
    });
    const grantId = (await store.getRoomAccess(room.id)).grants[0]!.grantId;
    room = await service.revokeInvite('owner', room.id, room.revision, 'guest');
    await expect(
      service.acceptInvite('guest', room.id, grantId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });

    let closed = await service.createRoom('owner-2', createInput());
    closed = await service.grantInvite('owner-2', closed.id, closed.revision, {
      principalId: 'closed-guest',
    });
    const closedGrantId = (await store.getRoomAccess(closed.id)).grants[0]!
      .grantId;
    closed = await service.deleteRoom('owner-2', closed.id, closed.revision);
    await expect(
      service.declineInvite('closed-guest', closed.id, closedGrantId),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
  });

  it('serializes expected-revision mutations and never loses a room update', async () => {
    const { service } = fixture();
    const room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    const results = await Promise.allSettled([
      service.renameRoom('owner', room.id, room.revision, 'first'),
      service.renameRoom('owner', room.id, room.revision, 'second'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const current = await service.getRoom('owner', room.id);
    expect(['first', 'second']).toContain(current.name);
    expect(current.revision).toBe(1);
  });

  it('rejects settings that displace a reserved seat and resets readiness on valid changes', async () => {
    const { service } = fixture(new MemoryAdmissionStore(), {
      maxPlayers: 4,
      resolveCapacity: (room) =>
        (room.setup as { playerCount: number }).playerCount,
    });
    let room = await service.createRoom(
      'owner',
      createInput({
        visibility: 'public',
        setup: { playerCount: 4 },
      }),
    );
    room = await service.joinRoom('guest', room.id, room.revision);
    room = await service.grantInvite('owner', room.id, room.revision, {
      principalId: 'reserved',
      seatId: 'reserved-seat',
    });
    room = await service.ready('guest', room.id, room.revision, true);
    await expect(
      service.configureRoom('owner', room.id, room.revision, {
        playerCount: 2,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    expect((await service.getRoom('owner', room.id)).revision).toBe(
      room.revision,
    );
    room = await service.configureRoom('owner', room.id, room.revision, {
      playerCount: 3,
    });
    expect(room.metadata.capacity).toBe(3);
    expect(room.members.every((member) => !member.ready)).toBe(true);
    expect(room.metadata.reservations).toHaveLength(1);
  });

  it('freezes member readiness after color changes, rejects duplicate colors, and retains closure audit', async () => {
    const { service, store } = fixture();
    let room = await service.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    room = await service.setColor('owner', room.id, room.revision, 'green');
    room = await service.joinRoom('guest', room.id, room.revision, {
      color: 'orange',
    });
    await expect(
      service.setColor('guest', room.id, room.revision, 'green'),
    ).rejects.toThrow('color taken');
    const closed = await service.deleteRoom('owner', room.id, room.revision);
    expect(closed.status).toBe('closed');
    expect((await store.getRoom(room.id))?.status).toBe('closed');
  });

  it('does not permit room edits after a room is closed', async () => {
    const { service, store } = fixture();
    const room = await service.createRoom('owner', createInput());
    await store.transaction(room.id, async (tx) => {
      tx.setRoom({
        ...tx.getRoom(),
        status: 'closed',
        revision: tx.getRoom().revision + 1,
      });
    });
    await expect(
      service.renameRoom('owner', room.id, room.revision + 1, 'late'),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('generic room management PostgreSQL durability', () => {
  const schema = `bgp_rooms_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  let pool: Pool;
  let store: PostgresAdmissionStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresAdmissionStore({ pool, schema });
    await store.migrate();
    await store.validateSchema();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE "${schema}"."room_grants", "${schema}"."room_security", "${schema}"."room_create_receipts", "${schema}"."starts", "${schema}"."rooms" CASCADE`,
    );
  });

  it('reports missing room access as not found', async () => {
    await expect(store.getRoomAccess('missing-room')).rejects.toMatchObject({
      envelope: { code: 'NOT_FOUND', messageKey: 'platform.room.not_found' },
    });
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('persists private access and password state across a fresh service instance', async () => {
    const first = fixture(store).service;
    let room = await first.createRoom(
      'owner',
      createInput({ password: 'secret' }),
    );
    room = await first.grantInvite('owner', room.id, room.revision, {
      principalId: 'guest',
    });
    const restarted = fixture(
      new PostgresAdmissionStore({ pool, schema }),
    ).service;
    expect(await restarted.listInvitations('guest')).toEqual({
      items: [
        expect.objectContaining({
          grantId: expect.any(String),
          roomId: room.id,
          ownerId: 'owner',
        }),
      ],
    });
    const listed = await restarted.listRooms('guest');
    expect(listed.rooms.map((candidate) => candidate.id)).toContain(room.id);
    const joined = await restarted.joinRoom('guest', room.id, room.revision);
    expect(joined.members.map((member) => member.principalId)).toEqual([
      'owner',
      'guest',
    ]);
    expect(
      JSON.stringify(await restarted.getRoom('guest', room.id)),
    ).not.toContain('hash:secret');
  });

  it('persists idempotent room creation across instances and retains deleted receipts', async () => {
    const first = fixture(store).service;
    const restarted = fixture(
      new PostgresAdmissionStore({ pool, schema }),
    ).service;
    const input = createInput({
      requestId: 'pg-room-create-retry-1',
      name: 'Original table',
      password: 'secret',
    });
    const results = await Promise.all([
      first.createRoom('owner', input),
      restarted.createRoom('owner', input),
    ]);
    expect(new Set(results.map((room) => room.id)).size).toBe(1);
    const created = results.at(0);
    if (!created) throw new Error('room create result missing');
    const requestId = input.requestId;
    if (!requestId) throw new Error('room create request id missing');
    const changed = await first.renameRoom(
      'owner',
      created.id,
      created.revision,
      'Changed table',
    );
    expect(await restarted.createRoom('owner', input)).toMatchObject({
      id: created.id,
      name: 'Changed table',
      revision: changed.revision,
    });
    expect(
      await store.getRoomCreateReceipt('owner', requestId),
    ).not.toHaveProperty('password');
    await expect(
      restarted.createRoom('owner', { ...input, name: 'Other table' }),
    ).rejects.toMatchObject({
      envelope: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    const isolated = await first.createRoom('other', input);
    expect(isolated.id).not.toBe(created.id);

    await pool.query(`DELETE FROM "${schema}"."rooms" WHERE id = $1`, [
      created.id,
    ]);
    await expect(first.createRoom('owner', input)).rejects.toMatchObject({
      envelope: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('accepts and declines native-style grants atomically across instances', async () => {
    const first = fixture(store).service;
    let acceptedRoom = await first.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    acceptedRoom = await first.grantInvite(
      'owner',
      acceptedRoom.id,
      acceptedRoom.revision,
      { principalId: 'guest', seatId: 'guest-seat' },
    );
    const acceptedGrantId = (await store.getRoomAccess(acceptedRoom.id))
      .grants[0]!.grantId;
    const restarted = fixture(
      new PostgresAdmissionStore({ pool, schema }),
    ).service;
    const joined = await restarted.acceptInvite(
      'guest',
      acceptedRoom.id,
      acceptedGrantId,
    );
    expect(joined.members.at(-1)).toMatchObject({
      principalId: 'guest',
      seatId: 'guest-seat',
    });
    expect((await store.getRoomAccess(acceptedRoom.id)).grants[0]?.state).toBe(
      'accepted',
    );

    let declinedRoom = await first.createRoom(
      'owner-2',
      createInput({ visibility: 'public' }),
    );
    declinedRoom = await first.grantInvite(
      'owner-2',
      declinedRoom.id,
      declinedRoom.revision,
      { principalId: 'reserved', seatId: 'reserved-seat' },
    );
    const declinedGrantId = (await store.getRoomAccess(declinedRoom.id))
      .grants[0]!.grantId;
    const declined = await restarted.declineInvite(
      'reserved',
      declinedRoom.id,
      declinedGrantId,
    );
    expect(declined.metadata.reservations).toBeUndefined();
    const joinedAfterRelease = await restarted.joinRoom(
      'unreserved',
      declinedRoom.id,
      declined.revision,
    );
    expect(joinedAfterRelease.members.at(-1)?.principalId).toBe('unreserved');
  });

  it('rejects duplicate room grants before the durable delete-and-reinsert commit', async () => {
    const first = fixture(store).service;
    const room = await first.createRoom('owner', createInput());

    await expect(
      store.transactionWithAccess(room.id, async (tx) => {
        tx.setGrant({
          grantId: 'grant-1',
          roomId: room.id,
          principalId: 'guest',
          state: 'pending',
        });
        tx.setGrant({
          grantId: 'grant-2',
          roomId: room.id,
          principalId: 'guest',
          state: 'pending',
        });
      }),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    expect(await store.getRoomAccess(room.id)).toEqual({
      security: {},
      grants: [],
    });
  });

  it('uses row locking for concurrent expected-revision edits', async () => {
    const first = fixture(store).service;
    const room = await first.createRoom(
      'owner',
      createInput({ visibility: 'public' }),
    );
    const second = fixture(
      new PostgresAdmissionStore({ pool, schema }),
    ).service;
    const results = await Promise.allSettled([
      first.renameRoom('owner', room.id, room.revision, 'first'),
      second.renameRoom('owner', room.id, room.revision, 'second'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect((await first.getRoom('owner', room.id)).revision).toBe(1);
  });

  it('commits initial invitations atomically and rejects invalid batches before creating a room', async () => {
    const { service } = fixture(store);
    const source = await service.createRoom('owner', createInput());
    const room = { ...source, id: 'rematch-room' };
    const grant = {
      grantId: 'initial-grant',
      roomId: room.id,
      principalId: 'guest',
      seatId: 'reserved',
      state: 'pending' as const,
    };
    await expect(
      store.createRoomWithAccess(room, {}, [
        grant,
        { ...grant, grantId: 'duplicate-person' },
      ]),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(await store.getRoom(room.id)).toBeNull();
    await store.createRoomWithAccess(room, {}, [grant]);
    const restarted = fixture(
      new PostgresAdmissionStore({ pool, schema }),
    ).service;
    expect(
      (await restarted.getRoom('guest', room.id)).metadata.reservations,
    ).toBeUndefined();
    const joined = await restarted.joinRoom('guest', room.id, room.revision);
    expect(
      joined.members.find((member) => member.principalId === 'guest')?.seatId,
    ).toBe('reserved');
  });
});
