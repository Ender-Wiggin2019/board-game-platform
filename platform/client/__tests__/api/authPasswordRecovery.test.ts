import type { InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/api/authApi.js';
import { httpClient } from '@/api/httpClient.js';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/lib/pushCleanup.js', () => ({
  disconnectLocalPushNotifications: vi.fn(),
}));

const user = {
  id: 'actor',
  name: 'Actor',
  email: 'actor@test.com',
  role: 'player',
};

function validSessionToken(): string {
  return `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 300 }))}.signature`;
}

describe('real authApi password session recovery', () => {
  let originalAdapter: typeof httpClient.defaults.adapter;

  beforeEach(() => {
    originalAdapter = httpClient.defaults.adapter;
    useAuthStore.getState().logout();
  });

  afterEach(() => {
    httpClient.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
    useAuthStore.getState().logout();
  });

  it('refreshes a valid-time stale session and completes the password transition', async () => {
    const initialToken = validSessionToken();
    useAuthStore.getState().login(initialToken, user);
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'renewed-token', user },
    });
    let attempts = 0;
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      attempts += 1;
      if (attempts === 1) {
        throw {
          config,
          isAxiosError: true,
          response: {
            status: 401,
            data: {
              message: 'Invalid or expired token',
              i18n: { key: 'invalid_or_expired_token' },
            },
          },
        };
      }
      return {
        config,
        data: {
          accessToken: 'replacement-token',
          user,
        },
        status: 200,
        statusText: 'OK',
        headers: {},
      };
    });
    httpClient.defaults.adapter = adapter;

    await expect(
      authApi.changePassword({
        currentPassword: 'old-password',
        newPassword: 'new-password',
      }),
    ).resolves.toEqual({ token: 'replacement-token', user });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh.mock.calls[0]?.[0]).toContain('/auth/refresh');
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(adapter.mock.calls[1]?.[0].headers.Authorization).toBe(
      'Bearer renewed-token',
    );
    expect(useAuthStore.getState().token).toBe('replacement-token');
    expect(useAuthStore.getState().user?.id).toBe(user.id);
  });

  it('does not refresh or replay an invalid current-password response', async () => {
    const initialToken = validSessionToken();
    useAuthStore.getState().login(initialToken, user);
    const refresh = vi.spyOn(axios, 'post');
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      throw {
        config,
        isAxiosError: true,
        response: {
          status: 401,
          data: {
            message: 'Invalid current password',
            i18n: { key: 'invalid_current_password' },
          },
        },
      };
    });
    httpClient.defaults.adapter = adapter;

    await expect(
      authApi.changePassword({
        currentPassword: 'wrong-password',
        newPassword: 'new-password',
      }),
    ).rejects.toMatchObject({ status: 401 });

    expect(refresh).not.toHaveBeenCalled();
    expect(adapter).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().token).toBe(initialToken);
    expect(useAuthStore.getState().user?.id).toBe(user.id);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
