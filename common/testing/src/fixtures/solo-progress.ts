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

export type SoloProgressSetup = { readonly levelId?: string };
export type SoloProgressCommand = {
  readonly type: 'answer';
  readonly answer: string;
};
export type SoloProgressEvent =
  | {
      readonly type: 'answer-checked';
      readonly attempt: number;
      readonly correct: boolean;
    }
  | { readonly type: 'progress-completed'; readonly levelId: string };

export interface SoloProgressState {
  readonly participant: FixtureParticipant;
  readonly levelId: string;
  readonly answer: string;
  readonly attempts: number;
  readonly progress: number;
  readonly completed: boolean;
  readonly revision: number;
}

export type SoloProgressView = {
  readonly levelId: string;
  readonly attempts: number;
  readonly progress: number;
  readonly completed: boolean;
  readonly revision: number;
};

// Deliberately private: it exists only in the server fixture module and never in a player view or summary.
const SOLO_SENTINEL_ANSWER = 'fixture-sentinel-answer-7e9';

const rules: GameRules<
  SoloProgressState,
  SoloProgressSetup,
  SoloProgressCommand,
  SoloProgressView,
  SoloProgressEvent,
  null,
  null
> = {
  create: (setup, context) => ({
    participant: participantsFromActors(context.participants)[0] ?? {
      principalId: 'solo',
      seatId: 'solo',
    },
    levelId: setup.levelId ?? 'level-1',
    answer: SOLO_SENTINEL_ANSWER,
    attempts: 0,
    progress: 0,
    completed: false,
    revision: 0,
  }),

  execute: (
    state,
    command,
    context,
  ): Transition<SoloProgressState, SoloProgressEvent> => {
    if (command.type !== 'answer' || typeof command.answer !== 'string')
      return reject('INVALID_COMMAND');
    if (state.completed) return reject('PROGRESS_COMPLETE');
    if (!actorForParticipant(context.actor, [state.participant]))
      return reject('ACTOR_NOT_SEATED');
    const attempt = state.attempts + 1;
    const correct = command.answer === state.answer;
    const completed = correct;
    const events: SoloProgressEvent[] = [
      { type: 'answer-checked', attempt, correct },
    ];
    if (correct)
      events.push({ type: 'progress-completed', levelId: state.levelId });
    return accepted(
      {
        ...state,
        attempts: attempt,
        progress: correct ? 1 : 0,
        completed,
        revision: state.revision + 1,
      },
      ...events,
    );
  },

  project: (state) => ({
    levelId: state.levelId,
    attempts: state.attempts,
    progress: state.progress,
    completed: state.completed,
    revision: state.revision,
  }),

  projectEvent: (event) =>
    event.type === 'answer-checked'
      ? { type: event.type, attempt: event.attempt, correct: event.correct }
      : event,

  encode: (state) => ({
    participant: { ...state.participant },
    levelId: state.levelId,
    answer: state.answer,
    attempts: state.attempts,
    progress: state.progress,
    completed: state.completed,
    revision: state.revision,
  }),

  decode: (saved) => saved as unknown as SoloProgressState,
};

export const soloProgressPuzzleFixture: Readonly<
  GameModule<
    SoloProgressState,
    SoloProgressSetup,
    SoloProgressCommand,
    SoloProgressView,
    SoloProgressEvent,
    null,
    null
  >
> = defineGame({
  gameId: 'fixture-solo-progress',
  releaseId: 'fixture-solo-progress-v1',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
    {
      id: 'solo-progress',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      history: 'progress-only',
      platformRating: false,
      concurrency: 'revision',
    },
    {
      id: 'solo-result',
      entry: 'direct-solo',
      minPlayers: 1,
      maxPlayers: 1,
      history: 'ephemeral-result',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  schemas: fixtureSchemas(),
  rules,
  summarize: (state) => ({
    levelId: state.levelId,
    progress: state.progress,
    completed: state.completed,
    revision: state.revision,
  }),
  collectFacts: (_before, transition) => {
    if (!transition.ok) return [];
    return transition.events.flatMap((event) =>
      event.type === 'progress-completed'
        ? [{ fact: 'progress-completed', levelId: event.levelId }]
        : [],
    );
  },
  completion: (state) => ({
    finished: state.completed,
    progress: { levelId: state.levelId, completed: state.completed },
  }),
});

/** Server-side test helper; the answer itself is intentionally not exported. */
export function createSoloProgressSolutionCommand(): SoloProgressCommand {
  return { type: 'answer', answer: SOLO_SENTINEL_ANSWER };
}

export const soloProgressFixture = soloProgressPuzzleFixture;
export const soloProgressGame = soloProgressPuzzleFixture;
