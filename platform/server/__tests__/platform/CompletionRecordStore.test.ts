import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CompletionRecordInput,
  MemoryCompletionRecordStore,
} from '@/platform/CompletionRecordStore.js';

const route: SessionRoute = {
  gameId: 'completion-game',
  modeId: 'ranked',
  sessionId: 'completion-session-1',
  releaseId: 'completion-release-1',
  backendBindingId: 'completion-backend-1',
  storageBindingId: 'completion-storage-1',
  ownershipEpoch: 'completion-epoch-1',
};

const admission: MatchAdmission = {
  id: 'completion-admission-1',
  route,
  participants: [
    { principalId: 'player-1', seatId: 'seat-1' },
    { principalId: 'player-2', seatId: 'seat-2' },
  ],
  visibility: 'public',
  rating: null,
  validityPolicyVersion: 'validity-1',
  createdAt: 1,
};

const baseInput: CompletionRecordInput = {
  platformId: 'platform-1',
  admission,
  status: 'completed',
  resultRevision: 1,
  endedAt: 100,
  result: {
    kind: 'cooperative',
    participantIds: ['player-1', 'player-2'],
    outcome: 'won',
  },
};

describe('MemoryCompletionRecordStore', () => {
  it('deduplicates the canonical key and audits conflicting digests', async () => {
    const store = new MemoryCompletionRecordStore({
      admission: { getAdmission: async () => admission },
      now: () => 200,
    });
    const first = await store.accept(baseInput);
    const repeated = await store.accept({ ...baseInput });
    expect(repeated.status).toBe('duplicate');
    expect(repeated.record.digest).toBe(first.record.digest);
    await expect(
      store.accept({ ...baseInput, endedAt: 101 }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await store.listConflicts('platform-1', route.sessionId),
    ).toHaveLength(1);
  });

  it('maps a persisted SessionCompleted envelope through the same authority', async () => {
    const store = new MemoryCompletionRecordStore({ platformId: 'platform-1' });
    const accepted = await store.accept(
      {
        producerId: `game:${route.gameId}:session:${route.sessionId}`,
        eventId: 'completion-envelope-1',
        sessionId: route.sessionId,
        kind: 'SessionCompleted',
        schemaVersion: 1,
        sourceRelease: route.releaseId,
        aggregateSequence: 7,
        digest: 'source-digest',
        payload: {
          result: baseInput.result,
          resultRevision: 1,
          endedAt: 100,
        },
      },
      admission,
    );
    expect(accepted.record.source).toMatchObject({
      producerId: `game:${route.gameId}:session:${route.sessionId}`,
      eventId: 'completion-envelope-1',
      sourceDigest: 'source-digest',
    });
    expect(accepted.record.sourceRevision).toBe(7);
  });

  it('retains frozen-participant public achievement facts in the canonical digest', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'platform-1',
    });
    const envelope = {
      producerId: `game:${route.gameId}:session:${route.sessionId}`,
      eventId: 'completion-envelope-achievements',
      sessionId: route.sessionId,
      kind: 'SessionCompleted',
      schemaVersion: 1,
      sourceRelease: route.releaseId,
      aggregateSequence: 8,
      payload: {
        result: baseInput.result,
        resultRevision: 1,
        endedAt: 100,
        progress: {
          achievementFacts: {
            schemaVersion: 1,
            kind: 'seti:completed-achievement-facts',
            facts: [
              {
                userId: 'player-1',
                facts: [{ metric: 'game-completed', value: 1 }],
              },
            ],
          },
        },
      },
    } as const;
    const accepted = await store.accept(envelope, admission);
    expect(accepted.record.achievementSources).toEqual([
      {
        principalId: 'player-1',
        facts: [{ metric: 'game-completed', value: 1 }],
      },
    ]);
    await expect(store.accept(envelope, admission)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(
      store.accept(
        {
          ...envelope,
          eventId: 'completion-envelope-achievements-conflict',
          payload: {
            ...envelope.payload,
            progress: {
              achievementFacts: {
                ...envelope.payload.progress.achievementFacts,
                facts: [
                  {
                    userId: 'player-1',
                    facts: [{ metric: 'game-completed', value: 2 }],
                  },
                ],
              },
            },
          },
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      store.accept(
        {
          ...envelope,
          eventId: 'completion-envelope-achievements-forged',
          payload: {
            ...envelope.payload,
            progress: {
              achievementFacts: {
                ...envelope.payload.progress.achievementFacts,
                facts: [
                  {
                    userId: 'not-a-participant',
                    facts: [{ metric: 'game-completed', value: 1 }],
                  },
                ],
              },
            },
          },
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
  });

  it('normalizes only trusted cancelled control facts and rejects pause/resume', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'platform-1',
    });
    const envelope = {
      producerId: `game:${route.gameId}:session:${route.sessionId}`,
      eventId: 'completion-envelope-cancel',
      sessionId: route.sessionId,
      kind: 'SessionControlled',
      schemaVersion: 1,
      sourceRelease: route.releaseId,
      aggregateSequence: 9,
      occurredAt: 123,
      payload: {
        action: 'cancel',
        principalId: 'player-1',
        status: 'cancelled',
        summary: { reason: 'operator' },
      },
    } as const;
    const accepted = await store.accept(envelope, admission);
    expect(accepted.record).toMatchObject({
      status: 'cancelled',
      resultRevision: 1,
      sourceRevision: 9,
      endedAt: 123,
    });
    expect(accepted.record).not.toHaveProperty('result');
    expect(accepted.record).not.toHaveProperty('achievementSources');
    await expect(store.accept(envelope, admission)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(
      store.accept(
        {
          ...envelope,
          eventId: 'completion-envelope-pause',
          payload: {
            action: 'pause',
            principalId: 'player-1',
            status: 'paused',
          },
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept(
        {
          ...envelope,
          eventId: 'completion-envelope-cancel-status-mismatch',
          payload: {
            action: 'cancel',
            principalId: 'player-1',
            status: 'paused',
          },
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept(
        {
          ...envelope,
          eventId: 'completion-envelope-cancel-no-time',
          occurredAt: undefined,
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept(
        { ...envelope, producerId: 'untrusted-game-producer' },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
  });

  it('rejects forged envelope metadata and replay references with unknown keys', async () => {
    const store = new MemoryCompletionRecordStore({ platformId: 'platform-1' });
    const envelope = {
      producerId: `game:${route.gameId}:session:${route.sessionId}`,
      eventId: 'completion-envelope-2',
      sessionId: route.sessionId,
      kind: 'SessionCompleted',
      schemaVersion: 1,
      sourceRelease: route.releaseId,
      aggregateSequence: 2,
      payload: {
        result: baseInput.result,
        resultRevision: 1,
        endedAt: 100,
        replayRef: {
          platformId: 'platform-1',
          gameId: route.gameId,
          sessionId: route.sessionId,
          replayId: 'replay-1',
          releaseId: route.releaseId,
          storageBindingId: route.storageBindingId,
          formatVersion: 1,
          forged: true,
        },
      },
    };
    await expect(store.accept(envelope, admission)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      store.accept({ ...envelope, schemaVersion: 2 }, admission),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept({ ...envelope, producerId: 'forged-producer' }, admission),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
    const { forged: omittedForgedField, ...validReplayRef } =
      envelope.payload.replayRef;
    void omittedForgedField;
    const {
      storageBindingId: omittedStorageBinding,
      ...replayWithoutStorageBinding
    } = validReplayRef;
    void omittedStorageBinding;
    await expect(
      store.accept(
        {
          ...envelope,
          payload: {
            ...envelope.payload,
            replayRef: replayWithoutStorageBinding,
          },
        },
        admission,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept({ ...envelope, sessionId: undefined }, admission),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
    await expect(
      store.accept({ ...baseInput, platformId: 'other-platform' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('freezes the admission and rejects implicit revision corrections', async () => {
    const store = new MemoryCompletionRecordStore({
      admission: { getAdmission: async () => admission },
    });
    await expect(
      store.accept({ ...baseInput, resultRevision: 2 }),
    ).rejects.toMatchObject({
      code: 'REVISION_NOT_ALLOWED',
    });
    const mismatch = { ...admission, validityPolicyVersion: 'other-policy' };
    await expect(
      store.accept({ ...baseInput, admission: mismatch }),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
  });

  it('claims, retries failed settlement, and settles without a downstream when none is configured', async () => {
    let now = 100;
    const store = new MemoryCompletionRecordStore({
      platformId: 'platform-1',
      now: () => now,
    });
    await store.accept(baseInput);
    const firstClaim = await store.claimNext({
      owner: 'worker-1',
      leaseMs: 20,
    });
    expect(firstClaim).not.toBeNull();
    if (!firstClaim) throw new Error('claim missing');
    await expect(
      store.processClaim(firstClaim, {
        settle: async () => {
          throw new Error('settlement unavailable');
        },
      }),
    ).rejects.toThrow('settlement unavailable');
    expect(
      (await store.get('platform-1', route.sessionId))?.processingError,
    ).toContain('settlement unavailable');
    now = 1_101;
    const retry = await store.claimNext({ owner: 'worker-2' });
    expect(retry).not.toBeNull();
    if (!retry) throw new Error('retry claim missing');
    const settled = await store.processClaim(retry);
    expect(settled.processingState).toBe('settled');
    expect(settled.claimToken).toBeUndefined();
  });

  it('renews and settles claims within the configured platform boundary', async () => {
    const store = new MemoryCompletionRecordStore({
      platformId: 'platform-1',
    });
    await store.accept(baseInput);
    const claim = await store.claimNext({ owner: 'platform-worker' });
    if (!claim) throw new Error('claim missing');
    const renewed = await store.renewClaim(claim);
    expect(renewed.record.platformId).toBe('platform-1');
    const settled = await store.processClaim(renewed);
    expect(settled.processingState).toBe('settled');
    await expect(
      store.claimNext({ owner: 'platform-worker-retry' }),
    ).resolves.toBeNull();
  });

  it('fences expired claims', async () => {
    let now = 100;
    const store = new MemoryCompletionRecordStore({ now: () => now });
    await store.accept(baseInput);
    const claim = await store.claimNext({ owner: 'worker-1', leaseMs: 5 });
    if (!claim) throw new Error('claim missing');
    now = 106;
    await expect(store.markResultStored(claim)).rejects.toMatchObject({
      code: 'CLAIM_LOST',
    });
    expect(await store.claimNext({ owner: 'worker-2' })).not.toBeNull();
  });

  it('does not invoke settlement again when a completed claim is replayed', async () => {
    const store = new MemoryCompletionRecordStore();
    await store.accept(baseInput);
    const claim = await store.claimNext({ owner: 'worker-1' });
    if (!claim) throw new Error('claim missing');
    let calls = 0;
    await store.processClaim(claim, {
      settle: async () => {
        calls += 1;
      },
    });
    const replayed = await store.processClaim(claim, {
      settle: async () => {
        calls += 1;
      },
    });
    expect(replayed.processingState).toBe('settled');
    expect(calls).toBe(1);
  });
});
