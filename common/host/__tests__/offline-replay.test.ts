import type { Actor, JsonValue } from '@board-game/contracts';
import {
  type AutomationDecisionInput,
  defineAutomationPolicy,
} from '@board-game/sdk';
import type { AutomationTrace } from '@board-game/storage';
import {
  type SequentialTurnCommand,
  sequentialTurnFixture,
} from '@board-game/testing/fixtures';
import { describe, expect, it } from 'vitest';
import {
  type OfflineAutomationReplayResult,
  replayAutomationTraceOffline,
} from '../src/index.js';

const capturedActor: Actor = {
  principalId: 'captured-ai',
  seatId: 'seat-1',
  kind: 'player',
  controller: 'ai',
};

function makeTrace(
  kind: AutomationTrace['kind'],
  command: JsonValue = { type: 'claim' },
): AutomationTrace {
  const state = sequentialTurnFixture.rules.create(
    { target: 2 },
    {
      sessionId: 'offline-session',
      modeId: 'sequential',
      seed: 'offline-seed',
      participants: [
        capturedActor,
        {
          principalId: 'other-player',
          seatId: 'seat-2',
          kind: 'player',
        },
      ],
    },
  );
  const input: AutomationDecisionInput = {
    view: { status: 'active', revision: 0 },
    actor: capturedActor,
    turn: {
      id: 'turn-0',
      mode: 'sequential',
      activeSeatIds: ['seat-1'],
    },
    seed: 'offline-policy-seed',
    options: null,
  };
  return {
    kind,
    sessionId: 'offline-session',
    traceId: `trace-${kind}`,
    decisionId: `decision-${kind}`,
    commandId: `command-${kind}`,
    deadlineId: `deadline-${kind}`,
    releaseId: sequentialTurnFixture.releaseId,
    policyId: kind === 'automation' ? 'captured-policy' : 'player-command',
    ...(kind === 'automation' ? { policyVersion: 'captured-v1' } : {}),
    expectedRevision: 0,
    seatId: 'seat-1',
    turnId: 'turn-0',
    state: sequentialTurnFixture.rules.encode(state),
    input: input as unknown as JsonValue,
    schemaVersion: sequentialTurnFixture.stateSchemaVersion,
    options: null,
    command,
    ...(kind === 'automation'
      ? { diagnostics: { source: 'captured-policy' } }
      : {}),
    outcome: 'executed',
    startedAt: 100,
    finishedAt: 101,
    createdAt: 100,
    eventSequenceStart: 1,
    eventSequenceCount: 1,
  };
}

function policy(id: string, marker: string, timeoutMs = 100) {
  return defineAutomationPolicy<SequentialTurnCommand>({
    id,
    version: 'current-v1',
    kind: 'ai',
    label: id,
    timeoutMs,
    decide: (input) => ({
      kind: 'automation-decision',
      command: { type: 'claim' },
      diagnostics: { marker, actor: input.actor.principalId },
    }),
  });
}

function stableResult(result: OfflineAutomationReplayResult) {
  const { durationMs: _durationMs, ...stable } = result;
  return stable;
}

describe('offline private trace replay', () => {
  it('repeats a captured command against a cloned checkpoint', async () => {
    const trace = makeTrace('command');
    const before = structuredClone(trace);

    const first = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace,
    });
    const second = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace,
    });

    expect(first.legal).toBe(true);
    expect(first.originalCommand).toEqual({ type: 'claim' });
    expect(first.command).toEqual({ type: 'claim' });
    expect(first.newCommand).toEqual({ type: 'claim' });
    expect(stableResult(first)).toEqual(stableResult(second));
    expect(trace).toEqual(before);
  });

  it('compares policies using the captured actor and input', async () => {
    const trace = makeTrace('automation');
    const first = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace,
      currentPolicy: policy('policy-a', 'a'),
    });
    const second = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace,
      currentPolicy: policy('policy-b', 'b'),
    });

    expect(first.legal).toBe(true);
    expect(second.legal).toBe(true);
    expect(first.policyId).toBe('policy-a');
    expect(second.policyId).toBe('policy-b');
    expect(first.originalPolicyId).toBe('captured-policy');
    expect(first.originalCommand).toEqual({ type: 'claim' });
    expect(first.newCommand).toEqual({ type: 'claim' });
    expect(first.diagnostics).toEqual({ marker: 'a', actor: 'captured-ai' });
    expect(second.diagnostics).toEqual({ marker: 'b', actor: 'captured-ai' });
  });

  it('reports an illegal captured command without changing the trace', async () => {
    const trace = makeTrace('command', { type: 'not-a-command' });
    const before = structuredClone(trace);
    const result = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace,
    });

    expect(result.legal).toBe(false);
    expect(result.error).toEqual({
      code: 'INVALID_REQUEST',
      messageKey: 'fixture.invalid_command',
    });
    expect(trace).toEqual(before);
  });

  it('aborts a policy that exceeds its offline timeout', async () => {
    let aborted = false;
    const slowPolicy = defineAutomationPolicy<SequentialTurnCommand>({
      id: 'slow-policy',
      version: 'current-v1',
      kind: 'ai',
      label: 'Slow policy',
      timeoutMs: 5,
      decide: (_input, signal) =>
        new Promise<SequentialTurnCommand>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ type: 'claim' });
            },
            { once: true },
          );
        }),
    });
    const result = await replayAutomationTraceOffline({
      module: sequentialTurnFixture,
      trace: makeTrace('automation'),
      currentPolicy: slowPolicy,
    });

    expect(result.legal).toBe(false);
    expect(result.error).toEqual({
      code: 'CONFLICT',
      messageKey: 'host.automation.timeout',
    });
    expect(aborted).toBe(true);
  });
});
