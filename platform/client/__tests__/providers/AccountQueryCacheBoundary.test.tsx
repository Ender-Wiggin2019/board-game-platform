import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery';
import { AccountQueryCacheBoundary } from '@/providers/AccountQueryCacheBoundary';
import { useAuthStore } from '@/stores/authStore';

const ACCOUNT_QUERY_KEY = ['account-private-state'] as const;

function AccountPrivateState({
  load,
}: {
  load: (token: string) => Promise<string>;
}): React.JSX.Element {
  const token = useAuthStore((state) => state.token);
  const query = useQuery({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: () => load(token ?? ''),
    enabled: Boolean(token),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return <output>{query.data ?? 'loading'}</output>;
}

describe('AccountQueryCacheBoundary', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
  });

  it('removes the previous account cache before the next identity can render it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const load = vi.fn(() => new Promise<string>(() => undefined));
    useAuthStore.getState().login('token-a', {
      id: 'account-a',
      name: 'Ada',
      email: 'ada@example.com',
    });
    queryClient.setQueryData(ACCOUNT_QUERY_KEY, 'account-a-secret');

    render(
      <QueryClientProvider client={queryClient}>
        <AccountQueryCacheBoundary />
        <AccountPrivateState load={load} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('account-a-secret')).toBeInTheDocument();

    act(() => {
      useAuthStore.getState().login('token-b', {
        id: 'account-b',
        name: 'Grace',
        email: 'grace@example.com',
      });
      expect(queryClient.getQueryData(ACCOUNT_QUERY_KEY)).toBeUndefined();
    });

    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
    expect(screen.queryByText('account-a-secret')).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('token-b');
  });

  it('does not reuse or apply an in-flight request from the previous identity', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let resolveAccountA!: (value: string) => void;
    let resolveAccountB!: (value: string) => void;
    const load = vi.fn(
      (token: string) =>
        new Promise<string>((resolve) => {
          if (token === 'token-a') resolveAccountA = resolve;
          if (token === 'token-b') resolveAccountB = resolve;
        }),
    );
    useAuthStore.getState().login('token-a', {
      id: 'account-a',
      name: 'Ada',
      email: 'ada@example.com',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <AccountQueryCacheBoundary />
        <AccountPrivateState load={load} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledWith('token-a'));

    act(() => {
      useAuthStore.getState().login('token-b', {
        id: 'account-b',
        name: 'Grace',
        email: 'grace@example.com',
      });
    });
    await waitFor(() => expect(load).toHaveBeenCalledWith('token-b'));

    await act(async () => {
      resolveAccountA('account-a-secret');
      await Promise.resolve();
    });
    expect(screen.queryByText('account-a-secret')).not.toBeInTheDocument();

    act(() => resolveAccountB('account-b-secret'));
    expect(await screen.findByText('account-b-secret')).toBeInTheDocument();
  });

  it('clears account caches on a direct store logout', () => {
    const queryClient = new QueryClient();
    useAuthStore.getState().login('token-a', {
      id: 'account-a',
      name: 'Ada',
      email: 'ada@example.com',
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AccountQueryCacheBoundary />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(ACCOUNT_QUERY_KEY, 'account-a-secret');

    act(() => {
      useAuthStore.getState().logout();
      expect(queryClient.getQueryData(ACCOUNT_QUERY_KEY)).toBeUndefined();
    });
  });

  it('keeps account queries across token rotation but clears them on a new same-account login', () => {
    const queryClient = new QueryClient();
    const user = {
      id: 'account-a',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('token-a', user);
    render(
      <QueryClientProvider client={queryClient}>
        <AccountQueryCacheBoundary />
      </QueryClientProvider>,
    );
    queryClient.setQueryData(ACCOUNT_QUERY_KEY, 'account-a-secret');
    queryClient.setQueryData(accountProfileQueryKey(), user);

    const pendingRefresh = useAuthStore.getState();
    const player = { ...user, role: 'player' };
    act(() =>
      useAuthStore.getState().refreshSession('token-b', player, pendingRefresh),
    );
    expect(queryClient.getQueryData(ACCOUNT_QUERY_KEY)).toBe(
      'account-a-secret',
    );
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(player);

    const admin = { ...player, role: 'admin' };
    act(() => useAuthStore.getState().setUser(admin));
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(admin);

    act(() => useAuthStore.getState().login('token-c', user));
    expect(queryClient.getQueryData(ACCOUNT_QUERY_KEY)).toBeUndefined();
  });

  it('does not rewrite a profile already present in the query cache', () => {
    const queryClient = new QueryClient();
    const user = {
      id: 'account-a',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('token', user);
    render(
      <QueryClientProvider client={queryClient}>
        <AccountQueryCacheBoundary />
      </QueryClientProvider>,
    );

    const updated = { ...user, role: 'player' };
    queryClient.setQueryData(accountProfileQueryKey(), updated);
    const write = vi.spyOn(queryClient, 'setQueryData');
    act(() => useAuthStore.getState().setUser(updated));

    expect(write).not.toHaveBeenCalled();
  });
});
