import {
  type AccessContext,
  type CreateSessionRequest,
  type SessionRoute,
} from '@board-game/contracts';
import {
  defineAutomationPolicy,
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

type SystemCommand = { readonly type: 'tick' };

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
  gameId: 'fixture-scheduler-system',
  releaseId: 'fixture-scheduler-system-v1',
  schemas: {
    ...sequentialTurnFixture.schemas,
    systemCommand: {
      name: 'fixture.scheduler.system-command',
      version: 1,
      schema: {
        type: 'object',
        properties: { type: { type: 'string', enum: ['tick'] } },
        required: ['type'],
        additionalProperties: false,
      },
    },
  },
  executeSystem: (
    state,
    command,
  ): Transition<SequentialTurnState, SequentialTurnEvent> => {
    if (command.type !== 'tick')
      return {
        ok: false,
        error: { code: 'INVALID', messageKey: 'test.system.invalid' },
      };
    return {
      ok: true,
      state: { ...state, turnIndex: state.turnIndex + 1 },
      events: [],
    };
  },
  systemSchedule: (state) => ({
    deadlineId: `system:${state.turnIndex}`,
    dueAt: 0,
    command: { type: 'tick' },
  }),
});

const owner: AccessContext = {
  principalId: 'owner',
  authEpoch: 'auth-owner',
  scopes: ['session:create', 'session:view', 'session:system'],
};

function route(
  module: typeof systemModule | typeof sequentialTurnFixture,
  sessionId: string,
): SessionRoute {
  return {
    gameId: module.gameId,
    modeId: 'sequential',
    sessionId,
    releaseId: module.releaseId,
    backendBindingId: 'scheduler-backend',
    storageBindingId: 'scheduler-storage',
    ownershipEpoch: 'scheduler-owner',
  };
}

async function start(
  host: GameHost,
  module: typeof systemModule | typeof sequentialTurnFixture,
  sessionId: string,
  participants: CreateSessionRequest['participants'],
): Promise<SessionRoute> {
  const sessionRoute = route(module, sessionId);
  const request: CreateSessionRequest = {
    protocolVersion: 1,
    accessContext: owner,
    route: sessionRoute,
    startId: `start-${sessionId}`,
    startGeneration: 0,
    participants,
    setup: { target: 2 },
    seed: `seed-${sessionId}`,
  };
  await host.createSession(request);
  await host.activateSession({
    protocolVersion: 1,
    accessContext: owner,
    route: sessionRoute,
    startId: request.startId,
  });
  return sessionRoute;
}

describe('Host scheduler partitions', () => {
  it('lets a system scan advance another session while automation is slow', async () => {
    const storage = new MemoryStorageDriver();
    let now = 100;
    let policyStarted = false;
    const slowPolicy = defineAutomationPolicy({
      id: 'slow-policy',
      kind: 'ai',
      label: 'Slow policy',
      timeoutMs: 200,
      decide: (): Promise<never> => {
        policyStarted = true;
        return new Promise<never>(() => undefined);
      },
    });
    const automationModule = defineGame({
      ...sequentialTurnFixture,
      gameId: 'fixture-scheduler-automation',
      releaseId: 'fixture-scheduler-automation-v1',
      turn: (state: Readonly<SequentialTurnState>) => ({
        id: `turn-${state.turnIndex}`,
        mode: 'sequential' as const,
        activeSeatIds: [state.activeSeatId],
      }),
    });
    const host = new GameHost({
      registry: new GameRegistry()
        .register(automationModule)
        .register(systemModule),
      storage,
      backendBindingId: 'scheduler-backend',
      storageBindingId: 'scheduler-storage',
      automationPolicies: [slowPolicy],
      authorize: async () => undefined,
      now: () => now,
    });
    const automationRoute = await start(
      host,
      automationModule,
      'slow-automation',
      [
        {
          principalId: 'ai-seat',
          seatId: 'seat-1',
          controller: 'ai',
          controllerId: 'slow-policy',
        },
        { principalId: 'human-seat', seatId: 'seat-2' },
      ],
    );
    const systemRoute = await start(host, systemModule, 'system-peer', [
      { principalId: 'system-owner', seatId: 'seat-1' },
      { principalId: 'system-peer', seatId: 'seat-2' },
    ]);
    now = 200;

    const automationTick = host.tickSystemCommands(async () => owner, 100, {
      kind: 'automation',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(policyStarted).toBe(true);

    const systemTick = await host.tickSystemCommands(async () => owner, 100, {
      kind: 'system',
    });
    expect(systemTick).toMatchObject([
      {
        kind: 'system',
        sessionId: systemRoute.sessionId,
        status: 'accepted',
      },
    ]);
    expect((await storage.getHead(systemRoute.sessionId))?.revision).toBe(2);
    expect((await storage.getHead(automationRoute.sessionId))?.revision).toBe(
      1,
    );

    const automationResult = await automationTick;
    expect(automationResult).toMatchObject([
      {
        kind: 'automation',
        sessionId: automationRoute.sessionId,
        status: 'rejected',
        receipt: {
          error: { messageKey: 'host.automation.timeout' },
        },
      },
    ]);
  });
});
