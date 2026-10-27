import { randomUUID } from 'node:crypto';
import type {
  MatchAdmission,
  Participant,
  SessionRoute,
} from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryRatingStore,
  PostgresRatingStore,
  type RatingPolicy,
  type RatingPolicyRegistry,
  RatingSettlementService,
  type RatingSettlementTransaction,
  type RatingStore,
} from '../src/ratings/index.js';
import { migrationStatements } from '../src/ratings/migration.js';

const participants: readonly Participant[] = [
  { principalId: 'player-a', seatId: 'seat-a' },
  { principalId: 'player-b', seatId: 'seat-b' },
];

function route(sessionId: string, gameId = 'rating-game'): SessionRoute {
  return {
    gameId,
    modeId: 'ranked',
    sessionId,
    releaseId: 'release-1',
    backendBindingId: 'backend-1',
    storageBindingId: 'storage-1',
    ownershipEpoch: 'epoch-1',
  };
}

function admission(sessionId: string, poolId = 'pool-1'): MatchAdmission {
  return {
    id: `admission-${sessionId}`,
    route: route(sessionId),
    participants,
    visibility: 'private',
    rating: {
      poolId,
      policyVersion: 'rating-v1',
      progressionPolicyVersion: 'progression-v1',
      seasonId: 'season-1',
    },
    validityPolicyVersion: 'validity-v1',
    createdAt: 1,
  };
}

function result(first: string) {
  const second = first === 'player-a' ? 'player-b' : 'player-a';
  return {
    kind: 'competitive' as const,
    rankGroups: [
      { teams: [{ participantIds: [first] }] },
      { teams: [{ participantIds: [second] }] },
    ],
  };
}

function policy(): RatingPolicy {
  return {
    policyVersion: 'rating-v1',
    progressionPolicyVersion: 'progression-v1',
    initialState: () => ({ rating: 1 }),
    calculate: ({ previous, ranking }) =>
      Object.keys(previous).map((participantId) => ({
        participantId,
        after: {
          rating:
            Number((previous[participantId] as { rating: number }).rating) +
            (ranking[0] === participantId ? 1 : 0),
        },
        rankingScore: ranking[0] === participantId ? 2 : 1,
      })),
  };
}

class Registry implements RatingPolicyRegistry {
  policyValue: RatingPolicy | null = policy();

  get(
    policyVersion: string,
    progressionPolicyVersion: string,
  ): RatingPolicy | null {
    if (
      this.policyValue?.policyVersion !== policyVersion ||
      this.policyValue.progressionPolicyVersion !== progressionPolicyVersion
    )
      return null;
    return this.policyValue;
  }
}

function serviceFor(
  store: RatingStore,
  admissions: ReadonlyMap<string, MatchAdmission>,
  registry: RatingPolicyRegistry = new Registry(),
) {
  return new RatingSettlementService({
    store,
    admissions: {
      getAdmission: async (sessionId) => admissions.get(sessionId) ?? null,
    },
    policies: registry,
  });
}

function request(sessionId: string, resultValue = result('player-a')) {
  return {
    sessionId,
    resultRevision: 1,
    result: resultValue,
    occurredAt: 100,
  };
}

