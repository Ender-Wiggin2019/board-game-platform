import {
  type AccessContext,
  type CreateSessionRequest,
  type JsonValue,
  type SessionRoute,
} from '@board-game/contracts';
import {
  defineDeveloperConsole,
  defineGame,
  type GameModule,
  type Transition,
} from '@board-game/sdk';
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

const player: AccessContext = {
  principalId: 'alice',
  authEpoch: 'player-1',
  scopes: ['session:create', 'session:command', 'session:view'],
};
const scheduler: AccessContext = {
  principalId: 'scheduler',
  authEpoch: 'scheduler-1',
  scopes: ['session:system'],
};
const operator: AccessContext = {
  principalId: 'operator',
  authEpoch: 'operator-1',
  scopes: ['session:admin', 'session:developer'],
};

const inputSchema = {
  name: 'developer.boost.input',
  version: 1,
  schema: {
    type: 'object' as const,
    properties: { amount: { type: 'integer' as const, minimum: 1 } },
    required: ['amount'],
    additionalProperties: false,
  },
  privateMetadata: 'must-not-be-exposed',
};

type DeveloperModule = GameModule<
  SequentialTurnState,
  SequentialTurnSetup,
  SequentialTurnCommand,
  SequentialTurnView,
  SequentialTurnEvent,
  null,
  null
>;

function moduleWithDeveloperConsole(
  options: { readonly disabledMode?: boolean } = {},
): Readonly<DeveloperModule> {
  const developer = defineDeveloperConsole({
    commands: [
      {
        name: 'boost',
        label: 'Boost turn index',
        description: 'Increase the diagnostic turn index.',
        inputSchema,
        execute: (
          state,
          command,
          _context,
        ): Transition<SequentialTurnState, SequentialTurnEvent> => {
          const input = command.input as { readonly amount: number };
          return {
            ok: true,
            state: { ...state, turnIndex: state.turnIndex + input.amount },
            events: [
              {
                type: 'turn-claimed',
                seatId: state.activeSeatId,
                score: input.amount,
              },
            ],
          };
        },
      },
    ],
    isModeEnabled: (modeId) =>
      options.disabledMode && modeId === 'disabled'
        ? { enabled: false, reason: 'test.developer.disabled' }
        : true,
  });
  return defineGame({
    ...sequentialTurnFixture,
    gameId: 'fixture-developer-console',
    releaseId: 'fixture-developer-console-v1',
    modes: [
      ...sequentialTurnFixture.modes,
      {
        ...sequentialTurnFixture.modes[0],
        id: 'disabled',
        platformRating: false,
      },
    ],
    developerConsole: developer,
  });
}

function route(module: DeveloperModule, modeId = 'sequential'): SessionRoute {
  return {
    gameId: module.gameId,
    modeId,
    sessionId: `developer-${modeId}`,
    releaseId: module.releaseId,
    backendBindingId: 'developer-backend',
    storageBindingId: 'developer-storage',
    ownershipEpoch: 'owner-1',
  };
}

function request(
  module: DeveloperModule,
  modeId = 'sequential',
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: player,
    route: route(module, modeId),
    startId: `start-${modeId}`,
    startGeneration: 0,
    participants: [
      { principalId: 'alice', seatId: 'seat-1' },
      { principalId: 'bob', seatId: 'seat-2' },
    ],
    setup: { target: 20 },
    seed: 'developer-seed',
  };
}

async function start(
  host: GameHost,
  module: DeveloperModule,
  modeId = 'sequential',
) {
  const value = request(module, modeId);
  await host.createSession(value);
  await host.activateSession({
    protocolVersion: 1,
    accessContext: player,
    route: value.route,
    startId: value.startId,
  });
  return value;
}

function host(
  module: DeveloperModule,
  storage = new MemoryStorageDriver(),
  authorize: (
    context: AccessContext,
    operation: string,
  ) => Promise<void> = async (context, operation) => {
    if (
      operation === 'developer-console' &&
      context.principalId !== operator.principalId
    )
      throw new Error('operator required');
  },
) {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'developer-backend',
    storageBindingId: 'developer-storage',
    authorize,
    now: () => 100,
  });
}

function catalogRequest(route: SessionRoute, accessContext = operator) {
  return { protocolVersion: 1 as const, route, accessContext };
}

function commandRequest(
  route: SessionRoute,
  commandId: string,
  expectedRevision: number,
  input: JsonValue,
  accessContext = operator,
) {
  return {
    protocolVersion: 1 as const,
    route,
    accessContext,
    commandId,
    expectedRevision,
    command: { name: 'boost', input },
  };
}

