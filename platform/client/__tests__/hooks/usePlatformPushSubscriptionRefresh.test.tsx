import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAuthUser } from '../../src/api/types.js';
import { usePlatformPushSubscriptionRefresh } from '../../src/hooks/usePlatformPushSubscriptionRefresh.js';
import { useAuthStore } from '../../src/stores/authStore.js';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  refreshPushSubscription: vi.fn(),
  currentUser: undefined as IAuthUser | undefined,
}));

vi.mock('../../src/api/pushApi.js', () => ({
  pushApi: { getConfig: mocks.getConfig },
}));

vi.mock('../../src/lib/pushNotifications.js', () => ({
  refreshPushSubscription: mocks.refreshPushSubscription,
}));

vi.mock('../../src/hooks/useAuth.js', () => ({
  useCurrentUser: () => ({ data: mocks.currentUser }),
}));

const accountA: IAuthUser = {
  id: 'account-a',
  name: 'Ada',
  email: 'ada@example.test',
  role: 'player',
  preferences: { pushNotificationsEnabled: true },
};

const accountB: IAuthUser = {
  id: 'account-b',
  name: 'Grace',
  email: 'grace@example.test',
  role: 'player',
  preferences: { pushNotificationsEnabled: true },
};

const configured = {
  configured: true,
  publicKey: 'test-public-key',
  deviceCount: 1,
};

beforeEach(() => {
  useAuthStore.getState().logout();
  mocks.getConfig.mockReset();
  mocks.refreshPushSubscription.mockReset();
  mocks.getConfig.mockResolvedValue(configured);
  mocks.currentUser = undefined;
});

afterEach(() => {
  act(() => useAuthStore.getState().logout());
});

describe('usePlatformPushSubscriptionRefresh', () => {
  it('refreshes an enabled account subscription', async () => {
    mocks.currentUser = accountA;
    useAuthStore.getState().login('token-a', accountA);

    renderHook(() => usePlatformPushSubscriptionRefresh());

    await waitFor(() =>
      expect(mocks.refreshPushSubscription).toHaveBeenCalledWith(
        'test-public-key',
      ),
    );
  });

  it('does not refresh an account after its session changes', async () => {
    let resolveAccountA!: (value: typeof configured) => void;
    let resolveAccountB!: (value: typeof configured) => void;
    mocks.getConfig
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAccountA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveAccountB = resolve;
          }),
      );

    mocks.currentUser = accountA;
    useAuthStore.getState().login('token-a', accountA);
    renderHook(() => usePlatformPushSubscriptionRefresh());
    await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledTimes(1));

    mocks.currentUser = accountB;
    act(() => useAuthStore.getState().login('token-b', accountB));
    await waitFor(() => expect(mocks.getConfig).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveAccountA(configured);
      await Promise.resolve();
    });
    expect(mocks.refreshPushSubscription).not.toHaveBeenCalled();

    await act(async () => {
      resolveAccountB(configured);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.refreshPushSubscription).toHaveBeenCalledTimes(1),
    );
    expect(useAuthStore.getState().user?.id).toBe('account-b');
  });
});
