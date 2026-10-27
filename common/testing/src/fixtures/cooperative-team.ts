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

export type CooperativeTeamSetup = { readonly target?: number };
export type CooperativeTeamCommand = { readonly type: 'contribute' };
export type CooperativeTeamEvent = {
  readonly type: 'team-contributed';
  readonly seatId: string;
  readonly teamScore: number;
};

export interface CooperativeTeamState {
  readonly participants: readonly FixtureParticipant[];
  readonly target: number;
  readonly teamScore: number;
  readonly contributions: Readonly<Record<string, number>>;
  readonly finished: boolean;
  readonly revision: number;
}

export type CooperativeTeamView = {
  readonly status: 'active' | 'completed';
  readonly teamScore: number;
  readonly target: number;
  readonly contributions: Readonly<Record<string, number>>;
  readonly participants: readonly string[];
  readonly revision: number;
};

const rules: GameRules<
  CooperativeTeamState,
  CooperativeTeamSetup,
  CooperativeTeamCommand,
  CooperativeTeamView,
  CooperativeTeamEvent,
  null,
  null
> = {
  create: (setup, context) => {
    const participants = participantsFromActors(context.participants);
    return {
      participants,
      target:
        Number.isSafeInteger(setup.target) && (setup.target ?? 0) > 0
          ? (setup.target as number)
          : 3,
      teamScore: 0,
      contributions: Object.fromEntries(
        participants.map((participant) => [participant.seatId, 0]),
      ),
      finished: false,
      revision: 0,
    };
  },

  execute: (
    state,
    command,
    context,
  ): Transition<CooperativeTeamState, CooperativeTeamEvent> => {
    if (command.type !== 'contribute') return reject('INVALID_COMMAND');
    if (state.finished) return reject('GAME_COMPLETE');
    const participant = actorForParticipant(context.actor, state.participants);
    if (!participant) return reject('ACTOR_NOT_SEATED');
    const teamScore = state.teamScore + 1;
    return accepted(
      {
        ...state,
        teamScore,
        contributions: {
          ...state.contributions,
          [participant.seatId]:
            (state.contributions[participant.seatId] ?? 0) + 1,
        },
        finished: teamScore >= state.target,
        revision: state.revision + 1,
      },
      { type: 'team-contributed', seatId: participant.seatId, teamScore },
    );
  },

  project: (state) => ({
    status: state.finished ? 'completed' : 'active',
    teamScore: state.teamScore,
    target: state.target,
    contributions: { ...state.contributions },
    participants: state.participants.map((participant) => participant.seatId),
    revision: state.revision,
  }),

  projectEvent: (event) => event,

  encode: (state) => ({
    participants: state.participants.map((participant) => ({ ...participant })),
    target: state.target,
    teamScore: state.teamScore,
    contributions: { ...state.contributions },
    finished: state.finished,
    revision: state.revision,
  }),

  decode: (saved) => saved as unknown as CooperativeTeamState,
};

export const cooperativeTeamFixture: Readonly<
  GameModule<
    CooperativeTeamState,
    CooperativeTeamSetup,
    CooperativeTeamCommand,
    CooperativeTeamView,
    CooperativeTeamEvent,
    null,
    null
  >
> = defineGame({
  gameId: 'fixture-cooperative-team',
  releaseId: 'fixture-cooperative-team-v1',
  stateSchemaVersion: 1,
  viewSchemaVersion: 1,
  modes: [
    {
      id: 'cooperative',
      entry: 'room',
      minPlayers: 2,
      maxPlayers: 4,
      history: 'summary-and-replay',
      platformRating: false,
      concurrency: 'revision',
    },
  ],
  schemas: fixtureSchemas(),
  rules,
  summarize: (state) => ({
    status: state.finished ? 'completed' : 'active',
    teamScore: state.teamScore,
    revision: state.revision,
  }),
  collectFacts: (_before, transition) =>
    transition.ok
      ? transition.events.map((event) => ({
          fact: 'team-contributed',
          seatId: event.seatId,
          teamScore: event.teamScore,
        }))
      : [],
  completion: (state) => ({
    finished: state.finished,
    progress: { teamScore: state.teamScore, target: state.target },
  }),
});

export const cooperativeTeamGame = cooperativeTeamFixture;
