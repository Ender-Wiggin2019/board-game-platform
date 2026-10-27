import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore.js';

const httpClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  refreshAuthSession: vi.fn(),
  withAuthSessionTransition: vi.fn(async (action) =>
    action({ refresh: httpClientMock.refreshAuthSession }),
  ),
}));

vi.mock('@/api/httpClient.js', () => ({
  httpClient: httpClientMock,
  refreshAuthSession: httpClientMock.refreshAuthSession,
  withAuthSessionTransition: httpClientMock.withAuthSessionTransition,
}));

describe('authApi', () => {
  beforeEach(() => {
    httpClientMock.get.mockReset();
    httpClientMock.post.mockReset();
    httpClientMock.put.mockReset();
    httpClientMock.refreshAuthSession.mockReset();
    httpClientMock.withAuthSessionTransition.mockClear();
    useAuthStore.getState().logout();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value:
        '__Host-seti-csrf=auth-token; __Host-seti-registration-csrf=registration-token',
    });
  });

  it('changes password and normalizes the rotated session response', async () => {
    const user = {
      id: 'user-1',
      name: 'Guest',
      email: 'guest@test.com',
      role: 'guest',
    };
    httpClientMock.post.mockResolvedValueOnce({
      data: { accessToken: 'new-token', user },
    });
    useAuthStore.getState().login('old-token', user);
    const { authApi } = await import('@/api/authApi.js');
    await expect(
      authApi.changePassword({
        currentPassword: 'old-secret',
        newPassword: 'new-secret',
      }),
    ).resolves.toEqual({ token: 'new-token', user });
    expect(useAuthStore.getState().token).toBe('new-token');
    expect(httpClientMock.post).toHaveBeenCalledWith(
      '/auth/me/password',
      {
        currentPassword: 'old-secret',
        newPassword: 'new-secret',
      },
      { skipAuthRefresh: true, _authRefreshWithinTransition: true },
    );
    expect(authApi).not.toHaveProperty('grantTesterAccess');
  });

  it('rejects the retired token response instead of accepting it as a session', async () => {
    httpClientMock.post.mockResolvedValueOnce({
      data: {
        token: 'legacy-token',
        user: { id: 'user-1', name: 'Guest', email: 'guest@test.com' },
      },
    });
    const { authApi } = await import('@/api/authApi.js');
    await expect(
      authApi.login({ email: 'guest@test.com', password: 'password' }),
    ).rejects.toThrow('Invalid auth response: missing token');
  });

  it.each([
    'seti-csrf=legacy-token',
    'XSRF-TOKEN=legacy-token',
    '__Host-seti-registration-csrf=registration-token',
  ])('does not use %s as the session CSRF cookie', async (cookie) => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value: cookie,
    });
    const { csrfHeaders } = await import('@/api/authApi.js');
    expect(csrfHeaders()).toEqual({});
  });

  it('reauthenticates before ending every session', async () => {
    httpClientMock.post.mockResolvedValueOnce({ data: { ok: true } });
    useAuthStore.getState().login('session-token', {
      id: 'user-1',
      name: 'Guest',
      email: 'guest@test.com',
    });
    const { authApi } = await import('@/api/authApi.js');

    await authApi.logoutAll({ currentPassword: 'current-secret' });

    expect(httpClientMock.post).toHaveBeenCalledWith(
      '/auth/logout-all',
      { currentPassword: 'current-secret' },
      {
        headers: { 'X-CSRF-Token': 'auth-token' },
        skipAuthRefresh: true,
      },
    );
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('redeems an invite code for the current user', async () => {
    httpClientMock.post.mockResolvedValueOnce({
      data: {
        id: 'user-1',
        name: 'Guest',
        email: 'guest@test.com',
        role: 'player',
      },
    });

    const { authApi } = await import('@/api/authApi.js');
    const user = await authApi.redeemInviteCode({ code: 'ABCD2345' });

    expect(httpClientMock.post).toHaveBeenCalledWith('/auth/me/invite-code', {
      code: 'ABCD2345',
    });
    expect(user.role).toBe('player');
  });

  it('registers directly without a registration draft or CSRF cookie', async () => {
    httpClientMock.post.mockResolvedValueOnce({
      data: {
        accessToken: 'access-token',
        user: {
          id: 'user-1',
          name: 'Guest',
          email: 'guest@test.com',
          role: 'guest',
        },
      },
    });
    const { authApi } = await import('@/api/authApi.js');
    const input = {
      email: 'guest@test.com',
      name: 'Guest',
      password: 'a-password-longer-than-15',
      passwordConfirm: 'a-password-longer-than-15',
      consentVersion: 'account-registration-v1',
    };
    await authApi.register(input);
    expect(useAuthStore.getState().user?.id).toBe('user-1');
    expect(httpClientMock.post).toHaveBeenCalledTimes(1);
    expect(httpClientMock.post).toHaveBeenCalledWith('/auth/register', input);
  });

  it('uses the shared session exchange for refresh', async () => {
    httpClientMock.refreshAuthSession.mockResolvedValueOnce({
      token: 'access-token',
      user: {
        id: 'user-1',
        name: 'Guest',
        email: 'guest@test.com',
        role: 'guest',
      },
    });

    const { authApi } = await import('@/api/authApi.js');
    await authApi.refresh();

    expect(httpClientMock.refreshAuthSession).toHaveBeenCalledOnce();
    expect(httpClientMock.post).not.toHaveBeenCalled();
  });
});
