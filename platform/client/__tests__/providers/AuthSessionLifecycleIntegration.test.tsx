import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient } from '@/api/httpClient';
import { emitSessionEnd } from '@/api/sessionEnd';
import type { IAuthUser } from '@/api/types';
import { useToastStore } from '@/components/ui/toastStore';
import i18n from '@/i18n';
import { AuthSessionBootstrap } from '@/providers/AuthSessionBootstrap';
import { SessionTerminationListener } from '@/providers/SessionTerminationListener';
import { useAuthStore } from '@/stores/authStore';

const userA: IAuthUser = {
  id: 'player-a',
  name: 'Player A',
  email: 'player-a@example.com',
  role: 'player',
};

const userB: IAuthUser = {
  id: 'player-b',
  name: 'Player B',
  email: 'player-b@example.com',
  role: 'player',
};

function tokenWithExpiry(secondsFromNow: number): string {
  return `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }))}.signature`;
}

function resetAuthState(): void {
  useAuthStore.setState({
    token: null,
    user: null,
    isAuthenticated: false,
    isRestoring: false,
    sessionExpired: false,
    authEpoch: 0,
  });
  useToastStore.setState({ toasts: [] });
}

function renderSessionProviders({
  bootstrap = false,
}: {
  bootstrap?: boolean;
} = {}): {
  view: ReturnType<typeof render>;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const children: ReactNode = bootstrap ? (
    <AuthSessionBootstrap>
      <div data-testid='session-ready' />
    </AuthSessionBootstrap>
  ) : (
    <div data-testid='session-ready' />
  );
  return {
    queryClient,
    view: render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          {children}
          <SessionTerminationListener />
        </QueryClientProvider>
      </I18nextProvider>,
    ),
  };
}

describe('real auth session lifecycle chain', () => {
  beforeEach(() => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(
      '__Host-seti-csrf=integration-csrf',
    );
    resetAuthState();
  });

  afterEach(() => {
    resetAuthState();
    vi.restoreAllMocks();
  });

  it('commits a cookie-backed cold-start refresh once through the real providers', async () => {
    const restoredToken = tokenWithExpiry(3_600);
    const commit = vi.spyOn(useAuthStore.getState(), 'refreshSession');
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: restoredToken, user: userA },
    });

    const { view } = renderSessionProviders({ bootstrap: true });
    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe(restoredToken);
      expect(useAuthStore.getState().user?.id).toBe(userA.id);
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[0]).toContain('/auth/refresh');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().authEpoch).toBe(1);
    view.unmount();
  });

  it('coalesces socket renewal with an overlapping HTTP request at the real transport seam', async () => {
    const currentToken = tokenWithExpiry(30);
    const renewedToken = tokenWithExpiry(3_600);
    useAuthStore.getState().login(currentToken, userA);

    let finishRefresh!: (response: {
      data: { accessToken: string; user: IAuthUser };
    }) => void;
    const refresh = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const requestAdapter = vi.fn(
      async (config: InternalAxiosRequestConfig) => ({
        config,
        data: { rooms: [] },
        status: 200,
        statusText: 'OK',
        headers: {},
      }),
    );
    const { view } = renderSessionProviders();

    act(() => {
      emitSessionEnd({ reason: 'server-disconnect' });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());

    const request = httpClient.get('/lobby/rooms', {
      adapter: requestAdapter,
    });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    expect(requestAdapter).not.toHaveBeenCalled();

    finishRefresh({ data: { accessToken: renewedToken, user: userA } });
    await expect(request).resolves.toMatchObject({
      data: { rooms: [] },
    });
    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe(renewedToken);
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestAdapter.mock.calls[0]?.[0].headers.Authorization).toBe(
      `Bearer ${renewedToken}`,
    );
    view.unmount();
  });

  it('does not let a stale refresh response erase a replacement account', async () => {
    const currentToken = tokenWithExpiry(3_600);
    const replacementToken = tokenWithExpiry(3_600);
    useAuthStore.getState().login(currentToken, userA);

    let finishRefresh!: (response: {
      data: { accessToken: string; user: IAuthUser };
    }) => void;
    vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['session-sentinel'], { value: 'keep' });
    const view = render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <SessionTerminationListener />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    act(() => {
      emitSessionEnd({ reason: 'server-disconnect' });
    });
    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledOnce();
    });

    act(() => {
      useAuthStore.getState().login(replacementToken, userB);
      finishRefresh({
        data: { accessToken: 'stale-token', user: userA },
      });
    });
    await waitFor(() => {
      expect(useAuthStore.getState().token).toBe(replacementToken);
      expect(useAuthStore.getState().user?.id).toBe(userB.id);
    });

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(queryClient.getQueryData(['session-sentinel'])).toEqual({
      value: 'keep',
    });
    expect(useToastStore.getState().toasts).toEqual([]);
    view.unmount();
  });
});
