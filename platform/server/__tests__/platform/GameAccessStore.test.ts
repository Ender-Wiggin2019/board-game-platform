import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GameAccessStoreError,
  hashGameAccessCode,
  PostgresGameAccessStore,
} from '@/platform/game-access/store.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('PostgresGameAccessStore', () => {
  const schema = `game_access_${process.pid}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`;
  let pool: Pool;
  let store: PostgresGameAccessStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresGameAccessStore({ pool, schema });
    await store.migrate();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('persists grants and deduplicates repeated redemption after a store restart', async () => {
    const code = 'PG-ACCESS-001';
    const created = await store.createCode({
      gameId: 'fixture-game',
      entitlement: 'beta-access',
      codeHash: hashGameAccessCode(code),
      maxUses: 2,
      createdBy: 'admin-1',
      createdAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    const first = await store.redeemCode({
      gameId: 'fixture-game',
      principalId: 'player-1',
      codeHash: hashGameAccessCode(code),
      sourceRecordId: 'source-pg-1',
      redeemedAt: new Date('2027-01-01T00:01:00.000Z'),
    });
    const repeated = await new PostgresGameAccessStore({
      pool,
      schema,
    }).redeemCode({
      gameId: 'fixture-game',
      principalId: 'player-1',
      codeHash: hashGameAccessCode(code),
      sourceRecordId: 'source-pg-1',
      redeemedAt: new Date('2027-01-01T00:02:00.000Z'),
    });
    expect(repeated).toEqual(first);
    expect(
      await store.hasEntitlement('fixture-game', 'player-1', 'beta-access'),
    ).toBe(true);
    expect((await store.listCodes('fixture-game'))[0]).toMatchObject({
      codeId: created.codeId,
      usedCount: 1,
    });
  });

  it('serializes concurrent redemptions against maxUses', async () => {
    const code = 'PG-ACCESS-002';
    await store.createCode({
      gameId: 'fixture-game',
      entitlement: 'beta-access',
      codeHash: hashGameAccessCode(code),
      maxUses: 1,
      createdBy: 'admin-1',
    });
    const results = await Promise.allSettled([
      store.redeemCode({
        gameId: 'fixture-game',
        principalId: 'player-a',
        codeHash: hashGameAccessCode(code),
        sourceRecordId: 'source-pg-a',
      }),
      store.redeemCode({
        gameId: 'fixture-game',
        principalId: 'player-b',
        codeHash: hashGameAccessCode(code),
        sourceRecordId: 'source-pg-b',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      GameAccessStoreError,
    );
    expect((rejected as PromiseRejectedResult).reason.code).toBe(
      'CODE_EXHAUSTED',
    );
  });
});
