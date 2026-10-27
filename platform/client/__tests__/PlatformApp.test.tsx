import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  Link,
  RouterProvider,
} from '@tanstack/react-router';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../src/api/authApi.js';
import {
  type PlatformSessionDirectoryRecord,
  platformApi,
} from '../src/api/platformApi.js';
import { platformGamesApi } from '../src/api/platformGamesApi.js';
import { pushApi } from '../src/api/pushApi.js';
import type {
  GameClientRegistration,
  GameLiveEntryProps,
} from '../src/GameClientRegistration.js';
import { createGameClientRegistry } from '../src/gameClientRegistry.js';
import { createPlatformRouter } from '../src/PlatformApp.js';
import { configurePlatformGameClientRegistry } from '../src/platform/gameClientRegistry.js';
import {
  createBrowserPlatformRuntime,
  type GameEntryRuntime,
} from '../src/runtime.js';
import { useAuthStore } from '../src/stores/authStore.js';

const user = {
  id: 'account-1',
  name: 'Shared Account',
  email: 'player@example.test',
  role: 'player',
  baseRole: 'player',
  preferences: { language: 'en' as const },
};
const clients: QueryClient[] = [];

vi.mock('../src/features/chat/PlatformSessionChat.js', () => ({
  PlatformSessionChat: ({ sessionId }: { sessionId: string }) => (
    <div data-testid='shared-session-chat'>{sessionId}</div>
  ),
}));

vi.mock('../src/api/platformPerformanceApi.js', () => ({
  platformPerformanceApi: {
    getSnapshot: vi.fn().mockResolvedValue({
      capturedAt: '2026-10-26T12:00:00.000Z',
      uptimeSeconds: 60,
      sampleWindowMs: 10_000,
      cpuPercent: null,
      memoryBytes: {
        rss: 1,
        heapUsed: 1,
        heapTotal: 1,
        external: 1,
        arrayBuffers: 1,
      },
      eventLoopLagMs: null,
    }),
  },
}));

function catalogGame(gameId: string) {
  return {
    metadata: {
      gameId,
      name: gameId.toUpperCase(),
      description: `${gameId} game`,
      themeId: gameId,
    },
    releaseId: `${gameId}-release`,
    capabilities: ['profile', 'achievements'] as const,
    policyVersions: [],
    assets: [],
  };
}

function gameWithRoutes(
  legacyRoutes: GameClientRegistration['legacyRoutes'],
): GameClientRegistration {
  return {
    gameId: 'example',
    metadata: { nameKey: 'example.name' },
    setup: {
      default: () => ({}),
      getPlayerCount: (_setup, fallback) => fallback,
      updatePlayerCount: (setup) => setup,
    },
    entry: { loadLive: async () => ({ default: () => <p>Example table</p> }) },
    legacyRoutes,
  };
}

