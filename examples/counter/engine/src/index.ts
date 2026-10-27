import {
  defineGame,
  sequentialTurn,
  type GameModule,
  type JsonValue,
} from '@board-game/sdk';
import {
  DEFAULT_TARGET,
  GAME_ID,
  type CounterCommand,
  type CounterEvent,
  type CounterQuery,
  type CounterReplayAnswer,
  type CounterSetup,
  type CounterView,
} from '@board-games/counter-common';

type State = {
  readonly revision: number;
  readonly count: number;
  readonly target: number;
  readonly previous: number | null;
  readonly playerIds: readonly string[];
  readonly seatIds: readonly string[];
};

type Module = GameModule<
  State,
  CounterSetup,
  CounterCommand,
  CounterView,
  CounterEvent,
  CounterQuery,
  CounterReplayAnswer
>;

function targetFromSetup(setup: CounterSetup): number {
  const target = setup.target ?? DEFAULT_TARGET;
  if (!Number.isSafeInteger(target) || target < 1 || target > 10)
    throw new Error('target must be an integer between 1 and 10');
  return target;
}

export function createCounterGame(releaseId = 'counter-development'): Module {
  return defineGame({
    gameId: GAME_ID,
    releaseId,
    stateSchemaVersion: 1,
    viewSchemaVersion: 1,
    modes: [{
      id: 'solo',
      entry: 'room',
      minPlayers: 1,
      maxPlayers: 2,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    }],
    schemas: {
      setup: {
        name: 'counter.setup',
        version: 1,
        schema: {
          type: 'object',
          properties: { target: { type: 'integer', minimum: 1, maximum: 10 } },
          additionalProperties: false,
        },
      },
      command: {
        name: 'counter.command',
        version: 1,
        schema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['increment', 'undo'] } },
          required: ['type'],
          additionalProperties: false,
        },
      },
      query: {
        name: 'counter.query',
        version: 1,
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['replayManifest', 'replayFrames'] },
            eventLimit: { type: 'integer', minimum: 1, maximum: 200 },
            from: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    rules: {
      create: (setup, context): State => {
        const players = context.participants.filter((actor) => actor.kind === 'player');
        if (players.length === 0) throw new Error('A player is required');
        if (players.some((player) => !player.seatId)) throw new Error('A player seat is required');
        return {
          revision: 0,
          count: 0,
          target: targetFromSetup(setup),
          previous: null,
          playerIds: players.map((player) => player.principalId),
          seatIds: players.map((player) => player.seatId as string),
        };
      },
      execute: (state: State, command, context) => {
        if (context.actor.kind !== 'player' || !state.playerIds.includes(context.actor.principalId))
          return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'counter.playerRequired' } };
        if (state.count >= state.target)
          return { ok: false, error: { code: 'CLOSED', messageKey: 'counter.completed' } };
        if (command.type === 'undo') {
          if (state.previous === null)
            return { ok: false, error: { code: 'NO_UNDO', messageKey: 'counter.noUndo' } };
          return {
            ok: true,
            state: { ...state, revision: state.revision + 1, count: state.previous, previous: null },
            events: [{ type: 'changed', count: state.previous }],
          };
        }
        return {
          ok: true,
          state: { ...state, revision: state.revision + 1, previous: state.count, count: state.count + 1 },
          events: [{ type: 'changed', count: state.count + 1 }],
        };
      },
      project: (state, viewer) => ({
        count: state.count,
        target: state.target,
        status: state.count >= state.target ? 'completed' : 'active',
        playerId: state.playerIds[0] as string,
        canIncrement: viewer.principalId !== undefined && state.playerIds.includes(viewer.principalId) && state.count < state.target,
        canUndo: viewer.principalId !== undefined && state.playerIds.includes(viewer.principalId) && state.previous !== null && state.count < state.target,
      }),
      projectEvent: (event) => event,
      query: (state: State, query): CounterReplayAnswer => {
        if (query.type === 'replayManifest')
          return { kind: 'manifest', releaseId, frames: [], limit: query.eventLimit };
        return {
          kind: 'frames',
          releaseId,
          from: query.from,
          limit: query.limit,
          frames: [{ revision: state.revision, count: state.count }],
        };
      },
      encode: (state): JsonValue => ({ ...state }),
      decode: (saved): State => {
        if (!saved || typeof saved !== 'object' || Array.isArray(saved))
          throw new Error('Unsupported counter checkpoint');
        const value = saved as Record<string, JsonValue>;
        const revision = value.revision;
        const count = value.count;
        const target = value.target;
        const previous = value.previous;
        const playerIds = value.playerIds;
        const seatIds = value.seatIds;
        const integer = (candidate: JsonValue): candidate is number =>
          typeof candidate === 'number' && Number.isSafeInteger(candidate);
        if (!integer(revision) || revision < 0 ||
          !integer(count) || count < 0 ||
          !integer(target) || target < 1 || target > 10 ||
          (previous !== null && (!integer(previous) || previous < 0 || previous >= count)) ||
          !Array.isArray(playerIds) || playerIds.length === 0 ||
          playerIds.some((playerId) => typeof playerId !== 'string') ||
          !Array.isArray(seatIds) || seatIds.length !== playerIds.length ||
          seatIds.some((seatId) => typeof seatId !== 'string'))
          throw new Error('Unsupported counter checkpoint');
        return { revision, count, target, previous, playerIds, seatIds };
      },
    },
    turn: (state) => state.count >= state.target ? null : sequentialTurn('turn:' + state.revision, state.seatIds[state.revision % state.seatIds.length] ?? null),
    summarize: (state) => ({ count: state.count, target: state.target, status: state.count >= state.target ? 'completed' : 'active' }),
    collectFacts: () => [],
    result: (state) => ({ kind: state.playerIds.length === 1 ? 'solo' : 'cooperative', participantIds: state.playerIds, outcome: 'completed', score: state.count }),
    completion: (state) => ({ finished: state.count >= state.target }),
  });
}

export const game = createCounterGame();
