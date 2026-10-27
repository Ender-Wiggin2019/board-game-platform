import type { SessionRoute } from '@board-game/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '../src/api/authApi.js';
import { httpClient } from '../src/api/httpClient.js';
import { createBrowserPlatformRuntime } from '../src/runtime.js';
import { useAuthStore } from '../src/stores/authStore.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAuthStore.getState().logout();
});

describe('browser platform runtime', () => {
  it('uses the shared authenticated account store without a game installed', async () => {
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
      data: {
        accessToken: 'access-token',
        user: {
          id: 'user-1',
          name: 'Player One',
          email: 'player@example.test',
          role: 'player',
          baseRole: 'player',
        },
      },
    });
    const first = createBrowserPlatformRuntime();
    const second = createBrowserPlatformRuntime();
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    const session = await authApi.login({
      email: 'player@example.test',
      password: 'password',
    });
    expect(session.user?.id).toBe('user-1');
    expect(second.viewer.principalId).toBe('user-1');
    expect(second.viewer.identityKey).toBe(first.viewer.identityKey);
    await authApi.logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      '/auth/login',
      '/auth/logout',
    ]);
  });

  it('uses a selected seat when direct sessions exchange a player credential', async () => {
    const route: SessionRoute = {
      gameId: 'brass',
      modeId: 'standard',
      releaseId: 'brass-v1',
      sessionId: 'session-direct',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
      data: {
        playerEndpoint: 'https://game.example.test/player',
        route,
        token: 'player-token-123456789',
        expiresAt: Date.now() + 60_000,
        client: { endpoint: 'https://game.example.test/player', route },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocolVersion: 1,
              response: {
                gameId: route.gameId,
                sessionId: route.sessionId,
                releaseId: route.releaseId,
                viewSchemaVersion: 1,
                audienceKey: 'seat:2',
                viewEpoch: route.ownershipEpoch,
                baseRevision: 1,
                revision: 1,
                streamCursor: 'cursor-1',
                kind: 'snapshot',
                payload: {},
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const runtime = createBrowserPlatformRuntime({ directSessions: true });
    const transport = runtime.session.createTransport(route, 'seat-2');
    await transport.getPlayerView({ protocolVersion: 1, route });

    expect(post).toHaveBeenCalledWith(
      '/platform/sessions/session-direct/connection',
      { mode: 'player' },
      {
        showServerUpdateDialog: false,
        params: { seatId: 'seat-2' },
      },
    );
  });

  it('selects viewer mode only through the entry runtime mode adapter', async () => {
    const route: SessionRoute = {
      gameId: 'brass',
      modeId: 'standard',
      releaseId: 'brass-v1',
      sessionId: 'session-viewer',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    };
    const post = vi.spyOn(httpClient, 'post').mockResolvedValue({
      data: {
        playerEndpoint: 'https://game.example.test/player',
        route,
        token: 'viewer-token-123456789',
        expiresAt: Date.now() + 60_000,
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ protocolVersion: 1, response: {} }), {
            status: 200,
          }),
      ),
    );

    const { withPlatformConnectionMode } = await import('../src/runtime.js');
    const runtime = withPlatformConnectionMode(
      createBrowserPlatformRuntime({ directSessions: true }),
      'viewer',
    );
    await runtime.session.createTransport(route).getPlayerView({
      protocolVersion: 1,
      route,
    });

    expect(post).toHaveBeenCalledWith(
      '/platform/sessions/session-viewer/connection',
      { mode: 'viewer' },
      { showServerUpdateDialog: false },
    );
  });
});
