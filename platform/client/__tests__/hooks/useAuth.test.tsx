import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/api/authApi.js';
import { useUpdatePreferences } from '@/hooks/useAuth.js';
import { useAuthStore } from '@/stores/authStore.js';

const accountA = {
  id: 'account-a',
  name: 'Ada',
  email: 'ada@example.test',
  role: 'player',
  preferences: { language: 'en' as const },
};

const accountB = {
  id: 'account-b',
  name: 'Grace',
  email: 'grace@example.test',
  role: 'player',
  preferences: { language: 'zh-CN' as const },
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  useAuthStore.getState().logout();
  vi.restoreAllMocks();
});

describe('useUpdatePreferences without a game extension', () => {
  it('reports pending while a generic account patch is in flight', async () => {
    useAuthStore.getState().login('token-a', accountA);
    const updatedUser = {
      ...accountA,
      preferences: { language: 'zh-CN' as const },
    };
    let resolveRequest!: (user: typeof updatedUser) => void;
    vi.spyOn(authApi, 'updatePreferences').mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const { result } = renderHook(() => useUpdatePreferences(), {
      wrapper: createWrapper(),
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ language: 'zh-CN' });
    });

    await waitFor(() => expect(result.current.isPending).toBe(true));
    await act(async () => {
      resolveRequest(updatedUser);
      await pending;
    });

    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(useAuthStore.getState().user?.preferences?.language).toBe('zh-CN');
  });

  it('exposes a current-account patch failure after the request settles', async () => {
    useAuthStore.getState().login('token-a', accountA);
    const failure = new Error('preferences unavailable');
    vi.spyOn(authApi, 'updatePreferences').mockRejectedValue(failure);

    const { result } = renderHook(() => useUpdatePreferences(), {
      wrapper: createWrapper(),
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ language: 'zh-CN' });
    });
    await act(async () => {
      await expect(pending).rejects.toThrow('preferences unavailable');
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.isError).toBe(true);
      expect(result.current.error).toBe(failure);
    });
  });

  it('ignores a stale failure after the account session changes', async () => {
    useAuthStore.getState().login('token-a', accountA);
    let rejectRequest!: (reason: Error) => void;
    vi.spyOn(authApi, 'updatePreferences').mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );

    const { result } = renderHook(() => useUpdatePreferences(), {
      wrapper: createWrapper(),
    });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.mutateAsync({ language: 'zh-CN' });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    act(() => useAuthStore.getState().login('token-b', accountB));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    await act(async () => {
      rejectRequest(new Error('account A request failed'));
      await expect(pending).rejects.toThrow('account A request failed');
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(useAuthStore.getState().user?.id).toBe(accountB.id);
  });
});
