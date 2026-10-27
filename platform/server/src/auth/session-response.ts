import type { IUserProfile } from '@board-platform/contracts/types/protocol/auth';
import type { IAuthSessionTokens } from './session.service.js';

export const REFRESH_COOKIE_NAME = '__Host-seti-refresh';
const CSRF_COOKIE_NAME = '__Host-seti-csrf';
const SESSION_COOKIE_OPTIONS = {
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

export interface ICookieResponse {
  cookie(
    name: string,
    value: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax';
      path: string;
      maxAge: number;
    },
  ): void;
  clearCookie(
    name: string,
    options: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: 'lax';
      path: string;
    },
  ): void;
}

/** Cookies must survive a profile lookup failure after refresh rotation. */
export async function writeSessionResponse(
  response: Pick<ICookieResponse, 'cookie'>,
  tokens: IAuthSessionTokens,
  loadProfile: () => IUserProfile | Promise<IUserProfile>,
): Promise<{ accessToken: string; user: IUserProfile }> {
  const options = {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: Math.max(0, tokens.expiresAt.getTime() - Date.now()),
  };
  response.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...options,
    httpOnly: true,
  });
  response.cookie(CSRF_COOKIE_NAME, tokens.csrfToken, {
    ...options,
    httpOnly: false,
  });
  return { accessToken: tokens.accessToken, user: await loadProfile() };
}

export function clearSessionCookies(
  response: Pick<ICookieResponse, 'clearCookie'>,
): void {
  response.clearCookie(REFRESH_COOKIE_NAME, {
    ...SESSION_COOKIE_OPTIONS,
    httpOnly: true,
  });
  response.clearCookie(CSRF_COOKIE_NAME, {
    ...SESSION_COOKIE_OPTIONS,
    httpOnly: false,
  });
}
