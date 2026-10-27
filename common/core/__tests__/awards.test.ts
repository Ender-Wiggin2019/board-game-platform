import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryAwardStore } from '../src/awards/memory.js';
import { PostgresAwardStore } from '../src/awards/postgres.js';
import {
  AwardRewardRunner,
  awardRewardSourceRecordId,
} from '../src/awards/runner.js';
import type { AwardGrantRequest, AwardStore } from '../src/awards/types.js';
import { MemoryEntitlementStore } from '../src/entitlements/memory.js';

function award(sourceRecordId = 'game:session-1'): AwardGrantRequest {
  return {
    namespace: 'seti-achievements',
    principalId: 'player-1',
    awardId: 'first-contact',
    tier: 'bronze',
    definitionVersion: 'seti-achievements-v1',
    sourceRecordId,
    rewards: [
      {
        rewardId: 'time-gem',
        namespace: 'seti-currency',
        asset: 'time-gem',
        quantity: 2,
        metadata: { reason: 'first-contact' },
      },
      {
        rewardId: 'badge-token',
        namespace: 'seti-cosmetics',
        asset: 'badge:first-contact',
        quantity: 1,
      },
    ],
    createdAt: 100,
  };
}

async function exerciseAwardStore(store: AwardStore): Promise<void> {
  const first = await store.grantAward(award());
  expect(first.awardGrantId).toBeTruthy();
  expect(await store.getAward(first)).toEqual(first);
  expect(await store.listPendingRewards({ limit: 10 })).toHaveLength(2);

  // A second game can establish the same immutable award without a duplicate.
  const repeated = await store.grantAward(award('game:session-2'));
  expect(repeated).toEqual(first);
  await expect(
    store.grantAward({
      ...award('game:session-3'),
      definitionVersion: 'seti-achievements-v2',
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  const pending = await store.listPendingRewards({ limit: 1 });
  expect(pending).toHaveLength(1);
  const delivered = await store.markRewardDelivered(pending[0].rewardId, 200);
  expect(delivered.status).toBe('delivered');
  expect(await store.markRewardDelivered(pending[0].rewardId, 999)).toEqual(
    delivered,
  );
  expect(await store.getReward(pending[0].rewardId)).toEqual(delivered);
  expect(await store.listPendingRewards({ limit: 10 })).toHaveLength(1);
}

describe('MemoryAwardStore', () => {
  it('keeps immutable awards and atomically stages pending rewards', async () => {
    const store = new MemoryAwardStore({ now: () => 500 });
    await exerciseAwardStore(store);
  });

  it('serializes concurrent eligibility and preserves imported reward delivery', async () => {
    const store = new MemoryAwardStore({ now: () => 500 });
    const [first, second] = await Promise.all([
      store.grantAward(award('game:one')),
      store.grantAward(award('game:two')),
    ]);
    expect(first).toEqual(second);
    expect(await store.listPendingRewards({ limit: 10 })).toHaveLength(2);

    const imported = new MemoryAwardStore({ now: () => 500 });
    const importedAward = await imported.importAward({
      ...award('import:receipt-1'),
      importedRewardAlreadyDelivered: ['time-gem'],
    });
    expect(importedAward.sourceRecordId).toBe('import:receipt-1');
    expect(await imported.listPendingRewards({ limit: 10 })).toHaveLength(1);
    await expect(
      imported.grantAward({
        ...award('import:receipt-2'),
        importedRewardAlreadyDelivered: ['time-gem'],
      } as AwardGrantRequest),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('replays a reward safely when delivery acknowledgement is lost', async () => {
    let now = 500;
    const awards = new MemoryAwardStore({ now: () => now });
    const entitlements = new MemoryEntitlementStore({ now: () => now });
    await awards.grantAward({
      ...award(),
      rewards: [award().rewards[0]],
    });
    const pending = await awards.listPendingRewards({ limit: 10 });
    const mark = vi
      .spyOn(awards, 'markRewardDelivered')
      .mockRejectedValueOnce(new Error('ack lost'));
    const runner = new AwardRewardRunner({ awards, entitlements });
    await expect(runner.deliverPending({ limit: 10 })).rejects.toThrow(
      'ack lost',
    );
    const failed = await awards.getReward(pending[0].rewardId);
    expect(failed).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: 1_500,
    });
    expect(await awards.listPendingRewards({ limit: 10 })).toHaveLength(0);
    expect(
      await entitlements.getBalance({
        namespace: 'seti-currency',
        principalId: 'player-1',
        asset: 'time-gem',
      }),
    ).toMatchObject({ granted: 2, available: 2 });
    now = 1_500;
    const delivered = await runner.deliverPending({ limit: 10, now });
    expect(delivered).toHaveLength(1);
    expect(await awards.listPendingRewards({ limit: 10 })).toEqual([]);
    expect(mark).toHaveBeenCalledTimes(2);
    expect(awardRewardSourceRecordId(pending[0])).toContain(
      `award:${pending[0].awardGrantId}:reward:`,
    );
    expect(
      await entitlements.getBalance({
        namespace: 'seti-currency',
        principalId: 'player-1',
        asset: 'time-gem',
      }),
    ).toMatchObject({ granted: 2, available: 2 });
  });

  it('records a poison reward and continues delivering later rows', async () => {
    let now = 500;
    const awards = new MemoryAwardStore({ now: () => now });
    const entitlements = new MemoryEntitlementStore({ now: () => now });
    await awards.grantAward({
      ...award('game:poison'),
      rewards: [
        { ...award().rewards[0], rewardId: 'poison' },
        { ...award().rewards[1], rewardId: 'healthy' },
      ],
    });
    const originalGrant = entitlements.grant.bind(entitlements);
    const failingEntitlements = {
      grant: async (request: Parameters<typeof entitlements.grant>[0]) => {
        if (request.asset === 'time-gem') throw new Error('poison reward');
        return originalGrant(request);
      },
    };
    const runner = new AwardRewardRunner({
      awards,
      entitlements: failingEntitlements,
    });
    await expect(runner.deliverPending({ limit: 10, now })).rejects.toThrow(
      'poison reward',
    );
    const rewards = await awards.listPendingRewards({ limit: 10, now: 500 });
    expect(rewards).toHaveLength(0);
    const rows = await awards.listPendingRewards({ limit: 10, now: 1_500 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, nextAttemptAt: 1_500 });

    now = 1_500;
    const retryRunner = new AwardRewardRunner({ awards, entitlements });
    await expect(
      retryRunner.deliverPending({ limit: 10, now }),
    ).resolves.toHaveLength(1);
    expect(await awards.listPendingRewards({ limit: 10, now })).toEqual([]);
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('PostgresAwardStore', () => {
  const schema = `award_test_${process.pid}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`;
  let store: PostgresAwardStore;
  let cleanupPool: Pool;
  let now = 500;

  beforeAll(async () => {
    store = new PostgresAwardStore({
      connectionString: databaseUrl,
      schema,
      now: () => now,
    });
    await store.migrate();
    cleanupPool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await store.close();
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanupPool.end();
  });

  it('retains immutable awards and pending rewards across store restart', async () => {
    const first = await store.grantAward(award());
    const pending = await store.listPendingRewards({ limit: 10 });
    expect(pending).toHaveLength(2);
    await store.close();
    store = new PostgresAwardStore({
      connectionString: databaseUrl,
      schema,
      now: () => now,
    });
    expect(await store.getAward(first)).toEqual(first);
    expect(await store.listPendingRewards({ limit: 10 })).toEqual(pending);
    expect(await store.markRewardDelivered(pending[0].rewardId)).toMatchObject({
      status: 'delivered',
    });
  });

  it('deduplicates concurrent eligibility and keeps the reward ledger atomic', async () => {
    const [first, second] = await Promise.all([
      store.grantAward(award('game:concurrent-a')),
      store.grantAward(award('game:concurrent-b')),
    ]);
    expect(first).toEqual(second);
    expect(await store.listPendingRewards({ limit: 10 })).toHaveLength(1);
    await expect(
      store.grantAward({
        ...award('game:conflict'),
        rewards: [{ ...award().rewards[0], quantity: 3 }],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('persists reward retry backoff and continues after a poison row', async () => {
    if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
    now = 500;
    const awards = await store.grantAward({
      ...award('game:pg-poison'),
      awardId: 'pg-poison',
      rewards: [
        { ...award().rewards[0], rewardId: 'poison' },
        { ...award().rewards[1], rewardId: 'healthy' },
      ],
    });
    const entitlements = new MemoryEntitlementStore({ now: () => now });
    const originalGrant = entitlements.grant.bind(entitlements);
    const failingEntitlements = {
      grant: async (request: Parameters<typeof entitlements.grant>[0]) => {
        if (request.asset === 'time-gem') throw new Error('pg poison reward');
        return originalGrant(request);
      },
    };
    const runner = new AwardRewardRunner({
      awards: store,
      entitlements: failingEntitlements,
    });
    await expect(runner.deliverPending({ limit: 10, now })).rejects.toThrow(
      'pg poison reward',
    );
    expect(await store.listPendingRewards({ limit: 10, now })).toHaveLength(0);
    now = 1_500;
    const pending = await store.listPendingRewards({ limit: 10, now });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ attempts: 1, nextAttemptAt: 1_500 });
    const retryRunner = new AwardRewardRunner({
      awards: store,
      entitlements,
    });
    await expect(
      retryRunner.deliverPending({ limit: 10, now }),
    ).resolves.toHaveLength(1);
    expect(await store.listPendingRewards({ limit: 10, now })).toEqual([]);
    expect(await store.getAward(awards)).toEqual(awards);
  });
});
