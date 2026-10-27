import { EErrorCode, type IErrorI18n } from '@board-game/contracts';
import axios, { type AxiosRequestConfig } from 'axios';
import { CLIENT_ENV } from '../config/env.js';
import i18n from '../i18n.js';
import { disconnectLocalPushNotifications } from '../lib/pushCleanup.js';
import { translateServerErrorMessage } from '../lib/serverErrorI18n.js';
import { notifyServerUpdateRequired } from '../lib/serverUpdateNotification.js';
import {
  isCurrentAuthSession,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';
import type { IServerAuthResponse } from './authApi.js';
import {
  getErrorStatus,
  withAuthRefreshLock,
} from './authRefreshCoordinator.js';
import { getAccessTokenExpiresAt, isAccessTokenExpiring } from './authToken.js';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Opt in only when this failure blocks the core game or lobby flow. */
    showServerUpdateDialog?: boolean;
    /** Prevent a 401 from recursively exchanging the refresh cookie. */
    skipAuthRefresh?: boolean;
    _authRefreshAttempts?: number;
    /** Allow the password mutation to recover a stale session inside its lock. */
    _authRefreshWithinTransition?: boolean;
    _authSessionReplayCount?: number;
    _authRequestUserId?: string;
    _authRequestEpoch?: number;
    _serviceRequestSequence?: number;
  }
}

export { shouldRetryHttpQuery } from './queryRetry';

export interface IHttpClientError extends Error {
  i18nKey?: string;
  /** Stable platform contract fields returned by /platform HTTP routes. */
  responseCode?: string;
  responseMessageKey?: string;
  status?: number;
  retryAfterSeconds?: number;
  code?: string;
  requestKey?: string;
  requestSequence?: number;
}

