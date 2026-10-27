import { randomUUID } from 'node:crypto';
import {
  type AccessContext,
  type CreateSessionRequest,
  contractError,
  type SessionRoute,
  type SubmitCommandRequest,
} from '@board-game/contracts';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type SessionOwner,
  type SessionTransaction,
  type StorageDriver,
} from '@board-game/storage';
import {
  createSoloProgressSolutionCommand,
  sequentialTurnFixture,
  simultaneousHiddenFixture,
  soloProgressFixture,
} from '@board-game/testing/fixtures';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { GameHost, GameRegistry, SessionQueue } from '../src/index.js';

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
const cancelOnlyAlice: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: ['session:control:cancel'],
};
const viewers = [alice, bob];
function registry() {
  return new GameRegistry()
    .register(sequentialTurnFixture)
    .register(simultaneousHiddenFixture)
    .register(soloProgressFixture);
}
function host(
  storage: StorageDriver,
  authorize = async (context: AccessContext) => {
    if (!viewers.some((viewer) => viewer.principalId === context.principalId))
      throw contractError('FORBIDDEN', 'test.identity.denied');
  },
) {
  return new GameHost({
    registry: registry(),
    storage,
    backendBindingId: 'local',
    storageBindingId: 'test',
    authorize,
    now: () => 100,
  });
}
function createRequest(
  kind: 'sequential' | 'simultaneous' | 'solo-progress' = 'sequential',
): CreateSessionRequest {
  const module =
    kind === 'sequential'
      ? sequentialTurnFixture
      : kind === 'simultaneous'
        ? simultaneousHiddenFixture
        : soloProgressFixture;
  return {
    protocolVersion: 1,
    accessContext: alice,
    startId: randomUUID(),
    startGeneration: 0,
    route: {
      gameId: module.gameId,
      modeId: kind,
      sessionId: randomUUID(),
      releaseId: module.releaseId,
      backendBindingId: 'local',
      storageBindingId: 'test',
      ownershipEpoch: 'owner-1',
    },
    participants: (kind === 'solo-progress' ? [alice] : viewers).map(
      (p, i) => ({ principalId: p.principalId, seatId: `seat-${i + 1}` }),
    ),
    setup: kind === 'sequential' ? { target: 2 } : {},
    seed: 'fixed-seed',
  };
}
async function start(
  backend: GameHost,
  kind: 'sequential' | 'simultaneous' | 'solo-progress' = 'sequential',
) {
  const request = createRequest(kind);
  await backend.createSession(request);
  await backend.activateSession({
    protocolVersion: 1,
    accessContext: alice,
    route: request.route,
    startId: request.startId,
  });
  return request;
}
function command(
  route: SessionRoute,
  accessContext = alice,
  revision = 1,
): SubmitCommandRequest {
  return {
    protocolVersion: 1,
    accessContext,
    route,
    commandId: randomUUID(),
    precondition: { kind: 'revision', expectedRevision: revision },
    command: { type: 'claim' },
  };
}
function viewRequest(route: SessionRoute, accessContext = alice) {
  return { protocolVersion: 1 as const, route, accessContext };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
const databaseUrl = process.env.BGP_TEST_DATABASE_URL;

describe.each(['memory', ...(databaseUrl ? ['postgres'] : [])])(
  'Host transaction contract (%s)',
  (driver) => {
    async function storage(): Promise<StorageDriver> {
      if (driver === 'memory') return new MemoryStorageDriver();
      const schema = `host_test_${randomUUID().replaceAll('-', '')}`;
      const pool = new Pool({ connectionString: databaseUrl });
      const store = new PostgresStorageDriver({ pool, schema });
      await store.migrate();
      cleanups.push(async () => {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
        await pool.end();
      });
      return store;
    }

    it('keeps creation and activation idempotent and rejects commands before activation', async () => {
      const store = await storage();
      const backend = host(store);
      const request = createRequest();
      const first = await backend.createSession(request);
      expect(await backend.createSession(request)).toEqual(first);
      await expect(
        backend.createSession({ ...request, setup: { target: 3 } }),
      ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
      await expect(
        backend.submitCommand(command(request.route, alice, 0)),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_SUSPENDED' } });
      const activation = {
        ...viewRequest(request.route),
        startId: request.startId,
      };
      const active = await backend.activateSession(activation);
      expect(await backend.activateSession(activation)).toEqual(active);
      expect(
        (await store.readOutboxBatch({ limit: 10 })).map((event) => event.kind),
      ).toEqual(['SessionCreated', 'SessionActivated']);
    });

    it('gives game creation the same clock value persisted in the initial head', async () => {
      const store = await storage();
      const creationTimes: Array<number | undefined> = [];
      const timedModule = {
        ...sequentialTurnFixture,
        rules: {
          ...sequentialTurnFixture.rules,
          create: (
            ...args: Parameters<typeof sequentialTurnFixture.rules.create>
          ) => {
            const [, context] = args;
            creationTimes.push(context.logicalTime);
            return sequentialTurnFixture.rules.create(...args);
          },
        },
      };
      let clock = 1_000;
      const backend = new GameHost({
        registry: new GameRegistry().register(timedModule),
        storage: store,
        backendBindingId: 'local',
        storageBindingId: 'test',
        authorize: async () => undefined,
        now: () => clock++,
      });
      const request = createRequest();
      await backend.createSession(request);
      const head = await store.getHead(request.route.sessionId);
      expect(creationTimes).toEqual([head?.logicalTime]);
      expect(creationTimes[0]).toBe(1_000);
      await backend.createSession(request);
      expect(creationTimes).toHaveLength(1);
    });

    it('persists the activation hook once using the activation clock after delayed preparation', async () => {
      const store = await storage();
      const activationTimes: number[] = [];
      const timedModule = {
        ...sequentialTurnFixture,
        summarize: (
          state: ReturnType<typeof sequentialTurnFixture.rules.create>,
        ) => ({ target: state.target }),
        rules: {
          ...sequentialTurnFixture.rules,
          activate: (
            state: ReturnType<typeof sequentialTurnFixture.rules.create>,
            context: { readonly logicalTime: number },
          ) => {
            activationTimes.push(context.logicalTime);
            return { ...state, target: 7 };
          },
        },
      };
      let clock = 1_000;
      const options = {
        registry: new GameRegistry().register(timedModule),
        storage: store,
        backendBindingId: 'local',
        storageBindingId: 'test',
        authorize: async () => undefined,
        now: () => clock,
      };
      const request = createRequest();
      await new GameHost(options).createSession(request);
      clock = 600_000;
      const activation = {
        ...viewRequest(request.route),
        startId: request.startId,
      };
      const active = await new GameHost(options).activateSession(activation);
      const head = await store.getHead(request.route.sessionId);
      expect(activationTimes).toEqual([clock]);
      expect(head).toMatchObject({
        activatedAt: clock,
        encodedState: { target: 7 },
        summary: { target: 7 },
      });
      clock += 10_000;
      expect(await new GameHost(options).activateSession(activation)).toEqual(
        active,
      );
      expect(activationTimes).toHaveLength(1);
    });

    it('recovers ACK loss before stale revision checks without replaying side effects', async () => {
      const store = await storage();
      const backend = host(store);
      const { route } = await start(backend);
      const request = command(route);
      const accepted = await backend.submitCommand(request);
      const count = (await store.readOutboxBatch({ limit: 100 })).length;
      const resumed = host(store);
      const duplicate = await resumed.submitCommand(request);
      expect(duplicate.receipt).toMatchObject({
        status: 'duplicate',
        persistedRevision: accepted.receipt.persistedRevision,
      });
      expect(duplicate.view).toBeUndefined();
      expect((await store.readOutboxBatch({ limit: 100 })).length).toBe(count);
      await expect(
        resumed.submitCommand({
          ...request,
          command: { type: 'claim', injected: true },
        }),
      ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
      await expect(
        resumed.submitCommand({ ...request, accessContext: bob }),
      ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect(
        await resumed.getStatus({
          ...viewRequest(route),
          commandId: request.commandId,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(
        await resumed.getStatus({
          ...viewRequest(route, bob),
          commandId: request.commandId,
        }),
      ).toMatchObject({ status: 'unknown' });
      const safe = JSON.stringify(duplicate);
      expect(safe).not.toContain('inputHash');
      expect(safe).not.toContain('actorPrincipalId');
    });

    it('rechecks current authorization even when a receipt exists', async () => {
      const store = await storage();
      let disabled = false;
      const backend = host(store, async () => {
        if (disabled) throw contractError('FORBIDDEN', 'test.disabled');
      });
      const { route } = await start(backend);
      const request = command(route);
      await backend.submitCommand(request);
      disabled = true;
      await expect(backend.submitCommand(request)).rejects.toMatchObject({
        envelope: { code: 'FORBIDDEN' },
      });
    });

    it('fences competing hosts and rejects stale ownership and release routes', async () => {
      const store = await storage();
      const first = host(store);
      const second = host(store);
      const { route } = await start(first);
      const results = await Promise.allSettled([
        first.submitCommand(command(route)),
        second.submitCommand(command(route)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await store.getHead(route.sessionId))?.revision).toBe(2);
      await expect(
        first.submitCommand(
          command({ ...route, ownershipEpoch: 'owner-0' }, bob, 2),
        ),
      ).rejects.toMatchObject({ envelope: { code: 'OWNERSHIP_LOST' } });
      await expect(
        first.getPlayerView(
          viewRequest({ ...route, releaseId: 'another-release' }),
        ),
      ).rejects.toMatchObject({ envelope: { code: 'OWNERSHIP_LOST' } });
    });

    it('accepts independent simultaneous prompts and projects secrets only to the owning player', async () => {
      const store = await storage();
      const first = host(store);
      const second = host(store);
      const { route } = await start(first, 'simultaneous');
      const hidden = (
        accessContext: AccessContext,
        choice: string,
      ): SubmitCommandRequest => ({
        protocolVersion: 1,
        accessContext,
        route,
        commandId: randomUUID(),
        precondition: {
          kind: 'prompt',
          promptId: 'prompt-1',
          participantInputRevision: 0,
        },
        command: { type: 'submit', choice },
      });
      await first.submitCommand(hidden(alice, 'red'));
      const aliceView = await first.getPlayerView(viewRequest(route));
      const bobView = await second.getPlayerView(viewRequest(route, bob));
      expect(aliceView.payload).toMatchObject({
        yourChoice: 'red',
        revealedChoices: null,
      });
      expect(bobView.payload).toMatchObject({
        yourChoice: null,
        revealedChoices: null,
      });
      expect(JSON.stringify(bobView)).not.toContain('red');
      const response = await second.submitCommand(hidden(bob, 'blue'));
      expect(response.receipt.persistedRevision).toBe(3);
      expect(response.view?.payload).toMatchObject({
        phase: 'revealed',
        revealedChoices: { 'seat-1': 'red', 'seat-2': 'blue' },
      });
      expect(
        await first.resume({
          ...viewRequest(route, bob),
          streamCursor: aliceView.streamCursor,
        }),
      ).toMatchObject({ kind: 'resync-required' });
      expect(
        (await first.getPlayerView(viewRequest(route))).audienceKey,
      ).not.toBe(bobView.audienceKey);
    });

    it('lets a non-current participant submit an exact revision for rule-owned checks', async () => {
      const store = await storage();
      const backend = host(store);
      const { route } = await start(backend);

      const response = await backend.submitCommand(command(route, bob, 1));

      expect(response.receipt.status).toBe('rejected');
      expect(response.receipt.error?.messageKey).toBe('fixture.not_your_turn');
    });

    it('fences idempotency when the same principal selects a different seat', async () => {
      const store = await storage();
      const backend = host(store);
      const { route } = await start(backend);
      const first = command(route, alice, 1);

      await backend.submitCommand(first);
      await expect(
        backend.submitCommand({
          ...first,
          accessContext: { ...alice, seatId: 'seat-1' },
        }),
      ).rejects.toMatchObject({
        envelope: { code: 'IDEMPOTENCY_CONFLICT' },
      });
    });

    it('reads bounded viewer-projected events without exposing private choices', async () => {
      const store = await storage();
      const backend = host(store, async () => undefined);
      const { route } = await start(backend, 'simultaneous');
      const hidden = (
        accessContext: AccessContext,
        choice: 'red' | 'blue',
      ): SubmitCommandRequest => ({
        protocolVersion: 1,
        accessContext,
        route,
        commandId: randomUUID(),
        precondition: {
          kind: 'prompt',
          promptId: 'prompt-1',
          participantInputRevision: 0,
        },
        command: { type: 'submit', choice },
      });
      await backend.submitCommand(hidden(alice, 'red'));

      const firstPage = await backend.getEvents({
        protocolVersion: 1,
        accessContext: bob,
        route,
        afterSequence: 0,
        limit: 1,
      });
      expect(firstPage).toMatchObject({
        gameId: route.gameId,
        sessionId: route.sessionId,
        releaseId: route.releaseId,
        viewEpoch: bob.authEpoch,
        nextSequence: 1,
        hasMore: false,
        resetRequired: false,
      });
      expect(firstPage.events).toHaveLength(1);
      expect(firstPage.events[0]?.payload).toEqual({
        type: 'choice-submitted',
        seatId: 'seat-1',
        inputRevision: 1,
      });
      expect(JSON.stringify(firstPage)).not.toContain('"choice":"red"');

      const alicePage = await backend.getEvents({
        protocolVersion: 1,
        accessContext: alice,
        route,
        afterSequence: 0,
        limit: 10,
      });
      expect(alicePage.events[0]?.payload).toMatchObject({ choice: 'red' });
      expect(alicePage.audienceKey).not.toBe(firstPage.audienceKey);

      const reset = await backend.getEvents({
        protocolVersion: 1,
        accessContext: bob,
        route,
        afterSequence: 0,
        limit: 10,
        viewEpoch: 'stale-epoch',
      });
      expect(reset).toMatchObject({
        events: [],
        nextSequence: 0,
        hasMore: false,
        resetRequired: true,
        viewEpoch: bob.authEpoch,
      });

      await backend.submitCommand(hidden(bob, 'blue'));
      const spectator: AccessContext = {
        principalId: 'spectator',
        authEpoch: 'auth-1',
        scopes: ['session:view', 'session:spectate'],
      };
      const spectatorPage = await backend.getEvents({
        protocolVersion: 1,
        accessContext: spectator,
        route,
        afterSequence: 1,
        limit: 10,
      });
      expect(spectatorPage.events.map((event) => event.sequence)).toEqual([
        2, 3,
      ]);
      expect(JSON.stringify(spectatorPage)).not.toContain('"choice":"red"');
      expect(spectatorPage.events[1]?.payload).toMatchObject({
        type: 'choices-revealed',
        choices: { 'seat-1': 'red', 'seat-2': 'blue' },
      });
    });

    it('commits rule-approved cancellation without a scored result and keeps retry receipts', async () => {
      const store = await storage();
      const cancellationModule = {
        ...sequentialTurnFixture,
        completion: () => ({ finished: false, cancelled: true }),
        result: () => {
          throw new Error('cancelled game must not score');
        },
      };
      const backend = new GameHost({
        registry: new GameRegistry().register(cancellationModule),
        storage: store,
        backendBindingId: 'local',
        storageBindingId: 'test',
        authorize: async () => {
          /* Authorized fixture players. */
        },
        now: () => 100,
      });
      const creation = await start(backend);
      const request = command(creation.route);
      expect((await backend.submitCommand(request)).receipt.status).toBe(
        'accepted',
      );
      expect(await store.getHead(creation.route.sessionId)).toMatchObject({
        status: 'cancelled',
        revision: 2,
      });
      expect((await backend.submitCommand(request)).receipt.status).toBe(
        'duplicate',
      );
      const outbox = await store.readOutboxBatch({ limit: 100 });
      expect(outbox.filter((item) => item.kind === 'SessionCompleted')).toEqual(
        [],
      );
      expect(
        outbox.find((item) => item.kind === 'SessionControlled')?.payload,
      ).toMatchObject({
        action: 'cancel',
        principalId: 'alice',
        status: 'cancelled',
      });
      expect(
        outbox.find((item) => item.kind === 'SessionControlled')?.payload,
      ).not.toHaveProperty('result');
      await expect(
        backend.submitCommand({ ...command(creation.route, bob, 2) }),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
    });

    it('keeps a terminal tombstone and progress while erasing puzzle state and events', async () => {
      const store = await storage();
      const backend = host(store);
      const creation = await start(backend, 'solo-progress');
      const solution = createSoloProgressSolutionCommand();
      const request = { ...command(creation.route), command: solution };
      const result = await backend.submitCommand(request);
      expect(result.view?.payload).toMatchObject({
        completed: true,
        progress: 1,
      });
      expect(
        (await store.getHead(creation.route.sessionId))?.encodedState,
      ).toBeNull();
      expect(
        await store.readEvents(creation.route.sessionId, { limit: 10 }),
      ).toEqual([]);
      await expect(
        backend.getEvents({
          protocolVersion: 1,
          accessContext: alice,
          route: creation.route,
          afterSequence: 0,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [],
        hasMore: false,
        resetRequired: false,
      });
      expect(
        JSON.stringify(await store.readOutboxBatch({ limit: 100 })),
      ).not.toContain(solution.answer);
      expect(await backend.submitCommand(request)).toMatchObject({
        receipt: { status: 'duplicate' },
      });
      expect(await backend.createSession(creation)).toMatchObject({
        status: 'completed',
      });
      await expect(
        backend.getPlayerView(viewRequest(creation.route)),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      expect(
        await backend.getSessionSummary(viewRequest(creation.route)),
      ).toMatchObject({ summary: { progress: 1 } });
      await expect(
        backend.submitCommand({
          ...request,
          commandId: randomUUID(),
          precondition: { kind: 'revision', expectedRevision: 2 },
        }),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
    });

    it('records control actions as monotonic idempotent commands', async () => {
      const store = await storage();
      const backend = host(store);
      const { route, startId } = await start(backend);
      const pause = {
        ...viewRequest(route),
        commandId: randomUUID(),
        expectedRevision: 1,
        action: 'pause' as const,
      };
      expect(await backend.controlSession(pause)).toMatchObject({
        status: 'paused',
        receipt: { persistedRevision: 2 },
      });
      expect(await backend.controlSession(pause)).toMatchObject({
        receipt: { status: 'duplicate' },
      });
      await expect(
        backend.activateSession({ ...viewRequest(route), startId }),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      await expect(
        backend.submitCommand(command(route, alice, 2)),
      ).rejects.toMatchObject({ envelope: { code: 'SESSION_CLOSED' } });
      await backend.controlSession({
        ...pause,
        commandId: randomUUID(),
        expectedRevision: 2,
        action: 'resume',
      });
      expect(
        (await backend.submitCommand(command(route, alice, 3))).receipt
          .persistedRevision,
      ).toBe(4);
    });

    it('allows the cancel-only scope to cancel and rejects pause or resume', async () => {
      const store = await storage();
      const backend = host(store);
      const { route } = await start(backend, 'solo-progress');
      const cancel = {
        ...viewRequest(route, cancelOnlyAlice),
        commandId: randomUUID(),
        expectedRevision: 1,
        action: 'cancel' as const,
      };

      await expect(backend.controlSession(cancel)).resolves.toMatchObject({
        status: 'cancelled',
        receipt: { status: 'accepted', persistedRevision: 2 },
      });
      await expect(backend.controlSession(cancel)).resolves.toMatchObject({
        status: 'cancelled',
        receipt: { status: 'duplicate' },
      });
      await expect(
        backend.controlSession({
          ...cancel,
          commandId: randomUUID(),
          action: 'pause',
        }),
      ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
      await expect(
        backend.controlSession({
          ...cancel,
          commandId: randomUUID(),
          action: 'resume',
        }),
      ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    });
  },
);

describe('failed candidates and queue limits', () => {
  it('rolls back state, receipts and facts when persistence fails', async () => {
    class FailingStorage extends MemoryStorageDriver {
      fail = false;
      override transaction<T>(
        id: string,
        owner: SessionOwner,
        work: (tx: SessionTransaction) => Promise<T>,
      ): Promise<T> {
        return super.transaction(id, owner, async (tx) => {
          const result = await work(tx);
          if (this.fail) throw new Error('injected commit failure');
          return result;
        });
      }
    }
    const store = new FailingStorage();
    const backend = host(store);
    const { route } = await start(backend);
    const before = await store.getHead(route.sessionId);
    const request = command(route);
    store.fail = true;
    await expect(backend.submitCommand(request)).rejects.toThrow(
      'injected commit failure',
    );
    expect(await store.getHead(route.sessionId)).toEqual(before);
    expect(
      await store.getReceipt(route.sessionId, request.commandId),
    ).toBeNull();
    expect(await store.readOutboxBatch({ limit: 100 })).toHaveLength(2);
    store.fail = false;
    expect((await backend.submitCommand(request)).receipt.status).toBe(
      'accepted',
    );
  });

  it('rejects mutating read-only queries without changing the stored candidate', async () => {
    const store = new MemoryStorageDriver();
    const altered = {
      ...sequentialTurnFixture,
      schemas: {
        ...sequentialTurnFixture.schemas,
        query: {
          name: 'mutation',
          version: 1,
          schema: { type: 'null' as const },
        },
      },
      rules: {
        ...sequentialTurnFixture.rules,
        query: (state: Readonly<{ target: number }>, _query: null) => {
          (state as { target: number }).target = 999;
          return null;
        },
      },
    };
    const backend = new GameHost({
      registry: new GameRegistry().register(altered),
      storage: store,
      backendBindingId: 'local',
      storageBindingId: 'test',
      authorize: async () => undefined,
    });
    const { route } = await start(backend);
    await expect(
      backend.queryOptions({ ...viewRequest(route), revision: 1, query: null }),
    ).rejects.toMatchObject({ envelope: { code: 'INTERNAL' } });
    expect(
      (await backend.getPlayerView(viewRequest(route))).payload,
    ).toMatchObject({ target: 2 });
  });

  it('allows read-only queries on retained terminal state but not purged tombstones', async () => {
    let queried = 0;
    const queryable = {
      ...sequentialTurnFixture,
      gameId: 'fixture-terminal-query',
      releaseId: 'fixture-terminal-query-v1',
      schemas: {
        ...sequentialTurnFixture.schemas,
        query: {
          name: 'fixture.terminal.query',
          version: 1,
          schema: { type: 'null' as const },
        },
      },
      rules: {
        ...sequentialTurnFixture.rules,
        query: (state: Readonly<{ target: number }>, _query: null) => {
          queried += 1;
          return { target: state.target };
        },
      },
    };
    const store = new MemoryStorageDriver();
    const backend = new GameHost({
      registry: new GameRegistry().register(queryable),
      storage: store,
      backendBindingId: 'local',
      storageBindingId: 'test',
      authorize: async () => undefined,
      now: () => 100,
    });
    const base = createRequest();
    const request = {
      ...base,
      route: {
        ...base.route,
        gameId: queryable.gameId,
        releaseId: queryable.releaseId,
      },
      setup: { target: 1 },
    } satisfies CreateSessionRequest;
    await backend.createSession(request);
    await backend.activateSession({
      ...viewRequest(request.route),
      startId: request.startId,
    });
    const accepted = await backend.submitCommand({
      ...command(request.route),
      command: { type: 'claim' },
    });
    expect(accepted.receipt.status).toBe('accepted');
    expect((await store.getHead(request.route.sessionId))?.status).toBe(
      'completed',
    );
    await expect(
      backend.queryOptions({
        ...viewRequest(request.route),
        revision: accepted.receipt.persistedRevision ?? -1,
        query: null,
      }),
    ).resolves.toMatchObject({ answer: { target: 1 } });
    expect(queried).toBe(1);

    await store.clearTerminalSession(request.route.sessionId);
    await expect(
      backend.queryOptions({
        ...viewRequest(request.route),
        revision: accepted.receipt.persistedRevision ?? -1,
        query: null,
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'SESSION_CLOSED',
        messageKey: 'host.result.notRetained',
      },
    });
    expect(queried).toBe(1);
  });

  it('bounds per-session queues, releases rejected work and drains without new work', async () => {
    const queue = new SessionQueue(1, 1);
    let release!: () => void;
    const pending = queue.run(
      'a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    await expect(queue.run('a', async () => undefined)).rejects.toMatchObject({
      envelope: { code: 'RATE_LIMITED' },
    });
    await expect(queue.run('b', async () => undefined)).rejects.toMatchObject({
      envelope: { code: 'RATE_LIMITED' },
    });
    release();
    await pending;
    await expect(
      queue.run('b', async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
    await queue.drain();
    await expect(queue.run('b', async () => undefined)).rejects.toMatchObject({
      envelope: { code: 'NOT_READY' },
    });
  });
});
