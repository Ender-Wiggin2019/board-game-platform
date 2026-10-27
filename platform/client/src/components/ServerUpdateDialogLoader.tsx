import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ServerUpdateDialog } from '@/components/ServerUpdateDialog';
import { resolveRequestFailure } from '@/lib/requestRecovery';
import {
  type IServerUpdateNotification,
  onServerUpdateRecovered,
  onServerUpdateRequired,
} from '@/lib/serverUpdateNotification';

interface IServerUpdateDialogLoaderProps {
  onRetry?: (notification: IServerUpdateNotification) => Promise<unknown>;
}

function requiresLatestVersion(
  notification: IServerUpdateNotification,
): boolean {
  return resolveRequestFailure(notification, true) === 'version';
}

export function ServerUpdateDialogLoader({
  onRetry,
}: IServerUpdateDialogLoaderProps = {}): React.JSX.Element | null {
  const [notification, setNotification] =
    useState<IServerUpdateNotification | null>(null);
  const notificationRef = useRef<IServerUpdateNotification | null>(null);

  const handleNotification = useCallback(
    (nextNotification: IServerUpdateNotification): void => {
      const currentNotification = notificationRef.current;
      if (
        currentNotification &&
        requiresLatestVersion(currentNotification) &&
        !requiresLatestVersion(nextNotification)
      ) {
        return;
      }
      notificationRef.current = nextNotification;
      setNotification(nextNotification);
    },
    [],
  );

  useEffect(() => {
    const unsubscribeFailure = onServerUpdateRequired(handleNotification);
    const unsubscribeRecovery = onServerUpdateRecovered(
      ({ requestKey, requestSequence }) => {
        const currentNotification = notificationRef.current;
        if (
          !currentNotification ||
          requiresLatestVersion(currentNotification) ||
          currentNotification.requestKey !== requestKey ||
          currentNotification.requestSequence === undefined ||
          requestSequence < currentNotification.requestSequence
        ) {
          return;
        }
        notificationRef.current = null;
        setNotification(null);
      },
    );
    return () => {
      unsubscribeFailure();
      unsubscribeRecovery();
    };
  }, [handleNotification]);

  const retry = useMemo(() => {
    if (!notification) return undefined;
    if (notification.retry) return notification.retry;
    if (notification.source !== 'http' || notification.retryable !== true) {
      return undefined;
    }
    return onRetry;
  }, [notification, onRetry]);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (!notification || !retry) return;

    if (notification.retry) {
      await notification.retry();
    } else {
      await onRetry?.(notification);
    }
    if (notificationRef.current === notification) {
      notificationRef.current = null;
      setNotification(null);
    }
  }, [notification, onRetry, retry]);

  const handleDismiss = useCallback((): void => {
    if (!notification || notificationRef.current !== notification) return;
    notificationRef.current = null;
    setNotification(null);
  }, [notification]);

  if (!notification) {
    return null;
  }
  return (
    <ServerUpdateDialog
      notification={notification}
      onDismiss={handleDismiss}
      onRetry={retry ? handleRetry : undefined}
    />
  );
}
