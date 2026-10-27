import type { JsonValue } from '@board-game/contracts';
import type {
  IPlatformDailyChallengeAttempt,
  IPlatformDailyChallengeGrinderLeaderboardEntry,
  IPlatformDailyChallengeGrinderLeaderboardResponse,
  IPlatformDailyChallengeLeaderboardEntry,
  IPlatformDailyChallengeLeaderboardResponse,
  IPlatformDailyChallengeLeaderboardsResponse,
  IPlatformDailyChallengeScoreLeaderboardEntry,
  IPlatformDailyChallengeScoreLeaderboardResponse,
  IPlatformDailyChallengeSettings,
  IPlatformDailyChallengeSettingsPatch,
  IPlatformDailyChallengeSnapshot,
  IPlatformDailyChallengeStartResponse,
  IPlatformDailyChallengeTodayResponse,
  TPlatformDailyChallengePublication,
} from '@board-platform/contracts';
import { httpClient } from '@/api/httpClient.js';

export type PlatformDailyChallengeAttempt = IPlatformDailyChallengeAttempt;
export type PlatformDailyChallengeDefinition = IPlatformDailyChallengeSnapshot;
export type PlatformDailyChallengeToday = IPlatformDailyChallengeTodayResponse;
export type PlatformDailyChallengeStartResponse =
  IPlatformDailyChallengeStartResponse;
export type PlatformDailyChallengeLeaderboardResponse =
  IPlatformDailyChallengeLeaderboardResponse;
export type PlatformDailyLeaderboardEntry =
  IPlatformDailyChallengeLeaderboardEntry;
export type PlatformDailyScoreLeaderboardEntry =
  IPlatformDailyChallengeScoreLeaderboardEntry;
export type PlatformDailyScoreLeaderboard =
  IPlatformDailyChallengeScoreLeaderboardResponse;
export type PlatformDailyGrinderLeaderboardEntry =
  IPlatformDailyChallengeGrinderLeaderboardEntry;
export type PlatformDailyGrinderLeaderboard =
  IPlatformDailyChallengeGrinderLeaderboardResponse;
export type PlatformDailyLeaderboards =
  IPlatformDailyChallengeLeaderboardsResponse;
export type PlatformDailyChallengeSettings = IPlatformDailyChallengeSettings;
export type PlatformDailyChallengeSettingsPatch =
  IPlatformDailyChallengeSettingsPatch;

export interface PlatformDailyChallengeAttemptsResponse {
  readonly date: string;
  readonly attempts: readonly PlatformDailyChallengeAttempt[];
}

export interface PlatformDailyChallengePublicationPatch {
  readonly publicationState: Exclude<
    TPlatformDailyChallengePublication,
    'pending'
  >;
}

function gamePath(gameId: string, resource: string): string {
  return `/platform/games/${encodeURIComponent(gameId)}/${resource}`;
}

export function createDailyChallengeRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function')
    throw new Error('PLATFORM_DAILY_REQUEST_ID_UNAVAILABLE');
  return globalThis.crypto.randomUUID();
}

export const platformGameApi = {
  async getDailyChallengeToday(
    gameId: string,
  ): Promise<PlatformDailyChallengeToday> {
    const response = await httpClient.get<PlatformDailyChallengeToday>(
      gamePath(gameId, 'daily-challenges/today'),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async startDailyChallenge(
    gameId: string,
    requestId = createDailyChallengeRequestId(),
  ): Promise<PlatformDailyChallengeStartResponse> {
    const response = await httpClient.post<PlatformDailyChallengeStartResponse>(
      gamePath(gameId, 'daily-challenges/start'),
      { requestId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getDailyChallengeAttempts(
    gameId: string,
    date: string,
  ): Promise<PlatformDailyChallengeAttemptsResponse> {
    const response =
      await httpClient.get<PlatformDailyChallengeAttemptsResponse>(
        gamePath(gameId, 'daily-challenges/attempts'),
        {
          showServerUpdateDialog: true,
          ...(date ? { params: { date } } : {}),
        },
      );
    return response.data;
  },

  async updateDailyChallengePublication(
    gameId: string,
    sessionId: string,
    patch: PlatformDailyChallengePublicationPatch,
  ): Promise<PlatformDailyChallengeAttempt> {
    const response = await httpClient.patch<PlatformDailyChallengeAttempt>(
      gamePath(
        gameId,
        `daily-challenges/attempts/${encodeURIComponent(sessionId)}/publication`,
      ),
      patch,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getDailyChallengeLeaderboards(
    gameId: string,
    date: string,
  ): Promise<PlatformDailyChallengeLeaderboardResponse> {
    const response =
      await httpClient.get<PlatformDailyChallengeLeaderboardResponse>(
        gamePath(gameId, 'daily-challenges/leaderboards'),
        {
          showServerUpdateDialog: true,
          ...(date ? { params: { date } } : {}),
        },
      );
    return response.data;
  },

  async getDailyChallengeLeaderboard(
    gameId: string,
    date: string,
  ): Promise<readonly PlatformDailyLeaderboardEntry[]> {
    const response =
      await httpClient.get<IPlatformDailyChallengeLeaderboardResponse>(
        gamePath(gameId, 'daily-challenges/leaderboard'),
        {
          showServerUpdateDialog: true,
          ...(date ? { params: { date } } : {}),
        },
      );
    return response.data.entries;
  },

  async getDailyChallengeSettings(
    gameId: string,
  ): Promise<PlatformDailyChallengeSettings> {
    const response = await httpClient.get<PlatformDailyChallengeSettings>(
      gamePath(gameId, 'admin/daily-challenges'),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async updateDailyChallengeSettings(
    gameId: string,
    patch: PlatformDailyChallengeSettingsPatch,
  ): Promise<PlatformDailyChallengeSettings> {
    const response = await httpClient.patch<PlatformDailyChallengeSettings>(
      gamePath(gameId, 'admin/daily-challenges'),
      patch,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getPlayerStatistics(gameId: string): Promise<JsonValue> {
    const response = await httpClient.get<JsonValue>(
      gamePath(gameId, 'profile'),
      { showServerUpdateDialog: true },
    );
    if (
      typeof response.data === 'object' &&
      response.data !== null &&
      !Array.isArray(response.data) &&
      'stats' in response.data &&
      response.data.stats !== undefined
    )
      return response.data.stats;
    return response.data;
  },

  async getOperatorStatistics(gameId: string): Promise<JsonValue> {
    const response = await httpClient.get<JsonValue>(
      gamePath(gameId, 'stats'),
      { showServerUpdateDialog: true },
    );
    return response.data;
  },
};
