import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getErrorStatus } from '@/api/authRefreshCoordinator';
import { authSessionLifecycle } from '@/api/authSessionLifecycle';
import {
  ACCESS_TOKEN_REFRESH_LEEWAY_MS,
  getAccessTokenExpiresAt,
} from '@/api/authToken';
import { FullScreenStatus } from '@/components/FullScreenStatus';
import { RequestRecoveryDialog } from '@/components/RequestRecoveryDialog';
import { logDebug } from '@/lib/debugLog';
import { resolveRequestFailure } from '@/lib/requestRecovery';
import { useAuthStore } from '@/stores/authStore';

interface IRecoveryState {
  pending: boolean;
  error?: unknown;
  retryAt?: number;
  isRetrying: boolean;
}

/** Restore saved sign-in without treating a retryable failure as a logout. */
export function AuthSessionBootstrap({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const [state, setState] = useState<IRecoveryState>({
    pending: true,
    isRetrying: false,
  });
  const retryRef = useRef<() => Promise<void>>();
  const finishRef = useRef<() => void>();

  useEffect(() => {
    let active = true;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    let retryAt = 0;
    let retryNotBefore = 0;
    const requestSession = authSessionLifecycle.capture();
    const hadSessionCookie = document.cookie
      .split(';')
      .some((part) => part.trim().startsWith('__Host-seti-csrf='));
    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const finish = (): void => {
      if (!active || settled) return;
      settled = true;
      clearTimer();
      authSessionLifecycle.forget(requestSession);
      useAuthStore.getState().setRestoring(false);
      setState({ pending: false, isRetrying: false });
    };
    const expiresAt = getAccessTokenExpiresAt(requestSession.token);
    finishRef.current = finish;
    if (
      (!requestSession.isAuthenticated && !hadSessionCookie) ||
      (requestSession.isAuthenticated &&
        expiresAt !== undefined &&
        expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_LEEWAY_MS)
    ) {
      finish();
      return;
    }
    useAuthStore.getState().setRestoring(true);

    const armRetry = (): void => {
      clearTimer();
      if (!active || settled || !navigator.onLine) return;
      timer = setTimeout(
        () => void restore(),
        Math.min(Math.max(0, retryAt - Date.now()), 2_147_000_000),
      );
    };
    const restore = (): Promise<void> => {
      if (!active || settled) return Promise.resolve();
      if (inFlight) return inFlight;
      if (Date.now() < retryAt) {
        armRetry();
        return Promise.resolve();
      }
      if (!navigator.onLine) {
        if (requestSession.isAuthenticated)
          useAuthStore.getState().setRestoring(false);
        setState({
          pending: !requestSession.isAuthenticated,
          error: new Error('offline'),
          isRetrying: false,
        });
        return Promise.resolve();
      }
      clearTimer();
      setState((current) => ({
        ...current,
        isRetrying: true,
        retryAt: undefined,
      }));
      inFlight = (async () => {
        const result = await authSessionLifecycle.refresh(requestSession);
        if (!active || settled) return;
        switch (result.kind) {
          case 'stale':
          case 'refreshed':
            finish();
            return;
          case 'expired':
            if (requestSession.isAuthenticated || hadSessionCookie)
              useAuthStore.getState().expireSession();
            else useAuthStore.getState().logout();
            finish();
            return;
          case 'retry':
            retryAt = result.retryAt;
            retryNotBefore = result.retryNotBefore;
            if (requestSession.isAuthenticated)
              useAuthStore.getState().setRestoring(false);
            logDebug('warn', 'auth', 'Automatic sign-in delayed', {
              kind: resolveRequestFailure(result.error),
              status: getErrorStatus(result.error),
              attempt: result.attempt,
            });
            setState({
              pending: !requestSession.isAuthenticated,
              error: result.error,
              retryAt,
              isRetrying: false,
            });
            armRetry();
        }
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    retryRef.current = restore;
    const onResume = (): void => {
      if (!navigator.onLine) return;
      if (Date.now() >= retryNotBefore) retryAt = 0;
      void restore();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') onResume();
    };
    const onOffline = (): void => {
      clearTimer();
      if (!settled && !inFlight)
        setState((current) => ({
          ...current,
          error: new Error('offline'),
          retryAt: undefined,
        }));
    };
    const unsubscribe = useAuthStore.subscribe(() => {
      if (!authSessionLifecycle.isCurrent(requestSession)) finish();
    });
    window.addEventListener('online', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    void restore();
    return () => {
      active = false;
      clearTimer();
      unsubscribe();
      window.removeEventListener('online', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <>
      {state.pending ? (
        state.error === undefined ? (
          <FullScreenStatus />
        ) : null
      ) : (
        children
      )}
      {state.error !== undefined ? (
        <RequestRecoveryDialog
          error={state.error}
          onRetry={() => retryRef.current?.()}
          onDismiss={() => finishRef.current?.()}
          dismissLabel={
            state.pending
              ? t('client.requestRecovery.signin_action')
              : undefined
          }
          dismissible={!state.pending}
          retryAt={state.retryAt}
          isRetrying={state.isRetrying}
        />
      ) : null}
    </>
  );
}
