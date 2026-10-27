import { waitFor } from '@testing-library/react';
import type { InternalAxiosRequestConfig } from 'axios';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectLocalPushNotifications } from '@/lib/pushCleanup.js';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/lib/pushCleanup.js', () => ({
  disconnectLocalPushNotifications: vi.fn(),
}));

import { withAuthRefreshLock } from '@/api/authRefreshCoordinator.js';
import {
  getHttpErrorMessage,
  httpClient,
  refreshAuthSession,
  shouldLogoutForUnauthorizedResponse,
  shouldRetryHttpQuery,
  withAuthSessionTransition,
} from '@/api/httpClient.js';
import i18n from '@/i18n.js';

describe('httpClient unauthorized handling', () => {
  it('logs out for token authentication failures', () => {
    expect(
      shouldLogoutForUnauthorizedResponse({
        status: 401,
        requestUrl: '/lobby/rooms',
        responseData: { message: 'Invalid or expired token' },
      }),
    ).toBe(true);
    expect(
      shouldLogoutForUnauthorizedResponse({
        status: 401,
        requestUrl: '/auth/me',
        responseData: { message: 'Unauthorized' },
      }),
    ).toBe(true);
  });

  it('does not log out for auth forms or business-level unauthorized errors', () => {
    expect(
      shouldLogoutForUnauthorizedResponse({
        status: 401,
        requestUrl: '/auth/login',
        responseData: { message: 'Invalid credentials' },
      }),
    ).toBe(false);
    expect(
      shouldLogoutForUnauthorizedResponse({
        status: 401,
        requestUrl: '/lobby/rooms/room-1/start',
        responseData: { code: 'UNAUTHORIZED', message: 'Only host can start' },
      }),
    ).toBe(false);
  });

  it.each([
    '/auth/me/',
    '/auth/me?reload=true',
    'https://example.test/api/auth/me',
  ])('recognizes the exact session endpoint: %s', (requestUrl) => {
    expect(
      shouldLogoutForUnauthorizedResponse({
        status: 401,
        requestUrl,
        responseData: { message: 'Unauthorized' },
      }),
    ).toBe(true);
  });
});

