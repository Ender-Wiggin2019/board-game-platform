import { randomUUID } from 'node:crypto';
import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CompletionRecordInput,
  PostgresCompletionRecordStore,
} from '@/platform/CompletionRecordStore.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

const route: SessionRoute = {
  gameId: 'completion-pg-game',
  modeId: 'ranked',
  sessionId: 'completion-pg-session-1',
  releaseId: 'completion-pg-release-1',
  backendBindingId: 'completion-pg-backend-1',
  storageBindingId: 'completion-pg-storage-1',
  ownershipEpoch: 'completion-pg-epoch-1',
};

const admission: MatchAdmission = {
  id: 'completion-pg-admission-1',
  route,
  participants: [
    { principalId: 'player-1', seatId: 'seat-1' },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'validity-1',
  createdAt: 1,
};

const input: CompletionRecordInput = {
  platformId: 'platform-pg',
  admission,
  status: 'completed',
  resultRevision: 1,
  endedAt: 100,
  result: {
    kind: 'cooperative',
    participantIds: ['player-1', 'player-2'],
    outcome: 'completed',
  },
  achievementSources: [
    {
      principalId: 'player-1',
      facts: [{ metric: 'game-completed', value: 1 }],
    },
  ],
};

function inputFor(
  platformId: string,
  sessionId: string,
): CompletionRecordInput {
  const scopedRoute = { ...route, sessionId };
  return {
    ...input,
    platformId,
    admission: {
      ...admission,
      id: `${platformId}-admission`,
      route: scopedRoute,
    },
  };
}

postgresSuite('PostgresCompletionRecordStore', () => {
  const schema = `completion_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: Pool;
  let store: PostgresCompletionRecordStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresCompletionRecordStore({
      pool,
      schema,
      admission: { getAdmission: async () => admission },
    });
    await store.migrate();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('persists the authority and recovers a claimed row after the lease expires', async () => {
    const first = await store.accept(input);
    expect(first.status).toBe('accepted');
    expect((await store.accept(input)).status).toBe('duplicate');
    const claim = await store.claimNext({
      owner: 'pg-worker',
      leaseMs: 30_000,
    });
    expect(claim?.record.digest).toBe(first.record.digest);
    if (!claim) throw new Error('claim missing');
    const settled = await store.processClaim(claim);
    expect(settled.processingState).toBe('settled');
    expect(
      (await store.get(input.platformId, route.sessionId))?.processingState,
    ).toBe('settled');
    expect(
      (await store.get(input.platformId, route.sessionId))?.achievementSources,
    ).toEqual(input.achievementSources);
    const conflict = { ...input, endedAt: 101 };
    await expect(store.accept(conflict)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await store.listConflicts(input.platformId, route.sessionId),
    ).toHaveLength(1);
  });

  it('claims only the configured platform in a shared schema', async () => {
    const platformA = 'platform-pg-a';
    const platformB = 'platform-pg-b';
    const inputA = inputFor(platformA, 'completion-pg-zzz');
    const inputB = inputFor(platformB, 'completion-pg-aaa');
    const options = {
      pool,
      schema,
      now: () => 1_000,
    };
    const storeA = new PostgresCompletionRecordStore({
      ...options,
      platformId: platformA,
    });
    const storeB = new PostgresCompletionRecordStore({
      ...options,
      platformId: platformB,
    });
    await storeA.accept(inputA);
    await storeB.accept(inputB);

    const claimA = await storeA.claimNext({
      owner: 'platform-a-worker',
      leaseMs: 30_000,
    });
    expect(claimA?.record.platformId).toBe(platformA);
    if (!claimA) throw new Error('platform A claim missing');
    const renewedA = await storeA.renewClaim(claimA);
    const settledA = await storeA.processClaim(renewedA);
    expect(settledA.processingState).toBe('settled');
    await expect(
      storeA.claimNext({ owner: 'platform-a-worker-retry' }),
    ).resolves.toBeNull();

    const claimB = await storeB.claimNext({ owner: 'platform-b-worker' });
    expect(claimB?.record.platformId).toBe(platformB);
    if (!claimB) throw new Error('platform B claim missing');
    await storeB.processClaim(claimB);
  });
});
