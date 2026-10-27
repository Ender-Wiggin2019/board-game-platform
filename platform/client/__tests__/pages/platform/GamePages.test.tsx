import type { JsonObject } from '@board-game/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDailyChallengeRequestId,
  type PlatformDailyChallengeSettings,
  platformGameApi,
} from '@/api/platformGameApi.js';
import { GameDailyChallengeAdminPage } from '@/pages/platform/GameDailyChallengeAdminPage.js';
import { GameDailyChallengePage } from '@/pages/platform/GameDailyChallengePage.js';
import { GameStatisticsPage } from '@/pages/platform/GameStatisticsPage.js';
import { useAuthStore } from '@/stores/authStore.js';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/api/platformGameApi.js', () => ({
  createDailyChallengeRequestId: vi.fn(() => 'request-test'),
  platformGameApi: {
    getDailyChallengeToday: vi.fn(),
    getDailyChallengeLeaderboard: vi.fn(),
    getDailyChallengeAttempts: vi.fn(),
    getDailyChallengeLeaderboards: vi.fn(),
    updateDailyChallengePublication: vi.fn(),
    getDailyChallengeSettings: vi.fn(),
    updateDailyChallengeSettings: vi.fn(),
    startDailyChallenge: vi.fn(),
    getPlayerStatistics: vi.fn(),
    getOperatorStatistics: vi.fn(),
  },
}));

const api = vi.mocked(platformGameApi);
type RequestIdMock = {
  mockReset: () => void;
  mockReturnValue: (value: string) => RequestIdMock;
  mockReturnValueOnce: (value: string) => RequestIdMock;
};
const createRequestIdMock =
  createDailyChallengeRequestId as unknown as RequestIdMock;

function emptyLeaderboards(date = '2026-10-26') {
  return {
    date,
    firstLook: { date, top: [] },
    overall: { date, top: [] },
    grinder: { date, top: [] },
  };
}

function leaderboardWithAda() {
  const entry = {
    rank: 1,
    entryKey: 'entry-ada',
    displayName: 'Ada',
    publicationState: 'public' as const,
    attemptNumber: 1,
    score: 38,
    completedAt: '2026-10-26T00:00:00.000Z',
    sessionId: 'session-ada',
    replayAvailable: true,
  };
  return {
    date: '2026-10-26',
    firstLook: { date: '2026-10-26', top: [entry] },
    overall: { date: '2026-10-26', top: [entry] },
    grinder: { date: '2026-10-26', top: [] },
  };
}

function renderWithQuery(ui: React.JSX.Element): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

beforeEach(() => {
  navigate.mockReset();
  api.getDailyChallengeToday.mockReset();
  createRequestIdMock.mockReset();
  createRequestIdMock.mockReturnValue('request-test');
  api.getDailyChallengeLeaderboard.mockReset();
  api.getDailyChallengeAttempts.mockReset();
  api.getDailyChallengeLeaderboards.mockReset();
  api.updateDailyChallengePublication.mockReset();
  api.getDailyChallengeSettings.mockReset();
  api.updateDailyChallengeSettings.mockReset();
  api.startDailyChallenge.mockReset();
  api.getPlayerStatistics.mockReset();
  api.getOperatorStatistics.mockReset();
  useAuthStore.setState({
    token: 'test-token',
    user: { id: 'user-a' } as never,
    isAuthenticated: true,
    isRestoring: false,
    sessionExpired: false,
    authEpoch: 0,
  });
});

function SettingsEditor({
  settings,
  onChange,
}: {
  readonly settings: JsonObject;
  readonly onChange: (settings: JsonObject) => void;
}): React.JSX.Element {
  return (
    <div>
      <output data-testid='settings-value'>{String(settings.value)}</output>
      <button
        type='button'
        onClick={() => onChange({ ...settings, value: 'edited' })}
      >
        Edit
      </button>
    </div>
  );
}

