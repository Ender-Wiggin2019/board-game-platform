import {
  type IAuthUser,
  isCurrentAuthSession,
  isSameAuthSession,
  useAuthStore,
} from '../stores/authStore.js';
import { authApi } from './authApi.js';
import {
  getAuthRefreshRetryAfterMs,
  getAuthRefreshRetryDelay,
  isPermanentAuthRefreshFailure,
} from './authRefreshCoordinator.js';
import type { ILoginResponse } from './types.js';

/** The identity captured before an asynchronous refresh starts. */
export interface IAuthSessionSnapshot {
  token: string | null;
  user: IAuthUser | null;
  authEpoch: number;
  isAuthenticated: boolean;
}

export type TAuthSessionRefreshResult =
  | { kind: 'refreshed'; session: ILoginResponse }
  | { kind: 'stale' }
  | {
      kind: 'retry';
      error: unknown;
      retryAt: number;
      retryNotBefore: number;
      attempt: number;
    }
  | { kind: 'expired'; error: unknown };

/** Production and test adapters for the session lifecycle implementation. */
export interface IAuthSessionLifecycleAdapter {
  readSession: () => IAuthSessionSnapshot;
  isCurrent: (requestSession: IAuthSessionSnapshot) => boolean;
  refresh: () => Promise<ILoginResponse>;
}

/**
 * Owns refresh outcomes that are shared by cold-start restore and active
 * session renewal. Browser event scheduling and visible projections stay in
 * their providers; this module owns identity races, retry policy, and the
 * permanent-failure classification at the refresh seam.
 */
export class AuthSessionLifecycle {
  private readonly inFlight = new Map<
    string,
    Promise<TAuthSessionRefreshResult>
  >();

  private readonly attempts = new Map<string, number>();

  public constructor(private readonly adapter: IAuthSessionLifecycleAdapter) {}

  public capture(): IAuthSessionSnapshot {
    return this.adapter.readSession();
  }

  public isCurrent(requestSession: IAuthSessionSnapshot): boolean {
    return this.adapter.isCurrent(requestSession);
  }

  /** Attempt one refresh for the captured session identity. */
  public refresh(
    requestSession: IAuthSessionSnapshot,
  ): Promise<TAuthSessionRefreshResult> {
    const key = getSessionKey(requestSession);
    if (!this.isCurrent(requestSession))
      return Promise.resolve({ kind: 'stale' });

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<TAuthSessionRefreshResult> => {
      try {
        const session = await this.adapter.refresh();
        // The transport commits successful refreshes and may rotate the
        // token. Active sessions still reject a result that completed after
        // logout or account replacement; a cold-start transport may
        // legitimately transition an anonymous snapshot into a session.
        if (requestSession.isAuthenticated && !this.isCurrent(requestSession))
          return { kind: 'stale' };
        this.attempts.delete(key);
        return { kind: 'refreshed', session };
      } catch (error) {
        if (!this.isCurrent(requestSession)) return { kind: 'stale' };
        if (isPermanentAuthRefreshFailure(error)) {
          this.attempts.delete(key);
          return { kind: 'expired', error };
        }

        const attempt = this.attempts.get(key) ?? 0;
        this.attempts.set(key, attempt + 1);
        const now = Date.now();
        return {
          kind: 'retry',
          error,
          retryAt: now + getAuthRefreshRetryDelay(error, attempt),
          retryNotBefore: now + getAuthRefreshRetryAfterMs(error),
          attempt: attempt + 1,
        };
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Forget retry state when a provider dismisses an unfinished operation. */
  public forget(requestSession: IAuthSessionSnapshot): void {
    this.attempts.delete(getSessionKey(requestSession));
  }
}

function getSessionKey(session: IAuthSessionSnapshot): string {
  return `${session.authEpoch}:${session.user?.id ?? 'anonymous'}`;
}

function readAuthSession(): IAuthSessionSnapshot {
  const session = useAuthStore.getState();
  return {
    token: session.token,
    user: session.user,
    authEpoch: session.authEpoch,
    isAuthenticated: session.isAuthenticated,
  };
}

export const authSessionLifecycle = new AuthSessionLifecycle({
  readSession: readAuthSession,
  isCurrent: (requestSession) =>
    requestSession.isAuthenticated
      ? isCurrentAuthSession(requestSession)
      : isSameAuthSession(requestSession),
  refresh: () => authApi.refresh(),
});
