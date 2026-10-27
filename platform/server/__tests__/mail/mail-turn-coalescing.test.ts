import { describe, expect, it } from 'vitest';
import {
  buildTurnReminderSummary,
  MAX_COALESCED_TURN_GAMES,
} from '@/mail/mail-turn-coalescing.js';

describe('turn reminder coalescing', () => {
  it('deduplicates games and uses the game list for a multi-game action', () => {
    const summary = buildTurnReminderSummary(
      [
        { gameId: 'game-a', gameName: 'Alpha', actionUrl: '/game/game-a' },
        { gameId: 'game-a', gameName: 'Alpha', actionUrl: '/game/game-a' },
        { gameId: 'game-b', gameName: 'Beta', actionUrl: '/game/game-b' },
      ],
      '/my-games',
    );

    expect(summary.games.map((game) => game.gameId)).toEqual([
      'game-a',
      'game-b',
    ]);
    expect(summary.variables).toEqual({
      gameName: 'Alpha · Beta',
      gameSummary: '2 games',
      actionUrl: '/my-games',
    });
  });

  it("keeps a single game's deep link and bounds summary size", () => {
    const summary = buildTurnReminderSummary(
      Array.from({ length: MAX_COALESCED_TURN_GAMES + 2 }, (_, index) => ({
        gameId: `game-${index}`,
        gameName: `Game ${index} ${'x'.repeat(50)}`,
        actionUrl: `/game/game-${index}`,
      })),
      '/my-games',
    );

    expect(summary.games).toHaveLength(MAX_COALESCED_TURN_GAMES);
    expect(
      Buffer.byteLength(summary.variables.gameName, 'utf8'),
    ).toBeLessThanOrEqual(160);
    expect(summary.variables.gameName.endsWith('…')).toBe(true);
    expect(summary.variables.actionUrl).toBe('/my-games');
  });

  it('retains the existing action URL for one game', () => {
    const summary = buildTurnReminderSummary(
      [{ gameId: 'game-a', gameName: 'Alpha', actionUrl: '/game/game-a' }],
      '/my-games',
    );

    expect(summary.variables).toEqual({
      gameName: 'Alpha',
      gameSummary: '1 game',
      actionUrl: '/game/game-a',
    });
  });
});