describe('game workspace pages', () => {
  it('shows a fixed daily setup, own result and public leaderboard in game scope', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: {
          playerCount: 4,
          scenarioLabel: 'Pittsburgh classic',
          aiPresetLabel: 'Industrialist',
          aiCount: 3,
        },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempt: {
        attemptId: 'attempt-1',
        challengeDate: '2026-10-26',
        attemptNumber: 1,
        status: 'started',
        publicationState: 'pending',
        score: 12,
        sessionId: 'session-1',
        result: { rank: 4 },
        updatedAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 1,
      leaderboards: leaderboardWithAda(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });

    const queryClient = renderWithQuery(
      <GameDailyChallengePage gameId='brass-pittsburgh' />,
    );

    expect((await screen.findAllByText('2026-10-26')).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText('daily-42')).toBeInTheDocument();
    expect(
      screen.getByText(/fixed scenario is ready to play/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Pittsburgh classic')).not.toBeInTheDocument();
    expect(screen.getByText(/score 12, rank 4/i)).toBeInTheDocument();
    expect((await screen.findAllByText('Ada')).length).toBeGreaterThan(0);
    expect(api.getDailyChallengeToday).toHaveBeenCalledWith('brass-pittsburgh');
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual([
      'game',
      'brass-pittsburgh',
      'daily-challenge',
      'today',
      0,
      'user-a',
    ]);
  });

  it('renders the three boards without exposing anonymous session identity', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      latestAttempt: {
        attemptId: 'attempt-1',
        challengeDate: '2026-10-26',
        attemptNumber: 1,
        status: 'completed',
        publicationState: 'pending',
        sessionId: 'secret-session',
        score: 42,
        updatedAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [
        {
          attemptId: 'attempt-1',
          challengeDate: '2026-10-26',
          attemptNumber: 1,
          status: 'completed',
          publicationState: 'pending',
          sessionId: 'secret-session',
          score: 42,
          updatedAt: '2026-10-26T00:00:00.000Z',
        },
      ],
      attemptCount: 1,
      leaderboards: {
        date: '2026-10-26',
        firstLook: {
          date: '2026-10-26',
          top: [
            {
              rank: 1,
              entryKey: 'opaque-entry',
              publicationState: 'anonymous',
              attemptNumber: 1,
              score: 42,
              completedAt: '2026-10-26T00:00:00.000Z',
            },
          ],
        },
        overall: { date: '2026-10-26', top: [] },
        grinder: { date: '2026-10-26', top: [] },
      },
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.updateDailyChallengePublication.mockResolvedValue({
      attemptId: 'attempt-1',
      challengeDate: '2026-10-26',
      attemptNumber: 1,
      status: 'completed',
      publicationState: 'anonymous',
      sessionId: 'secret-session',
      score: 42,
      updatedAt: '2026-10-26T00:00:00.000Z',
    });

    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    expect(await screen.findByText('Anonymous player')).toBeInTheDocument();
    expect(screen.getAllByText('First Look').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Overall').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Grinder').length).toBeGreaterThan(0);
    expect(screen.queryByText('secret-session')).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Publish anonymously' }),
    );
    await waitFor(() =>
      expect(api.updateDailyChallengePublication).toHaveBeenCalledWith(
        'brass-pittsburgh',
        'secret-session',
        { publicationState: 'anonymous' },
      ),
    );
  });

  it('explains when a pending attempt will be auto-published', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [
        {
          attemptId: 'attempt-1',
          challengeDate: '2026-10-26',
          attemptNumber: 1,
          status: 'completed',
          publicationState: 'pending',
          sessionId: 'session-1',
          score: 42,
          autoPublishAt: '2026-10-26T00:05:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
        },
      ],
      attemptCount: 1,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });

    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    expect(await screen.findByText(/Auto-publishes at/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Publish publicly' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Publish anonymously' }),
    ).toBeInTheDocument();
  });

  it('links only eligible daily replays and keeps anonymous owners private', async () => {
    const entry = (
      rank: number,
      publicationState: 'public' | 'anonymous',
      sessionId: string,
      isCurrentUser = false,
    ) => ({
      rank,
      entryKey: `${publicationState}-${rank}`,
      publicationState,
      ...(isCurrentUser ? { isCurrentUser: true } : {}),
      attemptNumber: 1,
      score: 100 - rank,
      completedAt: '2026-10-26T00:00:00.000Z',
      sessionId,
      replayAvailable: true,
    });
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: {
        date: '2026-10-26',
        firstLook: {
          date: '2026-10-26',
          top: [
            entry(1, 'public', 'session-public-top'),
            entry(2, 'anonymous', 'session-anonymous-other'),
            entry(3, 'anonymous', 'session-anonymous-owner', true),
            entry(4, 'public', 'session-public-four'),
          ],
        },
        overall: { date: '2026-10-26', top: [] },
        grinder: { date: '2026-10-26', top: [] },
      },
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });

    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    const replayLinks = await screen.findAllByRole('link', {
      name: 'Replay available',
    });
    expect(replayLinks).toHaveLength(2);
    expect(replayLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/game/session-public-top/replay',
      '/game/session-anonymous-owner/replay',
    ]);
    expect(
      screen.queryByText('session-anonymous-other'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('session-public-four')).not.toBeInTheDocument();
  });

  it('reuses one start request id across a retry after a network failure', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.startDailyChallenge
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ start: { sessionId: 'session-1' } } as never);

    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);
    const start = await screen.findByRole('button', {
      name: 'Start challenge',
    });
    fireEvent.click(start);
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
    fireEvent.click(screen.getByRole('button', { name: 'Start challenge' }));
    await waitFor(() =>
      expect(api.startDailyChallenge).toHaveBeenCalledTimes(2),
    );
    expect(api.startDailyChallenge.mock.calls[0]?.[1]).toBe(
      api.startDailyChallenge.mock.calls[1]?.[1],
    );
  });

  it('does not reuse a start request id after switching games', async () => {
    const response = (gameId: string) => ({
      challenge: {
        gameId,
        releaseId: `${gameId}-development`,
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: `daily-${gameId}`,
        setup: { playerCount: 1 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.getDailyChallengeToday.mockImplementation(async (gameId) =>
      response(gameId),
    );
    api.startDailyChallenge.mockRejectedValue(new Error('Offline'));
    createRequestIdMock
      .mockReturnValueOnce('request-brass')
      .mockReturnValueOnce('request-arnak');

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <GameDailyChallengePage gameId='brass-pittsburgh' />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start challenge' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <GameDailyChallengePage gameId='arnak' />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(api.getDailyChallengeToday).toHaveBeenLastCalledWith('arnak'),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start challenge' }),
    );
    await waitFor(() =>
      expect(api.startDailyChallenge).toHaveBeenCalledTimes(2),
    );
    expect(api.startDailyChallenge.mock.calls.map((call) => call[1])).toEqual([
      'request-brass',
      'request-arnak',
    ]);
  });

  it('does not reuse a start request id after switching accounts', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 1 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.startDailyChallenge.mockRejectedValue(new Error('Offline'));
    createRequestIdMock
      .mockReturnValueOnce('request-user-a')
      .mockReturnValueOnce('request-user-b');

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <GameDailyChallengePage gameId='brass-pittsburgh' />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start challenge' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');

    act(() =>
      useAuthStore.setState({
        user: { id: 'user-b' } as never,
        authEpoch: 1,
      }),
    );
    await waitFor(() =>
      expect(api.getDailyChallengeToday).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Start challenge' }),
    );
    await waitFor(() =>
      expect(api.startDailyChallenge).toHaveBeenCalledTimes(2),
    );
    expect(api.startDailyChallenge.mock.calls.map((call) => call[1])).toEqual([
      'request-user-a',
      'request-user-b',
    ]);
  });

  it('keeps a recoverable error state for a game page', async () => {
    api.getDailyChallengeToday.mockRejectedValueOnce(new Error('Offline'));
    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
    api.getDailyChallengeToday.mockResolvedValueOnce({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.getDailyChallengeLeaderboard.mockResolvedValueOnce([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() =>
      expect(screen.getAllByText('2026-10-26').length).toBeGreaterThan(0),
    );
  });

  it('refreshes today before retrying a leaderboard whose date changed', async () => {
    const challenge = (challengeDate: string) => ({
      gameId: 'brass-pittsburgh',
      releaseId: 'brass-development',
      modeId: 'daily-challenge',
      challengeDate,
      seed: `daily-${challengeDate}`,
      setup: { playerCount: 4 },
      settingsRevision: 1,
      createdAt: `${challengeDate}T00:00:00.000Z`,
    });
    api.getDailyChallengeToday
      .mockResolvedValueOnce({
        challenge: challenge('2026-10-26'),
        attempts: [],
        attemptCount: 0,
        leaderboards: undefined as never,
        historyDates: [],
        nextRefreshAt: '2026-10-27T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        challenge: challenge('2026-10-27'),
        attempts: [],
        attemptCount: 0,
        leaderboards: undefined as never,
        historyDates: [],
        nextRefreshAt: '2026-10-28T00:00:00.000Z',
      });
    api.getDailyChallengeLeaderboard
      .mockRejectedValueOnce(
        Object.assign(new Error('date changed'), {
          responseMessageKey: 'platform.daily.date_changed',
        }),
      )
      .mockResolvedValueOnce([]);
    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    expect(
      await screen.findByText(
        'The challenge date changed. Refresh today to load the current leaderboard.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh today' }));
    expect((await screen.findAllByText('2026-10-27')).length).toBeGreaterThan(
      0,
    );
    await waitFor(() =>
      expect(api.getDailyChallengeLeaderboard).toHaveBeenLastCalledWith(
        'brass-pittsburgh',
        '2026-10-27',
      ),
    );
  });

  it('scopes statistics requests and query identity by game', async () => {
    api.getPlayerStatistics.mockResolvedValue({
      globalStats: { totalSessions: 5, completedSessions: 3 },
      playerStats: { playedSessions: 2, wins: 1 },
      debug: 'secret implementation detail',
    });
    const queryClient = renderWithQuery(
      <GameStatisticsPage gameId='brass-pittsburgh' />,
    );

    expect(await screen.findByText('Wins')).toBeInTheDocument();
    expect(screen.getByText('All games')).toBeInTheDocument();
    expect(screen.getAllByText('Your games').length).toBeGreaterThan(0);
    expect(
      screen.queryByText('secret implementation detail'),
    ).not.toBeInTheDocument();
    expect(api.getPlayerStatistics).toHaveBeenCalledWith('brass-pittsburgh');
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual([
      'game',
      'brass-pittsburgh',
      'statistics',
      'player',
      0,
      'user-a',
    ]);
  });

  it('does not reuse another account’s daily attempt after auth changes', async () => {
    const response = (score: number) => ({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { playerCount: 4 },
        settingsRevision: 1,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempt: {
        attemptId: `attempt-${score}`,
        challengeDate: '2026-10-26',
        attemptNumber: 1,
        status: 'completed' as const,
        publicationState: 'pending' as const,
        score,
        updatedAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 1,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.getDailyChallengeToday
      .mockResolvedValueOnce(response(12))
      .mockResolvedValueOnce(response(48));
    api.getDailyChallengeLeaderboard.mockResolvedValue([]);
    renderWithQuery(<GameDailyChallengePage gameId='brass-pittsburgh' />);

    expect(await screen.findByText(/score 12, rank —/i)).toBeInTheDocument();
    act(() =>
      useAuthStore.setState({
        user: { id: 'user-b' } as never,
        authEpoch: 1,
      }),
    );
    expect(await screen.findByText(/score 48, rank —/i)).toBeInTheDocument();
    expect(api.getDailyChallengeToday).toHaveBeenCalledTimes(2);
  });

  it('renders game-owned daily challenge details through the renderer slot', async () => {
    api.getDailyChallengeToday.mockResolvedValue({
      challenge: {
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        modeId: 'daily-challenge',
        challengeDate: '2026-10-26',
        seed: 'daily-42',
        setup: { internalEngineSetting: 'do-not-display' },
        settingsRevision: 37,
        createdAt: '2026-10-26T00:00:00.000Z',
      },
      attempts: [],
      attemptCount: 0,
      leaderboards: emptyLeaderboards(),
      historyDates: [],
      nextRefreshAt: '2026-10-27T00:00:00.000Z',
    });
    api.getDailyChallengeLeaderboard.mockResolvedValue([]);
    renderWithQuery(
      <GameDailyChallengePage
        gameId='brass-pittsburgh'
        renderChallenge={({ challenge }) => <p>game-owned:{challenge.seed}</p>}
      />,
    );

    expect(await screen.findByText('game-owned:daily-42')).toBeInTheDocument();
    expect(screen.queryByText('do-not-display')).not.toBeInTheDocument();
    expect(screen.queryByText('37')).not.toBeInTheDocument();
  });

  it('keeps an edited settings draft and its revision through background refetch and save failure', async () => {
    api.getDailyChallengeSettings.mockResolvedValue({
      gameId: 'brass-pittsburgh',
      releaseId: 'brass-development',
      settings: { value: 'server' },
      revision: 4,
      updatedAt: '2026-10-26T00:00:00.000Z',
    });
    api.updateDailyChallengeSettings.mockRejectedValue(new Error('Conflict'));
    const queryClient = renderWithQuery(
      <GameDailyChallengeAdminPage
        gameId='brass-pittsburgh'
        renderSettings={SettingsEditor}
      />,
    );

    expect(await screen.findByTestId('settings-value')).toHaveTextContent(
      'server',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('settings-value')).toHaveTextContent('edited');

    api.getDailyChallengeSettings.mockResolvedValueOnce({
      gameId: 'brass-pittsburgh',
      releaseId: 'brass-development',
      settings: { value: 'new-server-value' },
      revision: 5,
      updatedAt: '2026-10-26T00:01:00.000Z',
    });
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: [
          'game',
          'brass-pittsburgh',
          'daily-challenge',
          'settings',
          0,
          'user-a',
        ],
      });
    });
    expect(screen.getByTestId('settings-value')).toHaveTextContent('edited');

    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflict');
    expect(screen.getByTestId('settings-value')).toHaveTextContent('edited');
    expect(api.updateDailyChallengeSettings).toHaveBeenCalledWith(
      'brass-pittsburgh',
      { settings: { value: 'edited' }, expectedRevision: 4 },
    );
  });

  it('does not save the previous game draft while the next game settings are pending', async () => {
    let resolveSecond:
      | ((value: PlatformDailyChallengeSettings) => void)
      | undefined;
    api.getDailyChallengeSettings
      .mockResolvedValueOnce({
        gameId: 'brass-pittsburgh',
        releaseId: 'brass-development',
        settings: { value: 'brass' },
        revision: 7,
        updatedAt: '2026-10-26T00:00:00.000Z',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      )
      .mockResolvedValue({
        gameId: 'arnak',
        releaseId: 'arnak-development',
        settings: { value: 'arnak' },
        revision: 8,
        updatedAt: '2026-10-26T00:02:00.000Z',
      });
    api.updateDailyChallengeSettings.mockResolvedValue({
      gameId: 'arnak',
      releaseId: 'arnak-development',
      settings: { value: 'arnak' },
      revision: 8,
      updatedAt: '2026-10-26T00:02:00.000Z',
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <GameDailyChallengeAdminPage
          gameId='brass-pittsburgh'
          renderSettings={SettingsEditor}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('brass')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <GameDailyChallengeAdminPage
          gameId='arnak'
          renderSettings={SettingsEditor}
        />
      </QueryClientProvider>,
    );
    resolveSecond?.({
      gameId: 'arnak',
      releaseId: 'arnak-development',
      settings: { value: 'arnak' },
      revision: 8,
      updatedAt: '2026-10-26T00:02:00.000Z',
    });
    expect(await screen.findByText('arnak')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() =>
      expect(api.updateDailyChallengeSettings).toHaveBeenCalled(),
    );
    expect(api.updateDailyChallengeSettings).toHaveBeenCalledWith('arnak', {
      settings: { value: 'edited' },
      expectedRevision: 8,
    });
  });
});
