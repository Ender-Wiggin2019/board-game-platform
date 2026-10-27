import { RequestRecoveryDialog } from '@/components/RequestRecoveryDialog';
import { type IServerUpdateNotification } from '@/lib/serverUpdateNotification';

export function ServerUpdateDialog({
  notification,
  onDismiss,
  onRetry,
}: {
  notification: IServerUpdateNotification;
  onDismiss: () => void;
  onRetry?: () => void | Promise<unknown>;
}): React.JSX.Element {
  return (
    <RequestRecoveryDialog
      error={notification}
      onRetry={onRetry ?? notification.retry}
      onDismiss={onDismiss}
      retryAt={notification.retryAt}
    />
  );
}
