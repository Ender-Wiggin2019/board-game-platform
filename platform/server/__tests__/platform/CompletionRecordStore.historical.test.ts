import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CompletionRecordInput,
  type HistoricalCompletionBaseline,
  MemoryCompletionRecordStore,
} from '@/platform/CompletionRecordStore.js';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'regular-multiplayer',
  sessionId: 'seti-history-import-1',
  releaseId: 'seti-legacy-v1',
  backendBindingId: 'seti-legacy-backend',
  storageBindingId: 'seti-legacy-storage',
  ownershipEpoch: 'seti-legacy-owner',
};

const admission: MatchAdmission = {
  id: 'seti-history-admission-1',
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
  platformId: 'history-platform',
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
};

const baseline: HistoricalCompletionBaseline = {
  sourceSystem: 'seti-legacy',
  sourceKey: 'game:legacy-game-1:completion',
  sourceDigest: 'sha256:legacy-result-copy-1',
};

describe('historical completion import', () => {
  it('imports as settled and suppresses a late completion worker run', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'history-platform',
    });
    const imported = await store.importSettledHistorical({ record, baseline });
    expect(imported.status).toBe('imported');
    expect(imported.record.processingState).toBe('settled');
    expect(
      await store.getHistoricalBaseline('history-platform', route.sessionId),
    ).toEqual(baseline);

    const repeated = await store.importSettledHistorical({
      record: {
        ...record,
        source: {
          producerId: 'legacy-copy-operator',
          eventId: 'retry-1',
          sourceDigest: 'operator-envelope-2',
        },
      },
      baseline,
    });
    expect(repeated.status).toBe('duplicate');

    const lateFact = await store.accept({
      ...record,
      source: {
        producerId: `game:seti:session:${route.sessionId}`,
        eventId: 'late-session-completed',
        sourceDigest: 'late-fact-digest',
      },
    });
    expect(lateFact.status).toBe('duplicate');
    let settlementCalls = 0;
    const claim = await store.claimNext({ owner: 'completion-worker' });
    expect(claim).toBeNull();
    if (claim)
      await store.processClaim(claim, {
        settle: async () => {
          settlementCalls += 1;
        },
      });
    expect(settlementCalls).toBe(0);
  });

  it('rejects importing over an unsettled record and audits the baseline', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'history-platform',
    });
    await store.accept(record);
    await expect(
      store.importSettledHistorical({ record, baseline }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.get('history-platform', route.sessionId)).toMatchObject({
      processingState: 'received',
    });
    const [conflict] = await store.listConflicts(
      'history-platform',
      route.sessionId,
    );
    expect(conflict?.incoming).toMatchObject({ historicalBaseline: baseline });
  });

  it('preserves the settled record when baseline or result content conflicts', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'history-platform',
    });
    const first = await store.importSettledHistorical({ record, baseline });
    await expect(
      store.importSettledHistorical({
        record: { ...record, endedAt: 101 },
        baseline,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      store.importSettledHistorical({
        record,
        baseline: { ...baseline, sourceKey: 'different-business-key' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = await store.get('history-platform', route.sessionId);
    expect(current?.digest).toBe(first.record.digest);
    expect(
      await store.getHistoricalBaseline('history-platform', route.sessionId),
    ).toEqual(baseline);
    expect(
      await store.listConflicts('history-platform', route.sessionId),
    ).toHaveLength(2);
  });

  it('bounds source identity evidence', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'history-platform',
    });
    await expect(
      store.importSettledHistorical({
        record,
        baseline: { ...baseline, sourceKey: 'x'.repeat(513) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
