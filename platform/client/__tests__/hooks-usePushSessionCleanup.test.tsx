// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePushSessionCleanup } from '../src/hooks/usePushSessionCleanup.js';
import { useAuthStore } from '../src/stores/authStore.js';

const disconnectLocalPushNotifications = vi.fn();

vi.mock('../src/lib/pushCleanup.js', () => ({
  disconnectLocalPushNotifications: () => disconnectLocalPushNotifications(),
}));

beforeEach(() => {
  disconnectLocalPushNotifications.mockReset();
  disconnectLocalPushNotifications.mockResolvedValue(undefined);
  useAuthStore.getState().login('token', {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@example.com',
  });
});

describe('usePushSessionCleanup', () => {
  it('cancels a stale browser subscription on an unauthenticated launch', async () => {
    useAuthStore.getState().logout();

    renderHook(() => usePushSessionCleanup());

    await waitFor(() =>
      expect(disconnectLocalPushNotifications).toHaveBeenCalledTimes(1),
    );
  });

  it('cancels the local subscription after any store logout', async () => {
    renderHook(() => usePushSessionCleanup());

    act(() => useAuthStore.getState().logout());

    await waitFor(() =>
      expect(disconnectLocalPushNotifications).toHaveBeenCalledTimes(1),
    );
  });

  it('does not unsubscribe while the session remains active', async () => {
    renderHook(() => usePushSessionCleanup());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
  });
});
