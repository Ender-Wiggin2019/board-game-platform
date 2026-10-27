import { randomUUID } from 'node:crypto';
import type {
  AccessContext,
  CreateSessionRequest,
  SessionRoute,
  SubmitCommandRequest,
} from '@board-game/contracts';
import { MemoryStorageDriver } from '@board-game/storage';
import {
  type SequentialTurnState,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

const scopes = [
  'session:create',
  'session:command',
  'session:view',
  'session:control',
];
const alice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes,
};
const bob: AccessContext = {
  principalId: 'bob',
  authEpoch: 'auth-1',
  scopes,
};

type Counters = {
  encode: number;
  decode: number;
  project: number;
};

function projectionModule(counters: Counters) {
  let mutateNextProjection = true;
  const original = sequentialTurnFixture.rules;
  return {
    ...sequentialTurnFixture,
    gameId: 'fixture-host-projection-isolation',
    releaseId: 'fixture-host-projection-isolation-v1',
    rules: {
      ...original,
      encode: (state: Readonly<SequentialTurnState>) => {
        counters.encode += 1;
        return original.encode(state);
      },
      decode: (
        saved: Parameters<typeof original.decode>[0],
        version: number,
      ) => {
        counters.decode += 1;
        return original.decode(saved, version);
      },
      project: (
        state: Readonly<SequentialTurnState>,
        viewer: Parameters<typeof original.project>[1],
      ) => {
        counters.project += 1;
        if (mutateNextProjection) {
          mutateNextProjection = false;
          (state as { scores: Record<string, number> }).scores['seat-1'] = 999;
        }
        return original.project(state, viewer);
      },
    },
  };
}

function createRequest(
  module: ReturnType<typeof projectionModule>,
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: alice,
    startId: randomUUID(),
    startGeneration: 0,
    route: {
      gameId: module.gameId,
      modeId: 'sequential',
      sessionId: randomUUID(),
      releaseId: module.releaseId,
      backendBindingId: 'local',
      storageBindingId: 'test',
      ownershipEpoch: 'owner-1',
    },
    participants: [
      { principalId: alice.principalId, seatId: 'seat-1' },
      { principalId: bob.principalId, seatId: 'seat-2' },
    ],
    setup: { target: 2 },
    seed: 'fixed-seed',
  };
}

function viewRequest(route: SessionRoute, accessContext: AccessContext) {
  return { protocolVersion: 1 as const, route, accessContext };
}

function command(route: SessionRoute): SubmitCommandRequest {
  return {
    protocolVersion: 1,
    accessContext: alice,
    route,
    commandId: 'projection-command',
    precondition: { kind: 'revision', expectedRevision: 1 },
    command: { type: 'claim' },
  };
}

async function start(
  host: GameHost,
  request: CreateSessionRequest,
): Promise<void> {
  await host.createSession(request);
  await host.activateSession({
    protocolVersion: 1,
    accessContext: alice,
    route: request.route,
    startId: request.startId,
  });
}

function host(
  storage: MemoryStorageDriver,
  module: ReturnType<typeof projectionModule>,
) {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'local',
    storageBindingId: 'test',
    authorize: async () => undefined,
    now: () => 100,
  });
}

describe('Host projection isolation', () => {
  it('decodes once for a read and isolates a mutating renderer per viewer', async () => {
    const counters: Counters = { encode: 0, decode: 0, project: 0 };
    const module = projectionModule(counters);
    const storage = new MemoryStorageDriver();
    const backend = host(storage, module);
    const request = createRequest(module);
    await start(backend, request);

    const before = await storage.getHead(request.route.sessionId);
    counters.encode = 0;
    counters.decode = 0;
    counters.project = 0;

    const aliceView = await backend.getPlayerView(
      viewRequest(request.route, alice),
    );
    expect(counters).toEqual({ encode: 0, decode: 1, project: 1 });
    expect(aliceView.payload).toMatchObject({
      scores: { 'seat-1': 999 },
    });

    const bobView = await backend.getPlayerView(
      viewRequest(request.route, bob),
    );
    expect(counters).toEqual({ encode: 0, decode: 2, project: 2 });
    expect(bobView.payload).toMatchObject({
      scores: { 'seat-1': 0 },
    });
    expect(await storage.getHead(request.route.sessionId)).toEqual(before);
  });

  it('keeps the committed candidate and retry receipt unchanged after projection mutation', async () => {
    const counters: Counters = { encode: 0, decode: 0, project: 0 };
    const module = projectionModule(counters);
    const storage = new MemoryStorageDriver();
    const backend = host(storage, module);
    const request = createRequest(module);
    await start(backend, request);

    const commandRequest = command(request.route);
    const first = await backend.submitCommand(commandRequest);
    expect(first.receipt.status).toBe('accepted');
    const committed = await storage.getHead(request.route.sessionId);
    const receipt = await storage.getReceipt(
      request.route.sessionId,
      commandRequest.commandId,
    );

    const retry = await backend.submitCommand(commandRequest);
    expect(retry.receipt.status).toBe('duplicate');
    expect(await storage.getHead(request.route.sessionId)).toEqual(committed);
    expect(
      await storage.getReceipt(
        request.route.sessionId,
        commandRequest.commandId,
      ),
    ).toEqual(receipt);
    expect(committed?.encodedState).toMatchObject({
      scores: { 'seat-1': 1 },
    });
  });
});
