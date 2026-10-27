import { randomUUID } from 'node:crypto';
import type {
  AccessContext,
  SessionRoute,
  SubmitCommandRequest,
} from '@board-game/contracts';
import {
  MemoryEntitlementStore,
  PostgresEntitlementStore,
} from '@board-game/core';
import {
  GameHost,
  GameRegistry,
  ResourceCoordinator,
  type ResourcePendingOptions,
  type ResourceStore,
} from '@board-game/host';
import { MemoryStorageDriver, type StorageDriver } from '@board-game/storage';
import {
  type SequentialTurnCommand,
  type SequentialTurnState,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

const alice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:create', 'session:command', 'session:view'],
};

const route: SessionRoute = {
  gameId: sequentialTurnFixture.gameId,
  modeId: 'sequential',
  sessionId: 'resource-session-1',
  releaseId: sequentialTurnFixture.releaseId,
  backendBindingId: 'local',
  storageBindingId: 'test',
  ownershipEpoch: 'owner-1',
};

const resourceModule = {
  ...sequentialTurnFixture,
  commandResourceRequirement: () => ({
    namespace: 'seti',
    asset: 'time-gem',
    quantity: 1,
  }),
};

function gameModule(gameId: string): typeof resourceModule {
  return { ...resourceModule, gameId } as typeof resourceModule;
}

function opaqueResourceModule() {
  type OpaqueState = SequentialTurnState & { readonly helper: () => void };
  const rules = {
    ...sequentialTurnFixture.rules,
    create: (
      setup: { readonly target?: number },
      context: Parameters<typeof sequentialTurnFixture.rules.create>[1],
    ): OpaqueState => ({
      ...sequentialTurnFixture.rules.create(setup, context),
      helper: () => undefined,
    }),
    encode: (state: Readonly<OpaqueState>) => {
      const { helper: _helper, ...plain } = state;
      return sequentialTurnFixture.rules.encode(plain);
    },
    decode: (
      saved: Parameters<typeof sequentialTurnFixture.rules.decode>[0],
      schemaVersion: number,
    ): OpaqueState => ({
      ...sequentialTurnFixture.rules.decode(saved, schemaVersion),
      helper: () => undefined,
    }),
    execute: (
      state: Readonly<OpaqueState>,
      command: SequentialTurnCommand,
      context: Parameters<typeof sequentialTurnFixture.rules.execute>[2],
    ) => {
      const transition = sequentialTurnFixture.rules.execute(
        state,
        command,
        context,
      );
      return transition.ok
        ? {
            ...transition,
            state: { ...transition.state, helper: () => undefined },
          }
        : transition;
    },
  };
  return {
    ...resourceModule,
    rules,
  } as unknown as typeof resourceModule;
}

function command(
  commandId: string = randomUUID(),
  expectedRevision = 1,
  commandRoute: SessionRoute = route,
): SubmitCommandRequest<SequentialTurnCommand> {
  return {
    protocolVersion: 1,
    accessContext: alice,
    route: commandRoute,
    commandId,
    precondition: { kind: 'revision', expectedRevision },
    command: { type: 'claim' },
  };
}

function reserveAckLost(base: ResourceStore): ResourceStore {
  return {
    reserve: async (request) => {
      await base.reserve(request);
      throw new Error('reservation acknowledgement lost');
    },
    getReservation: base.getReservation.bind(base),
    ...(base.getReservationsForCommand
      ? {
          getReservationsForCommand: base.getReservationsForCommand.bind(base),
        }
      : {}),
    confirm: base.confirm.bind(base),
    release: base.release.bind(base),
    listPending: base.listPending.bind(base),
  };
}

function confirmAckLost(base: ResourceStore): ResourceStore {
  return {
    reserve: base.reserve.bind(base),
    getReservation: base.getReservation.bind(base),
    ...(base.getReservationsForCommand
      ? {
          getReservationsForCommand: base.getReservationsForCommand.bind(base),
        }
      : {}),
    confirm: async (reference) => {
      const result = await base.confirm(reference);
      throw new Error(
        `confirmation acknowledgement lost for ${result.reservationId}`,
      );
    },
    release: base.release.bind(base),
    listPending: base.listPending.bind(base),
  };
}

