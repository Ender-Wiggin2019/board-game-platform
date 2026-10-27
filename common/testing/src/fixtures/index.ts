export {
  type CooperativeTeamCommand,
  type CooperativeTeamEvent,
  type CooperativeTeamSetup,
  type CooperativeTeamState,
  type CooperativeTeamView,
  cooperativeTeamFixture,
  cooperativeTeamGame,
} from './cooperative-team.js';
export {
  type SequentialTurnCommand,
  type SequentialTurnEvent,
  type SequentialTurnSetup,
  type SequentialTurnState,
  type SequentialTurnView,
  sequentialTurnFixture,
  sequentialTurnGame,
} from './sequential-turn.js';
export {
  type HiddenChoice,
  type SimultaneousHiddenCommand,
  type SimultaneousHiddenEvent,
  type SimultaneousHiddenSetup,
  type SimultaneousHiddenState,
  type SimultaneousHiddenView,
  simultaneousHiddenChoiceFixture,
  simultaneousHiddenFixture,
  simultaneousHiddenGame,
} from './simultaneous-hidden.js';
export {
  createSoloProgressSolutionCommand,
  type SoloProgressCommand,
  type SoloProgressEvent,
  type SoloProgressSetup,
  type SoloProgressState,
  type SoloProgressView,
  soloProgressFixture,
  soloProgressGame,
  soloProgressPuzzleFixture,
} from './solo-progress.js';

import { cooperativeTeamFixture } from './cooperative-team.js';
import { sequentialTurnFixture } from './sequential-turn.js';
import { simultaneousHiddenFixture } from './simultaneous-hidden.js';
import { soloProgressPuzzleFixture } from './solo-progress.js';

export const platformFixtureModules = [
  sequentialTurnFixture,
  simultaneousHiddenFixture,
  cooperativeTeamFixture,
  soloProgressPuzzleFixture,
] as const;