export const httpClient = axios.create({
  baseURL: CLIENT_ENV.VITE_API_URL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

let serviceRequestSequence = 0;

function readRequestKey(config: AxiosRequestConfig): string | undefined {
  const method = config.method?.toLowerCase() ?? 'get';
  return ['get', 'head'].includes(method)
    ? `${method}:${httpClient.getUri(config)}`
    : undefined;
}

type TRefreshExchange =
  | { ok: true; accessToken: string; user: IServerAuthResponse['user'] }
  | { ok: false; permanent: boolean; error?: IHttpClientError };

type TRefreshSession = {
  token: string | null;
  user: { id: string } | null;
  authEpoch: number;
};
type TRefreshInFlight = {
  session: TRefreshSession;
  promise: Promise<TRefreshExchange>;
};

let refreshInFlight: TRefreshInFlight | null = null;
let refreshBackoff: {
  session: TRefreshSession;
  result: Extract<TRefreshExchange, { ok: false }>;
  notBefore: number;
} | null = null;

/**
 * Cookie-changing auth requests share the refresh lock with every tab. The
 * local gate also prevents a same-tab refresh from finishing after a login or
 * logout has replaced the cookie jar.
 */
let authTransitionTail = Promise.resolve();
let activeAuthTransition: Promise<void> | null = null;

function readCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const name = '__Host-seti-csrf';
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

async function exchangeRefreshCookie(
  withinTransition = false,
): Promise<TRefreshExchange> {
  const transition = activeAuthTransition;
  if (!withinTransition && transition) {
    await transition;
    return exchangeRefreshCookie();
  }

  const requestSession = useAuthStore.getState();
  const session: TRefreshSession = {
    token: requestSession.token,
    user: requestSession.user ? { id: requestSession.user.id } : null,
    authEpoch: requestSession.authEpoch,
  };
  if (
    refreshBackoff &&
    isSameAuthSession(refreshBackoff.session) &&
    Date.now() < refreshBackoff.notBefore
  ) {
    const error = refreshBackoff.result.error;
    return {
      ...refreshBackoff.result,
      error: error
        ? Object.assign(new Error(error.message), error, {
            retryAfterSeconds: Math.ceil(
              (refreshBackoff.notBefore - Date.now()) / 1_000,
            ),
          })
        : undefined,
    };
  }
  if (
    refreshInFlight &&
    refreshInFlight.session.token === session.token &&
    refreshInFlight.session.user?.id === session.user?.id &&
    refreshInFlight.session.authEpoch === session.authEpoch
  ) {
    return refreshInFlight.promise;
  }

  const promise = (async (): Promise<TRefreshExchange> => {
    try {
      const request = () => {
        if (!isSameAuthSession(requestSession))
          throw new axios.CanceledError('Auth session changed');
        const headers: Record<string, string> = {};
        const csrfToken = readCsrfCookie();
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        return axios.post<IServerAuthResponse>(
          `${CLIENT_ENV.VITE_API_URL}/auth/refresh`,
          undefined,
          {
            headers,
            withCredentials: true,
            timeout: 10_000,
          },
        );
      };
      const response = await (withinTransition
        ? request()
        : withAuthRefreshLock(request));
      const accessToken = response.data.accessToken;
      if (!accessToken || !response.data.user) {
        return {
          ok: false,
          permanent: true,
          error: new Error('Invalid auth response: missing token'),
        };
      }
      if (!isSameAuthSession(requestSession)) {
        return { ok: false, permanent: false };
      }
      if (
        requestSession.user &&
        response.data.user.id !== requestSession.user.id
      ) {
        return {
          ok: false,
          permanent: true,
          error: Object.assign(
            new Error('Auth refresh returned a different user'),
            { status: 401 },
          ),
        };
      }
      useAuthStore
        .getState()
        .refreshSession(accessToken, response.data.user, requestSession);
      refreshBackoff = null;
      return { ok: true, accessToken, user: response.data.user };
    } catch (error) {
      const failure: Extract<TRefreshExchange, { ok: false }> = {
        ok: false,
        permanent: getErrorStatus(error) === 401,
        error: normalizeHttpError(error),
      };
      if (
        !failure.permanent &&
        failure.error?.retryAfterSeconds &&
        isSameAuthSession(requestSession)
      ) {
        refreshBackoff = {
          session,
          result: failure,
          notBefore: Date.now() + failure.error.retryAfterSeconds * 1_000,
        };
      }
      return failure;
    }
  })();
  refreshInFlight = { session, promise };
  void promise.then(
    () => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    },
    () => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    },
  );
  return promise;
}

/** Startup, scheduled renewal and HTTP recovery share one exchange per session. */
export async function refreshAuthSession() {
  const result = await exchangeRefreshCookie();
  if (!result.ok) throw result.error ?? new Error('Auth session changed');
  return { token: result.accessToken, user: result.user };
}

type TAuthSessionTransitionContext = {
  refresh: typeof refreshAuthSessionWithinTransition;
};

async function refreshAuthSessionWithinTransition() {
  const result = await exchangeRefreshCookie(true);
  if (!result.ok) throw result.error ?? new Error('Auth session changed');
  return { token: result.accessToken, user: result.user };
}

/**
 * Serialize a cookie-changing auth transition with refresh rotation. The
 * callback must commit any successful access session before this promise
 * resolves, while the shared lock is still held.
 */
export async function withAuthSessionTransition<T>(
  action: (context: TAuthSessionTransitionContext) => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = authTransitionTail;
  authTransitionTail = previous.then(() => gate);
  await previous;
  activeAuthTransition = gate;
  try {
    const pendingRefresh = refreshInFlight?.promise;
    if (pendingRefresh) await pendingRefresh;
    return await withAuthRefreshLock(() =>
      action({ refresh: refreshAuthSessionWithinTransition }),
    );
  } finally {
    if (activeAuthTransition === gate) activeAuthTransition = null;
    release();
  }
}

function responseMessage(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return '';
  }

  const message = (data as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join(' ');
  }
  return typeof message === 'string' ? message : '';
}

