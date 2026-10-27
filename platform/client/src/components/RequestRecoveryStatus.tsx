import { useRef } from 'react';
import { FullScreenStatus } from '@/components/FullScreenStatus';
import { RequestRecoveryDialog } from '@/components/RequestRecoveryDialog';

/** Used only until the requested page data is available. */
export function RequestRecoveryStatus({
  error,
  isRetrying,
  onRetry,
  retryTestId,
}: {
  error: unknown;
  isRetrying: boolean;
  onRetry: () => void | Promise<unknown>;
  retryTestId?: string;
}): React.JSX.Element {
  const lastError = useRef<unknown>();
  if (error !== undefined && error !== null) lastError.current = error;
  const activeError = error ?? lastError.current;
  return activeError === undefined ? (
    <FullScreenStatus />
  ) : (
    <RequestRecoveryDialog
      error={activeError}
      isRetrying={isRetrying}
      onRetry={onRetry}
      retryTestId={retryTestId}
    />
  );
}