describe('Host developer console', () => {
  it('returns only catalog metadata and the authoritative head revision', async () => {
    const module = moduleWithDeveloperConsole();
    const backend = host(module);
    const session = await start(backend, module);

    await expect(
      backend.getDeveloperConsole?.(catalogRequest(session.route)),
    ).resolves.toEqual({
      catalog: [
        expect.objectContaining({
          name: 'boost',
          label: 'Boost turn index',
          inputSchema: expect.objectContaining({
            name: inputSchema.name,
            version: inputSchema.version,
            schema: inputSchema.schema,
          }),
        }),
      ],
      enabled: true,
      revision: 1,
    });
    expect(
      (await backend.getDeveloperConsole?.(catalogRequest(session.route)))
        ?.catalog[0]?.inputSchema,
    ).not.toHaveProperty('privateMetadata');
  });

  it('requires both developer scopes and rejects player or scheduler contexts', async () => {
    const module = moduleWithDeveloperConsole();
    const backend = host(module);
    const session = await start(backend, module);

    await expect(
      backend.getDeveloperConsole?.(catalogRequest(session.route, player)),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      backend.submitDeveloperCommand?.(
        commandRequest(
          session.route,
          'scheduler-command',
          1,
          { amount: 1 },
          scheduler,
        ),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });

  it('rechecks operator authorization inside the transaction', async () => {
    const module = moduleWithDeveloperConsole();
    let calls = 0;
    const backend = host(
      module,
      new MemoryStorageDriver(),
      async (_context, operation) => {
        if (operation === 'developer-console') calls += 1;
      },
    );
    const session = await start(backend, module);
    await backend.submitDeveloperCommand?.(
      commandRequest(session.route, 'operator-command', 1, { amount: 1 }),
    );
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('uses schema and revision checks before executing the plugin', async () => {
    const module = moduleWithDeveloperConsole();
    const backend = host(module);
    const session = await start(backend, module);
    const before = await backend.getDeveloperConsole?.(
      catalogRequest(session.route),
    );

    await expect(
      backend.submitDeveloperCommand?.(
        commandRequest(session.route, 'invalid-input', 1, { amount: 0 }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'SCHEMA_VALIDATION_FAILED' } });
    await expect(
      backend.submitDeveloperCommand?.(
        commandRequest(session.route, 'stale', 0, { amount: 1 }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'STALE_REVISION' } });
    expect(
      (await backend.getDeveloperConsole?.(catalogRequest(session.route)))
        ?.revision,
    ).toBe(before?.revision);
  });

  it('commits developer transitions atomically and preserves receipt idempotency', async () => {
    const module = moduleWithDeveloperConsole();
    const storage = new MemoryStorageDriver();
    const backend = host(module, storage);
    const session = await start(backend, module);
    const command = commandRequest(session.route, 'boost-1', 1, { amount: 3 });
    const accepted = await backend.submitDeveloperCommand?.(command);
    expect(accepted).toMatchObject({
      receipt: { status: 'accepted', persistedRevision: 2 },
      revision: 2,
    });
    expect((await storage.getHead(session.route.sessionId))?.revision).toBe(2);
    expect(
      (await storage.readEvents(session.route.sessionId, { limit: 10 })).map(
        (event) => event.payload,
      ),
    ).toEqual([{ type: 'turn-claimed', seatId: 'seat-1', score: 3 }]);

    await expect(
      backend.submitDeveloperCommand?.(command),
    ).resolves.toMatchObject({ receipt: { status: 'duplicate' }, revision: 2 });
    await expect(
      backend.submitDeveloperCommand?.({
        ...command,
        command: { name: 'boost', input: { amount: 4 } },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect((await storage.getHead(session.route.sessionId))?.revision).toBe(2);
  });

  it('fails closed when a release has no plugin or the mode policy disables it', async () => {
    const noPlugin = sequentialTurnFixture as DeveloperModule;
    const noPluginHost = host(noPlugin);
    const noPluginSession = await start(noPluginHost, noPlugin);
    await expect(
      noPluginHost.getDeveloperConsole?.(catalogRequest(noPluginSession.route)),
    ).resolves.toMatchObject({
      catalog: [],
      enabled: false,
      reason: 'host.developerConsole.unavailable',
      revision: 1,
    });
    await expect(
      noPluginHost.submitDeveloperCommand?.(
        commandRequest(noPluginSession.route, 'missing', 1, { amount: 1 }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'NOT_READY' } });

    const disabled = moduleWithDeveloperConsole({ disabledMode: true });
    const disabledHost = host(disabled);
    const disabledSession = await start(disabledHost, disabled, 'disabled');
    await expect(
      disabledHost.getDeveloperConsole?.(catalogRequest(disabledSession.route)),
    ).resolves.toMatchObject({
      enabled: false,
      reason: 'test.developer.disabled',
      revision: 1,
    });
    await expect(
      disabledHost.submitDeveloperCommand?.(
        commandRequest(disabledSession.route, 'disabled', 1, { amount: 1 }),
      ),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });
});