function responseErrorCode(data: unknown): EErrorCode | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const code = (data as { code?: unknown }).code;
  return typeof code === 'string' &&
    Object.values(EErrorCode).includes(code as EErrorCode)
    ? (code as EErrorCode)
    : undefined;
}

function responseErrorI18n(data: unknown): IErrorI18n | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const i18n = (data as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== 'object') {
    return undefined;
  }

  const { key, params } = i18n as { key?: unknown; params?: unknown };
  if (typeof key !== 'string' || key.length === 0) {
    return undefined;
  }

  return {
    key,
    ...(params && typeof params === 'object'
      ? { params: params as IErrorI18n['params'] }
      : {}),
  };
}

export function getHttpErrorMessage(error: unknown): string {
  const responseData =
    error && typeof error === 'object'
      ? (error as { response?: { data?: unknown } }).response?.data
      : undefined;
  const serverMessage = responseMessage(responseData);
  if (serverMessage) {
    return translateServerErrorMessage(
      i18n.getFixedT(i18n.language, 'platform-common'),
      serverMessage,
      responseErrorCode(responseData),
      responseErrorI18n(responseData),
    );
  }
  return error instanceof Error ? error.message : 'Request failed';
}

function normalizeHttpError(error: unknown): IHttpClientError {
  const response =
    error && typeof error === 'object'
      ? (
          error as {
            response?: {
              data?: unknown;
              headers?: Record<string, unknown>;
            };
          }
        ).response
      : undefined;
  const normalizedError: IHttpClientError = new Error(
    getHttpErrorMessage(error),
  );
  const responseObject =
    response?.data && typeof response.data === 'object'
      ? (response.data as { code?: unknown; messageKey?: unknown })
      : undefined;
  if (typeof responseObject?.code === 'string') {
    normalizedError.responseCode = responseObject.code;
  }
  if (typeof responseObject?.messageKey === 'string') {
    normalizedError.responseMessageKey = responseObject.messageKey;
  }
  normalizedError.i18nKey = responseErrorI18n(response?.data)?.key;
  normalizedError.status = getErrorStatus(error);
  const code =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string') normalizedError.code = code;
  if (axios.isAxiosError(error) && error.config) {
    normalizedError.requestKey = readRequestKey(error.config);
    normalizedError.requestSequence = error.config._serviceRequestSequence;
  }
  const retryAfter = response?.headers?.['retry-after'];
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) {
    normalizedError.retryAfterSeconds = Number(retryAfter);
  } else if (typeof retryAfter === 'string') {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt))
      normalizedError.retryAfterSeconds = Math.max(
        0,
        Math.ceil((retryAt - Date.now()) / 1_000),
      );
  }
  return normalizedError;
}

