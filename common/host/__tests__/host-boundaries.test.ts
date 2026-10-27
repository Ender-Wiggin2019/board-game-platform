import { randomUUID } from 'node:crypto';
import {
  type AccessContext,
  type CreateSessionRequest,
  type SessionRoute,
  type SubmitCommandRequest,
} from '@board-game/contracts';
import {
  MemoryStorageDriver,
  type SessionHead,
  type SessionOwner,
  type SessionTransaction,
  type StorageDriver,
  StorageError,
} from '@board-game/storage';
import {
  type SequentialTurnEvent,
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
const bob: AccessContext = { principalId: 'bob', authEpoch: 'auth-1', scopes };
const viewerRequest = (route: SessionRoute, accessContext = alice) => ({
  protocolVersion: 1 as const,
  route,
  accessContext,
});

function host(
  storage: StorageDriver,
  module: typeof sequentialTurnFixture = sequentialTurnFixture,
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

function createRequest(
  module: typeof sequentialTurnFixture = sequentialTurnFixture,
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

async function start(
  backend: GameHost,
  module: typeof sequentialTurnFixture = sequentialTurnFixture,
) {
  const request = createRequest(module);
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

class CountingStorage extends MemoryStorageDriver {
  eventBatches = 0;
  eventSingles = 0;
  outboxBatches = 0;
  outboxSingles = 0;

  override transaction<T>(
    sessionId: string,
    owner: SessionOwner,
    callback: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T> {
    return super.transaction(sessionId, owner, (tx) =>
      callback({
        ...tx,
        appendEvents: async (events) => {
          this.eventBatches += 1;
          return tx.appendEvents(events);
        },
        appendEvent: async (event) => {
          this.eventSingles += 1;
          return tx.appendEvent(event);
        },
        appendOutboxMany: async (messages) => {
          this.outboxBatches += 1;
          return tx.appendOutboxMany(messages);
        },
        appendOutbox: async (message) => {
          this.outboxSingles += 1;
          return tx.appendOutbox(message);
        },
      }),
    );
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('Host lifecycle and candidate boundaries', () => {
  it('uses one event batch and one outbox batch for a command transition', async () => {
    const store = new CountingStorage();
    const backend = host(store);
    const request = await start(backend);
    store.eventBatches = 0;
    store.eventSingles = 0;
    store.outboxBatches = 0;
    store.outboxSingles = 0;

    await backend.submitCommand(command(request.route));

    expect(store.eventBatches).toBe(1);
    expect(store.eventSingles).toBe(0);
    expect(store.outboxBatches).toBe(1);
    expect(store.outboxSingles).toBe(0);
  });

  it('lets an admitted transaction finish while the host drains', async () => {
    class BlockingStorage extends MemoryStorageDriver {
      block = false;
      entered = deferred<void>();
      release = deferred<void>();

      override transaction<T>(
        id: string,
        owner: SessionOwner,
        work: (tx: SessionTransaction) => Promise<T>,
      ): Promise<T> {
        return super.transaction(id, owner, async (tx) => {
          if (this.block) {
            this.entered.resolve();
            await this.release.promise;
          }
          return work(tx);
        });
      }
    }

    const store = new BlockingStorage();
    const backend = host(store);
    const request = await start(backend);
    store.block = true;

    const submitted = backend.submitCommand(command(request.route));
    await store.entered.promise;
    const draining = backend.drain();

    store.release.resolve();
    await expect(submitted).resolves.toMatchObject({
      receipt: { status: 'accepted', persistedRevision: 2 },
    });
    await expect(draining).resolves.toBeUndefined();
    await expect(
      backend.submitCommand(command(request.route, 2)),
    ).rejects.toMatchObject({
      envelope: { code: 'NOT_READY' },
    });
  });

  it('resolves the pinned module before activating a session', async () => {
    const store = new MemoryStorageDriver();
    const request = createRequest();
    const installed = host(store);
    await installed.createSession(request);

    const restartedWithoutRelease = new GameHost({
      registry: new GameRegistry(),
      storage: store,
      backendBindingId: 'local',
      storageBindingId: 'test',
      authorize: async () => undefined,
      now: () => 100,
    });
    await expect(
      restartedWithoutRelease.activateSession({
        protocolVersion: 1,
        accessContext: alice,
        route: request.route,
        startId: request.startId,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_FOUND' } });
    expect((await store.getHead(request.route.sessionId))?.status).toBe(
      'suspended',
    );
  });

  it('checks query audience before status and revision', async () => {
    let queried = false;
    const module: typeof sequentialTurnFixture = {
      ...sequentialTurnFixture,
      gameId: 'fixture-boundary-query',
      releaseId: 'fixture-boundary-query-v1',
      schemas: {
        ...sequentialTurnFixture.schemas,
        query: {
          name: 'fixture.boundary.query',
          version: 1,
          schema: { type: 'null' },
        },
      },
      rules: {
        ...sequentialTurnFixture.rules,
        query: (_state, _query, _viewer) => {
          queried = true;
          return null;
        },
      },
    };
    const store = new MemoryStorageDriver();
    const backend = host(store, module);
    const request = await start(backend, module);
    const nonParticipant: AccessContext = {
      principalId: 'mallory',
      authEpoch: 'auth-1',
      scopes: ['session:view'],
    };

    await expect(
      backend.queryOptions({
        ...viewerRequest(request.route, nonParticipant),
        revision: 0,
        query: null,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    expect(queried).toBe(false);
  });

  it('does not allow a browser access context to submit as a bot participant', async () => {
    const store = new MemoryStorageDriver();
    const backend = host(store);
    const request = createRequest();
    const humanParticipant = request.participants[0];
    if (!humanParticipant) throw new Error('human participant missing');
    const botPrincipalId = 'bot:session:1';
    const botRequest = {
      ...request,
      participants: [
        humanParticipant,
        {
          principalId: botPrincipalId,
          seatId: 'seat-2',
          controller: 'bot' as const,
        },
      ],
    };
    await backend.createSession(botRequest);
    await backend.activateSession({
      protocolVersion: 1,
      accessContext: alice,
      route: botRequest.route,
      startId: botRequest.startId,
    });
    await expect(
      backend.submitCommand({
        ...command(botRequest.route),
        accessContext: { ...bob, principalId: botPrincipalId },
      }),
    ).rejects.toMatchObject({
      envelope: { code: 'FORBIDDEN', messageKey: 'host.participant.required' },
    });
    expect((await store.getHead(botRequest.route.sessionId))?.revision).toBe(1);
  });

  it('checks the existing route before comparing a start digest', async () => {
    const store = new MemoryStorageDriver();
    const backend = host(store);
    const request = createRequest();
    await backend.createSession(request);

    await expect(
      backend.createSession({
        ...request,
        route: { ...request.route, ownershipEpoch: 'owner-2' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'OWNERSHIP_LOST' } });
  });

  it('maps create head-read storage failures through the contract error boundary', async () => {
    class HeadReadFailureStorage extends MemoryStorageDriver {
      override async getHead(_sessionId: string): Promise<SessionHead | null> {
        throw new StorageError('DATABASE_ERROR', 'injected read failure');
      }
    }

    const store = new HeadReadFailureStorage();
    await expect(
      host(store).createSession(createRequest()),
    ).rejects.toMatchObject({
      envelope: { code: 'INTERNAL' },
    });
  });

  it('keeps event projection mutations out of the persisted event', async () => {
    const module: typeof sequentialTurnFixture = {
      ...sequentialTurnFixture,
      gameId: 'fixture-boundary-event',
      releaseId: 'fixture-boundary-event-v1',
      rules: {
        ...sequentialTurnFixture.rules,
        projectEvent: (event: SequentialTurnEvent) => {
          (event as { score: number }).score = 999;
          return event;
        },
      },
    };
    const store = new MemoryStorageDriver();
    const backend = host(store, module);
    const request = await start(backend, module);
    await backend.submitCommand(command(request.route));

    const [event] = await store.readEvents(request.route.sessionId, {
      limit: 10,
    });
    expect(event?.payload).toMatchObject({
      type: 'turn-claimed',
      score: 1,
    });
  });

  it('isolates completion, summary, and fact hooks from the committed candidate', async () => {
    const module: typeof sequentialTurnFixture = {
      ...sequentialTurnFixture,
      gameId: 'fixture-boundary-candidate',
      releaseId: 'fixture-boundary-candidate-v1',
      summarize: (state) => {
        (state as { target: number }).target = 888;
        return { marker: 'summary-safe' };
      },
      collectFacts: (before, transition) => {
        (before as { target: number }).target = 666;
        if (transition.ok) {
          (transition.state as { target: number }).target = 777;
          const event = transition.events[0];
          if (event) (event as { score: number }).score = 888;
        }
        return [];
      },
      completion: (state) => {
        (state as { target: number }).target = 999;
        return { finished: false };
      },
    };
    const store = new MemoryStorageDriver();
    const backend = host(store, module);
    const request = await start(backend, module);
    await backend.submitCommand(command(request.route));

    expect(
      (await store.getHead(request.route.sessionId))?.encodedState,
    ).toMatchObject({
      target: 2,
    });
    expect(
      (await backend.getPlayerView(viewerRequest(request.route))).payload,
    ).toMatchObject({ target: 2, scores: { 'seat-1': 1 } });
    expect(
      (await backend.getSessionSummary(viewerRequest(request.route))).summary,
    ).toEqual({ marker: 'summary-safe' });
    const [event] = await store.readEvents(request.route.sessionId, {
      limit: 10,
    });
    expect(event?.payload).toMatchObject({ score: 1 });
  });
});
