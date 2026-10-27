import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlatformBrowserNotifications } from '../../src/hooks/usePlatformBrowserNotifications.js';
import { useAuthStore } from '../../src/stores/authStore.js';

const mocks = vi.hoisted(() => ({
  ready: true,
  stop: vi.fn(),
  show: vi.fn(),
  onConnected: vi.fn(),
  onPlatformBrowserNotification: vi.fn(),
  setPlatformNotificationsReady: vi.fn(),
}));

vi.mock('../../src/api/platformSocket.js', () => ({
  platformSocket: {
    onConnected: (handler: () => void) => {
      mocks.onConnected(handler);
      return mocks.stop;
    },
    onPlatformBrowserNotification: (
      handler: (
        payload: unknown,
        acknowledge: (shown: boolean) => void,
      ) => void,
    ) => {
      mocks.onPlatformBrowserNotification(handler);
      return mocks.stop;
    },
    setPlatformNotificationsReady: (enabled: boolean) =>
      mocks.setPlatformNotificationsReady(enabled),
  },
}));

vi.mock('../../src/hooks/useAuth.js', () => ({
  useCurrentUser: () => ({ data: useAuthStore.getState().user }),
}));

vi.mock('../../src/lib/browserNotifications.js', () => ({
  canShowBrowserNotifications: () => mocks.ready,
  showBrowserNotification: (...args: unknown[]) => mocks.show(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready = true;
  mocks.show.mockResolvedValue(true);
  useAuthStore.getState().login('token', {
    id: 'user-1',
    name: 'Player',
    email: 'player@example.test',
    role: 'player',
    preferences: { pushNotificationsEnabled: true },
  });
});

afterEach(() => {
  act(() => useAuthStore.getState().logout());
});

describe('usePlatformBrowserNotifications', () => {
  it('announces readiness after attaching the receiver and acknowledges delivery', async () => {
    renderHook(() => usePlatformBrowserNotifications());
    expect(mocks.setPlatformNotificationsReady).toHaveBeenLastCalledWith(true);
    const receive = mocks.onPlatformBrowserNotification.mock.lastCall?.[0] as
      | ((payload: unknown, acknowledge: (shown: boolean) => void) => void)
      | undefined;
    const acknowledge = vi.fn();
    const payload = { title: 'Your turn', body: 'Board game' };
    await act(async () => {
      receive?.(payload, acknowledge);
    });
    expect(mocks.show).toHaveBeenCalledWith(payload, expect.any(Function));
    expect(acknowledge).toHaveBeenCalledWith(true);
  });

  it('withdraws readiness when permission is revoked or the account opts out', () => {
    const view = renderHook(() => usePlatformBrowserNotifications());
    mocks.ready = false;
    fireEvent(window, new Event('focus'));
    expect(mocks.setPlatformNotificationsReady).toHaveBeenLastCalledWith(false);
    act(() => {
      const currentUser = useAuthStore.getState().user;
      if (!currentUser) throw new Error('test user missing');
      useAuthStore.getState().setUser({
        ...currentUser,
        preferences: { pushNotificationsEnabled: false },
      });
    });
    view.rerender();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(mocks.setPlatformNotificationsReady).toHaveBeenLastCalledWith(false);
  });

  it('invalidates an in-flight delivery on logout or session replacement', async () => {
    const view = renderHook(() => usePlatformBrowserNotifications());
    const receive = mocks.onPlatformBrowserNotification.mock.lastCall?.[0] as
      | ((payload: unknown, acknowledge: (shown: boolean) => void) => void)
      | undefined;
    await act(async () => {
      receive?.({ title: 'Turn', body: '' }, vi.fn());
    });
    const isActive = mocks.show.mock.lastCall?.[1] as () => boolean;
    expect(isActive()).toBe(true);
    act(() => useAuthStore.getState().logout());
    expect(isActive()).toBe(false);
    view.unmount();
    expect(mocks.stop).toHaveBeenCalled();
    expect(mocks.setPlatformNotificationsReady).toHaveBeenLastCalledWith(false);
  });

  it('requires an opted-in player and reannounces readiness after reconnect', () => {
    const view = renderHook(() => usePlatformBrowserNotifications());
    const reconnect = mocks.onConnected.mock.lastCall?.[0] as
      | (() => void)
      | undefined;
    mocks.setPlatformNotificationsReady.mockClear();
    reconnect?.();
    expect(mocks.setPlatformNotificationsReady).toHaveBeenLastCalledWith(true);
    view.unmount();
    vi.clearAllMocks();
    act(() => {
      const currentUser = useAuthStore.getState().user;
      if (!currentUser) throw new Error('test user missing');
      useAuthStore.getState().setUser({ ...currentUser, role: 'guest' });
    });
    renderHook(() => usePlatformBrowserNotifications());
    expect(mocks.onPlatformBrowserNotification).not.toHaveBeenCalled();
  });
});
