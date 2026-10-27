import { describe, expect, it } from 'vitest';
import { defineGame, type GameModule } from '../src/index.js';

interface State {
  readonly count: number;
  readonly finished: boolean;
}

type Setup = { readonly initial: number };
type Command = { readonly amount: number };
type View = { readonly count: number };
type Event = { readonly amount: number };
type Query = { readonly kind: 'count' };
type Answer = { readonly count: number };

function moduleFixture(): GameModule<
  State,
  Setup,
  Command,
  View,
  Event,
  Query,
  Answer
> {
  return {
    gameId: 'fixture',
    releaseId: 'fixture-1',
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [
      {
        id: 'solo',
        entry: 'direct-solo',
        minPlayers: 1,
        maxPlayers: 1,
        history: 'progress-only',
        platformRating: false,
        concurrency: 'revision',
      },
    ],
    schemas: {
      setup: {
        name: 'setup',
        version: 1,
        schema: { type: 'object', additionalProperties: true },
      },
      command: {
        name: 'command',
        version: 1,
        schema: { type: 'object', additionalProperties: true },
      },
      query: {
        name: 'query',
        version: 1,
        schema: { type: 'object', additionalProperties: true },
      },
    },
    rules: {
      create: (setup) => ({ count: setup.initial, finished: false }),
      execute: (state, command) => ({
        ok: true,
        state: {
          count: state.count + command.amount,
          finished: state.count + command.amount >= 10,
        },
        events: [{ amount: command.amount }],
      }),
      project: (state) => ({ count: state.count }),
      projectEvent: (event) => event,
      query: (state) => ({ count: state.count }),
      encode: (state) => state,
      decode: (saved) => saved as unknown as State,
    },
    summarize: (state) => ({ count: state.count }),
    collectFacts: (_before, transition) =>
      transition.ok ? [{ amount: transition.events[0]?.amount ?? 0 }] : [],
    inputOpportunity: (_state, actor) =>
      actor.kind === 'player'
        ? { promptId: 'prompt-1', participantInputRevision: 0 }
        : null,
    completion: (state) => ({
      finished: state.finished,
      progress: { count: state.count },
    }),
  };
}

describe('defineGame', () => {
  it('validates and freezes a typed module without starting a server', () => {
    const module = defineGame(moduleFixture());
    expect(Object.isFrozen(module)).toBe(true);
    expect(Object.isFrozen(module.modes)).toBe(true);
    expect(module.completion({ count: 10, finished: true })).toEqual({
      finished: true,
      progress: { count: 10 },
    });
    expect(
      module.inputOpportunity?.(
        { count: 0, finished: false },
        { principalId: 'p', kind: 'player' },
      ),
    ).toEqual({
      promptId: 'prompt-1',
      participantInputRevision: 0,
    });
  });

  it('rejects duplicate modes, malformed schemas, and server lifecycle hooks', () => {
    const duplicate = moduleFixture();
    const firstMode = duplicate.modes[0];
    if (!firstMode) throw new Error('fixture must define a mode');
    (duplicate as { modes: typeof duplicate.modes }).modes = [
      firstMode,
      firstMode,
    ];
    expect(() => defineGame(duplicate)).toThrowError(/duplicateMode/);

    const malformed = moduleFixture();
    (malformed as { schemas: typeof malformed.schemas }).schemas = {
      ...malformed.schemas,
      command: { name: 'command', version: 0, schema: { type: 'any' } },
    };
    expect(() => defineGame(malformed)).toThrowError(/invalidDescriptor/);

    const withServer = {
      ...moduleFixture(),
      listen: () => undefined,
    } as GameModule<State, Setup, Command, View, Event, Query, Answer> & {
      listen: () => void;
    };
    expect(() => defineGame(withServer)).toThrowError(
      /serverLifecycleForbidden/,
    );
  });
});
