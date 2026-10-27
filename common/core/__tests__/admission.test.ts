import type { AccessContext, PlatformRoom } from '@board-game/contracts';
import { GameHost, GameRegistry } from '@board-game/host';
import { MemoryStorageDriver } from '@board-game/storage';
import { sequentialTurnFixture } from '@board-game/testing/fixtures';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionCoordinator } from '../src/admission/AdmissionCoordinator.js';
import { MemoryAdmissionStore } from '../src/admission/memory.js';

const access: AccessContext = {
  principalId: 'platform',
  authEpoch: '1',
  scopes: ['session:create', 'session:control'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setup(
  freezeSeed?: (room: PlatformRoom) => Promise<string>,
  automaticStart?: (room: PlatformRoom) => boolean,
) {
  const store = new MemoryAdmissionStore();
  const gameStore = new MemoryStorageDriver();
  const host = new GameHost({
    registry: new GameRegistry().register(sequentialTurnFixture),
    storage: gameStore,
    backendBindingId: 'embedded',
    storageBindingId: 'games',
    authorize: async () => undefined,
    now: () => 100,
  });
  const backend = host;
  const banned = new Set<string>();
  let id = 0;
  const makeCoordinator = () =>
    new AdmissionCoordinator({
      store,
      now: () => 100,
      newId: () => `id-${++id}`,
      resolveRelease: () => ({
        gameId: sequentialTurnFixture.gameId,
        releaseId: sequentialTurnFixture.releaseId,
        mode: sequentialTurnFixture.modes[0],
        backendBindingId: 'embedded',
        storageBindingId: 'games',
        ownershipEpoch: '1',
        backend,
        validateSetup: () => undefined,
      }),
      resolveBackend: () => backend,
      authorize: async (principalId) =>
        !principalId.startsWith('bot:') && !banned.has(principalId),
      ...(freezeSeed ? { freezeSeed } : {}),
      ...(automaticStart ? { automaticStart } : {}),
      freezePolicy: async () => ({
        rating: {
          poolId: 'fixture-pool',
          policyVersion: 'skill-v1',
          progressionPolicyVersion: 'progress-v1',
          seasonId: null,
        },
        validityPolicyVersion: 'casual-v1',
      }),
      accessForStart: async () => access,
    });
  const coordinator = makeCoordinator();
  async function room(): Promise<PlatformRoom> {
    let room = await coordinator.createRoom('alice', {
      gameId: sequentialTurnFixture.gameId,
      modeId: sequentialTurnFixture.modes[0].id,
      releaseId: sequentialTurnFixture.releaseId,
      visibility: 'private',
      setup: { target: 2 },
    });
    room = await coordinator.joinRoom('bob', room.id, room.revision);
    room = await coordinator.ready('alice', room.id, room.revision, true);
    return coordinator.ready('bob', room.id, room.revision, true);
  }
  return {
    store,
    gameStore,
    host,
    coordinator,
    makeCoordinator,
    banned,
    room,
  };
}

describe('durable room start coordination', () => {
  it('rejects player-chosen seeds for rated modes', async () => {
    const fixture = setup();
    await expect(
      fixture.coordinator.createRoom('alice', {
        gameId: sequentialTurnFixture.gameId,
        modeId: sequentialTurnFixture.modes[0].id,
        releaseId: sequentialTurnFixture.releaseId,
        visibility: 'private',
        setup: { target: 2 },
        seed: 'known-draws',
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'platform.room.ratedSeed',
      },
    });
  });

  it('pins a server-selected scenario seed once across lost replies and coordinator restarts', async () => {
    const freezeSeed = vi.fn().mockResolvedValue('daily:fixed-seed-v1');
    const fixture = setup(freezeSeed);
    const room = await fixture.room();
    const original = fixture.host.createSession.bind(fixture.host);
    const create = vi
      .spyOn(fixture.host, 'createSession')
      .mockImplementationOnce(async (request) => {
        await original(request);
        throw new Error('lost reply');
      });
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'scenario',
      ),
    ).rejects.toThrow('lost reply');
    freezeSeed.mockResolvedValue('different-on-new-release');
    await fixture.makeCoordinator().recoverStart(room.id);
    expect(freezeSeed).toHaveBeenCalledOnce();
    expect((await fixture.store.getStart(room.id))?.seed).toBe(
      'daily:fixed-seed-v1',
    );
    expect(create.mock.calls.map(([request]) => request.seed)).toEqual([
      'daily:fixed-seed-v1',
      'daily:fixed-seed-v1',
    ]);
  });

  it('rejects invalid scenario seeds before reserving a durable start', async () => {
    const fixture = setup(async () => '');
    const room = await fixture.room();
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'invalid-seed',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    expect(await fixture.store.getStart(room.id)).toBeNull();
    expect((await fixture.store.getRoom(room.id))?.status).toBe('open');
  });

  it('freezes roster, admission and route, then launches one active session', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const started = await fixture.coordinator.startRoom(
      'alice',
      room.id,
      room.revision,
      'request-1',
    );
    expect(started.state).toBe('active');
    expect(await fixture.store.getRoom(room.id)).toMatchObject({
      status: 'started',
      route: started.route,
    });
    expect(await fixture.store.getAdmission(started.sessionId)).toMatchObject({
      route: started.route,
      participants: room.members.map(({ ready: _ready, ...member }) => member),
      rating: {
        poolId: 'fixture-pool',
        policyVersion: 'skill-v1',
        progressionPolicyVersion: 'progress-v1',
        seasonId: null,
      },
      validityPolicyVersion: 'casual-v1',
    });
    expect((await fixture.gameStore.getHead(started.sessionId))?.status).toBe(
      'active',
    );
    expect(
      await fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-1',
      ),
    ).toEqual(started);
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'different',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    await expect(
      fixture.coordinator.configureRoom('alice', room.id, 999, {}),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
  });

  it('recovers a lost create reply after coordinator restart without creating a second session', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const create = vi.spyOn(fixture.host, 'createSession');
    const original = fixture.host.createSession.bind(fixture.host);
    create.mockImplementationOnce(async (request) => {
      await original(request);
      throw new Error('connection lost');
    });
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-1',
      ),
    ).rejects.toThrow('connection lost');
    const pending = await fixture.store.getStart(room.id);
    expect(pending?.state).toBe('creating');
    if (!pending) throw new Error('missing pending start');
    expect((await fixture.gameStore.getHead(pending.sessionId))?.status).toBe(
      'suspended',
    );
    const recovered = await fixture.makeCoordinator().recoverStart(room.id);
    expect(recovered).toMatchObject({
      state: 'active',
      sessionId: pending?.sessionId,
      startId: pending?.startId,
    });
    expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
        (item) => item.kind,
      ),
    ).toEqual(['SessionCreated', 'SessionActivated']);
  });

  it('recovers a lost activation reply and persists exactly one launch', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const original = fixture.host.activateSession.bind(fixture.host);
    vi.spyOn(fixture.host, 'activateSession').mockImplementationOnce(
      async (request) => {
        await original(request);
        throw new Error('connection lost');
      },
    );
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-1',
      ),
    ).rejects.toThrow();
    expect((await fixture.store.getStart(room.id))?.state).toBe('activating');
    expect(await fixture.makeCoordinator().recoverPending()).toEqual([
      { roomId: room.id, recovered: true },
    ]);
    expect((await fixture.store.getRoom(room.id))?.status).toBe('started');
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).filter(
        (item) => item.kind === 'SessionActivated',
      ),
    ).toHaveLength(1);
  });

  it('serializes duplicate starts and blocks stale settings and revoked participants', async () => {
    const fixture = setup();
    const room = await fixture.room();
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision - 1,
        'request-1',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'STALE_REVISION' } });
    fixture.banned.add('bob');
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-1',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(await fixture.store.getStart(room.id)).toBeNull();
    fixture.banned.clear();
    const results = await Promise.all([
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-1',
      ),
      fixture
        .makeCoordinator()
        .startRoom('alice', room.id, room.revision, 'request-1'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).filter(
        (item) => item.kind === 'SessionCreated',
      ),
    ).toHaveLength(1);
  });

  it('rejects rated starts that include a bot identity', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const bot = {
      principalId: 'bot:room-1:1',
      seatId: 'bot:room-1:seat-1',
      controller: 'bot' as const,
      ready: true,
    };
    await fixture.store.transaction(room.id, async (tx) => {
      const current = tx.getRoom();
      tx.setRoom({
        ...current,
        revision: current.revision + 1,
        members: [...current.members, bot],
      });
    });
    const mixed = await fixture.store.getRoom(room.id);
    if (!mixed) throw new Error('mixed room missing');

    await expect(
      fixture.coordinator.startRoom(
        'alice',
        mixed.id,
        mixed.revision,
        'mixed-bot-start',
      ),
    ).rejects.toMatchObject({
      envelope: { messageKey: 'platform.admission.ratedControllers' },
    });
  });

  it('retries automatic start from the latest room after a concurrent edit', async () => {
    const fixture = setup(undefined, (candidate) => {
      const setup = candidate.setup;
      return (
        candidate.members.length === 3 &&
        setup !== null &&
        typeof setup === 'object' &&
        !Array.isArray(setup) &&
        'target' in setup &&
        setup.target === 2
      );
    });
    const room = await fixture.room();
    await fixture.store.transaction(room.id, async (tx) => {
      const current = tx.getRoom();
      tx.setRoom({
        ...current,
        revision: current.revision + 1,
        members: [
          ...current.members,
          {
            principalId: 'bot:room-1:1',
            seatId: 'bot:room-1:seat-1',
            controller: 'bot',
            ready: true,
          },
        ],
      });
    });

    const readRoom = fixture.store.getRoom.bind(fixture.store);
    let firstRead = true;
    const getRoom = vi
      .spyOn(fixture.store, 'getRoom')
      .mockImplementation(async (roomId) => {
        const snapshot = await readRoom(roomId);
        if (firstRead) {
          firstRead = false;
          await fixture.store.transaction(roomId, async (tx) => {
            const current = tx.getRoom();
            tx.setRoom({
              ...current,
              revision: current.revision + 1,
              setup: { target: 2, label: 'concurrent-edit' },
            });
          });
        }
        return snapshot;
      });

    await expect(
      fixture.coordinator.autoStartRoom(room.id),
    ).rejects.toMatchObject({
      envelope: { messageKey: 'platform.admission.ratedControllers' },
    });

    expect(getRoom).toHaveBeenCalledTimes(2);
    expect(await readRoom(room.id)).toMatchObject({
      status: 'open',
      setup: { target: 2, label: 'concurrent-edit' },
    });
  });

  it('does not start when a concurrent edit disables automatic start', async () => {
    const fixture = setup(undefined, (candidate) => {
      const setup = candidate.setup;
      return (
        candidate.members.length === 3 &&
        setup !== null &&
        typeof setup === 'object' &&
        !Array.isArray(setup) &&
        'target' in setup &&
        setup.target === 2
      );
    });
    const room = await fixture.room();
    await fixture.store.transaction(room.id, async (tx) => {
      const current = tx.getRoom();
      tx.setRoom({
        ...current,
        revision: current.revision + 1,
        members: [
          ...current.members,
          {
            principalId: 'bot:room-1:1',
            seatId: 'bot:room-1:seat-1',
            controller: 'bot',
            ready: true,
          },
        ],
      });
    });

    const readRoom = fixture.store.getRoom.bind(fixture.store);
    let firstRead = true;
    const getRoom = vi
      .spyOn(fixture.store, 'getRoom')
      .mockImplementation(async (roomId) => {
        const snapshot = await readRoom(roomId);
        if (firstRead) {
          firstRead = false;
          await fixture.store.transaction(roomId, async (tx) => {
            const current = tx.getRoom();
            tx.setRoom({
              ...current,
              revision: current.revision + 1,
              setup: { target: 4 },
            });
          });
        }
        return snapshot;
      });

    await expect(
      fixture.coordinator.autoStartRoom(room.id),
    ).resolves.toBeNull();

    expect(getRoom).toHaveBeenCalledTimes(2);
    expect(await readRoom(room.id)).toMatchObject({
      status: 'open',
      setup: { target: 4 },
    });
    expect(await fixture.store.getStart(room.id)).toBeNull();
  });

  it('invalidates readiness after configuration and membership changes', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const updated = await fixture.coordinator.configureRoom(
      'alice',
      room.id,
      room.revision,
      { target: 4 },
    );
    expect(updated.members.every((member) => !member.ready)).toBe(true);
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        updated.revision,
        'request-1',
      ),
    ).rejects.toMatchObject({ envelope: { code: 'CONFLICT' } });
    const left = await fixture.coordinator.leaveRoom(
      'bob',
      room.id,
      updated.revision,
    );
    expect(left.members.map((member) => member.principalId)).toEqual(['alice']);
  });

  it('fences a create race so cancellation cannot activate the session', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalCreate = fixture.host.createSession.bind(fixture.host);
    let createCalls = 0;
    vi.spyOn(fixture.host, 'createSession').mockImplementation(
      async (request) => {
        createCalls += 1;
        const response = await originalCreate(request);
        if (createCalls === 1) {
          entered.resolve();
          await release.promise;
        }
        return response;
      },
    );

    const starting = fixture.coordinator.startRoom(
      'alice',
      room.id,
      room.revision,
      'request-race',
    );
    await entered.promise;
    const cancelled = fixture.coordinator.cancelStart('alice', room.id);
    await expect(cancelled).resolves.toMatchObject({ state: 'cancelled' });
    release.resolve();
    await expect(starting).resolves.toMatchObject({ state: 'cancelled' });

    expect(createCalls).toBe(2);
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
        (item) => item.kind,
      ),
    ).toEqual(['SessionCreated', 'SessionControlled']);
    expect((await fixture.store.getRoom(room.id))?.status).toBe('closed');
    expect((await fixture.store.getStart(room.id))?.state).toBe('cancelled');
  });

  it('recovers an unknown cancel acknowledgement without a second session', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const originalCreate = fixture.host.createSession.bind(fixture.host);
    vi.spyOn(fixture.host, 'createSession').mockImplementationOnce(
      async (request) => {
        await originalCreate(request);
        throw new Error('create reply lost');
      },
    );
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-cancel-retry',
      ),
    ).rejects.toThrow('create reply lost');

    const originalControl = fixture.host.controlSession.bind(fixture.host);
    const control = vi
      .spyOn(fixture.host, 'controlSession')
      .mockImplementationOnce(async (request) => {
        await originalControl(request);
        throw new Error('cancel reply lost');
      });
    await expect(
      fixture.coordinator.cancelStart('alice', room.id),
    ).rejects.toThrow('cancel reply lost');
    const pending = await fixture.store.getStart(room.id);
    expect(pending).toMatchObject({ state: 'cancelling' });
    if (!pending) throw new Error('missing cancelling start');
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0]?.[0]).toMatchObject({
      commandId: `${pending.startId}:cancel`,
      expectedRevision: 0,
    });

    const recovered = await fixture.makeCoordinator().recoverPending();
    expect(recovered).toEqual([{ roomId: room.id, recovered: true }]);
    expect((await fixture.store.getRoom(room.id))?.status).toBe('closed');
    expect((await fixture.store.getStart(room.id))?.state).toBe('cancelled');
    expect(
      (await fixture.gameStore.readOutboxBatch({ limit: 10 })).map(
        (item) => item.kind,
      ),
    ).toEqual(['SessionCreated', 'SessionControlled']);
  });

  it('rejects cancellation after activation has entered the activating phase', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const originalActivate = fixture.host.activateSession.bind(fixture.host);
    vi.spyOn(fixture.host, 'activateSession').mockImplementationOnce(
      async (request) => {
        await originalActivate(request);
        throw new Error('activation reply lost');
      },
    );
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-activating-cancel',
      ),
    ).rejects.toThrow('activation reply lost');
    const control = vi.spyOn(fixture.host, 'controlSession');
    await expect(
      fixture.coordinator.cancelStart('alice', room.id),
    ).rejects.toMatchObject({
      envelope: { code: 'CONFLICT' },
    });
    expect(control).not.toHaveBeenCalled();
    expect((await fixture.store.getStart(room.id))?.state).toBe('activating');
  });

  it('requires current owner authorization before fencing cancellation', async () => {
    const fixture = setup();
    const room = await fixture.room();
    const originalCreate = fixture.host.createSession.bind(fixture.host);
    vi.spyOn(fixture.host, 'createSession').mockImplementationOnce(
      async (request) => {
        await originalCreate(request);
        throw new Error('create reply lost');
      },
    );
    await expect(
      fixture.coordinator.startRoom(
        'alice',
        room.id,
        room.revision,
        'request-owner-revocation',
      ),
    ).rejects.toThrow('create reply lost');

    fixture.banned.add('alice');
    await expect(
      fixture.coordinator.cancelStart('alice', room.id),
    ).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN' },
    });
    expect((await fixture.store.getStart(room.id))?.state).toBe('creating');
    expect((await fixture.store.getRoom(room.id))?.status).toBe('starting');
  });
});