describe('HTTP session expiration races', () => {
  const user = {
    id: 'actor',
    name: 'Actor',
    email: 'actor@test.com',
    role: 'player',
  };
  beforeEach(() => {
    vi.mocked(disconnectLocalPushNotifications).mockReset();
    vi.mocked(disconnectLocalPushNotifications).mockResolvedValue(undefined);
    useAuthStore.getState().login('old-token', user);
  });

  it.each([
    ['/account-migrations/legacy/verify', 'Unauthorized Exception'],
    ['/account-migrations/legacy/verify', 'LEGACY_CREDENTIALS_INVALID'],
    ['/auth/me/email/start', 'REAUTH_REQUIRED'],
    ['/auth/me/email/confirm', 'EMAIL_CODE_INVALID'],
    ['/auth/me/email/confirm', 'EMAIL_PROOF_EXPIRED'],
  ])(
    'does not refresh or replay a business 401 on %s: %s',
    async (requestUrl, message) => {
      const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
        data: { accessToken: 'rotated-token', user },
      });
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
        throw {
          config,
          isAxiosError: true,
          response: {
            status: 401,
            data: { code: 'UNAUTHORIZED', message },
          },
        };
      });
      try {
        await expect(
          httpClient.post(requestUrl, {}, { adapter }),
        ).rejects.toMatchObject({ status: 401 });
        expect(refresh).not.toHaveBeenCalled();
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(useAuthStore.getState().token).toBe('old-token');
        expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
      } finally {
        refresh.mockRestore();
      }
    },
  );

  it('recovers a valid but stale password session inside its transition', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 300 }))}.signature`;
    useAuthStore.getState().login(token, user);
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
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
      };
    });
    try {
      await expect(
        withAuthSessionTransition(() =>
          httpClient.post(
            '/auth/me/password',
            { currentPassword: 'old', newPassword: 'new' },
            {
              adapter,
              skipAuthRefresh: true,
              _authRefreshWithinTransition: true,
            },
          ),
        ),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(refresh).toHaveBeenCalledOnce();
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls[1]?.[0].headers.Authorization).toBe(
        'Bearer renewed-token',
      );
      expect(useAuthStore.getState().token).toBe('renewed-token');
    } finally {
      refresh.mockRestore();
    }
  });

  it('does not refresh a password request for an invalid current password', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 300 }))}.signature`;
    useAuthStore.getState().login(token, user);
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
    try {
      await expect(
        withAuthSessionTransition(() =>
          httpClient.post(
            '/auth/me/password',
            { currentPassword: 'wrong', newPassword: 'new' },
            {
              adapter,
              skipAuthRefresh: true,
              _authRefreshWithinTransition: true,
            },
          ),
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(refresh).not.toHaveBeenCalled();
      expect(adapter).toHaveBeenCalledOnce();
      expect(useAuthStore.getState().token).toBe(token);
    } finally {
      refresh.mockRestore();
    }
  });

  it('still refreshes an expired session before retrying migration verification once', async () => {
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'rotated-token', user },
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer rotated-token') {
        return {
          config,
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: {},
        };
      }
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
    });
    try {
      await expect(
        httpClient.post('/account-migrations/legacy/verify', {}, { adapter }),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally {
      refresh.mockRestore();
    }
  });

  it.each([30, -30])(
    'renews a token expiring in %s seconds before sending a room request',
    async (seconds) => {
      const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
      useAuthStore.getState().login(token, user);
      const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
        data: { accessToken: 'renewed-token', user },
      });
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
        config,
        data: [],
        status: 200,
        statusText: 'OK',
        headers: {},
      }));
      try {
        await httpClient.get('/lobby/rooms/room-1', { adapter });
        expect(refresh).toHaveBeenCalledOnce();
        expect(adapter).toHaveBeenCalledOnce();
        expect(adapter.mock.calls[0][0].headers.Authorization).toBe(
          'Bearer renewed-token',
        );
      } finally {
        refresh.mockRestore();
      }
    },
  );

  it('shares one exchange between scheduled renewal and concurrent HTTP requests', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    let finish!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refresh = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      config,
      data: [],
      status: 200,
      statusText: 'OK',
      headers: {},
    }));
    try {
      const renewal = refreshAuthSession();
      const requests = [
        httpClient.get('/lobby/rooms', { adapter }),
        httpClient.get('/auth/me', { adapter }),
      ];
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      expect(adapter).not.toHaveBeenCalled();
      finish({ data: { accessToken: 'renewed-token', user } });
      await Promise.all([renewal, ...requests]);
      expect(refresh).toHaveBeenCalledOnce();
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(
        adapter.mock.calls.every(
          ([config]) => config.headers.Authorization === 'Bearer renewed-token',
        ),
      ).toBe(true);
    } finally {
      refresh.mockRestore();
    }
  });

  it('waits for a local refresh before starting a cookie transition', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    let finish!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refresh = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let transitionStarted = false;
    try {
      const pendingRefresh = refreshAuthSession();
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      const transition = withAuthSessionTransition(async () => {
        transitionStarted = true;
        return 'committed';
      });
      await Promise.resolve();
      expect(transitionStarted).toBe(false);
      finish({ data: { accessToken: 'renewed-token', user } });
      await expect(transition).resolves.toBe('committed');
      await expect(pendingRefresh).resolves.toMatchObject({
        token: 'renewed-token',
      });
    } finally {
      refresh.mockRestore();
    }
  });

  it.each([
    { seconds: -30, status: 401, sends: false, authenticated: false },
    { seconds: -30, status: 503, sends: false, authenticated: true },
    { seconds: 30, status: 503, sends: true, authenticated: true },
  ])(
    'handles renewal status $status with $seconds seconds remaining',
    async ({ seconds, status, sends, authenticated }) => {
      const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }))}.signature`;
      useAuthStore.getState().login(token, user);
      const refresh = vi.spyOn(axios, 'post').mockRejectedValue({
        response: { status, data: { message: 'Renewal failed' } },
      });
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
        config,
        data: [],
        status: 200,
        statusText: 'OK',
        headers: {},
      }));
      try {
        const request = httpClient.get('/lobby/rooms', { adapter });
        if (sends)
          await expect(request).resolves.toMatchObject({ status: 200 });
        else await expect(request).rejects.toMatchObject({ status });
        expect(adapter).toHaveBeenCalledTimes(sends ? 1 : 0);
        expect(useAuthStore.getState().isAuthenticated).toBe(authenticated);
        expect(useAuthStore.getState().sessionExpired).toBe(!authenticated);
      } finally {
        refresh.mockRestore();
      }
    },
  );

  it('does not send a renewal-waiting request into a newer login', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    let finish!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refresh = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const adapter = vi.fn();
    try {
      const result = httpClient
        .get('/lobby/rooms', { adapter })
        .catch((error) => error);
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      useAuthStore.getState().login('new-login', { ...user, id: 'other' });
      finish({ data: { accessToken: 'late-token', user } });
      const cancellation = await result;
      expect(axios.isCancel(cancellation)).toBe(true);
      expect(shouldRetryHttpQuery(0, cancellation)).toBe(false);
      expect(adapter).not.toHaveBeenCalled();
      expect(useAuthStore.getState().token).toBe('new-login');
    } finally {
      refresh.mockRestore();
    }
  });

  it('marks an anonymous authentication failure for global login redirection', async () => {
    useAuthStore.getState().logout();
    await expect(
      httpClient.get('/lobby/rooms', {
        adapter: (config) =>
          Promise.reject({
            config,
            isAxiosError: true,
            response: {
              status: 401,
              data: {
                message: 'Missing authorization token',
                i18n: { key: 'missing_token' },
              },
            },
          }),
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(useAuthStore.getState().sessionExpired).toBe(true);
  });

  it('honors Retry-After across request preflights without discarding the session', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(startedAt / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    const refresh = vi.spyOn(axios, 'post').mockRejectedValue({
      response: {
        status: 429,
        headers: { 'retry-after': '30' },
        data: { message: 'Too many requests' },
      },
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      config,
      data: [],
      status: 200,
      statusText: 'OK',
      headers: {},
    }));
    try {
      await expect(
        httpClient.get('/lobby/rooms', { adapter }),
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        httpClient.get('/auth/me', { adapter }),
      ).rejects.toMatchObject({ status: 429 });
      expect(refresh).toHaveBeenCalledOnce();
      expect(adapter).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      vi.setSystemTime(startedAt + 30_000);
      refresh.mockResolvedValue({
        data: { accessToken: 'renewed-token', user },
      });
      await expect(
        httpClient.get('/lobby/rooms', { adapter }),
      ).resolves.toMatchObject({ status: 200 });
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      refresh.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      failure: {
        isAxiosError: true,
        response: { status: 503, data: { message: 'Service unavailable' } },
      },
      status: 503,
      message: 'Service unavailable',
      retryAfterSeconds: undefined,
      retryable: true,
    },
    {
      failure: new Error('Network Error'),
      status: undefined,
      message: 'Network Error',
      retryAfterSeconds: undefined,
      retryable: true,
    },
    {
      failure: {
        isAxiosError: true,
        response: {
          status: 429,
          data: { message: 'Too many requests' },
          headers: { 'retry-after': '30' },
        },
      },
      status: 429,
      message: 'Too many requests',
      retryAfterSeconds: 30,
      retryable: false,
    },
  ])(
    'preserves the session and actual refresh failure: $message',
    async ({ failure, status, message, retryAfterSeconds, retryable }) => {
      const clock = vi.spyOn(Date, 'now');
      const refresh = vi
        .spyOn(axios, 'post')
        .mockRejectedValueOnce(failure)
        .mockResolvedValue({ data: { accessToken: 'rotated-token', user } });
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
        if (config.headers.Authorization === 'Bearer rotated-token') {
          return {
            config,
            data: [],
            status: 200,
            statusText: 'OK',
            headers: {},
          };
        }
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
      });

      try {
        const error = await httpClient
          .get('/lobby/rooms', { adapter })
          .catch((cause) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error.status).toBe(status);
        expect(error.message).toBe(message);
        expect(error.i18nKey).not.toBe('invalid_or_expired_token');
        expect(error.retryAfterSeconds).toBe(retryAfterSeconds);
        expect(shouldRetryHttpQuery(0, error)).toBe(retryable);
        expect(useAuthStore.getState().token).toBe('old-token');
        expect(useAuthStore.getState().isAuthenticated).toBe(true);
        expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
        if (retryAfterSeconds) {
          await expect(
            httpClient.get('/lobby/rooms', { adapter }),
          ).rejects.toMatchObject({ status: 429 });
          expect(refresh).toHaveBeenCalledOnce();
          clock.mockReturnValue(Date.now() + (retryAfterSeconds + 1) * 1_000);
        }
        await expect(
          httpClient.get('/lobby/rooms', { adapter }),
        ).resolves.toMatchObject({ status: 200 });
        expect(useAuthStore.getState().token).toBe('rotated-token');
      } finally {
        clock.mockRestore();
        refresh.mockRestore();
      }
    },
  );

  it('reads the CSRF cookie after waiting for a cross-tab refresh lock', async () => {
    let resolveFirst!: () => void;
    let queue = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T>(_name: string, action: () => Promise<T>) => {
          const previous = queue;
          let resolveQueue!: () => void;
          queue = new Promise<void>((resolve) => {
            resolveQueue = resolve;
          });
          await previous;
          try {
            return await action();
          } finally {
            resolveQueue();
          }
        },
      },
    });
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value: '__Host-seti-csrf=old-csrf',
    });
    const heldLock = withAuthRefreshLock(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = () => resolve('held');
        }),
    );
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'rotated-token', user },
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer rotated-token') {
        return { config, data: [], status: 200, statusText: 'OK', headers: {} };
      }
      throw {
        config,
        isAxiosError: true,
        response: {
          status: 401,
          data: { message: 'Invalid or expired token' },
        },
      };
    });
    try {
      const request = httpClient.get('/lobby/rooms', { adapter });
      await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));
      expect(refresh).not.toHaveBeenCalled();
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        value: '__Host-seti-csrf=new-csrf',
      });
      resolveFirst();
      await expect(heldLock).resolves.toBe('held');
      await expect(request).resolves.toMatchObject({ status: 200 });
      expect(refresh).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        undefined,
        expect.objectContaining({
          headers: { 'X-CSRF-Token': 'new-csrf' },
        }),
      );
    } finally {
      refresh.mockRestore();
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined,
      });
    }
  });

  it.each([true, false])(
    'handles an old-token 401 after session rotation, same account: %s',
    async (sameAccount) => {
      const refresh = vi.spyOn(axios, 'post');
      let resolveResponse = () => undefined as void;
      const response = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
        if (config.headers.Authorization === 'Bearer rotated-token') {
          return {
            config,
            data: { ok: true },
            status: 200,
            statusText: 'OK',
            headers: {},
          };
        }
        await response;
        throw {
          config,
          isAxiosError: true,
          message: 'Expired',
          response: {
            status: 401,
            data: {
              message: 'Invalid or expired token',
              i18n: { key: 'invalid_or_expired_token' },
            },
          },
        };
      });
      const request = httpClient
        .get('/auth/me', { adapter })
        .catch((error) => error);
      await waitFor(() => expect(adapter).toHaveBeenCalled());
      expect(adapter.mock.calls[0][0].headers.Authorization).toBe(
        'Bearer old-token',
      );
      if (sameAccount) {
        useAuthStore
          .getState()
          .refreshSession('rotated-token', user, useAuthStore.getState());
      } else {
        useAuthStore
          .getState()
          .login('rotated-token', { ...user, id: 'other' });
      }
      resolveResponse();
      const result = await request;
      if (sameAccount) expect(result).toMatchObject({ status: 200 });
      else expect(axios.isCancel(result)).toBe(true);
      expect(adapter).toHaveBeenCalledTimes(sameAccount ? 2 : 1);
      expect(refresh).not.toHaveBeenCalled();
      expect(useAuthStore.getState().token).toBe('rotated-token');
      expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
      refresh.mockRestore();
    },
  );

  it('does not replay an old request into a new login for the same account', async () => {
    const refresh = vi.spyOn(axios, 'post');
    let releaseResponse = () => undefined as void;
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      await heldResponse;
      throw {
        config,
        isAxiosError: true,
        response: {
          status: 401,
          data: { message: 'Invalid or expired token' },
        },
      };
    });
    const request = httpClient
      .get('/auth/me', { adapter })
      .catch((error) => error);
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));

    useAuthStore.getState().login('new-login-token', user);
    releaseResponse();

    expect(axios.isCancel(await request)).toBe(true);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBe('new-login-token');
    refresh.mockRestore();
  });

  it('cancels a successful response that arrives after logout', async () => {
    let releaseResponse = () => undefined as void;
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      await heldResponse;
      return {
        config,
        data: { rooms: ['stale-room'] },
        status: 200,
        statusText: 'OK',
        headers: {},
      };
    });
    const request = httpClient.get('/lobby/rooms', { adapter });
    await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1));

    useAuthStore.getState().logout();
    releaseResponse();

    const result = await request.catch((error) => error);
    expect(axios.isCancel(result)).toBe(true);
    expect(result.message).toBe('Auth session changed');
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('does not renew an already aborted request', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    const controller = new AbortController();
    controller.abort();
    const refresh = vi.spyOn(axios, 'post');
    const adapter = vi.fn();
    try {
      const result = await httpClient
        .get('/lobby/rooms', { adapter, signal: controller.signal })
        .catch((error) => error);
      expect(axios.isCancel(result)).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
      expect(adapter).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  });

  it('cancels a request aborted while proactive renewal is in flight', async () => {
    const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 30 }))}.signature`;
    useAuthStore.getState().login(token, user);
    const controller = new AbortController();
    let finish!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refresh = vi.spyOn(axios, 'post').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const adapter = vi.fn();
    try {
      const request = httpClient
        .get('/lobby/rooms', { adapter, signal: controller.signal })
        .catch((error) => error);
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      controller.abort();
      finish({ data: { accessToken: 'renewed-token', user } });
      const cancellation = await request;
      expect(axios.isCancel(cancellation)).toBe(true);
      expect(adapter).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  });

  it('replays a refreshed request when another refresh rotates its token before the 401 arrives', async () => {
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'first-refreshed-token', user },
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      const authorization = config.headers.Authorization;
      if (authorization === 'Bearer first-refreshed-token') {
        useAuthStore
          .getState()
          .refreshSession('latest-token', user, useAuthStore.getState());
      }
      if (authorization === 'Bearer latest-token') {
        return {
          config,
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: {},
        };
      }
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
    });

    try {
      await expect(
        httpClient.post(
          '/auth/me/invite-code',
          { code: 'ABC123' },
          { adapter },
        ),
      ).resolves.toMatchObject({ data: { ok: true } });
      expect(adapter).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(useAuthStore.getState().token).toBe('latest-token');
    } finally {
      refresh.mockRestore();
    }
  });

  it('refreshes again when another tab rotates the cookie after the first retry', async () => {
    const refresh = vi
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: { accessToken: 'first-refreshed-token', user },
      })
      .mockResolvedValueOnce({ data: { accessToken: 'latest-token', user } });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer latest-token') {
        return {
          config,
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: {},
        };
      }
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
    });

    try {
      await expect(
        httpClient.get('/lobby/rooms', { adapter }),
      ).resolves.toMatchObject({
        data: { ok: true },
      });
      expect(adapter).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().token).toBe('latest-token');
    } finally {
      refresh.mockRestore();
    }
  });

  it('uses a newer same-account token when refresh finishes after another refresh', async () => {
    let resolveRefresh!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refreshResponse = new Promise<{
      data: { accessToken: string; user: typeof user };
    }>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi
      .spyOn(axios, 'post')
      .mockReturnValue(refreshResponse as never);
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer latest-token') {
        return {
          config,
          data: { ok: true },
          status: 200,
          statusText: 'OK',
          headers: {},
        };
      }
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
    });

    try {
      const request = httpClient.get('/lobby/rooms', { adapter });
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      useAuthStore
        .getState()
        .refreshSession('latest-token', user, useAuthStore.getState());
      resolveRefresh({ data: { accessToken: 'stale-token', user } });
      await expect(request).resolves.toMatchObject({ data: { ok: true } });
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().token).toBe('latest-token');
    } finally {
      refresh.mockRestore();
    }
  });

  it('rechecks the account after asynchronous cleanup before logging out', async () => {
    let resolveCleanup = () => undefined as void;
    vi.mocked(disconnectLocalPushNotifications).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCleanup = resolve;
      }),
    );
    const refresh = vi.spyOn(axios, 'post').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: { message: 'Refresh session is invalid' },
      },
    });
    const request = httpClient
      .get('/auth/me', {
        adapter: (config) =>
          Promise.reject({
            config,
            isAxiosError: true,
            message: 'Expired',
            response: { status: 401, data: { message: 'Unauthorized' } },
          }),
      })
      .catch((error) => error);
    await waitFor(() =>
      expect(disconnectLocalPushNotifications).toHaveBeenCalled(),
    );
    useAuthStore.getState().login('other-token', { ...user, id: 'other' });
    resolveCleanup();
    expect(axios.isCancel(await request)).toBe(true);
    expect(useAuthStore.getState().token).toBe('other-token');
    expect(useAuthStore.getState().user?.id).toBe('other');
    refresh.mockRestore();
  });

  it('does not resurrect a logged-out account after a late refresh response', async () => {
    let resolveRefresh!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const refreshResponse = new Promise<{
      data: { accessToken: string; user: typeof user };
    }>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi
      .spyOn(axios, 'post')
      .mockReturnValue(refreshResponse as never);

    const request = httpClient
      .get('/lobby/rooms', {
        adapter: (config) =>
          Promise.reject({
            config,
            isAxiosError: true,
            message: 'Expired',
            response: {
              status: 401,
              data: { message: 'Invalid or expired token' },
            },
          }),
      })
      .catch((error) => error);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    useAuthStore.getState().logout();
    resolveRefresh({
      data: {
        accessToken: 'late-token',
        user,
      },
    });

    expect(axios.isCancel(await request)).toBe(true);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    refresh.mockRestore();
  });

  it('does not reuse a refresh that belongs to a previous account', async () => {
    let resolveOldRefresh!: (response: {
      data: { accessToken: string; user: typeof user };
    }) => void;
    const oldRefreshResponse = new Promise<{
      data: { accessToken: string; user: typeof user };
    }>((resolve) => {
      resolveOldRefresh = resolve;
    });
    const otherUser = { ...user, id: 'other' };
    const refresh = vi
      .spyOn(axios, 'post')
      .mockReturnValueOnce(oldRefreshResponse as never)
      .mockResolvedValueOnce({
        data: { accessToken: 'other-new-token', user: otherUser },
      });
    const oldAdapter = (config: InternalAxiosRequestConfig) =>
      Promise.reject({
        config,
        isAxiosError: true,
        response: {
          status: 401,
          data: { message: 'Invalid or expired token' },
        },
      });
    const oldRequest = httpClient
      .get('/lobby/rooms', { adapter: oldAdapter })
      .catch((error) => error);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    useAuthStore.getState().login('other-old-token', otherUser);
    const otherAdapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer other-new-token') {
        return {
          config,
          data: [],
          status: 200,
          statusText: 'OK',
          headers: {},
        };
      }
      throw {
        config,
        isAxiosError: true,
        response: {
          status: 401,
          data: { message: 'Invalid or expired token' },
        },
      };
    });
    const otherRequest = httpClient.get('/lobby/rooms', {
      adapter: otherAdapter,
    });

    resolveOldRefresh({ data: { accessToken: 'late-token', user } });
    await expect(otherRequest).resolves.toMatchObject({ status: 200 });
    expect(axios.isCancel(await oldRequest)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().token).toBe('other-new-token');
    expect(useAuthStore.getState().user?.id).toBe('other');
    expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
    refresh.mockRestore();
  });

  it.each([
    { field: 'accessToken', accepted: true },
    { field: 'token', accepted: false },
  ])('refresh accepts $field: $accepted', async ({ field, accepted }) => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value:
        'seti-csrf=legacy; XSRF-TOKEN=legacy; __Host-seti-registration-csrf=registration',
    });
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { [field]: 'new-token', user },
    });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => {
      if (config.headers.Authorization === 'Bearer new-token') {
        return { config, data: [], status: 200, statusText: 'OK', headers: {} };
      }
      throw {
        config,
        isAxiosError: true,
        message: 'Expired',
        response: {
          status: 401,
          data: { message: 'Invalid or expired token' },
        },
      };
    });
    try {
      const result = await httpClient
        .get('/lobby/rooms', { adapter })
        .catch((error) => error);
      expect(result.status).toBe(accepted ? 200 : 401);
      expect(adapter).toHaveBeenCalledTimes(accepted ? 2 : 1);
      expect(useAuthStore.getState().token).toBe(accepted ? 'new-token' : null);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(
        expect.stringContaining('/auth/refresh'),
        undefined,
        expect.objectContaining({ headers: {} }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('rejects a refresh response for a different authenticated account', async () => {
    const otherUser = { ...user, id: 'other-account' };
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { accessToken: 'other-token', user: otherUser },
    });
    try {
      await expect(refreshAuthSession()).rejects.toMatchObject({ status: 401 });
      expect(useAuthStore.getState().token).toBe('old-token');
      expect(useAuthStore.getState().user?.id).toBe(user.id);
    } finally {
      refresh.mockRestore();
    }
  });

  it('leaves an explicit refresh failure to the session recovery caller', async () => {
    const refresh = vi.spyOn(axios, 'post');
    try {
      await expect(
        httpClient.post('/auth/refresh', undefined, {
          adapter: (config) =>
            Promise.reject({
              config,
              isAxiosError: true,
              response: {
                status: 401,
                data: {
                  message: 'Invalid or expired token',
                  i18n: { key: 'invalid_or_expired_token' },
                },
              },
            }),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(refresh).not.toHaveBeenCalled();
      expect(useAuthStore.getState().token).toBe('old-token');
      expect(disconnectLocalPushNotifications).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  });

  it('logs out a revoked session without reloading the document', async () => {
    const hardNavigate = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal('window', {
      location: {
        set href(value: string) {
          hardNavigate(value);
        },
        reload,
      },
    });
    const refresh = vi.spyOn(axios, 'post').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 401,
        data: { message: 'Refresh session is invalid' },
      },
    });
    try {
      const error = await httpClient
        .get('/lobby/rooms', {
          adapter: (config) =>
            Promise.reject({
              config,
              isAxiosError: true,
              message: 'Unauthorized',
              response: {
                status: 401,
                data: {
                  message: 'Session revoked',
                  i18n: { key: 'invalid_or_expired_token' },
                },
              },
            }),
        })
        .catch((error) => error);
      expect(error).toMatchObject({
        status: 401,
        i18nKey: 'invalid_or_expired_token',
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(disconnectLocalPushNotifications).toHaveBeenCalledOnce();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(hardNavigate).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      refresh.mockRestore();
    }
  });
});

describe('HTTP query retry policy', () => {
  it('does not amplify 429 or other client errors', () => {
    expect(shouldRetryHttpQuery(0, { status: 429 })).toBe(false);
    expect(shouldRetryHttpQuery(0, { status: 404 })).toBe(false);
  });

  it('preserves a 429 status through the response interceptor', async () => {
    const error = await httpClient
      .get('/lobby/my-games', {
        adapter: () =>
          Promise.reject({
            config: { url: '/lobby/my-games' },
            isAxiosError: true,
            message: 'Request failed with status code 429',
            response: {
              headers: { 'retry-after': '45' },
              data: { message: 'Too Many Requests' },
              status: 429,
            },
          }),
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: 'Too Many Requests',
      status: 429,
      retryAfterSeconds: 45,
    });
    expect(shouldRetryHttpQuery(0, error)).toBe(false);
  });

  it('allows two retries for transport and server failures', () => {
    expect(shouldRetryHttpQuery(0, new Error('offline'))).toBe(true);
    expect(shouldRetryHttpQuery(1, { status: 503 })).toBe(true);
    expect(shouldRetryHttpQuery(2, { status: 503 })).toBe(false);
  });
});

describe('httpClient error message normalization', () => {
  it('prefers shared server error payload messages over Axios fallback text', () => {
    expect(
      getHttpErrorMessage({
        message: 'Request failed with status code 400',
        response: {
          data: {
            code: 'VALIDATION_ERROR',
            message: 'Room is full',
          },
        },
      }),
    ).toBe('Room is full');
  });

  it('localizes expired invite-code errors at the HTTP boundary', async () => {
    await i18n.changeLanguage('zh-CN');

    expect(
      getHttpErrorMessage({
        message: 'Request failed with status code 400',
        response: {
          data: {
            code: 'VALIDATION_ERROR',
            message: 'Invite code is expired',
            i18n: { key: 'invite_code_expired' },
          },
        },
      }),
    ).toBe('邀请码已过期。');
  });

  it('localizes exhausted invite-code errors at the HTTP boundary', async () => {
    await i18n.changeLanguage('zh-CN');

    expect(
      getHttpErrorMessage({
        message: 'Request failed with status code 400',
        response: {
          data: {
            code: 'VALIDATION_ERROR',
            message: 'Invite code is exhausted',
            i18n: { key: 'invite_code_exhausted' },
          },
        },
      }),
    ).toBe('邀请码已经被兑换完了。');
  });

  it('uses a localized generic message for internal server errors', async () => {
    await i18n.changeLanguage('zh-CN');

    expect(
      getHttpErrorMessage({
        message: 'Request failed with status code 500',
        response: {
          data: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error',
            i18n: { key: 'internal_server_error' },
          },
        },
      }),
    ).toBe('服务器出现错误，请稍后重试。');
  });

  it('joins validation message arrays', () => {
    expect(
      getHttpErrorMessage({
        message: 'Request failed with status code 400',
        response: {
          data: {
            message: ['name must not be empty', 'playerCount is required'],
          },
        },
      }),
    ).toBe('name must not be empty playerCount is required');
  });

  it('preserves a server semantic key on rejected HTTP errors', async () => {
    await i18n.changeLanguage('zh-CN');

    await expect(
      httpClient.get('/auth/me/invite-code', {
        adapter: () =>
          Promise.reject({
            config: { url: '/auth/me/invite-code' },
            isAxiosError: true,
            message: 'Request failed with status code 400',
            response: {
              data: {
                code: 'VALIDATION_ERROR',
                message: 'Invite code is expired',
                i18n: { key: 'invite_code_expired' },
              },
              status: 400,
            },
          }),
      }),
    ).rejects.toMatchObject({
      message: '邀请码已过期。',
      i18nKey: 'invite_code_expired',
    });
  });

  it.each([
    '/health',
    '/messages/unread-count',
    '/achievements/me',
    '/stats/me/summary',
    '/lobby/home-summary',
    '/lobby/my-games/action-required-count',
    '/lobby/invitations',
    '/game-notes/game-1',
    '/games/game-1/replay/advanced-stats',
  ])('keeps an unmarked 500 on %s local to its caller', async (url) => {
    const handleServerUpdate = vi.fn();
    window.addEventListener('seti:server-update-required', handleServerUpdate);

    try {
      await expect(
        httpClient.get(url, {
          adapter: (config) =>
            Promise.reject({
              config,
              isAxiosError: true,
              response: {
                data: { message: 'Service unavailable' },
                status: 500,
              },
            }),
        }),
      ).rejects.toMatchObject({
        message: 'Service unavailable',
        status: 500,
      });
      expect(handleServerUpdate).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        'seti:server-update-required',
        handleServerUpdate,
      );
    }
  });

  it('emits a global server update event for an opted-in core 5xx while preserving the thrown message', async () => {
    const serverUpdateEvents: Array<CustomEvent<unknown>> = [];
    const handleServerUpdate = (event: Event): void => {
      serverUpdateEvents.push(event as CustomEvent<unknown>);
    };
    window.addEventListener('seti:server-update-required', handleServerUpdate);

    await expect(
      httpClient.get('/lobby/rooms', {
        showServerUpdateDialog: true,
        adapter: (config) =>
          Promise.reject({
            config,
            isAxiosError: true,
            message: 'Request failed with status code 503',
            response: {
              data: { message: 'Service unavailable' },
              status: 503,
            },
          }),
      }),
    ).rejects.toThrow('Service unavailable');

    expect(serverUpdateEvents).toHaveLength(1);
    expect(serverUpdateEvents[0].detail).toEqual(
      expect.objectContaining({
        message: 'Service unavailable',
        source: 'http',
        status: 503,
      }),
    );

    window.removeEventListener(
      'seti:server-update-required',
      handleServerUpdate,
    );
  });
});
