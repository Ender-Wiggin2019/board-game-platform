import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRequestRetryCooldown } from '@/hooks/useRequestRetryCooldown';
import { forceReloadLatestVersion } from '@/lib/forceReloadLatestVersion';
import {
  resolveRequestFailure,
  type TRequestFailureKind,
} from '@/lib/requestRecovery';

interface IRequestRecoveryDialogProps {
  error: unknown;
  onRetry?: () => void | Promise<unknown>;
  onDismiss?: () => void;
  isRetrying?: boolean;
  retryAt?: number;
  retryTestId?: string;
  dismissLabel?: string;
  dismissible?: boolean;
}

function getRetrySeconds(retryAt: number | undefined, now: number): number {
  if (retryAt === undefined) return 0;
  return Math.max(0, Math.ceil((retryAt - now) / 1_000));
}

export function RequestRecoveryDialog({
  error,
  onRetry,
  onDismiss,
  isRetrying = false,
  retryAt,
  retryTestId,
  dismissLabel,
  dismissible = true,
}: IRequestRecoveryDialogProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const [isOnline, setIsOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  const [internalRetrying, setInternalRetrying] = useState(false);
  const [retryError, setRetryError] = useState<unknown>();
  const retryInFlightRef = useRef(false);
  const latestErrorRef = useRef(error);

  latestErrorRef.current = error;

  useEffect(() => {
    setRetryError(undefined);
  }, [error]);

  const activeError = retryError ?? error;
  const kind: TRequestFailureKind = resolveRequestFailure(
    activeError,
    isOnline,
  );
  const { retryAt: effectiveRetryAt, seconds: retrySeconds } =
    useRequestRetryCooldown(activeError, kind === 'version' ? 0 : retryAt);
  const retryAction = kind === 'version' ? forceReloadLatestVersion : onRetry;
  const retryOnCooldown = retrySeconds > 0;
  const retryPending = internalRetrying || isRetrying;
  const canRetry = retryAction !== undefined;
  const canDismiss =
    onDismiss !== undefined && !retryPending && kind !== 'version';

  const handleRetry = useCallback(async (): Promise<void> => {
    if (
      !retryAction ||
      kind === 'offline' ||
      retryInFlightRef.current ||
      isRetrying ||
      getRetrySeconds(effectiveRetryAt, Date.now()) > 0
    ) {
      return;
    }

    retryInFlightRef.current = true;
    setRetryError(undefined);
    setInternalRetrying(true);
    const requestError = latestErrorRef.current;
    try {
      await retryAction();
    } catch (nextError) {
      if (latestErrorRef.current === requestError) {
        setRetryError(nextError);
      }
    } finally {
      retryInFlightRef.current = false;
      setInternalRetrying(false);
    }
  }, [kind, isRetrying, retryAction, effectiveRetryAt]);

  const handleDismiss = useCallback((): void => {
    if (!canDismiss) return;
    onDismiss?.();
  }, [canDismiss, onDismiss]);

  const titleKey = `client.requestRecovery.${kind}.title`;
  const descriptionKey = `client.requestRecovery.${kind}.description`;
  const retryLabelKey =
    kind === 'version'
      ? 'client.route_error.version.reload'
      : 'client.common.retry';

  useEffect(() => {
    const handleOnline = (): void => setIsOnline(true);
    const handleOffline = (): void => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return (
    <Dialog
      open
      ariaLabel={t(titleKey)}
      dismissible={canDismiss && dismissible}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleDismiss();
      }}
    >
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>
        <DialogDescription>{t(descriptionKey)}</DialogDescription>
        {!retryPending && retryOnCooldown ? (
          <p role='status' className='mt-3 text-sm text-text-400'>
            {t('client.requestRecovery.retry_countdown', {
              seconds: retrySeconds,
            })}
          </p>
        ) : null}
        <DialogFooter>
          {canRetry && onDismiss && kind !== 'version' ? (
            <Button
              variant='ghost'
              disabled={retryPending}
              onClick={handleDismiss}
            >
              {dismissLabel ?? t('client.requestRecovery.return_to_page')}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              data-testid={retryTestId}
              disabled={retryPending || retryOnCooldown || kind === 'offline'}
              loading={retryPending}
              loadingLabel={t('client.requestRecovery.retrying')}
              onClick={() => void handleRetry()}
            >
              {t(retryLabelKey)}
            </Button>
          ) : (
            <Button
              data-testid={retryTestId}
              disabled={!onDismiss || retryPending}
              onClick={handleDismiss}
            >
              {dismissLabel ?? t('client.requestRecovery.return_to_page')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
