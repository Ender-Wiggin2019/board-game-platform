import { randomUUID } from 'node:crypto';
import type { SessionRoute } from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryEntitlementStore } from '../src/entitlements/memory.js';
import { PostgresEntitlementStore } from '../src/entitlements/postgres.js';
import type { EntitlementStore } from '../src/entitlements/types.js';

function grant(quantity = 5) {
  return {
    namespace: 'seti',
    sourceRecordId: 'baseline:player-1',
    principalId: 'player-1',
    asset: 'time-gem',
    quantity,
    metadata: { source: 'baseline' },
    createdAt: 100,
  } as const;
}

function reservation(
  commandId: string,
  quantity: number,
  overrides: Partial<{
    namespace: string;
    principalId: string;
    asset: string;
    sessionId: string;
    reservationId: string;
    route: SessionRoute;
  }> = {},
) {
  const sessionId = overrides.sessionId ?? 'session-1';
  const route =
    overrides.route ??
    ({
      gameId: 'seti',
      modeId: 'ranked',
      sessionId,
      releaseId: 'release-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    } satisfies SessionRoute);
  return {
    namespace: overrides.namespace ?? 'seti',
    principalId: overrides.principalId ?? 'player-1',
    asset: overrides.asset ?? 'time-gem',
    sessionId,
    commandId,
    quantity,
    intent: {
      route,
      commandDigest: `command-digest-${commandId}`,
      requirementsDigest: `requirements-digest-${quantity}`,
    },
    ...(overrides.reservationId
      ? { reservationId: overrides.reservationId }
      : {}),
    createdAt: 200,
  } as const;
}

async function exerciseStore(store: EntitlementStore): Promise<void> {
  const first = await store.grant(grant());
  expect(first.grantId).toBeTruthy();
  expect(await store.getGrant(grant())).toEqual(first);
  const duplicate = await store.grant({ ...grant(), createdAt: 999 });
  expect(duplicate).toEqual(first);
  await expect(store.grant({ ...grant(), quantity: 6 })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  expect(await store.getBalance(grant())).toMatchObject({
    granted: 5,
    consumed: 0,
    reserved: 0,
    available: 5,
    revision: 1,
  });

  const held = await store.reserve(reservation('command-1', 3));
  expect(await store.getReservation(held.reservationId)).toEqual(held);
  expect(await store.getBalance(grant())).toMatchObject({
    available: 2,
    reserved: 3,
  });
  expect(await store.reserve(reservation('command-1', 3))).toEqual(held);
  await expect(
    store.reserve(reservation('command-1', 2)),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    store.confirm({ reservationId: held.reservationId, principalId: 'other' }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  expect(await store.confirm(held.reservationId)).toMatchObject({
    status: 'confirmed',
  });
  expect(await store.confirm(held.reservationId)).toMatchObject({
    status: 'confirmed',
  });
  await expect(store.release(held.reservationId)).rejects.toMatchObject({
    code: 'RESERVATION_TERMINAL',
  });
  expect(await store.getBalance(grant())).toMatchObject({
    granted: 5,
    consumed: 3,
    reserved: 0,
    available: 2,
  });

  const released = await store.reserve(reservation('command-2', 2));
  expect(await store.listPending({ limit: 10 })).toEqual([released]);
  expect(await store.release(released.reservationId)).toMatchObject({
    status: 'released',
  });
  expect(await store.release(released.reservationId)).toMatchObject({
    status: 'released',
  });
  expect(await store.listPending({ limit: 10 })).toEqual([]);
  expect(await store.getBalance(grant())).toMatchObject({
    granted: 5,
    consumed: 3,
    reserved: 0,
    available: 2,
  });
}

describe('MemoryEntitlementStore', () => {
  it('is idempotent, clone-isolated, and preserves terminal reservation states', async () => {
    const store = new MemoryEntitlementStore({ now: () => 500 });
    await exerciseStore(store);
  });

  it('does not overspend under concurrent reservations and retains pending work', async () => {
    const store = new MemoryEntitlementStore({ now: () => 500 });
    await store.grant(grant(3));
    const results = await Promise.allSettled([
      store.reserve(reservation('command-a', 2)),
      store.reserve(reservation('command-b', 2)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await store.getBalance(grant())).toMatchObject({
      granted: 3,
      reserved: 2,
      available: 1,
    });
    expect(await store.listPending({ limit: 1 })).toHaveLength(1);
  });

  it('filters pending pages by route ownership before applying the limit', async () => {
    const store = new MemoryEntitlementStore({ now: () => 500 });
    await store.grant({
      ...grant(2),
      sourceRecordId: 'route-filter-grant',
    });
    const routeA = {
      ...reservation('route-filter-a', 1).intent.route,
      gameId: 'game-a',
      backendBindingId: 'backend-a',
      storageBindingId: 'shared-storage',
      sessionId: 'session-a',
    } satisfies SessionRoute;
    const routeB = {
      ...routeA,
      gameId: 'game-b',
      backendBindingId: 'backend-b',
      sessionId: 'session-b',
    } satisfies SessionRoute;
    const first = await store.reserve(
      reservation('route-filter-a', 1, {
        route: routeA,
        sessionId: routeA.sessionId,
        reservationId: 'reservation-filter-a',
      }),
    );
    const second = await store.reserve(
      reservation('route-filter-b', 1, {
        route: routeB,
        sessionId: routeB.sessionId,
        reservationId: 'reservation-filter-b',
      }),
    );
    expect(
      await store.listPending({
        limit: 1,
        gameId: routeB.gameId,
        backendBindingId: routeB.backendBindingId,
        storageBindingId: routeB.storageBindingId,
      }),
    ).toEqual([second]);
    expect(
      await store.listPending({
        limit: 1,
        gameId: routeA.gameId,
        backendBindingId: routeA.backendBindingId,
        storageBindingId: routeA.storageBindingId,
      }),
    ).toEqual([first]);
  });

  it('rejects invalid grants and leaves the balance unchanged after failed reserve', async () => {
    const store = new MemoryEntitlementStore();
    await expect(
      store.grant({ ...grant(), quantity: 0 }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await store.grant(grant(1));
    await expect(
      store.reserve(reservation('too-large', 2)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await store.listPending({ limit: 10 })).toEqual([]);
    expect(await store.getBalance(grant())).toMatchObject({
      granted: 1,
      consumed: 0,
      reserved: 0,
      available: 1,
    });
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('PostgresEntitlementStore', () => {
  const schema = `entitlement_test_${process.pid}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`;
  let store: PostgresEntitlementStore;
  let cleanupPool: Pool;

  beforeAll(async () => {
    store = new PostgresEntitlementStore({
      connectionString: databaseUrl,
      schema,
      now: () => 500,
    });
    await store.migrate();
    cleanupPool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await store.close();
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanupPool.end();
  });

  it('survives store restart and recovers a reservation after a lost acknowledgement', async () => {
    await exerciseStore(store);
    const held = await store.reserve(reservation('restart-command', 1));
    const reservationId = held.reservationId;
    await store.close();
    store = new PostgresEntitlementStore({
      connectionString: databaseUrl,
      schema,
      now: () => 600,
    });
    expect(await store.getReservation(reservationId)).toEqual(held);
    expect(await store.confirm(reservationId)).toMatchObject({
      status: 'confirmed',
    });
    expect(await store.getBalance(grant())).toMatchObject({
      consumed: 4,
      reserved: 0,
      available: 1,
    });
  });

  it('serializes concurrent reservations and rolls back an insufficient attempt', async () => {
    const results = await Promise.allSettled([
      store.reserve(reservation('pg-command-a', 1)),
      store.reserve(reservation('pg-command-b', 1)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      store.reserve(reservation('pg-too-large', 99)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(await store.listPending({ limit: 10 })).toHaveLength(1);
  });

  it('upgrades an empty legacy reservation table but preserves non-empty legacy rows for review', async () => {
    const legacySchema = `legacy_e_${process.pid}_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)}`;
    const legacyPool = new Pool({ connectionString: databaseUrl });
    const legacyTable = `"${legacySchema}"."reservations"`;
    const oldTable = `
      CREATE TABLE ${legacyTable} (
        reservation_id text PRIMARY KEY,
        namespace text NOT NULL,
        session_id text NOT NULL,
        command_id text NOT NULL,
        principal_id text NOT NULL,
        asset text NOT NULL,
        quantity bigint NOT NULL,
        status text NOT NULL,
        created_at double precision NOT NULL,
        updated_at double precision NOT NULL,
        UNIQUE (namespace, session_id, command_id)
      )`;
    try {
      await legacyPool.query(`CREATE SCHEMA "${legacySchema}"`);
      await legacyPool.query(oldTable);
      const emptyStore = new PostgresEntitlementStore({
        connectionString: databaseUrl,
        schema: legacySchema,
      });
      await emptyStore.migrate();
      const columns = await legacyPool.query(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'reservations'
            AND column_name IN ('intent', 'intent_digest')
          ORDER BY column_name`,
        [legacySchema],
      );
      expect(columns.rows).toEqual([
        { column_name: 'intent', is_nullable: 'NO' },
        { column_name: 'intent_digest', is_nullable: 'NO' },
      ]);
      await emptyStore.close();

      const nonEmptySchema = `legacy_r_${process.pid}_${randomUUID()
        .replaceAll('-', '')
        .slice(0, 8)}`;
      const nonEmptyTable = `"${nonEmptySchema}"."reservations"`;
      await legacyPool.query(`CREATE SCHEMA "${nonEmptySchema}"`);
      await legacyPool.query(oldTable.replace(legacySchema, nonEmptySchema));
      await legacyPool.query(
        `INSERT INTO ${nonEmptyTable}
          (reservation_id, namespace, session_id, command_id, principal_id, asset, quantity, status, created_at, updated_at)
         VALUES ('legacy-reservation', 'seti', 'legacy-session', 'legacy-command', 'player-1', 'time-gem', 1, 'reserved', 1, 1)`,
      );
      const nonEmptyStore = new PostgresEntitlementStore({
        connectionString: databaseUrl,
        schema: nonEmptySchema,
      });
      await expect(nonEmptyStore.migrate()).rejects.toMatchObject({
        code: 'MIGRATION_REQUIRED',
        message: expect.stringContaining('legacy entitlement reservations'),
      });
      const preserved = await legacyPool.query(
        `SELECT reservation_id, status, quantity
           FROM ${nonEmptyTable}`,
      );
      expect(preserved.rows).toEqual([
        {
          reservation_id: 'legacy-reservation',
          status: 'reserved',
          quantity: '1',
        },
      ]);
      const untouchedColumns = await legacyPool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'reservations'
            AND column_name IN ('intent', 'intent_digest')`,
        [nonEmptySchema],
      );
      expect(untouchedColumns.rows).toEqual([]);
      await nonEmptyStore.close();
      await legacyPool.query(`DROP SCHEMA "${nonEmptySchema}" CASCADE`);
    } finally {
      await legacyPool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`);
      await legacyPool.end();
    }
  });
});
