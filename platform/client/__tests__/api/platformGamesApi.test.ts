import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/api/httpClient', () => ({ httpClient: httpMocks }));

import { platformGamesApi } from '@/api/platformGamesApi';

describe('platformGamesApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encodes game ids and keeps principal targeting on public reads', async () => {
    const profile = { gameId: 'brass/pittsburgh', principalId: 'user-2' };
    const achievements = {
      gameId: 'brass/pittsburgh',
      principalId: 'user-2',
      definitionVersion: 'v1',
      items: [],
    };
    httpMocks.get
      .mockResolvedValueOnce({ data: [profile] })
      .mockResolvedValueOnce({ data: profile })
      .mockResolvedValueOnce({ data: achievements })
      .mockResolvedValueOnce({ data: { gameId: profile.gameId, assets: [] } })
      .mockResolvedValueOnce({ data: { gameId: profile.gameId, entries: [] } });

    await expect(platformGamesApi.listGames()).resolves.toEqual([profile]);
    await platformGamesApi.getProfile(profile.gameId, {
      principalId: profile.principalId,
    });
    await platformGamesApi.getAchievements(profile.gameId, {
      principalId: profile.principalId,
    });
    await platformGamesApi.getWallet(profile.gameId);
    await platformGamesApi.getRankings(profile.gameId);

    expect(httpMocks.get).toHaveBeenNthCalledWith(1, '/platform/games', {
      showServerUpdateDialog: true,
    });
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      2,
      '/platform/games/brass%2Fpittsburgh/profile',
      { showServerUpdateDialog: true, params: { principalId: 'user-2' } },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      3,
      '/platform/games/brass%2Fpittsburgh/achievements',
      { showServerUpdateDialog: true, params: { principalId: 'user-2' } },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      4,
      '/platform/games/brass%2Fpittsburgh/wallet',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      5,
      '/platform/games/brass%2Fpittsburgh/rankings',
      { showServerUpdateDialog: true },
    );
  });
});
