import {
  type AccessContext,
  type CreateSessionRequest,
  contractError,
  type SessionRoute,
} from '@board-game/contracts';
import {
  type AutomationDecisionInput,
  defineAutomationPolicy,
  defineGame,
} from '@board-game/sdk';
import {
  AUTOMATION_TRACE_MAX_AGE_MS,
  MemoryStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import {
  type SequentialTurnState,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import { GameHost, GameRegistry } from '../src/index.js';

const owner: AccessContext = {
  principalId: 'owner',
  authEpoch: 'auth-owner',
  scopes: [
    'session:create',
    'session:command',
    'session:view',
    'session:system',
  ],
};

const automationModule = defineGame({
  ...sequentialTurnFixture,
  gameId: 'fixture-automation',
  releaseId: 'fixture-automation-v1',
  turn: (state: Readonly<SequentialTurnState>) => ({
    id: `turn-${state.turnIndex}`,
    mode: 'sequential' as const,
    activeSeatIds: [state.activeSeatId],
  }),
  projectAutomationView: (_state, viewer) => ({
    seatId: viewer.seatId ?? null,
  }),
});

const rejectedAutomationModule = defineGame({
  ...automationModule,
  gameId: 'fixture-automation-rejected',
  releaseId: 'fixture-automation-rejected-v1',
  rules: {
    ...automationModule.rules,
    execute: () => ({
      ok: false as const,
      error: {
        code: 'AUTOMATION_REJECTED',
        messageKey: 'fixture.automation.rejected',
      },
    }),
  },
});

function route(
  sessionId: string,
  module: typeof automationModule = automationModule,
): SessionRoute {
  return {
    gameId: module.gameId,
    modeId: 'sequential',
    sessionId,
    releaseId: module.releaseId,
    backendBindingId: 'automation-backend',
    storageBindingId: 'automation-storage',
    ownershipEpoch: 'owner-1',
  };
}

function request(
  sessionId: string,
  module: typeof automationModule = automationModule,
): CreateSessionRequest {
  return {
    protocolVersion: 1,
    accessContext: owner,
    route: route(sessionId, module),
    startId: `start-${sessionId}`,
    startGeneration: 0,
    participants: [
      {
        principalId: 'ai-seat',
        seatId: 'seat-1',
        controller: 'ai',
        controllerId: 'claim-policy',
      },
      { principalId: 'human-seat', seatId: 'seat-2' },
    ],
    setup: { target: 2 },
    seed: 'automation-seed',
  };
}

function host(
  storage: StorageDriver,
  policy: ReturnType<typeof defineAutomationPolicy>,
  now: () => number,
  module: typeof automationModule = automationModule,
): GameHost {
  return new GameHost({
    registry: new GameRegistry().register(module),
    storage,
    backendBindingId: 'automation-backend',
    storageBindingId: 'automation-storage',
    automationPolicies: [policy],
    authorize: async () => undefined,
    now,
  });
}

async function start(
  backend: GameHost,
  sessionId: string,
  module: typeof automationModule = automationModule,
) {
  const input = request(sessionId, module);
  await backend.createSession(input);
  await backend.activateSession({
    protocolVersion: 1,
    accessContext: owner,
    route: input.route,
    startId: input.startId,
  });
  return input;
}

describe('Host automation and hotseat authorization', () => {
  it('runs a policy from a safe view and commits through rules.execute', async () => {
    const storage = new MemoryStorageDriver();
    const seen: AutomationDecisionInput[] = [];
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Claim one point',
      timeoutMs: 100,
      decide: (input) => {
        seen.push(input);
        return { type: 'claim' };
      },
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-session');
    const initial = await storage.getHead(input.route.sessionId);
    expect(initial?.deadline?.deadlineId).toMatch(/^automation:/);
    const initialView = await backend.getPlayerView({
      protocolVersion: 1,
      accessContext: {
        ...owner,
        principalId: 'human-seat',
        seatId: 'seat-2',
      },
      route: input.route,
    });
    expect(initialView.turn).toEqual({
      id: 'turn-0',
      mode: 'sequential',
      activeSeatIds: ['seat-1'],
    });
    expect(initialView.actingSeatId).toBe('seat-2');
    now = 200;

    expect(
      await backend.tickSystemCommands(async () => owner, 100, {
        kind: 'system',
      }),
    ).toEqual([]);
    const results = await backend.tickSystemCommands(async () => owner, 100, {
      kind: 'automation',
    });
    expect(results[0]).toMatchObject({
      kind: 'automation',
      status: 'accepted',
      deadlineId: initial?.deadline?.deadlineId,
    });
    expect(seen[0]).toMatchObject({
      view: { seatId: 'seat-1' },
      actor: {
        principalId: 'ai-seat',
        seatId: 'seat-1',
        controller: 'ai',
        controllerId: 'claim-policy',
      },
      turn: { id: 'turn-0', activeSeatIds: ['seat-1'] },
    });
    expect(seen[0]?.turn).toEqual({
      id: 'turn-0',
      mode: 'sequential',
      activeSeatIds: ['seat-1'],
    });
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(2);
    expect(
      (await storage.getHead(input.route.sessionId))?.summary,
    ).toMatchObject({ scores: { 'seat-1': 1 } });
    await storage.transaction(
      input.route.sessionId,
      { ownershipEpoch: input.route.ownershipEpoch },
      async (tx) =>
        expect(
          await tx.getAutomationDecision(
            initial?.deadline?.deadlineId?.replace(/^automation:/, '') ?? '',
          ),
        ).toBeNull(),
    );

    const view = await backend.getPlayerView({
      protocolVersion: 1,
      accessContext: {
        ...owner,
        principalId: 'human-seat',
      },
      route: input.route,
    });
    expect(view.turn).toMatchObject({
      id: 'turn-1',
      mode: 'sequential',
      activeSeatIds: ['seat-2'],
    });
    expect(view.actionPrecondition).toEqual({
      kind: 'revision',
      expectedRevision: 2,
    });
  });

  it('retains a bounded private trace and dry-runs the current policy', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      version: 'trace-v1',
      kind: 'ai',
      label: 'Traceable choice',
      timeoutMs: 100,
      decide: () => ({
        kind: 'automation-decision',
        command: { type: 'claim' },
        diagnostics: { nodes: 3 },
      }),
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-trace');
    now = 200;
    await backend.tickSystemCommands(async () => owner, 100, {
      kind: 'automation',
    });

    const traces = await backend.readAutomationTraces({
      route: input.route,
      accessContext: { ...owner, scopes: [...owner.scopes, 'session:admin'] },
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      policyId: 'claim-policy',
      policyVersion: 'trace-v1',
      outcome: 'executed',
      input: { actor: { controller: 'ai' } },
      diagnostics: { nodes: 3 },
    });

    const replay = await backend.replayAutomationDecision({
      route: input.route,
      accessContext: { ...owner, scopes: [...owner.scopes, 'session:admin'] },
      traceId: traces[0]?.traceId ?? '',
    });
    expect(replay).toMatchObject({
      policyId: 'claim-policy',
      policyVersion: 'trace-v1',
      command: { type: 'claim' },
      diagnostics: { nodes: 3 },
      legal: true,
    });
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(2);
    const events = await backend.getEvents({
      protocolVersion: 1,
      accessContext: { ...owner, principalId: 'human-seat' },
      route: input.route,
      afterSequence: 0,
      limit: 20,
    });
    expect(events.events[0]?.source).toEqual({
      kind: 'ai',
      seatId: 'seat-1',
      traceId: traces[0]?.traceId,
    });
  });

  it('captures a committed human command and dry-runs its exact checkpoint', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Traceable choice',
      timeoutMs: 100,
      decide: () => ({ type: 'claim' }),
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'command-trace');
    now = 200;
    await backend.tickSystemCommands(async () => owner, 100, {
      kind: 'automation',
    });
    const command = await backend.submitCommand({
      protocolVersion: 1,
      accessContext: {
        ...owner,
        principalId: 'human-seat',
        seatId: 'seat-2',
      },
      route: input.route,
      commandId: 'human-command-1',
      precondition: { kind: 'revision', expectedRevision: 2 },
      command: { type: 'claim' },
    });
    expect(command.receipt.status).toBe('accepted');
    const traces = await backend.readAutomationTraces({
      route: input.route,
      accessContext: { ...owner, scopes: [...owner.scopes, 'session:admin'] },
      kind: 'command',
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      kind: 'command',
      commandId: 'human-command-1',
      expectedRevision: 2,
      input: { actor: { principalId: 'human-seat', seatId: 'seat-2' } },
      eventSequenceStart: 2,
      eventSequenceCount: 1,
    });
    const replay = await backend.replayAutomationDecision({
      route: input.route,
      accessContext: { ...owner, scopes: [...owner.scopes, 'session:admin'] },
      traceId: traces[0]?.traceId ?? '',
    });
    expect(replay).toMatchObject({
      traceKind: 'command',
      command: { type: 'claim' },
      legal: true,
    });
    const events = await backend.getEvents({
      protocolVersion: 1,
      accessContext: { ...owner, principalId: 'human-seat' },
      route: input.route,
      afterSequence: 1,
      limit: 20,
    });
    expect(events.events[0]?.source).toEqual({
      kind: 'human',
      traceId: traces[0]?.traceId,
    });
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(3);
    const snapshot = traces[0];
    if (!snapshot) throw new Error('command trace missing');
    now += AUTOMATION_TRACE_MAX_AGE_MS + 1;
    await expect(
      backend.readAutomationTraces({
        route: input.route,
        accessContext: { ...owner, scopes: [...owner.scopes, 'session:admin'] },
      }),
    ).resolves.toEqual([]);
    const evidenceReplay = await backend.replayAutomationTraceEvidence({
      route: input.route,
      accessContext: owner,
      trace: snapshot,
    });
    expect(evidenceReplay).toMatchObject({
      traceKind: 'command',
      command: { type: 'claim' },
      durationMs: 0,
      legal: true,
    });
  });

  it('retains a rejected automation receipt without rescanning its deadline', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Rejected choice',
      timeoutMs: 100,
      decide: () => ({ type: 'claim' }),
    });
    let now = 100;
    const backend = host(storage, policy, () => now, rejectedAutomationModule);
    const input = await start(
      backend,
      'automation-rejected',
      rejectedAutomationModule,
    );
    now = 200;
    const first = await backend.tickSystemCommands(async () => owner);
    expect(first[0]).toMatchObject({ status: 'rejected' });
    expect(first[0]?.receipt?.status).toBe('rejected');
    expect(
      (await storage.getHead(input.route.sessionId))?.deadline,
    ).toBeUndefined();
    expect(
      (await storage.getHead(input.route.sessionId))?.automationFailure,
    ).toEqual({
      seatId: 'seat-1',
      messageKey: 'fixture.automation.rejected',
    });
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(2);
    expect(
      await storage.readOutboxBatch({
        sessionId: input.route.sessionId,
        limit: 20,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'SessionSummaryChanged',
          aggregateSequence: 2,
        }),
      ]),
    );
    await expect(
      backend.getPlayerView({
        protocolVersion: 1,
        accessContext: { ...owner, principalId: 'human-seat' },
        route: input.route,
      }),
    ).resolves.toMatchObject({
      revision: 2,
      automationFailure: {
        seatId: 'seat-1',
        messageKey: 'fixture.automation.rejected',
      },
    });
    const second = await backend.tickSystemCommands(async () => owner);
    expect(second).toEqual([]);
  });

  it('records a policy timeout as a terminal rejection instead of retrying forever', async () => {
    const storage = new MemoryStorageDriver();
    let decisions = 0;
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Timed out choice',
      timeoutMs: 5,
      decide: () => {
        decisions += 1;
        return new Promise<never>(() => undefined);
      },
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-timeout');
    now = 200;

    const first = await backend.tickSystemCommands(async () => owner);
    expect(first[0]).toMatchObject({
      status: 'rejected',
      receipt: {
        status: 'rejected',
        error: {
          code: 'CONFLICT',
          messageKey: 'host.automation.timeout',
          retryable: false,
        },
      },
    });
    expect(decisions).toBe(1);
    expect(
      (await storage.getHead(input.route.sessionId))?.deadline,
    ).toBeUndefined();
    expect(
      (await storage.getHead(input.route.sessionId))?.automationFailure,
    ).toEqual({
      seatId: 'seat-1',
      messageKey: 'host.automation.timeout',
    });
    expect(
      await storage.readOutboxBatch({
        sessionId: input.route.sessionId,
        limit: 20,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'SessionSummaryChanged',
          aggregateSequence: 2,
        }),
      ]),
    );

    const second = await backend.tickSystemCommands(async () => owner);
    expect(second).toEqual([]);
    expect(decisions).toBe(1);
  });

  it('records worker failures as terminal safe diagnostics instead of retrying', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Failed worker choice',
      timeoutMs: 100,
      decide: () => {
        throw contractError(
          'NOT_READY',
          'server.automation.workerFailed',
          true,
        );
      },
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-worker-failure');
    now = 200;

    const first = await backend.tickSystemCommands(async () => owner);
    expect(first[0]).toMatchObject({
      status: 'rejected',
      receipt: {
        status: 'rejected',
        error: {
          code: 'NOT_READY',
          messageKey: 'server.automation.workerFailed',
          retryable: false,
        },
      },
    });
    expect(
      (await storage.getHead(input.route.sessionId))?.deadline,
    ).toBeUndefined();
    expect(
      (await storage.getHead(input.route.sessionId))?.automationFailure,
    ).toEqual({
      seatId: 'seat-1',
      messageKey: 'server.automation.workerFailed',
    });
    expect(await backend.tickSystemCommands(async () => owner)).toEqual([]);
  });

  it('records malformed policy output as a terminal diagnostic', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Malformed choice',
      timeoutMs: 100,
      decide: () => undefined as never,
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-invalid-output');
    now = 200;

    const first = await backend.tickSystemCommands(async () => owner);
    expect(first[0]).toMatchObject({
      status: 'rejected',
      receipt: {
        status: 'rejected',
        error: {
          code: 'INVALID_REQUEST',
          messageKey: 'host.automation.command',
          retryable: false,
        },
      },
    });
    expect(await backend.tickSystemCommands(async () => owner)).toEqual([]);
    expect(
      (await storage.getHead(input.route.sessionId))?.deadline,
    ).toBeUndefined();
    expect(
      (await storage.getHead(input.route.sessionId))?.automationFailure,
    ).toEqual({
      seatId: 'seat-1',
      messageKey: 'host.automation.command',
    });
  });

  it('records a missing policy after restart instead of rescanning forever', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Restarted choice',
      timeoutMs: 100,
      decide: () => ({ type: 'claim' }),
    });
    const first = host(storage, policy, () => 100);
    const input = await start(first, 'automation-missing-policy');
    const restarted = new GameHost({
      registry: new GameRegistry().register(automationModule),
      storage,
      backendBindingId: 'automation-backend',
      storageBindingId: 'automation-storage',
      authorize: async () => undefined,
      now: () => 200,
    });

    const result = await restarted.tickSystemCommands(async () => owner);
    expect(result[0]).toMatchObject({
      status: 'rejected',
      receipt: {
        error: {
          code: 'NOT_READY',
          messageKey: 'host.automation.policy_missing',
          retryable: false,
        },
      },
    });
    expect(
      (await storage.getHead(input.route.sessionId))?.automationFailure,
    ).toEqual({
      seatId: 'seat-1',
      messageKey: 'host.automation.policy_missing',
    });
    expect(await restarted.tickSystemCommands(async () => owner)).toEqual([]);
  });

  it('requires the resolved system access before running a policy', async () => {
    const storage = new MemoryStorageDriver();
    let decisions = 0;
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Access checked choice',
      timeoutMs: 100,
      decide: () => {
        decisions += 1;
        return { type: 'claim' };
      },
    });
    let now = 100;
    const backend = host(storage, policy, () => now);
    const input = await start(backend, 'automation-access');
    now = 200;
    const result = await backend.tickSystemCommands(async () => ({
      ...owner,
      scopes: ['session:view'],
    }));
    expect(result[0]).toMatchObject({ status: 'skipped' });
    expect(decisions).toBe(0);
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(1);
  });

  it('reuses the first persisted policy choice across concurrent Hosts', async () => {
    const storage = new MemoryStorageDriver();
    let decisions = 0;
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Claim one point',
      timeoutMs: 100,
      decide: () => {
        decisions += 1;
        return { type: 'claim' };
      },
    });
    let now = 100;
    const first = host(storage, policy, () => now);
    const second = host(storage, policy, () => now);
    const input = await start(first, 'automation-concurrent');
    now = 200;

    const results = await Promise.all([
      first.tickSystemCommands(async () => owner),
      second.tickSystemCommands(async () => owner),
    ]);
    expect(results.flat().some((item) => item.status === 'accepted')).toBe(
      true,
    );
    expect(
      results.flat().filter((item) => item.status === 'accepted'),
    ).toHaveLength(1);
    expect(decisions).toBe(2);
    expect((await storage.getHead(input.route.sessionId))?.revision).toBe(2);
  });

  it('resumes a persisted choice after a Host restart without rerunning policy', async () => {
    const storage = new MemoryStorageDriver();
    let decisions = 0;
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Claim one point',
      timeoutMs: 100,
      decide: () => {
        decisions += 1;
        return { type: 'claim' };
      },
    });
    const first = host(storage, policy, () => 100);
    const input = await start(first, 'automation-restart');
    const head = await storage.getHead(input.route.sessionId);
    const deadlineId = head?.deadline?.deadlineId;
    if (!deadlineId?.startsWith('automation:'))
      throw new Error('expected an automation deadline');
    const decisionId = deadlineId.slice('automation:'.length);
    await storage.transaction(
      input.route.sessionId,
      { ownershipEpoch: input.route.ownershipEpoch },
      (tx) =>
        tx.putAutomationDecision({
          sessionId: input.route.sessionId,
          decisionId,
          commandId: `automation:${decisionId}`,
          deadlineId,
          expectedRevision: head?.revision ?? -1,
          seatId: 'seat-1',
          turnId: 'turn-0',
          command: { type: 'claim' },
          createdAt: 100,
        }),
    );
    const restarted = host(storage, policy, () => 200);
    const result = await restarted.tickSystemCommands(async () => owner);
    expect(result[0]).toMatchObject({ status: 'accepted' });
    expect(decisions).toBe(0);
  });

  it('clears a pending automation decision when a retained session is cancelled', async () => {
    const storage = new MemoryStorageDriver();
    const policy = defineAutomationPolicy({
      id: 'claim-policy',
      kind: 'ai',
      label: 'Claim one point',
      timeoutMs: 100,
      decide: () => ({ type: 'claim' }),
    });
    const backend = host(storage, policy, () => 100);
    const input = await start(backend, 'automation-cancel');
    const head = await storage.getHead(input.route.sessionId);
    const deadlineId = head?.deadline?.deadlineId;
    if (!deadlineId?.startsWith('automation:'))
      throw new Error('expected an automation deadline');
    const decisionId = deadlineId.slice('automation:'.length);
    await storage.transaction(
      input.route.sessionId,
      { ownershipEpoch: input.route.ownershipEpoch },
      (tx) =>
        tx.putAutomationDecision({
          sessionId: input.route.sessionId,
          decisionId,
          commandId: `automation:${decisionId}`,
          deadlineId,
          expectedRevision: head?.revision ?? -1,
          seatId: 'seat-1',
          turnId: 'turn-0',
          command: { type: 'claim' },
          createdAt: 100,
        }),
    );
    await backend.controlSession({
      protocolVersion: 1,
      accessContext: {
        ...owner,
        scopes: [...owner.scopes, 'session:control:cancel'],
      },
      route: input.route,
      commandId: 'cancel-automation',
      expectedRevision: head?.revision ?? -1,
      action: 'cancel',
    });
    await storage.transaction(
      input.route.sessionId,
      { ownershipEpoch: input.route.ownershipEpoch },
      async (tx) =>
        expect(await tx.getAutomationDecision(decisionId)).toBeNull(),
    );
  });

  it('requires an explicit selected seat for a repeated hotseat controller', async () => {
    const storage = new MemoryStorageDriver();
    const backend = new GameHost({
      registry: new GameRegistry().register(sequentialTurnFixture),
      storage,
      backendBindingId: 'hotseat-backend',
      storageBindingId: 'hotseat-storage',
      authorize: async () => undefined,
      now: () => 100,
    });
    const route: SessionRoute = {
      gameId: sequentialTurnFixture.gameId,
      modeId: 'sequential',
      sessionId: 'hotseat-session',
      releaseId: sequentialTurnFixture.releaseId,
      backendBindingId: 'hotseat-backend',
      storageBindingId: 'hotseat-storage',
      ownershipEpoch: 'owner-1',
    };
    const input: CreateSessionRequest = {
      protocolVersion: 1,
      accessContext: owner,
      route,
      startId: 'hotseat-start',
      startGeneration: 0,
      participants: [
        {
          principalId: 'seat-1-player',
          seatId: 'seat-1',
          controller: 'hotseat',
          controlledBy: 'owner',
        },
        {
          principalId: 'seat-2-player',
          seatId: 'seat-2',
          controller: 'hotseat',
          controlledBy: 'owner',
        },
      ],
      setup: { target: 2 },
      seed: 'hotseat-seed',
    };
    await backend.createSession(input);
    await backend.activateSession({
      protocolVersion: 1,
      accessContext: owner,
      route,
      startId: input.startId,
    });
    await expect(
      backend.getPlayerView({
        protocolVersion: 1,
        accessContext: owner,
        route,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'INVALID_REQUEST' } });
    await expect(
      backend.getPlayerView({
        protocolVersion: 1,
        accessContext: {
          principalId: 'intruder',
          authEpoch: owner.authEpoch,
          scopes: owner.scopes,
          seatId: 'seat-1',
        },
        route,
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
    await expect(
      backend.getPlayerView({
        protocolVersion: 1,
        accessContext: { ...owner, seatId: 'seat-1' },
        route,
      }),
    ).resolves.toMatchObject({ payload: { you: { seatId: 'seat-1' } } });
    await expect(
      backend.submitCommand({
        protocolVersion: 1,
        accessContext: { ...owner, seatId: 'seat-1' },
        route,
        commandId: 'hotseat-command',
        precondition: { kind: 'revision', expectedRevision: 1 },
        command: { type: 'claim' },
      }),
    ).resolves.toMatchObject({ receipt: { status: 'accepted' } });
    await expect(
      backend.submitCommand({
        protocolVersion: 1,
        accessContext: {
          principalId: 'intruder',
          authEpoch: owner.authEpoch,
          scopes: owner.scopes,
          seatId: 'seat-1',
        },
        route,
        commandId: 'hotseat-forged-seat',
        precondition: { kind: 'revision', expectedRevision: 2 },
        command: { type: 'claim' },
      }),
    ).rejects.toMatchObject({ envelope: { code: 'FORBIDDEN' } });
  });
});
