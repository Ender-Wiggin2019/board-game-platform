import type {
  AccessContext,
  CreateSessionRequest,
} from '@board-game/contracts';
import { MemoryStorageDriver } from '@board-game/storage';
import {
  type SequentialTurnEvent,
  type SequentialTurnState,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

const alice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:create', 'session:command', 'session:view'],
};

const replayModule = {
  ...sequentialTurnFixture,
  initialEvents: (
    state: Readonly<SequentialTurnState>,
  ): readonly SequentialTurnEvent[] => [
    { type: 'turn-claimed', seatId: 'seat-1', score: state.target },
  ],
};

const progressModule = {
  ...replayModule,
  modes: replayModule.modes.map((mode) => ({
    ...mode,
    history: 'progress-only' as const,
  })),
};

function createRequest(
  module: typeof replayModule | typeof progressModule,
  sessionId: string,
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: alice,
    route: {
      gameId: module.gameId,
      modeId: 'sequential',
      sessionId,
      releaseId: module.releaseId,
      backendBindingId: 'local',
      storageBindingId: 'test',
      ownershipEpoch: 'owner-1',
    },
    startId: `${sessionId}-start`,
    startGeneration: 0,
    setup: { target: 2 },
    participants: [
      { principalId: 'alice', seatId: 'seat-1' },
      { principalId: 'bob', seatId: 'seat-2' },
    ],
    seed: 'initial-events-seed',
  };
}

function host(
  storage: MemoryStorageDriver,
  module: typeof replayModule | typeof progressModule,
): GameHost {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'local',
    storageBindingId: 'test',
    authorize: async () => undefined,
    now: () => 100,
  });
}

describe('Host initial event persistence', () => {
  it('commits setup events atomically and advances the event sequence for replay history', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage, replayModule);
    const request = createRequest(replayModule, 'initial-events-replay');
    await backend.createSession(request);
    expect(
      (await storage.getHead(request.route.sessionId))?.eventSequence,
    ).toBe(1);
    expect(
      await storage.readEvents(request.route.sessionId, { limit: 10 }),
    ).toMatchObject([
      {
        eventId: 'initial-events-replay:event:1',
        aggregateSequence: 1,
        payload: { type: 'turn-claimed', seatId: 'seat-1', score: 2 },
      },
    ]);
    expect(await storage.readOutboxBatch({ limit: 10 })).toHaveLength(1);
    expect(await backend.createSession(request)).toMatchObject({
      sessionId: request.route.sessionId,
    });
    expect(
      await storage.readEvents(request.route.sessionId, { limit: 10 }),
    ).toHaveLength(1);
  });

  it('does not persist setup events for progress-only history', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage, progressModule);
    const request = createRequest(progressModule, 'initial-events-progress');
    await backend.createSession(request);
    expect(
      (await storage.getHead(request.route.sessionId))?.eventSequence,
    ).toBe(0);
    expect(
      await storage.readEvents(request.route.sessionId, { limit: 10 }),
    ).toEqual([]);
  });
});
