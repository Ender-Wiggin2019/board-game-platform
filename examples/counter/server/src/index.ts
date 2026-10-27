import { defineGameServer } from '@board-game/server';
import { GAME_ID, type CounterCommand } from '@board-games/counter-common';
import { createCounterGame } from '@board-games/counter-engine';

export const game = createCounterGame();
export const server = defineGameServer({
  manifest: { gameId: GAME_ID, releaseId: game.releaseId },
  module: game,
  services: {
    replay: {
      queries: {
        manifest: (eventLimit) => ({ type: 'replayManifest', eventLimit }),
        frames: (from, limit) => ({ type: 'replayFrames', from, limit }),
      },
    },
  },
});

export const developmentScenarios = [
  {
    id: 'complete',
    label: 'Complete the counter',
    setup: { target: 3 },
    commands: [
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
      { principalId: 'player1', command: { type: 'increment' as CounterCommand['type'] } },
    ],
  },
];