function host(
  storage: StorageDriver,
  entitlements: ResourceStore,
  now = 100,
  graceMs = 30_000,
  module = resourceModule,
  backendBindingId = 'local',
  storageBindingId = 'test',
): GameHost {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    entitlementStore: entitlements,
    resourceGraceMs: graceMs,
    now: () => now,
    backendBindingId,
    storageBindingId,
    authorize: async () => undefined,
  });
}

async function start(backend: GameHost, startRoute = route): Promise<void> {
  await backend.createSession({
    protocolVersion: 1,
    accessContext: alice,
    route: startRoute,
    startId: 'resource-start-1',
    startGeneration: 0,
    setup: { target: 2 },
    participants: [
      { principalId: 'alice', seatId: 'seat-1' },
      { principalId: 'bob', seatId: 'seat-2' },
    ],
    seed: 'resource-seed',
  });
  await backend.activateSession({
    protocolVersion: 1,
    accessContext: alice,
    route: startRoute,
    startId: 'resource-start-1',
  });
}

async function reservePending(
  store: MemoryEntitlementStore,
  pendingRoute: SessionRoute,
  commandId: string,
  reservationId: string,
) {
  return store.reserve({
    namespace: 'seti',
    asset: 'time-gem',
    quantity: 1,
    sessionId: pendingRoute.sessionId,
    commandId,
    principalId: 'alice',
    intent: {
      route: pendingRoute,
      commandDigest: `digest-${commandId}`,
      requirementsDigest: `requirements-${commandId}`,
    },
    reservationId,
    createdAt: 0,
  });
}

function forwardingStore(
  base: MemoryEntitlementStore,
  calls: ResourcePendingOptions[],
): ResourceStore {
  return {
    reserve: base.reserve.bind(base),
    getReservation: base.getReservation.bind(base),
    getReservationsForCommand: base.getReservationsForCommand.bind(base),
    confirm: base.confirm.bind(base),
    release: base.release.bind(base),
    listPending: async (options) => {
      calls.push(options);
      return base.listPending(options);
    },
  };
}

async function grant(
  store: MemoryEntitlementStore,
  quantity: number,
): Promise<void> {
  await store.grant({
    namespace: 'seti',
    sourceRecordId: `baseline:${randomUUID()}`,
    principalId: 'alice',
    asset: 'time-gem',
    quantity,
  });
}

