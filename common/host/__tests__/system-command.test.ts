import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type AccessContext,
  type Actor,
  type CreateSessionRequest,
  type SessionRoute,
} from '@board-game/contracts';
import { defineGame, type GameModule, type Transition } from '@board-game/sdk';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import {
  type SequentialTurnCommand,
  type SequentialTurnEvent,
  type SequentialTurnSetup,
  type SequentialTurnState,
  type SequentialTurnView,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

type SystemCommand = { readonly type: 'timeout' };

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;

const player: AccessContext = {
  principalId: 'alice',
  authEpoch: 'auth-1',
  scopes: [
    'session:create',
    'session:command',
    'session:view',
    'session:control',
  ],
};
const service: AccessContext = {
  principalId: 'scheduler',
  authEpoch: 'service-1',
  scopes: ['session:view', 'session:system'],
};

const systemModule: Readonly<
  GameModule<
    SequentialTurnState,
    SequentialTurnSetup,
    SequentialTurnCommand,
    SequentialTurnView,
    SequentialTurnEvent,
    null,
    null,
    SystemCommand
  >
> = defineGame({
  ...sequentialTurnFixture,
  releaseId: 'fixture-sequential-turn-system-v1',
  schemas: {
    ...sequentialTurnFixture.schemas,
    systemCommand: {
      name: 'fixture.system-command',
      version: 1,
      schema: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['timeout'] } },
        required: ['type'],
        additionalProperties: false,
      },
    },
  },
  executeSystem: (
    state,
    command,
    context,
  ): Transition<SequentialTurnState, SequentialTurnEvent> => {
    if (command.type !== 'timeout')
      return {
        ok: false,
        error: { code: 'INVALID', messageKey: 'test.system.invalid' },
      };
    return {
      ok: true,
      state: {
        ...state,
        turnIndex: state.turnIndex + 1,
      },
      events: [],
      publicParticipants: context.participants.map((participant) =>
        participant.principalId === 'alice'
          ? {
              ...participant,
              publicProfile: { displayName: 'Alice refreshed' },
            }
          : participant,
      ),
    };
  },
  systemSchedule: (state) =>
    state.finished
      ? null
      : {
          deadlineId: `turn-${state.turnIndex}`,
          dueAt: 1,
          command: { type: 'timeout' },
        },
});

function route(
  sessionId: string,
  module: typeof systemModule = systemModule,
): SessionRoute {
  return {
    gameId: module.gameId,
    modeId: 'sequential',
    sessionId,
    releaseId: module.releaseId,
    backendBindingId: 'system-test-backend',
    storageBindingId: 'system-test-storage',
    ownershipEpoch: 'owner-1',
  };
}

function createRequest(
  sessionId: string,
  module: typeof systemModule = systemModule,
  includeBot = false,
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: player,
    route: route(sessionId, module),
    startId: `start-${sessionId}`,
    startGeneration: 0,
    participants: [
      { principalId: 'alice', seatId: 'seat-1' },
      {
        principalId: 'bob',
        seatId: 'seat-2',
        ...(includeBot ? { controller: 'bot' as const } : {}),
      },
    ],
    setup: { target: 4 },
    seed: 'system-test-seed',
  };
}

function host(
  storage: StorageDriver,
  module: typeof systemModule = systemModule,
): GameHost {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'system-test-backend',
    storageBindingId: 'system-test-storage',
    authorize: async () => undefined,
    now: () => 100,
  });
}

async function start(
  backend: GameHost,
  sessionId: string,
  module: typeof systemModule = systemModule,
  includeBot = false,
) {
  const request = createRequest(sessionId, module, includeBot);
  await backend.createSession(request);
  await backend.activateSession({
    protocolVersion: 1,
    accessContext: player,
    route: request.route,
    startId: request.startId,
  });
  return request;
}