async function showRoute(
  path: string,
  registrations: readonly GameClientRegistration[] = [],
  runtime: GameEntryRuntime = createBrowserPlatformRuntime(),
) {
  const registry = createGameClientRegistry(registrations);
  configurePlatformGameClientRegistry(registry);
  const router = createPlatformRouter(registry, runtime);
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(queries);
  await act(async () => {
    render(
      <QueryClientProvider client={queries}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  return router;
}

beforeEach(() => {
  useAuthStore.getState().logout();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(authApi, 'getMe').mockResolvedValue(user);
  vi.spyOn(pushApi, 'getConfig').mockResolvedValue({
    configured: false,
    publicKey: null,
    deviceCount: 0,
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  useAuthStore.getState().logout();
  vi.restoreAllMocks();
  configurePlatformGameClientRegistry(createGameClientRegistry());
});

describe('game workspaces', () => {
  beforeEach(() => {
    useAuthStore.getState().login('account-token', user);
    vi.spyOn(platformGamesApi, 'listGames').mockResolvedValue([
      catalogGame('alpha'),
      catalogGame('beta'),
    ]);
    vi.spyOn(platformGamesApi, 'getAchievements').mockImplementation(
      async (gameId) => ({
        gameId,
        principalId: user.id,
        definitionVersion: '1',
        items: [],
      }),
    );
    vi.spyOn(platformGamesApi, 'getProfile').mockImplementation(
      async (gameId) => ({
        gameId,
        principalId: user.id,
        displayName: `${gameId} player`,
      }),
    );
    vi.spyOn(platformApi, 'catalog').mockResolvedValue([]);
    vi.spyOn(platformApi, 'listInvitations').mockResolvedValue({ items: [] });
  });

  const game = (gameId: string): GameClientRegistration => ({
    ...gameWithRoutes([]),
    gameId,
    metadata: { nameKey: `games.${gameId}.name` },
  });

  it('browses and filters sessions across games without loading their clients', async () => {
    const sessions: PlatformSessionDirectoryRecord[] = ['alpha', 'beta'].map(
      (gameId) => ({
        sessionId: `${gameId}-session`,
        admissionId: `${gameId}-admission`,
        route: {
          gameId,
          modeId: 'casual',
          sessionId: `${gameId}-session`,
          releaseId: `${gameId}-retained-release`,
          backendBindingId: `${gameId}-backend`,
          storageBindingId: `${gameId}-storage`,
          ownershipEpoch: 'epoch-1',
        },
        visibility: 'private',
        participants: [
          {
            principalId: user.id,
            seatId: 'seat-1',
            publicProfile: { displayName: 'Shared Account' },
          },
        ],
        status: 'active',
        latestAggregateSequence: 1,
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    vi.spyOn(platformApi, 'listSessions').mockImplementation(
      async (params) => ({
        items: sessions
          .filter(
            (session) =>
              !params?.gameId || session.route.gameId === params.gameId,
          )
          .map((session) => ({
            ...session,
            status: params?.status ?? 'active',
          })),
      }),
    );

    await showRoute('/platform/sessions');

    expect(
      await screen.findByRole('heading', { name: 'Your tables' }),
    ).toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: 'Resume' })).toHaveLength(
      2,
    );
    expect(platformApi.listSessions).toHaveBeenCalledWith({
      scope: 'mine',
      status: 'active',
      limit: 20,
    });
    expect(platformApi.catalog).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole('article').map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining('ALPHA'),
      expect.stringContaining('BETA'),
    ]);

    fireEvent.change(screen.getByRole('combobox', { name: 'Game' }), {
      target: { value: 'beta' },
    });
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    expect(screen.getByRole('link', { name: 'Resume' })).toHaveAttribute(
      'href',
      '/game/beta-session',
    );
    expect(platformApi.listSessions).toHaveBeenLastCalledWith({
      gameId: 'beta',
      scope: 'mine',
      status: 'active',
      limit: 20,
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'History status' }), {
      target: { value: 'completed' },
    });
    expect(
      await screen.findByRole('link', { name: 'View result' }),
    ).toHaveAttribute('href', '/game/beta-session/end');
    expect(
      screen.queryByRole('link', { name: 'Resume' }),
    ).not.toBeInTheDocument();
  });

  it('renders a home game catalog and opens the chosen game lobby', async () => {
    const router = await showRoute('/', [game('alpha'), game('beta')]);
    expect(
      await screen.findByRole('heading', { name: 'Choose your next game' }),
    ).toBeInTheDocument();
    const alpha = await screen.findByRole('link', { name: /ALPHA/ });
    expect(alpha).toHaveAttribute('href', '/games/alpha/lobby');
    fireEvent.click(alpha);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/games/alpha/lobby'),
    );
    expect(
      await screen.findByRole('heading', { name: 'ALPHA' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'BETA' }),
    ).not.toBeInTheDocument();
  });

  it('keeps game identity in the URL when switching tabs and shares the catalog query', async () => {
    const router = await showRoute('/games/beta/profile', [
      game('alpha'),
      game('beta'),
    ]);
    expect(await screen.findByText('beta player')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Achievements' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/games/beta/achievements'),
    );
    await waitFor(() =>
      expect(platformGamesApi.getAchievements).toHaveBeenCalledWith('beta', {
        principalId: user.id,
      }),
    );
    expect(platformGamesApi.listGames).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: 'ALPHA' }),
    ).not.toBeInTheDocument();
  });

  it('keeps a public profile identity when switching game profile tabs', async () => {
    const router = await showRoute('/games/beta/profile?principalId=other', [
      game('beta'),
    ]);
    expect(await screen.findByText('beta player')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Achievements' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ principalId: 'other' }),
    );
    await waitFor(() =>
      expect(platformGamesApi.getAchievements).toHaveBeenCalledWith('beta', {
        principalId: 'other',
      }),
    );
  });

  it('keeps profile content and navigation usable after a catalog refresh failure', async () => {
    await showRoute('/games/beta/profile', [game('beta')]);
    expect(await screen.findByText('beta player')).toBeInTheDocument();
    vi.mocked(platformGamesApi.listGames).mockRejectedValueOnce(
      new Error('Offline'),
    );
    await act(async () => {
      await clients.at(-1)?.refetchQueries({ queryKey: ['platform', 'games'] });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update.',
    );
    expect(screen.getByText('beta player')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Achievements' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });

  it('keeps the last loaded profile visible and retries a failed data refresh', async () => {
    await showRoute('/games/beta/profile', [game('beta')]);
    expect(await screen.findByText('beta player')).toBeInTheDocument();
    vi.mocked(platformGamesApi.getProfile).mockRejectedValueOnce(
      new Error('Offline'),
    );
    await act(async () => {
      await clients
        .at(-1)
        ?.refetchQueries({ queryKey: ['platform', 'game-profile'] });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update.',
    );
    expect(screen.getByText('beta player')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });

  it('distinguishes a locked achievement catalog from an empty catalog', async () => {
    vi.mocked(platformGamesApi.getAchievements).mockResolvedValue({
      gameId: 'beta',
      principalId: user.id,
      definitionVersion: '1',
      items: [
        {
          achievementId: 'first-step',
          title: 'First step',
          description: 'Complete one round.',
          tier: 'bronze',
          progress: 0,
          target: 1,
          unlocked: false,
        },
      ],
    });

    await showRoute('/games/beta/achievements', [game('beta')]);

    expect(
      await screen.findByText('No achievements unlocked yet.'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('0 / 1')).not.toHaveLength(0);
  });

  it('does not substitute another game for an unavailable deep link', async () => {
    await showRoute('/games/missing/achievements', [game('alpha')]);
    expect(
      await screen.findByText('This game is not available.'),
    ).toBeInTheDocument();
    expect(platformGamesApi.getAchievements).not.toHaveBeenCalled();
  });

  it('does not query profile data for a registered game absent from the catalog', async () => {
    vi.mocked(platformGamesApi.listGames).mockResolvedValueOnce([
      catalogGame('alpha'),
    ]);
    await showRoute('/games/beta/profile', [game('beta')]);
    expect(
      await screen.findByText('This game is not available.'),
    ).toBeInTheDocument();
    expect(platformGamesApi.getProfile).not.toHaveBeenCalled();
  });

  it('redirects old game-qualified profile links into the same workspace', async () => {
    const router = await showRoute(
      '/platform/profile?gameId=beta&tab=achievements&principalId=other',
      [game('beta')],
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/games/beta/achievements'),
    );
    await waitFor(() =>
      expect(platformGamesApi.getAchievements).toHaveBeenCalledWith('beta', {
        principalId: 'other',
      }),
    );
  });

  it('does not load game administration for a player, including a direct link', async () => {
    const load = vi.fn(async () => ({
      default: () => <p>Game maintenance</p>,
    }));
    await showRoute('/games/alpha/admin/skins', [
      {
        ...game('alpha'),
        administration: [{ id: 'skins', labelKey: 'Skins', load }],
      },
    ]);
    expect(
      await screen.findByText('This section is not available.'),
    ).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('link', { name: 'Game administration' }),
    ).not.toBeInTheDocument();
  });

  it('loads only the requested registered administration page for an administrator', async () => {
    const admin = { ...user, role: 'admin', baseRole: 'admin' };
    vi.mocked(authApi.getMe).mockResolvedValue(admin);
    useAuthStore.getState().login('admin-token', admin);
    const load = vi.fn(async () => ({
      default: () => <p>Game maintenance</p>,
    }));
    const other = vi.fn(async () => ({
      default: () => <p>Unused maintenance</p>,
    }));
    await showRoute('/games/alpha/admin/skins', [
      {
        ...game('alpha'),
        administration: [
          { id: 'overview', labelKey: 'Overview', load: other },
          { id: 'skins', labelKey: 'Skins', load },
        ],
      },
    ]);
    expect(await screen.findByText('Game maintenance')).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it('supports the game-admin alias and redirects the game root to its first page', async () => {
    const admin = { ...user, role: 'admin', baseRole: 'admin' };
    vi.mocked(authApi.getMe).mockResolvedValue(admin);
    useAuthStore.getState().login('admin-token', admin);
    const load = vi.fn(async () => ({
      default: () => <p>Brass maintenance</p>,
    }));
    const registration = {
      ...game('alpha'),
      administration: [{ id: 'overview', labelKey: 'Overview', load }],
    };

    const router = await showRoute('/admin/alpha', [registration]);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/admin/alpha/overview'),
    );
    expect(await screen.findByText('Brass maintenance')).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps /admin as the platform administration entry point', async () => {
    const admin = { ...user, role: 'admin', baseRole: 'admin' };
    vi.mocked(authApi.getMe).mockResolvedValue(admin);
    useAuthStore.getState().login('admin-token', admin);

    await showRoute('/admin', []);

    expect(
      await screen.findByRole('heading', { name: 'Platform administration' }),
    ).toBeInTheDocument();
  });

  it('serves platform performance from the admin route', async () => {
    const admin = { ...user, role: 'admin', baseRole: 'admin' };
    vi.mocked(authApi.getMe).mockResolvedValue(admin);
    useAuthStore.getState().login('admin-token', admin);

    await showRoute('/admin/performance', []);

    expect(
      await screen.findByRole('heading', { name: 'Platform performance' }),
    ).toBeInTheDocument();
  });
});

describe('platform routes without SETI installed', () => {
  it('navigates from game contributions to account settings through the same router', async () => {
    useAuthStore.getState().login('account-token', user);
    const game = gameWithRoutes([{ pathPrefix: '/example-menu' }]);
    const router = await showRoute('/example-menu', [
      {
        ...game,
        createRoutes: ({ rootRoute }) => [
          createRoute({
            getParentRoute: () => rootRoute,
            path: '/example-menu',
            component: () => <Link to='/account'>Open shared account</Link>,
          }),
        ],
      },
    ]);
    fireEvent.click(
      await screen.findByRole('link', { name: 'Open shared account' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Account settings' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
  });

  it('uses the installed game’s public route policy', async () => {
    await showRoute('/example-help', [
      gameWithRoutes([
        {
          pathPrefix: '/example-help',
          access: 'public',
          load: async () => ({ default: () => <p>Example help</p> }),
        },
      ]),
    ]);
    expect(await screen.findByText('Example help')).toBeInTheDocument();
    expect(authApi.getMe).not.toHaveBeenCalled();
  });

  it('permits a game’s account contribution before play access is granted', async () => {
    const guest = { ...user, role: 'guest', baseRole: 'guest' };
    vi.mocked(authApi.getMe).mockResolvedValue(guest);
    useAuthStore.getState().login('account-token', guest);
    await showRoute('/example-account', [
      gameWithRoutes([
        {
          pathPrefix: '/example-account',
          access: 'authenticated',
          load: async () => ({ default: () => <p>Example account setup</p> }),
        },
      ]),
    ]);
    expect(
      await screen.findByText('Example account setup'),
    ).toBeInTheDocument();
  });

  it('resolves a game’s sign-in destination without knowing its search fields', async () => {
    useAuthStore.getState().login('account-token', user);
    const game = gameWithRoutes([
      {
        pathPrefix: '/example-setup',
        load: async () => ({ default: () => <p>Example setup</p> }),
      },
    ]);
    const router = await showRoute('/auth?invite=abc', [
      {
        ...game,
        account: {
          resolveSignInReturnTo: (search) =>
            search.invite === 'abc' ? '/example-setup' : undefined,
        },
      },
    ]);
    expect(await screen.findByText('Example setup')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/example-setup');
  });

  it('opens the real login page with an empty game registry', async () => {
    await showRoute('/auth');
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Friends/ })).toBeNull();
    expect(authApi.getMe).not.toHaveBeenCalled();
  });

  it('loads a retained game entry only after an explicit session-not-found result', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const load = vi.fn(async () => ({
      default: () => <p>Retained game entry</p>,
    }));
    const get = vi.fn().mockRejectedValue({
      response: {
        data: {
          code: 'NOT_FOUND',
          messageKey: 'platform.gateway.session.notFound',
        },
      },
    });
    await showRoute(
      '/game/retained-session',
      [gameWithRoutes([{ pathPrefix: '/game', load }])],
      {
        ...runtime,
        http: { ...runtime.http, get },
      },
    );
    expect(await screen.findByText('Retained game entry')).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
  });

  it('routes a retained replay entry only after an explicit replay not-found result', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const load = vi.fn(async () => ({
      default: () => <p>Retained replay entry</p>,
    }));
    const get = vi.fn().mockRejectedValue({
      response: {
        data: {
          code: 'NOT_FOUND',
          messageKey: 'platform.gateway.session.notFound',
        },
      },
    });
    await showRoute(
      '/game/retained-session/replay',
      [gameWithRoutes([{ pathPrefix: '/game', load }])],
      {
        ...runtime,
        http: { ...runtime.http, get },
      },
    );
    expect(
      await screen.findByText('Retained replay entry'),
    ).toBeInTheDocument();
    expect(load).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      '/platform/sessions/retained-session/replay/route',
    );
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/retained-session/route',
    );
  });

  it('does not route a forbidden replay probe into a retained live entry', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const load = vi.fn(async () => ({
      default: () => <p>Retained replay entry</p>,
    }));
    const get = vi.fn().mockRejectedValue({
      response: {
        data: {
          code: 'FORBIDDEN',
          messageKey: 'platform.gateway.session.forbidden',
        },
      },
    });
    await showRoute(
      '/game/private-session/replay',
      [gameWithRoutes([{ pathPrefix: '/game', load }])],
      {
        ...runtime,
        http: { ...runtime.http, get },
      },
    );
    expect(
      await screen.findByRole('dialog', { name: 'This did not complete' }),
    ).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(
      '/platform/sessions/private-session/replay/route',
    );
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/private-session/route',
    );
  });

  it('does not switch game authority after an authorization failure', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const load = vi.fn(async () => ({
      default: () => <p>Retained game entry</p>,
    }));
    const get = vi.fn().mockRejectedValue(
      Object.assign(new Error('Access denied'), {
        response: {
          status: 403,
          data: { code: 'FORBIDDEN', messageKey: 'platform.gateway.forbidden' },
        },
      }),
    );
    await showRoute(
      '/game/private-session',
      [gameWithRoutes([{ pathPrefix: '/game', load }])],
      {
        ...runtime,
        http: { ...runtime.http, get },
      },
    );
    expect(
      await screen.findByRole('dialog', { name: 'This did not complete' }),
    ).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps account security and sign-out available without any game', async () => {
    useAuthStore.getState().login('account-token', user);
    await showRoute('/account');
    expect(
      await screen.findByRole('heading', { name: 'Account settings' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Display name')).toHaveValue('Shared Account');
    expect(
      screen.getByRole('button', { name: 'Change password' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sign out' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Friends/ })).toBeNull();
  });

  it('loads another registered game directly from its authoritative route', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const route = {
      gameId: 'brass',
      modeId: 'casual-multiplayer',
      releaseId: 'brass-test',
      sessionId: 'session-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const get = vi.fn().mockResolvedValue({
      data: { authority: 'platform', status: 'active', route },
    });
    const loadLive = vi.fn(async () => ({
      default: ({ runtime: entryRuntime }: { runtime: GameEntryRuntime }) => (
        <p>Brass table: {entryRuntime.viewer.principalId}</p>
      ),
    }));
    const registration: GameClientRegistration = {
      gameId: 'brass',
      metadata: { nameKey: 'brass.name' },
      setup: {
        default: () => ({}),
        getPlayerCount: (_setup, fallback) => fallback,
        updatePlayerCount: (setup) => setup,
      },
      entry: { loadLive },
    };
    await showRoute('/game/session-1', [registration], {
      ...runtime,
      http: { ...runtime.http, get },
    });
    expect(
      await screen.findByText('Brass table: account-1'),
    ).toBeInTheDocument();
    await waitFor(() => expect(loadLive).toHaveBeenCalledOnce());
    expect(get).toHaveBeenCalledWith('/platform/sessions/session-1/route');
    expect(await screen.findByTestId('shared-session-chat')).toHaveTextContent(
      'session-1',
    );
  });

  it.each([
    { path: '/game/session-1', sessionChat: 'game' as const, status: 'active' },
    {
      path: '/game/session-1/spectate',
      sessionChat: 'platform' as const,
      status: 'active',
    },
    {
      path: '/game/session-1',
      sessionChat: 'platform' as const,
      status: 'cancelled',
    },
  ])(
    'does not mount shared chat for $path / $sessionChat / $status',
    async ({ path, sessionChat, status }) => {
      useAuthStore.getState().login('account-token', user);
      const runtime = createBrowserPlatformRuntime();
      const route = {
        gameId: 'example',
        modeId: 'multiplayer',
        releaseId: 'example-test',
        sessionId: 'session-1',
        backendBindingId: 'backend-1',
        storageBindingId: 'storage-1',
        ownershipEpoch: '1',
      };
      await showRoute(path, [{ ...gameWithRoutes([]), sessionChat }], {
        ...runtime,
        http: {
          ...runtime.http,
          get: vi.fn().mockResolvedValue({
            data: { authority: 'platform', status, route },
          }),
        },
      });
      expect(await screen.findByText('Example table')).toBeInTheDocument();
      expect(screen.queryByTestId('shared-session-chat')).toBeNull();
    },
  );

  it('loads the resolved game globals for a native session route', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const route = {
      gameId: 'seti',
      modeId: 'casual-multiplayer',
      releaseId: 'seti-test',
      sessionId: 'session-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const get = vi.fn().mockResolvedValue({
      data: { authority: 'platform', status: 'active', route },
    });
    const globalsProps: Array<{ gameId?: string; scope?: string }> = [];
    const loadGlobals = vi.fn(async () => ({
      default: (props: { gameId?: string; scope?: string }) => {
        globalsProps.push(props);
        return <p>SETI globals</p>;
      },
    }));
    const registration: GameClientRegistration = {
      gameId: 'seti',
      metadata: { nameKey: 'seti.name' },
      setup: {
        default: () => ({}),
        getPlayerCount: (_setup, fallback) => fallback,
        updatePlayerCount: (setup) => setup,
      },
      applicationGlobals: loadGlobals,
      applicationGlobalsWhen: () => false,
      entry: {
        loadLive: async () => ({ default: () => <p>SETI table</p> }),
      },
    };
    await showRoute('/game/session-1', [registration], {
      ...runtime,
      http: { ...runtime.http, get },
    });

    expect(await screen.findByText('SETI globals')).toBeInTheDocument();
    expect(await screen.findByText('SETI table')).toBeInTheDocument();
    expect(loadGlobals).toHaveBeenCalledOnce();
    expect(globalsProps).toContainEqual(
      expect.objectContaining({ gameId: 'seti', scope: 'session' }),
    );
  });

  it('does not load a replay entry when the client disables replay', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const route = {
      gameId: 'chronologic',
      modeId: 'direct-solo',
      releaseId: 'chronologic-test',
      sessionId: 'session-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const get = vi.fn().mockResolvedValue({
      data: { authority: 'platform', status: 'completed', route },
    });
    const loadReplay = vi.fn(async () => ({
      default: () => <p>Chronologic replay</p>,
    }));
    const registration: GameClientRegistration = {
      gameId: 'chronologic',
      metadata: { nameKey: 'chronologic.name' },
      setup: {
        default: () => ({}),
        getPlayerCount: (_setup, fallback) => fallback,
        updatePlayerCount: (setup) => setup,
      },
      capabilities: { replay: false },
      entry: {
        loadLive: async () => ({ default: () => <p>Chronologic live</p> }),
        loadReplay,
      },
    };

    await showRoute('/game/session-1/replay', [registration], {
      ...runtime,
      http: { ...runtime.http, get },
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(loadReplay).not.toHaveBeenCalled();
  });

  it('binds replay entries to the read-only replay gateway', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const route = {
      gameId: 'chronologic',
      modeId: 'direct-solo',
      releaseId: 'chronologic-test',
      sessionId: 'session-replay',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const get = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/replay/route'))
        return { data: { authority: 'platform', status: 'completed', route } };
      if (url.endsWith('/replay/view'))
        return {
          data: {
            protocolVersion: 1,
            response: {
              gameId: route.gameId,
              sessionId: route.sessionId,
              releaseId: route.releaseId,
              viewSchemaVersion: 1,
              audienceKey: 'replay',
              viewEpoch: route.ownershipEpoch,
              baseRevision: 1,
              revision: 1,
              streamCursor: 'replay:1',
              kind: 'snapshot',
              payload: {},
            },
          },
        };
      throw new Error(`unexpected replay GET: ${url}`);
    });
    const post = vi.fn();
    const loadReplay = vi.fn(async () => ({
      default: ({
        route: replayRoute,
        runtime: entryRuntime,
      }: {
        readonly route: GameLiveEntryProps['route'];
        readonly runtime: GameEntryRuntime;
      }) => {
        useEffect(() => {
          void entryRuntime.session
            .createTransport(replayRoute)
            .getPlayerView({ protocolVersion: 1, route: replayRoute });
        }, [entryRuntime, replayRoute]);
        return <p>Replay table</p>;
      },
    }));
    const applicationGlobals = vi.fn(async () => ({
      default: ({
        runtime: globalsRuntime,
      }: {
        readonly runtime: GameEntryRuntime;
      }) => {
        useEffect(() => {
          void globalsRuntime.session
            .createTransport(route)
            .getPlayerView({ protocolVersion: 1, route })
            .catch(() => undefined);
        }, [globalsRuntime]);
        return <span data-testid='replay-globals' />;
      },
    }));
    const registration: GameClientRegistration = {
      gameId: 'chronologic',
      metadata: { nameKey: 'chronologic.name' },
      setup: {
        default: () => ({}),
        getPlayerCount: (_setup, fallback) => fallback,
        updatePlayerCount: (setup) => setup,
      },
      entry: {
        loadLive: async () => ({ default: () => <p>Chronologic live</p> }),
        loadReplay,
      },
      applicationGlobals,
    };

    await showRoute('/game/session-replay/replay', [registration], {
      ...runtime,
      http: { ...runtime.http, get, post },
    });

    expect(await screen.findByText('Replay table')).toBeInTheDocument();
    expect(await screen.findByTestId('replay-globals')).toBeInTheDocument();
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/platform/sessions/session-replay/replay/view',
      ),
    );
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/session-replay/route',
    );
    expect(get).not.toHaveBeenCalledWith(
      '/platform/sessions/session-replay/view',
    );
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shared-session-chat')).toBeNull();
  });

  it('contains an async game failure inside the session route boundary', async () => {
    useAuthStore.getState().login('account-token', user);
    const runtime = createBrowserPlatformRuntime();
    const route = {
      gameId: 'async-game',
      modeId: 'standard',
      releaseId: 'async-v1',
      sessionId: 'session-async',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const get = vi.fn().mockResolvedValue({
      data: { authority: 'platform', status: 'active', route },
    });
    const registration: GameClientRegistration = {
      gameId: 'async-game',
      metadata: { nameKey: 'async-game.name' },
      setup: {
        default: () => ({}),
        getPlayerCount: (_setup, fallback) => fallback,
        updatePlayerCount: (setup) => setup,
      },
      entry: {
        loadLive: async () => ({
          default: ({ runtime: entryRuntime }: GameLiveEntryProps) => {
            useEffect(() => {
              entryRuntime.reportError?.(new Error('async game failure'));
            }, [entryRuntime]);
            return <p>Async game table</p>;
          },
        }),
      },
    };

    await showRoute('/game/session-async', [registration], {
      ...runtime,
      http: { ...runtime.http, get },
    });

    expect(
      await screen.findByText('This game page is unavailable.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to game lobby' }),
    ).toHaveAttribute('href', '/games/async-game/lobby');
  });
});