describe('Host resource coordinator', () => {
  it('reserves outside the head transaction, confirms after commit, and deduplicates replay', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    await grant(entitlements, 2);
    const backend = host(storage, entitlements);
    await start(backend);

    const request = command('resource-command-1');
    expect((await backend.submitCommand(request)).receipt.status).toBe(
      'accepted',
    );
    expect(
      await entitlements.getBalance({
        namespace: 'seti',
        principalId: 'alice',
        asset: 'time-gem',
      }),
    ).toMatchObject({ consumed: 1, reserved: 0, available: 1 });
    expect((await backend.submitCommand(request)).receipt.status).toBe(
      'duplicate',
    );
    expect(await entitlements.listPending({ limit: 10 })).toEqual([]);
  });

  it('writes a durable rejected receipt when the resource balance is insufficient', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    const backend = host(storage, entitlements);
    await start(backend);
    const request = command('resource-command-insufficient');
    const response = await backend.submitCommand(request);
    expect(response.receipt.status).toBe('rejected');
    expect(response.receipt.error).toMatchObject({
      code: 'CONFLICT',
      retryable: false,
    });
    expect(
      await storage.getReceipt(route.sessionId, request.commandId),
    ).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'host.resource.insufficient' },
    });
    expect(await entitlements.listPending({ limit: 10 })).toEqual([]);
  });

  it('reconciles an abandoned reservation by writing rejected receipt before release', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 0 });
    await grant(entitlements, 1);
    const backend = host(storage, entitlements, 31_000, 30_000);
    await start(backend);
    const coordinator = new ResourceCoordinator({
      store: entitlements,
      storage,
      now: () => 31_000,
      graceMs: 30_000,
    });
    const prepared = await coordinator.prepare({
      route,
      commandId: 'abandoned-command',
      principalId: 'alice',
      commandDigest: 'abandoned-digest',
      requirement: { namespace: 'seti', asset: 'time-gem', quantity: 1 },
    });
    expect(prepared?.reservation.status).toBe('reserved');
    expect(await coordinator.reconcilePending()).toEqual([
      {
        reservationId: prepared?.reservation.reservationId,
        status: 'released',
      },
    ]);
    if (!prepared) throw new Error('Expected a resource reservation');
    expect(
      await entitlements.getReservation(prepared.reservation.reservationId),
    ).toMatchObject({
      status: 'released',
    });
    expect(
      await storage.getReceipt(route.sessionId, 'abandoned-command'),
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'STALE_OPERATION' },
    });
  });

  it('keeps a reservation pending after reserve acknowledgement loss, then safely tombstones it', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 0 });
    await grant(entitlements, 1);
    const backend = host(storage, reserveAckLost(entitlements), 31_000, 30_000);
    await start(backend);

    const request = command('reserve-ack-lost');
    await expect(backend.submitCommand(request)).rejects.toMatchObject({
      envelope: { code: 'INTERNAL' },
    });
    expect(
      await storage.getReceipt(route.sessionId, request.commandId),
    ).toBeNull();
    expect(await entitlements.listPending({ limit: 10 })).toHaveLength(1);
    expect(await backend.reconcileResources()).toMatchObject([
      { status: 'released' },
    ]);
    expect(
      await storage.getReceipt(route.sessionId, request.commandId),
    ).toMatchObject({
      status: 'rejected',
      error: { code: 'STALE_OPERATION' },
    });
    expect(await entitlements.listPending({ limit: 10 })).toEqual([]);
  });

  it('does not execute a late command after the reconciliation tombstone', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 0 });
    await grant(entitlements, 1);
    const backend = host(storage, reserveAckLost(entitlements), 31_000, 30_000);
    await start(backend);
    const request = command('late-command');
    await expect(backend.submitCommand(request)).rejects.toMatchObject({
      envelope: { code: 'INTERNAL' },
    });
    await backend.reconcileResources();
    const before = await storage.getHead(route.sessionId);
    const replay = await backend.submitCommand(request);
    const after = await storage.getHead(route.sessionId);
    expect(replay.receipt.status).toBe('rejected');
    expect(after?.revision).toBe(before?.revision);
    expect(
      await entitlements.getBalance({
        namespace: 'seti',
        principalId: 'alice',
        asset: 'time-gem',
      }),
    ).toMatchObject({ consumed: 0, reserved: 0, available: 1 });
  });

  it('keeps command identity, principal, requirement, and ownership fences bound', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 0 });
    await grant(entitlements, 3);
    const coordinator = new ResourceCoordinator({
      store: entitlements,
      storage,
    });
    const requirement = { namespace: 'seti', asset: 'time-gem', quantity: 1 };
    await coordinator.prepare({
      route,
      commandId: 'identity-command',
      principalId: 'alice',
      commandDigest: 'digest-a',
      requirement,
    });
    await expect(
      coordinator.prepare({
        route,
        commandId: 'identity-command',
        principalId: 'bob',
        commandDigest: 'digest-a',
        requirement,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      coordinator.prepare({
        route,
        commandId: 'identity-command',
        principalId: 'alice',
        commandDigest: 'digest-b',
        requirement,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      coordinator.prepare({
        route,
        commandId: 'identity-command',
        principalId: 'alice',
        commandDigest: 'digest-a',
        requirement: { ...requirement, quantity: 2 },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const backend = host(storage, entitlements);
    await start(backend);
    const staleRoute = { ...route, ownershipEpoch: 'owner-2' };
    await expect(
      backend.submitCommand(command('ownership-fence', 1, staleRoute)),
    ).rejects.toMatchObject({ envelope: { code: 'OWNERSHIP_LOST' } });
    expect(await entitlements.listPending({ limit: 10 })).toHaveLength(1);
  });

  it('does not release a reservation after the frozen ownership route changes', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 0 });
    await grant(entitlements, 1);
    const ownerChangedRoute = { ...route, ownershipEpoch: 'owner-2' };
    await storage.createSession({
      route: ownerChangedRoute,
      startId: 'owner-changed-start',
      startDigest: 'owner-changed-digest',
      status: 'active',
      revision: 0,
      eventSequence: 0,
      encodedState: { state: true },
      schemaVersion: 1,
      participants: [
        { principalId: 'alice', seatId: 'seat-1' },
        { principalId: 'bob', seatId: 'seat-2' },
      ],
      summary: { state: true },
      logicalTime: 0,
    });
    const coordinator = new ResourceCoordinator({
      store: entitlements,
      storage,
      now: () => 31_000,
      graceMs: 30_000,
    });
    const prepared = await coordinator.prepare({
      route,
      commandId: 'owner-changed-command',
      principalId: 'alice',
      commandDigest: 'owner-changed-digest',
      requirement: { namespace: 'seti', asset: 'time-gem', quantity: 1 },
    });
    expect(await coordinator.reconcilePending()).toEqual([
      {
        reservationId: prepared?.reservation.reservationId,
        status: 'conflict',
      },
    ]);
    if (!prepared) throw new Error('Expected a resource reservation');
    expect(
      await entitlements.getReservation(prepared.reservation.reservationId),
    ).toMatchObject({
      status: 'reserved',
    });
    expect(
      await storage.getReceipt(route.sessionId, 'owner-changed-command'),
    ).toBeNull();
  });

  it('keeps a committed accepted receipt authoritative when confirmation acknowledgement is lost', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    await grant(entitlements, 1);
    const backend = host(storage, confirmAckLost(entitlements));
    await start(backend);
    const response = await backend.submitCommand(command('confirm-ack-lost'));
    expect(response.receipt.status).toBe('accepted');
    expect(
      await entitlements.getBalance({
        namespace: 'seti',
        principalId: 'alice',
        asset: 'time-gem',
      }),
    ).toMatchObject({ consumed: 1, reserved: 0, available: 0 });
    expect(await entitlements.listPending({ limit: 10 })).toEqual([]);
  });

  it('uses the module codec before invoking resource hooks on opaque rule state', async () => {
    const storage = new MemoryStorageDriver();
    const entitlements = new MemoryEntitlementStore({ now: () => 100 });
    await grant(entitlements, 1);
    const backend = host(
      storage,
      entitlements,
      100,
      30_000,
      opaqueResourceModule(),
    );
    await start(backend);
    expect(
      (await backend.submitCommand(command('opaque-state-command'))).receipt
        .status,
    ).toBe('accepted');
  });

  it('keeps interleaved shared-store reconciliation fair across Host bindings', async () => {
    const storageA = new MemoryStorageDriver();
    const storageB = new MemoryStorageDriver();
    const base = new MemoryEntitlementStore({ now: () => 0 });
    await base.grant({
      namespace: 'seti',
      sourceRecordId: 'shared-resource-grant',
      principalId: 'alice',
      asset: 'time-gem',
      quantity: 2,
      createdAt: 0,
    });
    const calls: ResourcePendingOptions[] = [];
    const shared = forwardingStore(base, calls);
    const routeA = {
      ...route,
      gameId: 'resource-game-a',
      sessionId: 'resource-session-a',
      backendBindingId: 'backend-a',
      storageBindingId: 'shared-storage',
    } satisfies SessionRoute;
    const routeB = {
      ...route,
      gameId: 'resource-game-b',
      sessionId: 'resource-session-b',
      backendBindingId: 'backend-b',
      storageBindingId: 'shared-storage',
    } satisfies SessionRoute;
    const hostA = host(
      storageA,
      shared,
      31_000,
      0,
      gameModule(routeA.gameId),
      routeA.backendBindingId,
      routeA.storageBindingId,
    );
    const hostB = host(
      storageB,
      shared,
      31_000,
      0,
      gameModule(routeB.gameId),
      routeB.backendBindingId,
      routeB.storageBindingId,
    );
    await start(hostA, routeA);
    await start(hostB, routeB);
    const reservationA = await reservePending(
      base,
      routeA,
      'interleaved-a',
      'reservation-a',
    );
    const reservationB = await reservePending(
      base,
      routeB,
      'interleaved-b',
      'reservation-b',
    );

    // B's bounded page must skip A at the store, otherwise A's older row
    // consumes B's only slot and B makes no progress this tick.
    expect(await hostB.reconcileResources(1)).toEqual([
      { reservationId: reservationB.reservationId, status: 'released' },
    ]);
    expect(calls[0]).toMatchObject({
      limit: 1,
      backendBindingId: routeB.backendBindingId,
      storageBindingId: routeB.storageBindingId,
    });
    expect(await base.listPending({ limit: 10 })).toEqual([reservationA]);

    expect(await hostA.reconcileResources(1)).toEqual([
      { reservationId: reservationA.reservationId, status: 'released' },
    ]);
    expect(calls[1]).toMatchObject({
      limit: 1,
      backendBindingId: routeA.backendBindingId,
      storageBindingId: routeA.storageBindingId,
    });
    expect(await base.listPending({ limit: 10 })).toEqual([]);
  });

  it('rechecks a shared-store reservation route before a Host finalizes it', async () => {
    const storageA = new MemoryStorageDriver();
    const storageB = new MemoryStorageDriver();
    const base = new MemoryEntitlementStore({ now: () => 0 });
    await base.grant({
      namespace: 'seti',
      sourceRecordId: 'route-fence-grant',
      principalId: 'alice',
      asset: 'time-gem',
      quantity: 2,
      createdAt: 0,
    });
    const routeA = {
      ...route,
      gameId: 'resource-game-a',
      sessionId: 'route-session-a',
      backendBindingId: 'backend-a',
      storageBindingId: 'shared-storage',
    } satisfies SessionRoute;
    const routeB = {
      ...route,
      gameId: 'resource-game-b',
      sessionId: 'route-session-b',
      backendBindingId: 'backend-b',
      storageBindingId: 'shared-storage',
    } satisfies SessionRoute;
    const hostB = host(
      storageB,
      base,
      31_000,
      0,
      gameModule(routeB.gameId),
      routeB.backendBindingId,
      routeB.storageBindingId,
    );
    await start(hostB, routeB);
    const reservationA = await reservePending(
      base,
      routeA,
      'route-fence-a',
      'reservation-route-a',
    );
    const reservationB = await reservePending(
      base,
      routeB,
      'route-fence-b',
      'reservation-route-b',
    );
    const untrustedStore: ResourceStore = {
      reserve: base.reserve.bind(base),
      getReservation: base.getReservation.bind(base),
      getReservationsForCommand: base.getReservationsForCommand.bind(base),
      confirm: base.confirm.bind(base),
      release: base.release.bind(base),
      // Simulate a custom store that violates the pushed-down filter.
      listPending: async () => [reservationB],
    };
    const hostA = host(
      storageA,
      untrustedStore,
      31_000,
      0,
      gameModule(routeA.gameId),
      routeA.backendBindingId,
      routeA.storageBindingId,
    );
    await start(hostA, routeA);

    expect(await hostA.reconcileResources(1)).toEqual([
      { reservationId: reservationB.reservationId, status: 'conflict' },
    ]);
    expect(await base.listPending({ limit: 10 })).toEqual([
      reservationA,
      reservationB,
    ]);
    expect(await hostB.reconcileResources(1)).toEqual([
      { reservationId: reservationB.reservationId, status: 'released' },
    ]);
    expect(await base.listPending({ limit: 10 })).toEqual([reservationA]);
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('Postgres resource coordination', () => {
  it('serializes maxPool one reservation attempts without deadlock or overspend', async () => {
    const schema = `res_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const store = new PostgresEntitlementStore({
      connectionString: databaseUrl,
      schema,
      poolConfig: { max: 1 },
      now: () => 0,
    });
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await store.migrate();
      await store.grant({
        namespace: 'seti',
        sourceRecordId: `resource-pg:${randomUUID()}`,
        principalId: 'alice',
        asset: 'time-gem',
        quantity: 1,
        createdAt: 0,
      });
      const coordinator = new ResourceCoordinator({
        store,
        storage: new MemoryStorageDriver(),
        now: () => 31_000,
        graceMs: 30_000,
      });
      const requirement = { namespace: 'seti', asset: 'time-gem', quantity: 1 };
      const results = await Promise.allSettled([
        coordinator.prepare({
          route,
          commandId: 'pg-pool-command-a',
          principalId: 'alice',
          commandDigest: 'pg-digest-a',
          requirement,
        }),
        coordinator.prepare({
          route,
          commandId: 'pg-pool-command-b',
          principalId: 'alice',
          commandDigest: 'pg-digest-b',
          requirement,
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(
        await store.getBalance({
          namespace: 'seti',
          principalId: 'alice',
          asset: 'time-gem',
        }),
      ).toMatchObject({ reserved: 1, available: 0 });
    } finally {
      await store.close();
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.end();
    }
  });
});
