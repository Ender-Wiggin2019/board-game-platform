import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthSessionLifecycle,
  type IAuthSessionLifecycleAdapter,
  type IAuthSessionSnapshot,
} from '@/api/authSessionLifecycle.js';
import type { ILoginResponse } from '@/api/types';

const user = {
  id: 'user-1',
  name: 'Ada',
  email: 'ada@example.com',
};

function createAdapter(
  refresh: IAuthSessionLifecycleAdapter['refresh'] = vi.fn(),
): {
  adapter: IAuthSessionLifecycleAdapter;
  state: IAuthSessionSnapshot;
} {
  const state: IAuthSessionSnapshot = {
    token: 'token-a',
    user,
    authEpoch: 1,
    isAuthenticated: true,
  };
  const authoritativeRefresh = vi.fn(async () => {
    const session = await refresh();
    state.token = session.token;
    state.user = session.user;
    state.isAuthenticated = Boolean(session.token && session.user);
    return session;
  });
  return {
    state,
    adapter: {
      readSession: () => ({
        ...state,
        user: state.user ? { ...state.user } : null,
      }),
      isCurrent: (requestSession) =>
        requestSession.isAuthenticated
          ? state.isAuthenticated &&
            requestSession.authEpoch === state.authEpoch &&
            requestSession.user?.id === state.user?.id
          : requestSession.token === state.token &&
            requestSession.authEpoch === state.authEpoch &&
            requestSession.user?.id === state.user?.id,
      refresh: authoritativeRefresh,
    },
  };
}

describe('AuthSessionLifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('shares one authoritative refresh for distinct captures of one session', async () => {
    let resolveRefresh!: (session: ILoginResponse) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ILoginResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { adapter, state } = createAdapter(refresh);
    const lifecycle = new AuthSessionLifecycle(adapter);
    const firstSession = lifecycle.capture();
    const secondSession = lifecycle.capture();

    const first = lifecycle.refresh(firstSession);
    const second = lifecycle.refresh(secondSession);
    expect(refresh).toHaveBeenCalledOnce();

    resolveRefresh({ token: 'token-b', user });
    await expect(first).resolves.toEqual({
      kind: 'refreshed',
      session: { token: 'token-b', user },
    });
    await expect(second).resolves.toEqual({
      kind: 'refreshed',
      session: { token: 'token-b', user },
    });
    expect(state.token).toBe('token-b');
  });

  it('returns stale without applying a response for a newer account', async () => {
    let rejectRefresh!: (error: unknown) => void;
    const refresh = vi.fn(
      () =>
        new Promise<ILoginResponse>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    const { adapter, state } = createAdapter(refresh);
    const lifecycle = new AuthSessionLifecycle(adapter);
    const requestSession = lifecycle.capture();
    const pending = lifecycle.refresh(requestSession);

    state.token = 'token-new';
    state.user = { ...user, id: 'user-2' };
    state.authEpoch = 2;
    rejectRefresh(new Error('Auth session changed'));

    await expect(pending).resolves.toEqual({ kind: 'stale' });
    expect(state.token).toBe('token-new');
  });

  it('accepts a transport commit that restores an anonymous snapshot', async () => {
    const refresh = vi.fn().mockResolvedValue({ token: 'token-b', user });
    const { adapter, state } = createAdapter(refresh);
    state.token = null;
    state.user = null;
    state.isAuthenticated = false;
    state.authEpoch = 0;
    const lifecycle = new AuthSessionLifecycle(adapter);

    await expect(lifecycle.refresh(lifecycle.capture())).resolves.toEqual({
      kind: 'refreshed',
      session: { token: 'token-b', user },
    });
    expect(state.token).toBe('token-b');
    expect(state.user).toEqual(user);
  });

  it('returns the shared retry plan and succeeds on the next attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          status: 429,
          retryAfterSeconds: 60,
        }),
      )
      .mockResolvedValueOnce({ token: 'token-b', user });
    const { adapter } = createAdapter(refresh);
    const lifecycle = new AuthSessionLifecycle(adapter);
    const requestSession = lifecycle.capture();

    await expect(lifecycle.refresh(requestSession)).resolves.toMatchObject({
      kind: 'retry',
      attempt: 1,
      retryAt: Date.now() + 60_000,
      retryNotBefore: Date.now() + 60_000,
    });
    await expect(lifecycle.refresh(requestSession)).resolves.toEqual({
      kind: 'refreshed',
      session: { token: 'token-b', user },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('classifies a definitive refresh failure without mutating session state', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('expired'), { status: 401 }));
    const { adapter, state } = createAdapter(refresh);
    const lifecycle = new AuthSessionLifecycle(adapter);

    await expect(lifecycle.refresh(lifecycle.capture())).resolves.toMatchObject(
      {
        kind: 'expired',
      },
    );
    expect(state.token).toBe('token-a');
  });
});
