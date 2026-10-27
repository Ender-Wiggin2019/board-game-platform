import type {
  AchievementCollection,
  GameCatalogEntry,
  GameProfileSummary,
  GameRankingSummary,
  GameWallet,
} from '@board-game/contracts';
import { httpClient } from '@/api/httpClient';

export interface GamePrincipalQuery {
  readonly principalId?: string;
}

function gamePath(gameId: string, resource: string): string {
  return `/platform/games/${encodeURIComponent(gameId)}/${resource}`;
}

function principalConfig(principalId?: string): {
  readonly showServerUpdateDialog: true;
  readonly params?: { readonly principalId: string };
} {
  return principalId
    ? {
        showServerUpdateDialog: true,
        params: { principalId },
      }
    : { showServerUpdateDialog: true };
}

export const platformGamesApi = {
  async listGames(): Promise<readonly GameCatalogEntry[]> {
    const response = await httpClient.get<readonly GameCatalogEntry[]>(
      '/platform/games',
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getProfile(
    gameId: string,
    query: GamePrincipalQuery = {},
  ): Promise<GameProfileSummary> {
    const response = await httpClient.get<GameProfileSummary>(
      gamePath(gameId, 'profile'),
      principalConfig(query.principalId),
    );
    return response.data;
  },

  async getAchievements(
    gameId: string,
    query: GamePrincipalQuery = {},
  ): Promise<AchievementCollection> {
    const response = await httpClient.get<AchievementCollection>(
      gamePath(gameId, 'achievements'),
      principalConfig(query.principalId),
    );
    return response.data;
  },

  async getWallet(gameId: string): Promise<GameWallet> {
    const response = await httpClient.get<GameWallet>(
      gamePath(gameId, 'wallet'),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getRankings(gameId: string): Promise<GameRankingSummary> {
    const response = await httpClient.get<GameRankingSummary>(
      gamePath(gameId, 'rankings'),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },
};