describe('MemoryRatingStore', () => {
  it('settles once, preserves the pool sequence, and deduplicates redelivery', async () => {
    const store = new MemoryRatingStore();
    const admissions = new Map([['session-1', admission('session-1')]]);
    let calls = 0;
    const registered = policy();
    const registry: RatingPolicyRegistry = {
      get: () => ({
        ...registered,
        calculate: (input) => {
          calls += 1;
          return registered.calculate(input);
        },
      }),
    };
    const service = serviceFor(store, admissions, registry);
    const first = await service.settle(request('session-1'));
    const duplicate = await service.settle(request('session-1'));
    expect(first.sequence).toBe(1);
    expect(duplicate).toEqual(first);
    expect(calls).toBe(1);
    expect(await store.getRating('pool-1', 'player-a')).toMatchObject({
      updatedSequence: 1,
    });
  });

  it('rejects corrections and a conflicting business id', async () => {
    const store = new MemoryRatingStore();
    const admissions = new Map([['session-1', admission('session-1')]]);
    const service = serviceFor(store, admissions);
    await service.settle(request('session-1'));
    await expect(
      service.settle({ ...request('session-1'), resultRevision: 2 }),
    ).rejects.toMatchObject({
      code: 'CORRECTION_UNSUPPORTED',
    });
    await expect(
      service.settle({ ...request('session-1'), occurredAt: 101 }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('rolls back invalid policy output without consuming a sequence', async () => {
    const store = new MemoryRatingStore();
    const admissions = new Map([['session-1', admission('session-1')]]);
    const registry = new Registry();
    registry.policyValue = {
      ...policy(),
      calculate: () => [{ participantId: 'player-a', after: { rating: 2 } }],
    };
    const service = serviceFor(store, admissions, registry);
    await expect(service.settle(request('session-1'))).rejects.toMatchObject({
      code: 'INVALID_POLICY_OUTPUT',
    });
    expect(await store.getSettlement('session-1', 1)).toBeNull();
    expect(await store.getRating('pool-1', 'player-a')).toBeNull();
    registry.policyValue = policy();
    expect((await service.settle(request('session-1'))).sequence).toBe(1);
  });

  it('serializes concurrent matches sharing a pool and keeps independent pools separate', async () => {
    const store = new MemoryRatingStore();
    const admissions = new Map([
      ['session-1', admission('session-1', 'pool-1')],
      ['session-2', admission('session-2', 'pool-1')],
      ['session-3', admission('session-3', 'pool-2')],
    ]);
    const service = serviceFor(store, admissions);
    const [one, two, separate] = await Promise.all([
      service.settle(request('session-1')),
      service.settle(request('session-2', result('player-b'))),
      service.settle(request('session-3')),
    ]);
    expect(new Set([one.sequence, two.sequence])).toEqual(new Set([1, 2]));
    expect(separate.sequence).toBe(1);
    const shared = await store.getRating('pool-1', 'player-a');
    expect(shared?.updatedSequence).toBe(2);
    expect((shared?.value as { rating: number }).rating).toBe(2);
  });

  it('requires the exact registered policy pin', async () => {
    const store = new MemoryRatingStore();
    const baseAdmission = admission('session-1');
    if (!baseAdmission.rating) throw new Error('test admission must be rated');
    const unknownAdmission = {
      ...baseAdmission,
      rating: { ...baseAdmission.rating, policyVersion: 'rating-unknown' },
    } satisfies MatchAdmission;
    const admissions = new Map([['session-1', unknownAdmission]]);
    const service = serviceFor(store, admissions);
    await expect(service.settle(request('session-1'))).rejects.toMatchObject({
      code: 'POLICY_NOT_FOUND',
    });
  });

  it('does not allow a transaction handle to mutate state after commit', async () => {
    const store = new MemoryRatingStore();
    let leaked: RatingSettlementTransaction | undefined;
    await store.transaction('pool-1', async (tx) => {
      leaked = tx;
      return 'done';
    });
    await expect(leaked?.getState('player-a')).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
  });

  it('lists a pool with a bounded participant-id cursor', async () => {
    const store = new MemoryRatingStore();
    const admissions = new Map([['session-1', admission('session-1')]]);
    await serviceFor(store, admissions).settle(request('session-1'));

    const first = await store.list('pool-1', 1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.participantId).toBe('player-a');
    expect(first.nextCursor).toBe('player-a');

    const second = await store.list('pool-1', 1, first.nextCursor ?? undefined);
    expect(second.items.map((state) => state.participantId)).toEqual([
      'player-b',
    ]);
    expect(second.nextCursor).toBeNull();

    const ranked = await store.listByRanking('pool-1', 1);
    expect(ranked.items[0]?.participantId).toBe('player-a');
    expect(ranked.nextCursor).not.toBeNull();
    expect(await store.getRankedPosition('pool-1', 'player-b')).toBe(2);
  });
});

it('migrates a policy ranking projection with a matching index', () => {
  const statements = migrationStatements('rating_test').join('\n');
  expect(statements).toContain('ranking_score double precision');
  expect(statements).toContain('ratings_ranking_idx');
  expect(statements).toContain(
    'ranking_score DESC NULLS LAST, participant_id ASC',
  );
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite('PostgresRatingStore', () => {
  const schema = `rating_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let store: PostgresRatingStore;
  let pool: Pool;
  beforeAll(async () => {
    store = new PostgresRatingStore({ connectionString: databaseUrl, schema });
    await store.migrate();
    pool = new Pool({ connectionString: databaseUrl });
  });
  afterAll(async () => {
    await store.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('retains the settlement and sequence across store restart', async () => {
    const admissions = new Map([
      ['session-pg-1', admission('session-pg-1')],
      ['session-pg-2', admission('session-pg-2')],
    ]);
    const firstService = serviceFor(store, admissions);
    const first = await firstService.settle(request('session-pg-1'));
    await store.close();
    store = new PostgresRatingStore({ connectionString: databaseUrl, schema });
    const secondService = serviceFor(store, admissions);
    const second = await secondService.settle(
      request('session-pg-2', result('player-b')),
    );
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await store.getSettlement('session-pg-1', 1)).toEqual(first);
    expect((await store.getRating('pool-1', 'player-a'))?.updatedSequence).toBe(
      2,
    );
    const page = await store.list('pool-1', 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('player-a');
    const ranked = await store.listByRanking('pool-1', 1);
    expect(ranked.items[0]?.participantId).toBe('player-b');
    expect(ranked.items[0]?.rankingScore).toBe(2);
    expect(await store.getRankedPosition('pool-1', 'player-b')).toBe(1);
    expect(await store.getRankedPosition('pool-1', 'player-a')).toBe(2);
  });
});