export function shouldLogoutForUnauthorizedResponse({
  status,
  requestUrl,
  responseData,
}: {
  status?: number;
  requestUrl: string;
  responseData?: unknown;
}): boolean {
  if (status !== 401) {
    return false;
  }

  if (
    requestUrl.includes('/auth/login') ||
    requestUrl.includes('/auth/register')
  ) {
    return false;
  }

  if (responseErrorI18n(responseData)?.key === 'invalid_or_expired_token') {
    return true;
  }

  const requestPath = requestUrl.split(/[?#]/, 1)[0] ?? '';
  if (/\/auth\/me\/?$/.test(requestPath)) {
    return true;
  }

  const message = responseMessage(responseData).toLowerCase();
  return (
    message.includes('authorization token') ||
    message.includes('expired token') ||
    message.includes('invalid token')
  );
}

export function shouldNotifyServerUpdateForHttpStatus(
  status?: number,
): boolean {
  return (
    status === undefined || status === 426 || status === 429 || status >= 500
  );
}

function isCurrentRequestSession(config: {
  _authRequestEpoch?: number;
  _authRequestUserId?: string;
}): boolean {
  if (config._authRequestEpoch === undefined) return true;
  const session = useAuthStore.getState();
  return (
    config._authRequestEpoch === session.authEpoch &&
    config._authRequestUserId === session.user?.id
  );
}

httpClient.interceptors.request.use(async (config) => {
  config._serviceRequestSequence = ++serviceRequestSequence;
  const requestSession = useAuthStore.getState();
  const { token, user, authEpoch } = requestSession;
  if (config._authRequestEpoch === undefined) {
    config._authRequestUserId = user?.id;
    config._authRequestEpoch = authEpoch;
  }
  if (
    config._authRequestEpoch !== authEpoch ||
    config._authRequestUserId !== user?.id
  )
    throw new axios.CanceledError('Auth session changed');
  if (config.signal?.aborted) throw new axios.CanceledError();
  const requestUrl = config.url ?? '';
  if (
    token &&
    user &&
    !config.skipAuthRefresh &&
    !/\/auth\/(?:refresh|login|register|logout(?:-all)?|password\/)/.test(
      requestUrl,
    ) &&
    isAccessTokenExpiring(token)
  ) {
    const refresh = await exchangeRefreshCookie();
    if (config.signal?.aborted || !isCurrentAuthSession(requestSession)) {
      throw new axios.CanceledError('Auth session changed');
    }
    if (!refresh.ok && isSameAuthSession(requestSession)) {
      if (refresh.permanent) useAuthStore.getState().expireSession();
      const expiresAt = getAccessTokenExpiresAt(token);
      if (
        refresh.permanent ||
        (expiresAt !== undefined && expiresAt <= Date.now())
      ) {
        throw refresh.error ?? new Error('Auth session changed');
      }
    }
  }
  const currentToken = useAuthStore.getState().token;
  if (currentToken) {
    config.headers.Authorization = `Bearer ${currentToken}`;
  }
  config.withCredentials = true;
  return config;
});

httpClient.interceptors.response.use(
  (response) => {
    if (
      response.config.signal?.aborted ||
      !isCurrentRequestSession(response.config)
    ) {
      return Promise.reject(new axios.CanceledError('Auth session changed'));
    }
    return response;
  },
  async (error) => {
    if (axios.isCancel(error)) return Promise.reject(error);
    if (axios.isAxiosError(error)) {
      const requestUrl = error.config?.url ?? '';
      const originalRequest = error.config;
      if (
        originalRequest?.signal?.aborted ||
        (originalRequest && !isCurrentRequestSession(originalRequest))
      ) {
        return Promise.reject(new axios.CanceledError('Auth session changed'));
      }
      const requestSession = useAuthStore.getState();
      const requestAuthorization = axios.AxiosHeaders.from(
        originalRequest?.headers,
      ).get('Authorization');
      const canRefreshWithinTransition = Boolean(
        activeAuthTransition &&
          originalRequest?._authRefreshWithinTransition === true &&
          requestUrl.includes('/auth/me/password'),
      );
      const replayWithCurrentToken = () => {
        const currentSession = useAuthStore.getState();
        if (
          !originalRequest ||
          !currentSession.token ||
          currentSession.user?.id !== originalRequest._authRequestUserId ||
          currentSession.authEpoch !== originalRequest._authRequestEpoch ||
          requestAuthorization === `Bearer ${currentSession.token}` ||
          (originalRequest._authSessionReplayCount ?? 0) >= 2
        ) {
          return null;
        }
        originalRequest._authSessionReplayCount =
          (originalRequest._authSessionReplayCount ?? 0) + 1;
        return httpClient.request(originalRequest);
      };
      // A business 401 belongs to the form. Refreshing here would rotate its
      // session and replay a failed password attempt against the rate limit.
      const shouldRecoverAuth = Boolean(
        error.response?.status === 401 &&
          shouldLogoutForUnauthorizedResponse({
            status: error.response.status,
            requestUrl,
            responseData: error.response.data,
          }) &&
          requestSession.token &&
          originalRequest &&
          originalRequest._authRequestUserId === requestSession.user?.id &&
          originalRequest._authRequestEpoch === requestSession.authEpoch &&
          (!originalRequest.skipAuthRefresh || canRefreshWithinTransition) &&
          !requestUrl.includes('/auth/refresh') &&
          !requestUrl.includes('/auth/login') &&
          !requestUrl.includes('/auth/register') &&
          !requestUrl.includes('/auth/password/'),
      );
      if (shouldRecoverAuth) {
        // A concurrent refresh has already replaced this request's session.
        // This can happen again after our own refresh but before its retry ends.
        const replay = replayWithCurrentToken();
        if (replay) return replay;
      }
      if (
        shouldRecoverAuth &&
        originalRequest &&
        (originalRequest._authRefreshAttempts ?? 0) < 2
      ) {
        originalRequest._authRefreshAttempts =
          (originalRequest._authRefreshAttempts ?? 0) + 1;
        const refresh = await (canRefreshWithinTransition
          ? exchangeRefreshCookie(true)
          : exchangeRefreshCookie());
        if (!isCurrentRequestSession(originalRequest)) {
          return Promise.reject(
            new axios.CanceledError('Auth session changed'),
          );
        }
        if (refresh.ok) {
          originalRequest.headers = axios.AxiosHeaders.from(
            originalRequest.headers,
          );
          originalRequest.headers.set(
            'Authorization',
            `Bearer ${refresh.accessToken}`,
          );
          return httpClient.request(originalRequest);
        }

        // A different refresh can win while ours is still in flight.
        const replay = replayWithCurrentToken();
        if (replay) return replay;

        // Keep a still-valid in-memory session through transient refresh
        // failures. A definitive refresh 401 is the one case that proves the
        // persisted session cannot be recovered.
        if (!refresh.permanent) {
          return Promise.reject(refresh.error ?? normalizeHttpError(error));
        }
      }
      const message = getHttpErrorMessage(error);
      if (
        originalRequest?.showServerUpdateDialog === true &&
        shouldNotifyServerUpdateForHttpStatus(error.response?.status)
      ) {
        const normalizedError = normalizeHttpError(error);
        notifyServerUpdateRequired({
          message,
          source: 'http',
          status: error.response?.status,
          retryable: ['get', 'head'].includes(
            originalRequest.method?.toLowerCase() ?? 'get',
          ),
          code: responseErrorCode(error.response?.data),
          requestKey: readRequestKey(originalRequest),
          requestSequence: originalRequest._serviceRequestSequence,
          retryAt: normalizedError.retryAfterSeconds
            ? Date.now() + normalizedError.retryAfterSeconds * 1_000
            : undefined,
        });
      }
      if (
        !requestUrl.includes('/auth/refresh') &&
        originalRequest?._authRequestEpoch === requestSession.authEpoch &&
        originalRequest._authRequestUserId === requestSession.user?.id &&
        (!requestSession.token ||
          requestAuthorization === `Bearer ${requestSession.token}`) &&
        shouldLogoutForUnauthorizedResponse({
          status: error.response?.status,
          requestUrl,
          responseData: error.response?.data,
        })
      ) {
        try {
          if (requestSession.token) await disconnectLocalPushNotifications();
        } catch {
          // Authentication state must still be cleared if browser cleanup
          // cannot even be initialized.
        }
        if (!isCurrentRequestSession(originalRequest)) {
          return Promise.reject(
            new axios.CanceledError('Auth session changed'),
          );
        }
        if (isSameAuthSession(requestSession)) {
          useAuthStore.getState().expireSession();
        }
      }
      return Promise.reject(normalizeHttpError(error));
    }
    return Promise.reject(
      error instanceof Error ? error : new Error(getHttpErrorMessage(error)),
    );
  },
);
