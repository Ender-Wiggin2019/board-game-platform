import {
  defineGame,
  type GameModule,
  type GameRules,
  type JsonValue,
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

export type HiddenChoice = 'red' | 'blue';
export type SimultaneousHiddenSetup = Record<string, never>;
export type SimultaneousHiddenCommand = {
  readonly type: 'submit';
  readonly promptId?: string;
  readonly participantInputRevision?: number;
  readonly choice: HiddenChoice;
};
export type SimultaneousHiddenEvent =
  | {
      readonly type: 'choice-submitted';
      readonly seatId: string;
      readonly inputRevision: number;
      readonly choice: HiddenChoice;
    }
  | {
      readonly type: 'choices-revealed';
      readonly choices: Readonly<Record<string, HiddenChoice>>;
    };

interface Submission {
  readonly seatId: string;
  readonly inputRevision: number;
  readonly choice: HiddenChoice | null;
}

export interface SimultaneousHiddenState {
  readonly participants: readonly FixtureParticipant[];
  readonly promptId: string;
  readonly submissions: readonly Submission[];
  readonly phase: 'collecting' | 'revealed';
  readonly revision: number;
}

export type SimultaneousHiddenView = {
  readonly phase: 'collecting' | 'revealed';
  readonly promptId: string;
  readonly revision: number;
  readonly submissions: readonly {
    readonly seatId: string;
    readonly submitted: boolean;
    readonly inputRevision: number;
  }[];
  readonly yourChoice: HiddenChoice | null;
  readonly revealedChoices: Readonly<Record<string, HiddenChoice>> | null;
};

const PROMPT_ID = 'prompt-1';

function allSubmitted(state: SimultaneousHiddenState): boolean {
  return state.submissions.every((submission) => submission.choice !== null);
}

function publicChoices(
  state: SimultaneousHiddenState,
): Readonly<Record<string, HiddenChoice>> {
  return Object.fromEntries(
    state.submissions.flatMap((submission) =>
      submission.choice ? [[submission.seatId, submission.choice]] : [],
    ),
  );
}

const rules: GameRules<
  SimultaneousHiddenState,
  SimultaneousHiddenSetup,
  SimultaneousHiddenCommand,
  SimultaneousHiddenView,
  SimultaneousHiddenEvent,
  null,
  null
> = {
  create: (_setup, context) => ({
    participants: participantsFromActors(context.participants),
    promptId: PROMPT_ID,
    submissions: participantsFromActors(context.participants).map(
      (participant) => ({
        seatId: participant.seatId,
        inputRevision: 0,
        choice: null,
      }),
    ),
    phase: 'collecting',
    revision: 0,
  }),

  execute: (
    state,
    command,
    context,
  ): Transition<SimultaneousHiddenState, SimultaneousHiddenEvent> => {
    if (command.type !== 'submit' || !['red', 'blue'].includes(command.choice))
      return reject('INVALID_COMMAND');
    if (state.phase === 'revealed') return reject('PROMPT_COMPLETE');
    const participant = actorForParticipant(context.actor, state.participants);
    if (!participant) return reject('ACTOR_NOT_SEATED');
    if (command.promptId !== undefined && command.promptId !== state.promptId)
      return reject('STALE_PROMPT');
    const current = state.submissions.find(
      (submission) => submission.seatId === participant.seatId,
    );
    if (!current) return reject('ACTOR_NOT_SEATED');
    if (
      command.participantInputRevision !== undefined &&
      command.participantInputRevision !== current.inputRevision
    )
      return reject('STALE_INPUT_REVISION');

    const updatedSubmission: Submission = {
      seatId: current.seatId,
      inputRevision: current.inputRevision + 1,
      choice: command.choice,
    };
    const submissions = state.submissions.map((submission) =>
      submission.seatId === participant.seatId ? updatedSubmission : submission,
    );
    const nextState: SimultaneousHiddenState = {
      ...state,
      submissions,
      revision: state.revision + 1,
    };
    const events: SimultaneousHiddenEvent[] = [
      {
        type: 'choice-submitted',
        seatId: participant.seatId,
        inputRevision: updatedSubmission.inputRevision,
        choice: command.choice,
      },
    ];
    if (allSubmitted(nextState)) {
      events.push({
        type: 'choices-revealed',
        choices: publicChoices(nextState),
      });
      return accepted({ ...nextState, phase: 'revealed' }, ...events);
    }
    return accepted(nextState, ...events);
  },

  project: (state, viewer): SimultaneousHiddenView => {
    const own = state.submissions.find(
      (submission) => submission.seatId === viewer.seatId,
    );
    return {
      phase: state.phase,
      promptId: state.promptId,
      revision: state.revision,
      submissions: state.submissions.map((submission) => ({
        seatId: submission.seatId,
        submitted: submission.choice !== null,
        inputRevision: submission.inputRevision,
      })),
      yourChoice: own?.choice ?? null,
      revealedChoices: state.phase === 'revealed' ? publicChoices(state) : null,
    };
  },

  projectEvent: (event, viewer): JsonValue | null => {
    if (event.type === 'choices-revealed') return event;
    if (event.seatId === viewer.seatId) return event;
    return {
      type: event.type,
      seatId: event.seatId,
      inputRevision: event.inputRevision,
    };
  },

  encode: (state) => ({
    participants: state.participants.map((participant) => ({ ...participant })),
    promptId: state.promptId,
    submissions: state.submissions.map((submission) => ({ ...submission })),
    phase: state.phase,
    revision: state.revision,
  }),

  decode: (saved) => saved as unknown as SimultaneousHiddenState,
};

export const simultaneousHiddenFixture: Readonly<
  GameModule<
    SimultaneousHiddenState,
    SimultaneousHiddenSetup,
    SimultaneousHiddenCommand,
    SimultaneousHiddenView,
    SimultaneousHiddenEvent,
    null,
    null
  >
> = defineGame({
  gameId: 'fixture-simultaneous-hidden',
  releaseId: 'fixture-simultaneous-hidden-v1',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
    {
      id: 'simultaneous',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: true,
      concurrency: 'prompt',
    },
  ],
  schemas: fixtureSchemas(),
  result: (state) => ({
    kind: 'competitive',
    rankGroups: [
      {
        teams: state.participants.map((participant) => ({
          participantIds: [participant.principalId],
        })),
      },
    ],
  }),
  rules,
  inputOpportunity: (state, actor) => {
    const participant = actorForParticipant(actor, state.participants);
    const submission =
      participant &&
      state.submissions.find(
        (candidate) => candidate.seatId === participant.seatId,
      );
    return state.phase === 'collecting' && submission
      ? {
          promptId: state.promptId,
          participantInputRevision: submission.inputRevision,
        }
      : null;
  },
  summarize: (state) => ({
    phase: state.phase,
    promptId: state.promptId,
    revision: state.revision,
  }),
  collectFacts: (_before, transition) => {
    if (!transition.ok) return [];
    return transition.events.flatMap((event) =>
      event.type === 'choices-revealed'
        ? [{ fact: 'choices-revealed' }]
        : [{ fact: 'choice-submitted', seatId: event.seatId }],
    );
  },
  completion: (state) => ({
    finished: state.phase === 'revealed',
    progress: {
      submitted: state.submissions.filter(
        (submission) => submission.choice !== null,
      ).length,
      total: state.submissions.length,
    },
  }),
});

export const simultaneousHiddenChoiceFixture = simultaneousHiddenFixture;
export const simultaneousHiddenGame = simultaneousHiddenFixture;
