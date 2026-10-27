import {
  assertParticipant,
  assertTurnState,
  controlsParticipant,
  participantAccountId,
  turnPrecondition,
} from '@board-game/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_DECISION_RESULT_KIND,
  automationOptions,
  defineAutomationPolicy,
  parseAutomationDecisionResult,
  sequentialTurn,
  simultaneousTurn,
} from '../src/index.js';

describe('automation decision result parsing', () => {
  it('does not reinterpret a command object with a command field', () => {
    const command = { command: { type: 'nested' }, type: 'play' } as const;
    expect(parseAutomationDecisionResult(command)).toEqual({ command });
  });

  it('requires the reserved discriminant for private diagnostics', () => {
    expect(
      parseAutomationDecisionResult({
        command: { type: 'play' },
        diagnostics: { nodes: 3 },
      }),
    ).toEqual({
      command: { command: { type: 'play' }, diagnostics: { nodes: 3 } },
    });
    expect(
      parseAutomationDecisionResult({
        kind: AUTOMATION_DECISION_RESULT_KIND,
        command: { type: 'play' },
        diagnostics: { nodes: 3 },
      }),
    ).toEqual({
      command: { type: 'play' },
      diagnostics: { nodes: 3 },
    });
  });
});

describe('seat control and independent turn opportunities', () => {
  it('keeps account identity separate from a synthetic hotseat identity', () => {
    const seat = {
      principalId: 'local-player-2',
      seatId: 'seat-2',
      controller: 'hotseat' as const,
      controlledBy: 'account-1',
    };
    expect(() => assertParticipant(seat)).not.toThrow();
    expect(controlsParticipant(seat, 'account-1')).toBe(true);
    expect(controlsParticipant(seat, 'local-player-2')).toBe(false);
    expect(
      participantAccountId({ principalId: 'robot', controller: 'ai' }),
    ).toBeUndefined();
    expect(() => assertParticipant({ ...seat, controller: 'human' })).toThrow();
    expect(() =>
      assertParticipant({
        ...seat,
        controller: 'ai',
        controllerId: 'legal-bot',
      }),
    ).toThrow();
  });

  it('preserves another simultaneous seat prompt when one player responds', () => {
    const turn = simultaneousTurn('draft:1', {
      first: { promptId: 'first:pick', participantInputRevision: 0 },
      second: { promptId: 'second:pick', participantInputRevision: 3 },
    });
    const next = simultaneousTurn('draft:1', {
      second: turn.inputOpportunities!.second,
    });
    expect(turnPrecondition(turn, 'second', 1)).toEqual(
      turnPrecondition(next, 'second', 2),
    );
    expect(turnPrecondition(next, 'first', 2)).toEqual({
      kind: 'revision',
      expectedRevision: 2,
    });
    expect(
      turnPrecondition(sequentialTurn('turn:2', 'first'), 'first', 3),
    ).toEqual({ kind: 'revision', expectedRevision: 3 });
  });

  it('rejects ambiguous, foreign and unfenced opportunities', () => {
    expect(() =>
      assertTurnState({
        id: 'x',
        mode: 'sequential',
        activeSeatIds: ['a', 'b'],
      }),
    ).toThrow();
    expect(() =>
      assertTurnState({ id: 'x', mode: 'simultaneous', activeSeatIds: ['a'] }),
    ).toThrow();
    expect(() =>
      assertTurnState(sequentialTurn('x', 'a'), [{ seatId: 'b' }]),
    ).toThrow();
    expect(() =>
      assertTurnState(
        simultaneousTurn('x', {
          a: { promptId: 'p', participantInputRevision: -1 },
        }),
      ),
    ).toThrow();
  });
});

describe('registered automation policies', () => {
  const base = {
    id: 'simple',
    kind: 'ai' as const,
    label: 'Simple AI',
    timeoutMs: 100,
    decide: () => ({ type: 'pass' }),
  };

  it('rejects unbounded work and options not owned by a registered schema', () => {
    expect(() => defineAutomationPolicy({ ...base, timeoutMs: 0 })).toThrow();
    expect(() =>
      defineAutomationPolicy({ ...base, timeoutMs: 60_001 }),
    ).toThrow();
    expect(() =>
      automationOptions(defineAutomationPolicy(base), {
        difficulty: 'invented',
      }),
    ).toThrow();
  });

  it('validates provider options and isolates the returned configuration', () => {
    const policy = defineAutomationPolicy({
      ...base,
      optionsSchema: {
        name: 'options',
        version: 1,
        schema: {
          type: 'object' as const,
          properties: {
            level: { type: 'integer' as const, minimum: 1, maximum: 3 },
          },
          required: ['level'],
          additionalProperties: false,
        },
      },
      defaultOptions: { level: 2 },
    });
    expect(automationOptions(policy, undefined)).toEqual({ level: 2 });
    expect(() => automationOptions(policy, { level: 4 })).toThrow();
    expect(() =>
      automationOptions(policy, { level: 2, secret: true }),
    ).toThrow();
    expect(() =>
      defineAutomationPolicy({
        ...policy,
        presets: [{ id: 'easy', label: 'Easy', options: { level: 4 } }],
      }),
    ).toThrow();
    expect(() =>
      defineAutomationPolicy({
        ...policy,
        presets: [
          { id: 'easy', label: 'Easy', options: { level: 1 } },
          { id: 'easy', label: 'Repeated', options: { level: 2 } },
        ],
      }),
    ).toThrow();
    expect(
      defineAutomationPolicy({
        ...policy,
        presets: [{ id: 'easy', label: 'Easy', options: { level: 1 } }],
      }).presets?.[0].options,
    ).toEqual({ level: 1 });
  });
});
