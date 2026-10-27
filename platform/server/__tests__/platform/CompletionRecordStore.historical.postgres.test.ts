import { randomUUID } from 'node:crypto';
import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CompletionRecordInput,
  type HistoricalCompletionBaseline,
  PostgresCompletionRecordStore,
} from '@/platform/CompletionRecordStore.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'regular-multiplayer',
  sessionId: 'seti-history-pg-1',
  releaseId: 'seti-legacy-v1',
  backendBindingId: 'seti-legacy-backend',
  storageBindingId: 'seti-legacy-storage',
  ownershipEpoch: 'seti-legacy-owner',
};

const admission: MatchAdmission = {
  id: 'seti-history-pg-admission-1',
  route,
  participants: [
    { principalId: 'player-1', seatId: 'seat-1' },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'private',
  rating: null,
  validityPolicyVersion: 'seti-legacy-validity-v1',
  createdAt: 1,
};

const record: CompletionRecordInput = {
  platformId: 'history-platform-pg',
  admission,
  status: 'completed',
  resultRevision: 1,
  sourceRevision: 17,
  endedAt: 100,
  result: {
    kind: 'competitive',
    rankGroups: [
      {
        teams: [
          { participantIds: ['player-1'], score: 101 },
          { participantIds: ['player-2'], score: 90 },
        ],
      },
    ],
  },
  achievementSources: [
    {
      principalId: 'player-1',
      facts: [{ metric: 'game-completed', value: 1 }],
    },
  ],
};

const baseline: HistoricalCompletionBaseline = {
  sourceSystem: 'seti-legacy',
  sourceKey: 'game:legacy-game-1:completion',
  sourceDigest: 'sha256:legacy-result-copy-1',
};

postgresSuite('Postgres historical completion import', () => {
  const schema = `completion_history_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: Pool;
  let store: PostgresCompletionRecordStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresCompletionRecordStore({
      pool,
      schema,
    });
    await store.migrate();
    await pool.query(`
      CREATE TABLE "${schema}"."legacy_achievement_sources" (
        source_system text NOT NULL,
        source_key text NOT NULL,
        source_digest text NOT NULL,
        session_id text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('keeps the old ledger authoritative while late facts remain settled and unclaimed', async () => {
    await pool.query(
      `INSERT INTO "${schema}"."legacy_achievement_sources"
        (source_system, source_key, source_digest, session_id)
       VALUES ($1, $2, $3, $4)`,
      [
        baseline.sourceSystem,
        baseline.sourceKey,
        baseline.sourceDigest,
        route.sessionId,
      ],
    );
    const beforeLedger = await pool.query(
      `SELECT count(*)::int AS count
         FROM "${schema}"."legacy_achievement_sources"`,
    );

    const imported = await store.importSettledHistorical({ record, baseline });
    expect(imported.status).toBe('imported');
    expect(imported.record.processingState).toBe('settled');

    const late = await store.accept({
      ...record,
      source: {
        producerId: `game:seti:session:${route.sessionId}`,
        eventId: 'late-session-completed',
        sourceDigest: 'late-fact-digest',
      },
    });
    expect(late.status).toBe('duplicate');

    let settlementCalls = 0;
    const claim = await store.claimNext({ owner: 'history-worker' });
    expect(claim).toBeNull();
    if (claim)
      await store.processClaim(claim, {
        settle: async () => {
          settlementCalls += 1;
        },
      });
    expect(settlementCalls).toBe(0);

    const afterLedger = await pool.query(
      `SELECT count(*)::int AS count
         FROM "${schema}"."legacy_achievement_sources"`,
    );
    expect(afterLedger.rows[0]?.count).toBe(beforeLedger.rows[0]?.count);
    expect(
      await store.getHistoricalBaseline(
        record.platformId,
        route.sessionId,
        record.resultRevision,
      ),
    ).toEqual(baseline);
    expect(await store.get(record.platformId, route.sessionId)).toMatchObject({
      digest: imported.record.digest,
      processingState: 'settled',
      result: record.result,
    });
  });

  it('rejects an import over a claimed unsettled record without changing it', async () => {
    const scopedRecord: CompletionRecordInput = {
      ...record,
      admission: {
        ...admission,
        id: 'seti-history-pg-admission-2',
        route: { ...route, sessionId: 'seti-history-pg-2' },
      },
    };
    await store.accept(scopedRecord);
    const claim = await store.claimNext({ owner: 'existing-worker' });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error('expected existing claim');
    await expect(
      store.importSettledHistorical({
        record: scopedRecord,
        baseline: { ...baseline, sourceKey: 'game:legacy-game-2:completion' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await store.get(record.platformId, 'seti-history-pg-2'),
    ).toMatchObject({
      processingState: 'received',
      claimOwner: 'existing-worker',
    });
    const [conflict] = await store.listConflicts(
      record.platformId,
      'seti-history-pg-2',
    );
    expect(conflict?.incoming).toMatchObject({
      historicalBaseline: {
        sourceSystem: baseline.sourceSystem,
        sourceKey: 'game:legacy-game-2:completion',
      },
    });
  });
});
