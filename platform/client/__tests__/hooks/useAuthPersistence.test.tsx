import { ERole } from '@board-platform/contracts/auth/roles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/api/authApi.js';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery.js';
import {
  useCurrentUser,
  useLogin,
  useLogout,
  useRegister,
  useUpdatePreferences,
  useUpdateProfile,
} from '@/hooks/useAuth.js';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/api/authApi.js', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
    updateMe: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

const disconnectLocalPushNotifications = vi.fn();

vi.mock('@/lib/pushCleanup.js', () => ({
  disconnectLocalPushNotifications: () => disconnectLocalPushNotifications(),
}));

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useAuth user persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().logout();
    vi.mocked(authApi.logout).mockImplementation(async () => {
      useAuthStore.getState().logout();
    });
    disconnectLocalPushNotifications.mockReset();
    disconnectLocalPushNotifications.mockResolvedValue(undefined);
  });

  it.each(['logout', 'switch'])(
    'ignores profile updates after session %s',
    async (action) => {
      const user = {
        id: 'account',
        name: 'Me',
        email: 'me@test.com',
        role: 'guest',
      };
      const other = {
        id: 'other',
        name: 'Other',
        email: 'other@test.com',
        role: 'guest',
      };
      useAuthStore.getState().login('original-token', user);
      let resolve = (_value: Awaited<ReturnType<typeof authApi.updateMe>>) =>
        undefined as void;
      vi.mocked(authApi.updateMe).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const { result } = renderHook(() => useUpdateProfile(), {
        wrapper: createWrapper(),
      });
      act(() => result.current.mutate({ name: 'Updated' }));
      await waitFor(() => expect(authApi.updateMe).toHaveBeenCalled());
      act(() => {
        if (action === 'logout') useAuthStore.getState().logout();
        else useAuthStore.getState().login('other-token', other);
      });
      await act(async () => resolve({ ...user, name: 'Updated' }));
      expect(useAuthStore.getState().user?.id).toBe(
        action === 'logout' ? undefined : 'other',
      );
    },
  );

  it('keeps a newer role when a profile name update returns an older role', async () => {
    const guest = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('token', guest);
    let resolveUpdate!: (user: typeof guest) => void;
    vi.mocked(authApi.updateMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { result } = renderHook(() => useUpdateProfile(), {
      wrapper: createWrapper(),
    });
    act(() => result.current.mutate({ name: 'New Ada' }));
    await waitFor(() => expect(authApi.updateMe).toHaveBeenCalled());
    act(() => useAuthStore.getState().setUser({ ...guest, role: 'player' }));
    await act(async () => resolveUpdate({ ...guest, name: 'New Ada' }));

    expect(useAuthStore.getState().user).toMatchObject({
      name: 'New Ada',
      role: 'player',
    });
  });

  it('preserves the server role after login', async () => {
    vi.mocked(authApi.login).mockImplementation(async () => {
      const response = {
        token: 'jwt-token',
        user: {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.com',
          role: 'guest' as const,
        },
      };
      useAuthStore.getState().login(response.token, response.user);
      return response;
    });

    const { result } = renderHook(() => useLogin(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      result.current.mutate({
        email: 'ada@example.com',
        password: 'password123',
      });
    });

    await waitFor(() => {
      expect(useAuthStore.getState().user).toMatchObject({
        role: 'guest',
      });
    });
  });

  it('preserves the server role after registration', async () => {
    vi.mocked(authApi.register).mockImplementation(async () => {
      const response = {
        token: 'jwt-token',
        user: {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.com',
          role: 'guest' as const,
        },
      };
      useAuthStore.getState().login(response.token, response.user);
      return response;
    });

    const { result } = renderHook(() => useRegister(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      result.current.mutate({
        email: 'ada@example.com',
        name: 'Ada',
        password: 'password123456789',
        passwordConfirm: 'password123456789',
        consentVersion: 'account-registration-v1',
      });
    });

    await waitFor(() => {
      expect(useAuthStore.getState().user).toMatchObject({
        role: 'guest',
      });
    });
  });

  it('refreshes the stored role from the current-user endpoint', async () => {
    useAuthStore.getState().login('old-token', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    });
    vi.mocked(authApi.getMe).mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'admin',
    });

    renderHook(() => useCurrentUser(), {
      wrapper: createWrapper(),
    });

    await waitFor(() =>
      expect(useAuthStore.getState().user?.role).toBe('admin'),
    );
  });

  it('uses a refreshed session role when the profile cache still has the old role', () => {
    const guest = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('old-token', guest);
    const requestSession = useAuthStore.getState();
    const player = { ...guest, role: 'player' };
    useAuthStore.getState().refreshSession('new-token', player, requestSession);
    const client = new QueryClient();
    client.setQueryData(accountProfileQueryKey(), guest);

    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    expect(result.current.data?.role).toBe('player');
    expect(useAuthStore.getState().user?.role).toBe('player');
  });

  it('ignores an older profile response after a local permission update', async () => {
    const guest = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('token', guest);
    let resolveProfile!: (user: typeof guest) => void;
    vi.mocked(authApi.getMe).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProfile = resolve;
        }),
    );
    const { result } = renderHook(() => useCurrentUser(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(authApi.getMe).toHaveBeenCalled());
    const player = { ...guest, role: 'player' };
    act(() => useAuthStore.getState().setUser(player));
    await act(async () => resolveProfile(guest));

    expect(result.current.data?.role).toBe('player');
    expect(useAuthStore.getState().user?.role).toBe('player');
  });

  it('refreshes the session and projects the base role when Navigator access expires', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-10-22T12:00:00.000Z');
    vi.setSystemTime(now);
    const expiresAt = new Date(now.getTime() + 1_000).toISOString();
    const activeUser = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: ERole.NAVIGATOR,
      baseRole: ERole.PLAYER,
      navigator: {
        active: true,
        source: 'grant' as const,
        expiresAt,
      },
    };
    const expiredUser = {
      ...activeUser,
      role: ERole.PLAYER,
      navigator: {
        active: false,
        source: 'grant' as const,
        expiresAt,
      },
    };
    useAuthStore.getState().login('token', activeUser);
    vi.mocked(authApi.getMe)
      .mockResolvedValueOnce(activeUser)
      .mockResolvedValueOnce(expiredUser);

    try {
      renderHook(() => useCurrentUser(), {
        wrapper: createWrapper(),
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useAuthStore.getState().user?.role).toBe(ERole.NAVIGATOR);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(authApi.getMe).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toMatchObject({
        role: ERole.PLAYER,
        navigator: { active: false },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the current-user cache immediately after saving preferences', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const updatedUser = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'player',
      preferences: { emailTurnRemindersEnabled: false },
    };
    vi.mocked(authApi.updatePreferences).mockResolvedValue(updatedUser);
    useAuthStore.getState().login('token', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'player',
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdatePreferences(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ emailTurnRemindersEnabled: false });
    });

    expect(client.getQueryData(['auth', 'me'])).toEqual(updatedUser);
  });

  it('keeps a newer role when the fallback preference response has the old role', async () => {
    const guest = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
      preferences: { language: 'en' as const },
    };
    useAuthStore.getState().login('token', guest);
    let resolveUpdate!: (user: typeof guest) => void;
    vi.mocked(authApi.updatePreferences).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { result } = renderHook(() => useUpdatePreferences(), {
      wrapper: createWrapper(),
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ language: 'zh-CN' });
    });
    act(() => useAuthStore.getState().setUser({ ...guest, role: 'player' }));
    resolveUpdate({ ...guest, preferences: { language: 'en' } });
    await act(async () => pending);

    expect(useAuthStore.getState().user?.role).toBe('player');
  });

  it('does not apply a preference response from an obsolete account session', async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    let resolveRequest!: (user: {
      id: string;
      name: string;
      email: string;
      preferences: { language: 'en' };
    }) => void;
    vi.mocked(authApi.updatePreferences).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const accountB = {
      id: 'u2',
      name: 'Grace',
      email: 'grace@example.com',
      preferences: { language: 'zh-CN' as const },
    };
    useAuthStore.getState().login('token-a', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      preferences: { language: 'zh-CN' },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdatePreferences(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ language: 'en' });
    });
    act(() => {
      useAuthStore.getState().login('token-b', accountB);
      client.setQueryData(['auth', 'me'], accountB);
    });
    resolveRequest({
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      preferences: { language: 'en' },
    });
    await act(async () => {
      await pending;
    });

    expect(useAuthStore.getState().user).toEqual(accountB);
    expect(client.getQueryData(['auth', 'me'])).toEqual(accountB);
  });

  it('cleans the device before clearing the account session', async () => {
    useAuthStore.getState().login('token', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
    });
    const { result } = renderHook(() => useLogout(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current();
    });

    expect(disconnectLocalPushNotifications).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('does not clear a newer account cache after device cleanup finishes', async () => {
    useAuthStore.getState().login('token-a', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
    });
    let finishDisconnect!: () => void;
    disconnectLocalPushNotifications.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(['account-cache'], { account: 'a' });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLogout(), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current();
    });
    await waitFor(() =>
      expect(disconnectLocalPushNotifications).toHaveBeenCalled(),
    );

    act(() => {
      useAuthStore.getState().login('token-b', {
        id: 'u2',
        name: 'Grace',
        email: 'grace@example.com',
      });
      queryClient.setQueryData(['account-cache'], { account: 'b' });
      finishDisconnect();
    });
    await act(async () => pending);

    expect(queryClient.getQueryData(['account-cache'])).toEqual({
      account: 'b',
    });
  });
});
