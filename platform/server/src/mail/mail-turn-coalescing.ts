import { sanitizeGameName } from './mail-provider.js';

export const MAX_COALESCED_TURN_GAMES = 5;
const MAX_TURN_GAME_SUMMARY_BYTES = 160;

export interface ITurnReminderSummaryGame {
  gameId: string;
  gameName: string;
  actionUrl: string;
}

export interface ITurnReminderSummary {
  games: ITurnReminderSummaryGame[];
  variables: {
    gameName: string;
    gameSummary: string;
    actionUrl: string;
  };
}

/** Builds bounded variables that remain compatible with the existing SES template. */
export function buildTurnReminderSummary(
  games: readonly ITurnReminderSummaryGame[],
  allGamesActionUrl: string,
): ITurnReminderSummary {
  const uniqueGames: ITurnReminderSummaryGame[] = [];
  const seen = new Set<string>();
  for (const game of games) {
    if (seen.has(game.gameId)) continue;
    seen.add(game.gameId);
    uniqueGames.push({
      gameId: game.gameId,
      gameName: sanitizeGameName(game.gameName) || 'your game',
      actionUrl: game.actionUrl,
    });
    if (uniqueGames.length >= MAX_COALESCED_TURN_GAMES) break;
  }

  if (uniqueGames.length === 0) {
    uniqueGames.push({
      gameId: '',
      gameName: 'your game',
      actionUrl: allGamesActionUrl,
    });
  }

  const names = uniqueGames.map((game) => game.gameName);
  const gameName = boundSummary(names.join(' · '));
  const gameSummary = `${uniqueGames.length} game${uniqueGames.length === 1 ? '' : 's'}`;
  return {
    games: uniqueGames,
    variables: {
      // Existing turn_reminder templates render gameName. Keep the bounded
      // summary there; gameSummary gives newer templates the item count.
      gameName,
      gameSummary,
      actionUrl:
        uniqueGames.length === 1 ? uniqueGames[0].actionUrl : allGamesActionUrl,
    },
  };
}

function boundSummary(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_TURN_GAME_SUMMARY_BYTES) {
    return value;
  }
  let bounded = '';
  for (const character of value) {
    const candidate = `${bounded}${character}`;
    if (
      Buffer.byteLength(`${candidate}…`, 'utf8') > MAX_TURN_GAME_SUMMARY_BYTES
    ) {
      break;
    }
    bounded = candidate;
  }
  return `${bounded.trimEnd()}…`;
}
