import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  authSessionLifecycle,
  type IAuthSessionSnapshot,
  type TAuthSessionRefreshResult,
} from '@/api/authSessionLifecycle';
import {
  ACCESS_TOKEN_REFRESH_LEEWAY_MS,
  getAccessTokenExpiresAt,
} from '@/api/authToken';
import { onSessionEnd } from '@/api/sessionEnd';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/authStore';

type TRefreshSession = IAuthSessionSnapshot;

/** Renews before expiry and ends the session only when recovery fails permanently. */
export function SessionTerminationListener(): null {
  const expireSession = useAuthStore((state) => state.expireSession);
  const queryClient = useQueryClient();
  const { t } = useTranslation('platform-common');

  useEffect(() => {
    let active = true;
    let refreshInFlight: Promise<void> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryNotBefore = 0;
    let retrySession: TRefreshSession | null = null;
    let renewalTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetry = (): void => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      retryNotBefore = 0;
    };

    const isRecoverableSession = (session: TRefreshSession): boolean =>
      active &&
      retrySession === session &&
      authSessionLifecycle.isCurrent(session);

    const clearRecovery = (): void => {
      retrySession = null;
      clearRetry();
    };

    const armRetryTimer = (session: TRefreshSession, delayMs: number): void => {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (navigator.onLine) refreshSession(session);
      }, delayMs);
    };

    const scheduleRetry = (
      requestSession: TRefreshSession,
      result: TAuthSessionRefreshResult,
    ): void => {
      if (
        result.kind !== 'retry' ||
        !isRecoverableSession(requestSession) ||
        retryTimer
      ) {
        return;
      }
      const delayMs = Math.max(0, result.retryAt - Date.now());
      retryNotBefore = result.retryNotBefore;
      if (!navigator.onLine) return;
      armRetryTimer(requestSession, delayMs);
    };

    const refreshSession = (requestSession: TRefreshSession): void => {
      if (!isRecoverableSession(requestSession) || refreshInFlight) {
        return;
      }

      refreshInFlight = (async () => {
        const result = await authSessionLifecycle.refresh(requestSession);
        if (!active || !isRecoverableSession(requestSession)) {
          if (retrySession === requestSession) clearRecovery();
          return;
        }
        switch (result.kind) {
          case 'stale':
            if (retrySession === requestSession) clearRecovery();
            return;
          case 'refreshed':
            clearRecovery();
            return;
          case 'retry':
            scheduleRetry(requestSession, result);
            return;
          case 'expired':
            clearRecovery();
            expireSession();
            queryClient.clear();
            toast({
              title: t('client.server_errors.invalid_or_expired_token'),
              variant: 'error',
              duration: null,
            });
        }
      })().finally(() => {
        refreshInFlight = null;
        const queuedSession = retrySession;
        if (queuedSession && queuedSession !== requestSession) {
          if (authSessionLifecycle.isCurrent(queuedSession)) {
            refreshSession(queuedSession);
          } else {
            clearRecovery();
          }
        }
      });
    };

    const handleSessionEnd = (): void => {
      const requestSession = useAuthStore.getState();
      if (
        !requestSession.isAuthenticated ||
        !requestSession.token ||
        !requestSession.user
      ) {
        return;
      }
      if (retrySession && authSessionLifecycle.isCurrent(retrySession)) return;
      if (retrySession) clearRecovery();
      retrySession = authSessionLifecycle.capture();
      refreshSession(retrySession);
    };

    const handleOnline = (): void => {
      if (!retrySession) {
        scheduleRenewal();
        return;
      }
      if (refreshInFlight) return;
      const session = retrySession;
      if (!isRecoverableSession(session)) {
        clearRecovery();
        return;
      }
      if (Date.now() < retryNotBefore) {
        if (!retryTimer) {
          armRetryTimer(session, retryNotBefore - Date.now());
        }
        return;
      }
      clearRetry();
      refreshSession(session);
    };

    const scheduleRenewal = (): void => {
      if (renewalTimer) clearTimeout(renewalTimer);
      renewalTimer = null;
      const session = useAuthStore.getState();
      if (
        !session.isAuthenticated ||
        session.isRestoring ||
        (retrySession && authSessionLifecycle.isCurrent(retrySession))
      )
        return;
      const expiresAt = getAccessTokenExpiresAt(session.token);
      if (expiresAt === undefined) return;
      const delay = expiresAt - Date.now() - ACCESS_TOKEN_REFRESH_LEEWAY_MS;
      if (delay <= 0) {
        if (navigator.onLine) handleSessionEnd();
        return;
      }
      renewalTimer = setTimeout(
        scheduleRenewal,
        Math.min(delay, 2_147_000_000),
      );
    };
    const handleVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (retrySession && authSessionLifecycle.isCurrent(retrySession)) {
        if (navigator.onLine) handleOnline();
        return;
      }
      scheduleRenewal();
    };
    const handleFocus = (): void => {
      if (retrySession && authSessionLifecycle.isCurrent(retrySession)) {
        if (navigator.onLine) handleOnline();
        return;
      }
      scheduleRenewal();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    const unsubscribeAuth = useAuthStore.subscribe((session, previous) => {
      if (
        session.token !== previous.token ||
        session.authEpoch !== previous.authEpoch ||
        session.isRestoring !== previous.isRestoring
      )
        scheduleRenewal();
    });
    scheduleRenewal();

    const unsubscribe = onSessionEnd(handleSessionEnd);
    return () => {
      active = false;
      retrySession = null;
      clearRetry();
      if (renewalTimer) clearTimeout(renewalTimer);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      unsubscribeAuth();
      unsubscribe();
    };
  }, [expireSession, queryClient, t]);

  return null;
}
