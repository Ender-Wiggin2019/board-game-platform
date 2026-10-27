import {
  defineGame,
  type GameModule,
  type GameRules,
  type Transition,
} from '@board-game/sdk';
import {
  accepted,
  actorForParticipant,
  type FixtureParticipant,
  participantsFromActors,
  reject,
} from './common.js';
import { fixtureSchemas } from './schemas.js';

export type SequentialTurnSetup = { readonly target?: number };
export type SequentialTurnCommand = { readonly type: 'claim' };
export type SequentialTurnEvent = {
  readonly type: 'turn-claimed';
  readonly seatId: string;
  readonly score: number;
};

export interface SequentialTurnState {
  readonly participants: readonly FixtureParticipant[];
  readonly target: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly activeSeatId: string;
  readonly turnIndex: number;
  readonly finished: boolean;
  readonly winnerSeatId: string | null;
  readonly revision: number;
}

export type SequentialTurnView = {
  readonly status: 'active' | 'completed';
  readonly target: number;
  readonly activeSeatId: string;
  readonly turnIndex: number;
  readonly revision: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly you: {
    readonly seatId: string | null;
    readonly score: number;
    readonly canAct: boolean;
  };
  readonly winnerSeatId: string | null;
};

function setupTarget(setup: SequentialTurnSetup): number {
  return Number.isSafeInteger(setup.target) && (setup.target ?? 0) > 0
    ? (setup.target as number)
    : 2;
}

function nextSeat(
  participants: readonly FixtureParticipant[],
  activeSeatId: string,
): string {
  const current = participants.findIndex(
    (participant) => participant.seatId === activeSeatId,
  );
  return (
    participants[(current + 1) % participants.length]?.seatId ?? activeSeatId
  );
}

const rules: GameRules<
  SequentialTurnState,
  SequentialTurnSetup,
  SequentialTurnCommand,
  SequentialTurnView,
  SequentialTurnEvent,
  null,
  null
> = {
  create: (setup, context) => {
    const participants = participantsFromActors(context.participants);
    const first = participants[0]?.seatId ?? 'seat-1';
    return {
      participants,
      target: setupTarget(setup),
      scores: Object.fromEntries(
        participants.map((participant) => [participant.seatId, 0]),
      ),
      activeSeatId: first,
      turnIndex: 0,
      finished: false,
      winnerSeatId: null,
      revision: 0,
    };
  },

  execute: (
    state,
    command,
    context,
  ): Transition<SequentialTurnState, SequentialTurnEvent> => {
    if (command.type !== 'claim') return reject('INVALID_COMMAND');
    if (state.finished) return reject('GAME_COMPLETE');
    const participant = actorForParticipant(context.actor, state.participants);
    if (!participant) return reject('ACTOR_NOT_SEATED');
    if (participant.seatId !== state.activeSeatId)
      return reject('NOT_YOUR_TURN');

    const score = (state.scores[participant.seatId] ?? 0) + 1;
    const finished = score >= state.target;
    const event: SequentialTurnEvent = {
      type: 'turn-claimed',
      seatId: participant.seatId,
      score,
    };
    return accepted(
      {
        ...state,
        scores: { ...state.scores, [participant.seatId]: score },
        activeSeatId: finished
          ? participant.seatId
          : nextSeat(state.participants, participant.seatId),
        turnIndex: state.turnIndex + 1,
        finished,
        winnerSeatId: finished ? participant.seatId : null,
        revision: state.revision + 1,
      },
      event,
    );
  },

  project: (state, viewer): SequentialTurnView => {
    const you = state.participants.find(
      (participant) => participant.seatId === viewer.seatId,
    );
    return {
      status: state.finished ? 'completed' : 'active',
      target: state.target,
      activeSeatId: state.activeSeatId,
      turnIndex: state.turnIndex,
      revision: state.revision,
      scores: { ...state.scores },
      you: {
        seatId: you?.seatId ?? null,
        score: you ? (state.scores[you.seatId] ?? 0) : 0,
        canAct: !state.finished && you?.seatId === state.activeSeatId,
      },
      winnerSeatId: state.winnerSeatId,
    };
  },

  projectEvent: (event, _viewer) => event,

  encode: (state) => ({
    participants: state.participants.map((participant) => ({ ...participant })),
    target: state.target,
    scores: { ...state.scores },
    activeSeatId: state.activeSeatId,
    turnIndex: state.turnIndex,
    finished: state.finished,
    winnerSeatId: state.winnerSeatId,
    revision: state.revision,
  }),

  decode: (saved) => saved as unknown as SequentialTurnState,
};

export const sequentialTurnFixture: Readonly<
  GameModule<
    SequentialTurnState,
    SequentialTurnSetup,
    SequentialTurnCommand,
    SequentialTurnView,
    SequentialTurnEvent,
    null,
    null
  >
> = defineGame({
  gameId: 'fixture-sequential-turn',
  releaseId: 'fixture-sequential-turn-v1',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
    {
      id: 'sequential',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: true,
      concurrency: 'revision',
    },
  ],
  schemas: fixtureSchemas(),
  rules,
  summarize: (state) => ({
    status: state.finished ? 'completed' : 'active',
    winnerSeatId: state.winnerSeatId,
    scores: { ...state.scores },
    revision: state.revision,
  }),
  collectFacts: (_before, transition) =>
    transition.ok
      ? transition.events.map((event) => ({
          fact: 'turn-claimed',
          seatId: event.seatId,
          score: event.score,
        }))
      : [],
  completion: (state) => ({
    finished: state.finished,
    progress: { turnIndex: state.turnIndex, target: state.target },
  }),
  result: (state) => ({
    kind: 'competitive',
    rankGroups: [
      {
        teams: state.participants
          .filter((participant) => participant.seatId === state.winnerSeatId)
          .map((participant) => ({
            participantIds: [participant.principalId],
          })),
      },
      {
        teams: state.participants
          .filter((participant) => participant.seatId !== state.winnerSeatId)
          .map((participant) => ({
            participantIds: [participant.principalId],
          })),
      },
    ],
  }),
});

export const sequentialTurnGame = sequentialTurnFixture;
