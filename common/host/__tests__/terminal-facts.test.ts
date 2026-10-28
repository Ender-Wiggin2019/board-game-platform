import { randomUUID } from 'node:crypto';
import type {
  AccessContext,
  ControlSessionRequest,
  CreateSessionRequest,
  SessionRoute,
  SubmitCommandRequest,
} from '@board-game/contracts';
import type { GameModule, TerminalFactsContext } from '@board-game/sdk';
import { MemoryStorageDriver } from '@board-game/storage';
import {
  type SequentialTurnCommand,
  type SequentialTurnEvent,
  type SequentialTurnSetup,
  type SequentialTurnState,
  type SequentialTurnView,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

type TerminalModule = GameModule<
  SequentialTurnState,
  SequentialTurnSetup,
  SequentialTurnCommand,
  SequentialTurnView,
  SequentialTurnEvent,
  null,
  null
>;

const scopes = [
  'session:create',
  'session:command',
  'session:view',
  'session:control',
  'session:history:retire',
];
const alice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'terminal-facts-auth',
  scopes,
};
const cancelOnlyAlice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'terminal-facts-auth',
  scopes: ['session:control:cancel'],
};

const terminalFactsModule: TerminalModule = {
  ...sequentialTurnFixture,
  gameId: 'fixture-terminal-facts',
  releaseId: 'fixture-terminal-facts-v1',
  terminalFacts: (
    state: Readonly<SequentialTurnState>,
    context: TerminalFactsContext,
  ) => [
    {
      fact: 'terminal',
      status: context.status,
      logicalTime: context.logicalTime,
      turnIndex: state.turnIndex,
    },
  ],
};

function host(
  storage: MemoryStorageDriver,
  module: TerminalModule = terminalFactsModule,
): GameHost {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'terminal-facts-host',
    storageBindingId: 'terminal-facts-storage',
    authorize: async () => undefined,
    now: () => 100,
  });
}

function createRequest(
  module: TerminalModule = terminalFactsModule,
  target = 1,
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
      backendBindingId: 'terminal-facts-host',
      storageBindingId: 'terminal-facts-storage',
      ownershipEpoch: 'terminal-facts-owner',
    },
    participants: [
      { principalId: 'alice', seatId: 'seat-1' },
      { principalId: 'bob', seatId: 'seat-2' },
    ],
    setup: { target },
    seed: 'terminal-facts-seed',
  };
}

async function start(
  backend: GameHost,
  module: TerminalModule = terminalFactsModule,
  target = 1,
): Promise<CreateSessionRequest> {
  const request = createRequest(module, target);
  await backend.createSession(request);
  await backend.activateSession({
    protocolVersion: 1,
    accessContext: alice,
    route: request.route,
    startId: request.startId,
  });
  return request;
}

function command(route: SessionRoute, revision = 1): SubmitCommandRequest {
  return {
    protocolVersion: 1,
    accessContext: alice,
    route,
    commandId: randomUUID(),
    precondition: { kind: 'revision', expectedRevision: revision },
    command: { type: 'claim' },
  };
}

function terminalFacts(outbox: readonly { kind: string; payload: unknown }[]) {
  return outbox.filter(
    (message) =>
      message.kind === 'GameFact' &&
      typeof message.payload === 'object' &&
      message.payload !== null &&
      (message.payload as { fact?: unknown }).fact === 'terminal',
  );
}

describe('Host terminal facts', () => {
  it('writes completed facts once and keeps them readable after retirement', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage);
    const request = await start(backend);
    const submitted = command(request.route);

    await expect(backend.submitCommand(submitted)).resolves.toMatchObject({
      receipt: { status: 'accepted', persistedRevision: 2 },
    });
    const firstOutbox = await storage.readOutboxBatch({ limit: 100 });
    expect(
      terminalFacts(firstOutbox).map((message) => message.payload),
    ).toEqual([
      {
        fact: 'terminal',
        status: 'completed',
        logicalTime: 102,
        turnIndex: 1,
      },
    ]);

    await expect(backend.submitCommand(submitted)).resolves.toMatchObject({
      receipt: { status: 'duplicate' },
    });
    expect(await storage.readOutboxBatch({ limit: 100 })).toEqual(firstOutbox);

    const summary = await backend.getSessionSummary({
      protocolVersion: 1,
      accessContext: alice,
      route: request.route,
    });
    await backend.retireSessionHistory({
      protocolVersion: 1,
      accessContext: alice,
      route: request.route,
      expectedRevision: summary.sourceRevision,
    });
    expect(await storage.readOutboxBatch({ limit: 100 })).toEqual(firstOutbox);
  });

  it('writes cancellation facts through direct control exactly once', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage);
    const request = await start(backend, terminalFactsModule, 2);
    const cancel: ControlSessionRequest = {
      protocolVersion: 1,
      accessContext: cancelOnlyAlice,
      route: request.route,
      commandId: randomUUID(),
      expectedRevision: 1,
      action: 'cancel',
    };

    await expect(backend.controlSession(cancel)).resolves.toMatchObject({
      status: 'cancelled',
      receipt: { status: 'accepted', persistedRevision: 2 },
    });
    const firstOutbox = await storage.readOutboxBatch({ limit: 100 });
    expect(
      terminalFacts(firstOutbox).map((message) => message.payload),
    ).toEqual([
      {
        fact: 'terminal',
        status: 'cancelled',
        logicalTime: 102,
        turnIndex: 0,
      },
    ]);

    await expect(backend.controlSession(cancel)).resolves.toMatchObject({
      status: 'cancelled',
      receipt: { status: 'duplicate' },
    });
    expect(await storage.readOutboxBatch({ limit: 100 })).toEqual(firstOutbox);
  });

  it('rejects a terminal facts hook that mutates its state candidate', async () => {
    const mutatingModule: TerminalModule = {
      ...terminalFactsModule,
      gameId: 'fixture-terminal-facts-mutating',
      releaseId: 'fixture-terminal-facts-mutating-v1',
      terminalFacts: (state) => {
        (state as { turnIndex: number }).turnIndex += 1;
        return [];
      },
    };
    const storage = new MemoryStorageDriver();
    const backend = host(storage, mutatingModule);
    const request = await start(backend, mutatingModule);

    await expect(
      backend.submitCommand(command(request.route)),
    ).rejects.toMatchObject({ envelope: { code: 'INTERNAL' } });
    expect(await storage.getHead(request.route.sessionId)).toMatchObject({
      status: 'active',
      revision: 1,
    });
    expect(
      terminalFacts(await storage.readOutboxBatch({ limit: 100 })),
    ).toHaveLength(0);
  });
});
