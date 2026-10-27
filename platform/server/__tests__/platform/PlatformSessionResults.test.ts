import {
  contractError,
  type MatchAdmission,
  type SessionRoute,
} from '@board-game/contracts';
import type { SessionDirectoryStore, SessionGateway } from '@board-game/core';
import { BackendTransportError } from '@board-game/host';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCompletionRecordStore } from '@/platform/CompletionRecordStore.js';
import { PlatformSessionResults } from '@/platform/PlatformSessionResults.js';

const route: SessionRoute = {
  gameId: 'results-game',
  modeId: 'ranked',
  sessionId: 'results-session-1',
  releaseId: 'results-release-1',
  backendBindingId: 'results-backend-1',
  storageBindingId: 'results-storage-1',
  ownershipEpoch: 'results-epoch-1',
};

const admission: MatchAdmission = {
  id: 'results-admission-1',
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

function sessions(): SessionGateway {
  return {
    descriptor: async () => ({
      authority: 'platform',
      route,
      status: 'completed',
    }),
    summary: async () => {
      throw new Error('backend unavailable');
    },
    view: async () => {
      throw new Error('backend unavailable');
    },
  } as unknown as SessionGateway;
}

function directory(): SessionDirectoryStore {
  return {
    getSession: async () => {
      throw new Error(
        'directory should not be consulted for authoritative results',
      );
    },
  } as unknown as SessionDirectoryStore;
}

describe('PlatformSessionResults', () => {
  it('isolates replay grants from ordinary results and restricts native replay queries', async () => {
    const completionStore = new MemoryCompletionRecordStore();
    await completionStore.accept({
      platformId: 'platform-1',
      admission,
      status: 'completed',
      resultRevision: 1,
      sourceRevision: 9,
      endedAt: 100,
      result: {
        kind: 'cooperative',
        participantIds: ['player-1', 'player-2'],
        outcome: 'won',
      },
      replayRef: {
        platformId: 'platform-1',
        gameId: route.gameId,
        sessionId: route.sessionId,
        replayId: 'opaque-replay',
        releaseId: route.releaseId,
        storageBindingId: route.storageBindingId,
        formatVersion: 1,
      },
    });
    const ordinary = {
      ...sessions(),
      descriptor: async () => {
        throw contractError('FORBIDDEN', 'private.session');
      },
    } as unknown as SessionGateway;
    const query = vi.fn().mockResolvedValue({ answer: { frameCount: 1 } });
    const replay = { ...sessions(), query } as unknown as SessionGateway;
    const service = new PlatformSessionResults(ordinary, directory(), {
      completionStore,
      platformId: 'platform-1',
      replaySessions: replay,
    });
    service.registerRemoteRelease(route.gameId, route.releaseId);
    service.registerReplayQueries(route.gameId, route.releaseId, {
      manifest: (eventLimit) => ({ type: 'manifest', eventLimit }),
      frames: (from, limit) => ({ type: 'frames', from, limit }),
    });
    const reference = {
      principalId: 'spectator',
      authSessionId: 'auth-spectator',
    };
    await expect(
      service.getReplayManifest(reference, route.sessionId),
    ).resolves.toMatchObject({ route, sourceRevision: 9 });
    await expect(
      service.getCompletion(reference, route.sessionId),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      service.queryReplay(reference, route.sessionId, {
        revision: 9,
        query: { type: 'frames', from: 0, limit: 10 },
      }),
    ).resolves.toMatchObject({ answer: { frameCount: 1 } });
    const calls = query.mock.calls.length;
    await expect(
      service.queryReplay(reference, route.sessionId, {
        revision: 9,
        query: { type: 'private-options' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      service.queryReplay(reference, route.sessionId, {
        revision: 8,
        query: { type: 'frames', from: 0, limit: 10 },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'STALE_REVISION' } });
    expect(query).toHaveBeenCalledTimes(calls);
  });
  it.each([route.sessionId, 'seti:opaque-game-owned-replay'])(
    'resolves retained replay %s from its persisted reference and reports an offline game explicitly',
    async (replayId) => {
      const completionStore = new MemoryCompletionRecordStore();
      const replayRef = {
        platformId: 'platform-1',
        gameId: route.gameId,
        sessionId: route.sessionId,
        replayId,
        releaseId: route.releaseId,
        storageBindingId: route.storageBindingId,
        formatVersion: 1,
      };
      await completionStore.accept({
        platformId: 'platform-1',
        admission,
        status: 'completed',
        resultRevision: 1,
        sourceRevision: 9,
        endedAt: 100,
        result: {
          kind: 'cooperative',
          participantIds: ['player-1', 'player-2'],
          outcome: 'won',
        },
        replayRef,
      });
      const query = vi
        .fn()
        .mockResolvedValue({ answer: { frames: ['old-release'] } });
      const gateway = { ...sessions(), query } as unknown as SessionGateway;
      const service = new PlatformSessionResults(gateway, directory(), {
        completionStore,
        platformId: 'platform-1',
      });
      service.registerRemoteRelease(route.gameId, route.releaseId);
      service.registerReplayQueries(route.gameId, route.releaseId, {
        manifest: () => ({ type: 'old-manifest' }),
        frames: (from, limit) => ({ type: 'old-frames', from, limit }),
      });
      service.registerReplayQueries(route.gameId, 'new-release', {
        manifest: () => ({ type: 'new-manifest' }),
        frames: () => ({ type: 'new-frames' }),
      });
      const reference = { principalId: 'player-1', authSessionId: 'auth-1' };
      await expect(
        service.getReplayFrames(reference, route.sessionId, 2, 3),
      ).resolves.toMatchObject({
        route,
        sourceRevision: 9,
        replayRef,
        chunk: { frames: ['old-release'] },
      });
      expect(query).toHaveBeenLastCalledWith(reference, route.sessionId, {
        revision: 9,
        query: { type: 'old-frames', from: 2, limit: 3 },
      });
      query.mockRejectedValue(new BackendTransportError('NETWORK'));
      await expect(
        service.getReplayManifest(reference, route.sessionId),
      ).rejects.toMatchObject({
        envelope: { code: 'NOT_READY', retryable: true },
      });
      await expect(
        service.getCompletion(reference, route.sessionId),
      ).resolves.toMatchObject({ status: 'completed' });
    },
  );

  it('does not guess a replay when no immutable reference was retained', async () => {
    const completionStore = new MemoryCompletionRecordStore();
    await completionStore.accept({
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
    });
    const query = vi.fn();
    const service = new PlatformSessionResults(
      { ...sessions(), query } as unknown as SessionGateway,
      directory(),
      {
        completionStore,
        platformId: 'platform-1',
      },
    );
    service.registerRemoteRelease(route.gameId, route.releaseId);
    service.registerReplayQueries(route.gameId, route.releaseId, {
      manifest: () => ({ type: 'manifest' }),
      frames: () => ({ type: 'frames' }),
    });
    await expect(
      service.getReplayManifest(
        { principalId: 'player-1', authSessionId: 'auth-1' },
        route.sessionId,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads a remote completion after descriptor authorization while the backend is offline', async () => {
    const completionStore = new MemoryCompletionRecordStore({
      admission: { getAdmission: async () => admission },
    });
    await completionStore.accept({
      platformId: 'platform-1',
      admission,
      status: 'completed',
      resultRevision: 1,
      sourceRevision: 9,
      endedAt: 100,
      result: {
        kind: 'cooperative',
        participantIds: ['player-1', 'player-2'],
        outcome: 'won',
      },
    });
    const service = new PlatformSessionResults(sessions(), directory(), {
      completionStore,
      platformId: 'platform-1',
    });
    service.registerRemoteRelease(route.gameId, route.releaseId);
    const result = (await service.getCompletion(
      { principalId: 'player-1', authSessionId: 'auth-1' },
      route.sessionId,
    )) as {
      result: unknown;
      completion: { digest: string; sourceRevision: number };
      settlement: {
        processingState: string;
        claimToken?: string;
        processingError?: string;
      };
    };
    expect(result.result).toEqual({
      kind: 'cooperative',
      participantIds: ['player-1', 'player-2'],
      outcome: 'won',
    });
    expect(result.completion.digest).toMatch(/^sha256:/u);
    expect(result.completion.sourceRevision).toBe(9);
    expect(result.settlement.processingState).toBe('received');
    expect(result.settlement.claimToken).toBeUndefined();
    expect(result.settlement.processingError).toBeUndefined();
    expect(
      await service.getEndRecord(
        { principalId: 'player-1', authSessionId: 'auth-1' },
        route.sessionId,
      ),
    ).toEqual(result.result);
  });

  it('reports pending remote results without falling back to the game backend', async () => {
    const completionStore = new MemoryCompletionRecordStore();
    const service = new PlatformSessionResults(sessions(), directory(), {
      completionStore,
      platformId: 'platform-1',
    });
    service.registerRemoteRelease(route.gameId, route.releaseId);
    await expect(
      service.getCompletion(
        { principalId: 'player-1', authSessionId: 'auth-1' },
        route.sessionId,
      ),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });
  });
});
