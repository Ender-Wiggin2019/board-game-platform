import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/api/httpClient.js', () => ({ httpClient: httpMocks }));

import { platformGameApi } from '@/api/platformGameApi.js';

describe('platformGameApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the game-scoped daily challenge contract', async () => {
    const today = { challenge: { challengeDate: '2026-10-26' } };
    const start = { challenge: today.challenge, attempt: {}, start: {} };
    httpMocks.get.mockResolvedValueOnce({ data: today }).mockResolvedValueOnce({
      data: { challengeDate: '2026-10-26', entries: [] },
    });
    httpMocks.post.mockResolvedValueOnce({ data: start });

    await platformGameApi.getDailyChallengeToday('brass/pittsburgh');
    await platformGameApi.startDailyChallenge('brass/pittsburgh', 'request-1');
    await platformGameApi.getDailyChallengeLeaderboard(
      'brass/pittsburgh',
      '2026-10-26',
    );

    expect(httpMocks.get).toHaveBeenNthCalledWith(
      1,
      '/platform/games/brass%2Fpittsburgh/daily-challenges/today',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.post).toHaveBeenCalledWith(
      '/platform/games/brass%2Fpittsburgh/daily-challenges/start',
      { requestId: 'request-1' },
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      2,
      '/platform/games/brass%2Fpittsburgh/daily-challenges/leaderboard',
      {
        showServerUpdateDialog: true,
        params: { date: '2026-10-26' },
      },
    );
  });

  it('keeps daily settings nested and game scoped', async () => {
    const settings = {
      gameId: 'brass-pittsburgh',
      releaseId: 'brass-development',
      settings: { aiPreset: 'standard' },
      revision: 3,
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    httpMocks.get.mockResolvedValueOnce({ data: settings });
    httpMocks.patch.mockResolvedValueOnce({ data: settings });

    await platformGameApi.getDailyChallengeSettings('brass-pittsburgh');
    await platformGameApi.updateDailyChallengeSettings('brass-pittsburgh', {
      settings: { aiPreset: 'standard' },
      expectedRevision: 3,
    });

    expect(httpMocks.get).toHaveBeenCalledWith(
      '/platform/games/brass-pittsburgh/admin/daily-challenges',
      { showServerUpdateDialog: true },
    );
    expect(httpMocks.patch).toHaveBeenCalledWith(
      '/platform/games/brass-pittsburgh/admin/daily-challenges',
      { settings: { aiPreset: 'standard' }, expectedRevision: 3 },
      { showServerUpdateDialog: true },
    );
  });

  it('uses the attempts, publication, and three-board daily endpoints', async () => {
    httpMocks.get
      .mockResolvedValueOnce({
        data: { date: '2026-10-26', attempts: [] },
      })
      .mockResolvedValueOnce({
        data: {
          challengeDate: '2026-10-26',
          date: '2026-10-26',
          firstLook: { date: '2026-10-26', top: [] },
          overall: { date: '2026-10-26', top: [] },
          grinder: { date: '2026-10-26', top: [] },
        },
      });
    httpMocks.patch.mockResolvedValueOnce({
      data: {
        attemptId: 'attempt-1',
        challengeDate: '2026-10-26',
        attemptNumber: 1,
        status: 'completed',
        publicationState: 'public',
        updatedAt: '2026-10-26T00:00:00.000Z',
      },
    });

    await platformGameApi.getDailyChallengeAttempts(
      'brass-pittsburgh',
      '2026-10-26',
    );
    await platformGameApi.getDailyChallengeLeaderboards(
      'brass-pittsburgh',
      '2026-10-26',
    );
    await platformGameApi.updateDailyChallengePublication(
      'brass-pittsburgh',
      'session/1',
      { publicationState: 'anonymous' },
    );

    expect(httpMocks.get).toHaveBeenNthCalledWith(
      1,
      '/platform/games/brass-pittsburgh/daily-challenges/attempts',
      { showServerUpdateDialog: true, params: { date: '2026-10-26' } },
    );
    expect(httpMocks.get).toHaveBeenNthCalledWith(
      2,
      '/platform/games/brass-pittsburgh/daily-challenges/leaderboards',
      { showServerUpdateDialog: true, params: { date: '2026-10-26' } },
    );
    expect(httpMocks.patch).toHaveBeenCalledWith(
      '/platform/games/brass-pittsburgh/daily-challenges/attempts/session%2F1/publication',
      { publicationState: 'anonymous' },
      { showServerUpdateDialog: true },
    );
  });
});
