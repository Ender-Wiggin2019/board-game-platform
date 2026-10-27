import type {
  IAuthPublicConfig,
  IChangePasswordRequest,
} from '@board-platform/contracts/types/protocol/auth';
import type { IRedeemInviteCodeRequest } from '@board-platform/contracts/types/protocol/inviteCodes';
import { isCurrentAuthSession, useAuthStore } from '../stores/authStore.js';
import { isPermanentAuthRefreshFailure } from './authRefreshCoordinator.js';
import { getAccessTokenExpiresAt, isAccessTokenExpiring } from './authToken.js';
import {
  httpClient,
  refreshAuthSession,
  withAuthSessionTransition,
} from './httpClient.js';
import type {
  IAuthUser,
  IEmailChallengeResponse,
  IEmailChangeConfirmRequest,
  IEmailChangeConfirmResponse,
  IEmailChangeStartRequest,
  ILoginRequest,
  ILoginResponse,
  ILogoutAllRequest,
  IPasswordResetRequest,
  IPasswordResetSubmit,
  IRegisterRequest,
  IRegisterResponse,
  IUpdatePreferencesRequest,
  IUpdateProfileRequest,
} from './types.js';

export interface IServerAuthResponse {
  accessToken: string;
  user: IAuthUser;
}

export function normalizeAuthResponse(
  data: IServerAuthResponse,
): ILoginResponse {
  const token = data.accessToken;
  if (!token || !data.user) {
    throw new Error('Invalid auth response: missing token');
  }
  return { token, user: data.user };
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

function readCsrfCookie(): string | undefined {
  return readCookie('__Host-seti-csrf');
}

export function csrfHeaders(csrfToken?: string): Record<string, string> {
  const token = csrfToken ?? readCsrfCookie();
  return token ? { 'X-CSRF-Token': token } : {};
}

export const authApi = {
  login: async (data: ILoginRequest): Promise<ILoginResponse> => {
    return withAuthSessionTransition(async () => {
      const res = await httpClient.post<IServerAuthResponse>(
        '/auth/login',
        data,
      );
      const session = normalizeAuthResponse(res.data);
      useAuthStore.getState().login(session.token, session.user);
      return session;
    });
  },

  register: async (data: IRegisterRequest): Promise<IRegisterResponse> => {
    return withAuthSessionTransition(async () => {
      const res = await httpClient.post<IServerAuthResponse>(
        '/auth/register',
        data,
      );
      const session = normalizeAuthResponse(res.data);
      useAuthStore.getState().login(session.token, session.user);
      return session;
    });
  },

  refresh: refreshAuthSession,

  logout: async (): Promise<void> => {
    await withAuthSessionTransition(async () => {
      const requestSession = useAuthStore.getState();
      try {
        await httpClient.post('/auth/logout', undefined, {
          headers: csrfHeaders(),
          skipAuthRefresh: true,
        });
      } finally {
        const current = useAuthStore.getState();
        if (
          current.authEpoch === requestSession.authEpoch &&
          current.user?.id === requestSession.user?.id
        ) {
          current.logout();
        }
      }
    });
  },

  logoutAll: async (data: ILogoutAllRequest): Promise<void> => {
    await withAuthSessionTransition(async () => {
      const requestSession = useAuthStore.getState();
      await httpClient.post('/auth/logout-all', data, {
        headers: csrfHeaders(),
        skipAuthRefresh: true,
      });
      const current = useAuthStore.getState();
      if (
        current.authEpoch === requestSession.authEpoch &&
        current.user?.id === requestSession.user?.id
      ) {
        current.logout();
      }
    });
  },

  forgotPassword: async (data: IPasswordResetRequest): Promise<void> => {
    await httpClient.post('/auth/password/forgot', data);
  },

  resetPassword: async (data: IPasswordResetSubmit): Promise<void> => {
    await httpClient.post('/auth/password/reset', data, {
      headers: csrfHeaders(),
      skipAuthRefresh: true,
    });
  },

  getConfig: async (): Promise<IAuthPublicConfig> => {
    const res = await httpClient.get<IAuthPublicConfig>('/auth/config');
    return res.data;
  },
  updateConfig: async (data: IAuthPublicConfig): Promise<IAuthPublicConfig> => {
    const res = await httpClient.put<IAuthPublicConfig>('/auth/config', data);
    return res.data;
  },
  changePassword: async (
    data: IChangePasswordRequest & { passwordConfirm?: string },
  ): Promise<ILoginResponse> => {
    return withAuthSessionTransition(async ({ refresh }) => {
      const beforeRefresh = useAuthStore.getState();
      if (beforeRefresh.token && isAccessTokenExpiring(beforeRefresh.token)) {
        try {
          await refresh();
        } catch (error) {
          const expiresAt = getAccessTokenExpiresAt(beforeRefresh.token);
          if (
            isPermanentAuthRefreshFailure(error) ||
            (expiresAt !== undefined && expiresAt <= Date.now())
          ) {
            if (isPermanentAuthRefreshFailure(error))
              useAuthStore.getState().expireSession();
            throw error;
          }
        }
      }

      const requestSession = useAuthStore.getState();
      const res = await httpClient.post<IServerAuthResponse>(
        '/auth/me/password',
        data,
        { skipAuthRefresh: true, _authRefreshWithinTransition: true },
      );
      const session = normalizeAuthResponse(res.data);
      if (requestSession.isAuthenticated) {
        if (session.user.id !== requestSession.user?.id)
          throw new Error('Auth session changed');
        if (!isCurrentAuthSession(requestSession))
          throw new Error('Auth session changed');
        const currentSession = useAuthStore.getState();
        useAuthStore
          .getState()
          .refreshSession(session.token, session.user, currentSession);
      }
      return session;
    });
  },

  startEmailChange: async (
    data: IEmailChangeStartRequest,
  ): Promise<IEmailChallengeResponse> => {
    const res = await httpClient.post<IEmailChallengeResponse>(
      '/auth/me/email/start',
      data,
      { headers: csrfHeaders() },
    );
    return res.data;
  },

  confirmEmailChange: async (
    data: IEmailChangeConfirmRequest,
  ): Promise<IEmailChangeConfirmResponse> => {
    const res = await httpClient.post<IEmailChangeConfirmResponse>(
      '/auth/me/email/confirm',
      data,
      { headers: csrfHeaders() },
    );
    return res.data;
  },
  getMe: async (signal?: AbortSignal): Promise<IAuthUser> => {
    const res = await httpClient.get<IAuthUser>('/auth/me', { signal });
    return res.data;
  },

  updateMe: async (data: IUpdateProfileRequest): Promise<IAuthUser> => {
    const res = await httpClient.put<IAuthUser>('/auth/me', data);
    return res.data;
  },

  updatePreferences: async (
    data: IUpdatePreferencesRequest,
  ): Promise<IAuthUser> => {
    const res = await httpClient.patch<IAuthUser>('/auth/me/preferences', data);
    return res.data;
  },

  redeemInviteCode: async (
    data: IRedeemInviteCodeRequest,
  ): Promise<IAuthUser> => {
    const res = await httpClient.post<IAuthUser>('/auth/me/invite-code', data);
    return res.data;
  },
};