describe('authenticated system commands', () => {
  it('persists schedules and executes through the normal receipt transaction', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage);
    const request = await start(backend, 'system-session-1');
    const before = await storage.getHead(request.route.sessionId);
    expect(before?.deadline).toEqual({ deadlineId: 'turn-0', dueAt: 1 });

    const results = await backend.tickSystemCommands(async () => service);
    expect(results[0]).toMatchObject({
      status: 'accepted',
      deadlineId: 'turn-0',
    });
    expect((await storage.getHead(request.route.sessionId))?.revision).toBe(2);
    expect(
      (await storage.getHead(request.route.sessionId))?.participants[0],
    ).toMatchObject({
      principalId: 'alice',
      seatId: 'seat-1',
      publicProfile: { displayName: 'Alice refreshed' },
    });
    const outbox = await storage.readOutboxBatch({
      sessionId: request.route.sessionId,
      limit: 10,
    });
    expect(
      outbox.find((message) => message.kind === 'SessionSummaryChanged')
        ?.payload,
    ).toMatchObject({
      participants: expect.arrayContaining([
        expect.objectContaining({
          principalId: 'alice',
          publicProfile: { displayName: 'Alice refreshed' },
        }),
      ]),
    });
    expect(
      await storage.getReceipt(
        request.route.sessionId,
        'system:system-session-1:deadline:turn-0',
      ),
    ).toMatchObject({ status: 'accepted', actorPrincipalId: 'scheduler' });
  });

  it('preserves bot controller metadata through Host create and system transitions', async () => {
    const observedActors: Actor[] = [];
    const observingModule = defineGame({
      ...systemModule,
      gameId: 'fixture-sequential-turn-system-controller-preserved',
      releaseId: 'fixture-sequential-turn-system-controller-preserved-v1',
      rules: {
        ...systemModule.rules,
        create: (
          setup: Parameters<typeof systemModule.rules.create>[0],
          context: Parameters<typeof systemModule.rules.create>[1],
        ) => {
          observedActors.push(...context.participants);
          return systemModule.rules.create(setup, context);
        },
      },
    });
    const storage = new MemoryStorageDriver();
    const backend = host(storage, observingModule);
    const request = await start(
      backend,
      'system-session-controller',
      observingModule,
      true,
    );
    expect(observedActors[1]).toMatchObject({
      principalId: 'bob',
      kind: 'player',
      controller: 'bot',
    });
    const created = await storage.getHead(request.route.sessionId);
    expect(created?.participants[1]).toMatchObject({
      principalId: 'bob',
      controller: 'bot',
    });

    await backend.tickSystemCommands(async () => service);
    const transitioned = await storage.getHead(request.route.sessionId);
    expect(transitioned?.participants[1]).toMatchObject({
      principalId: 'bob',
      controller: 'bot',
    });
  });

  it('rejects a system roster transition that changes a bot controller', async () => {
    const changingModule = defineGame({
      ...systemModule,
      gameId: 'fixture-sequential-turn-system-controller-change',
      releaseId: 'fixture-sequential-turn-system-controller-change-v1',
      executeSystem: (state, _command, context) => ({
        ok: true as const,
        state: { ...state, turnIndex: state.turnIndex + 1 },
        events: [],
        publicParticipants: context.participants.map((participant) =>
          participant.principalId === 'bob'
            ? { ...participant, controller: 'human' as const }
            : participant,
        ),
      }),
    });
    const storage = new MemoryStorageDriver();
    const backend = host(storage, changingModule);
    const request = await start(
      backend,
      'system-session-controller-change',
      changingModule,
      true,
    );

    await expect(
      backend.submitSystemCommand({
        protocolVersion: 1,
        accessContext: service,
        route: request.route,
        commandId: 'controller-change',
        expectedRevision: 1,
        deadlineId: 'turn-0',
        command: { type: 'timeout' },
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'host.system.participant_identity_changed',
      },
    });
    expect((await storage.getHead(request.route.sessionId))?.revision).toBe(1);
  });

  it('makes concurrent scans idempotent and leaves a rejected deadline authoritative', async () => {
    const storage = new MemoryStorageDriver();
    const first = host(storage);
    const second = host(storage);
    const request = await start(first, 'system-session-2');
    const [a, b] = await Promise.all([
      first.tickSystemCommands(async () => service),
      second.tickSystemCommands(async () => service),
    ]);
    expect(
      [...a, ...b].filter((result) => result.status === 'accepted'),
    ).toHaveLength(1);
    expect((await storage.getHead(request.route.sessionId))?.revision).toBe(2);
    expect(
      await storage.readEvents(request.route.sessionId, { limit: 20 }),
    ).toHaveLength(0);
  });

  it('rejects pause while an active schedule has no control-time semantics', async () => {
    const storage = new MemoryStorageDriver();
    const backend = host(storage);
    const request = await start(backend, 'system-session-3');
    await expect(
      backend.controlSession({
        protocolVersion: 1,
        accessContext: player,
        route: request.route,
        commandId: 'pause-with-deadline',
        expectedRevision: 1,
        action: 'pause',
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'NOT_READY',
        messageKey: 'host.control.timerSemanticsUnavailable',
      },
    });
    expect((await storage.getHead(request.route.sessionId))?.status).toBe(
      'active',
    );
  });

  it('rejects a schedule hook that mutates its isolated candidate', async () => {
    let scheduleCalls = 0;
    const mutatingModule = defineGame({
      ...systemModule,
      gameId: 'fixture-sequential-turn-system-mutation',
      releaseId: 'fixture-sequential-turn-system-mutation-v1',
      systemSchedule: (state) => {
        scheduleCalls += 1;
        if (scheduleCalls === 3) (state as { target: number }).target = 999;
        return state.finished
          ? null
          : {
              deadlineId: `turn-${state.turnIndex}`,
              dueAt: 1,
              command: { type: 'timeout' as const },
            };
      },
    });
    const storage = new MemoryStorageDriver();
    const backend = host(storage, mutatingModule);
    const request = await start(
      backend,
      'system-session-schedule-mutation',
      mutatingModule,
    );
    const before = await storage.getHead(request.route.sessionId);

    await expect(
      backend.submitCommand({
        protocolVersion: 1,
        accessContext: player,
        route: request.route,
        commandId: 'schedule-mutation-command',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: { type: 'claim' },
      }),
    ).rejects.toMatchObject({
      envelope: {
        code: 'INTERNAL',
        messageKey: 'host.systemSchedule.mutatedState',
      },
    });
    expect(scheduleCalls).toBe(3);
    expect(await storage.getHead(request.route.sessionId)).toEqual(before);
  });

  it('rejects a system deadline in the platform automation namespace', async () => {
    const reservedModule = defineGame({
      ...systemModule,
      gameId: 'fixture-sequential-turn-system-reserved-deadline',
      releaseId: 'fixture-sequential-turn-system-reserved-deadline-v1',
      systemSchedule: (state) =>
        state.finished
          ? null
          : {
              deadlineId: 'automation:game-owned',
              dueAt: 1,
              command: { type: 'timeout' as const },
            },
    });
    const storage = new MemoryStorageDriver();
    const backend = host(storage, reservedModule);
    const request = createRequest(
      'system-session-reserved-deadline',
      reservedModule,
    );

    await expect(backend.createSession(request)).rejects.toMatchObject({
      envelope: {
        code: 'INVALID_REQUEST',
        messageKey: 'host.systemSchedule.invalid',
      },
    });
    expect(await storage.getHead(request.route.sessionId)).toBeNull();
  });
});

describe.skipIf(!databaseUrl)(
  'Postgres transaction authorization context',
  () => {
    it('lets an in-transaction authorization query use a max-one pool', async () => {
      if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
      const schema = `system_auth_${process.pid}`;
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const context = new AsyncLocalStorage<PoolClient>();
      const storage = new PostgresStorageDriver({
        pool,
        schema,
        runInTransactionContext: (client, callback) =>
          context.run(client, callback),
      });
      let inTransactionAuthorizations = 0;
      const backend = new GameHost({
        registry: new GameRegistry().register(systemModule),
        storage,
        backendBindingId: 'system-test-backend',
        storageBindingId: 'system-test-storage',
        authorize: async () => {
          const client = context.getStore();
          if (!client) return;
          await client.query('SELECT 1');
          inTransactionAuthorizations += 1;
        },
        now: () => 100,
      });
      try {
        await storage.migrate();
        await start(backend, 'system-postgres-auth');
        await backend.tickSystemCommands(async () => service);
        expect(inTransactionAuthorizations).toBeGreaterThan(0);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    });
  },
);
