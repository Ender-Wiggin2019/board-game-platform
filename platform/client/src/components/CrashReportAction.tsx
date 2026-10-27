import { useCallback, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import type { ICrashIncident } from '@/lib/crashReporter';

export interface ICrashReportActionProps {
  incident: ICrashIncident;
}

/**
 * Shows the automatic report state and keeps a manual retry available when a
 * crash report could not be sent.
 */
export function CrashReportAction({
  incident,
}: ICrashReportActionProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const subscribe = useCallback(
    (listener: () => void) => incident.subscribe(listener),
    [incident],
  );
  const getSnapshot = useCallback(() => incident.getSnapshot(), [incident]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isSending = snapshot.status === 'sending';
  const isSent = snapshot.status === 'sent';

  const submit = useCallback(() => {
    void incident.submit().catch(() => undefined);
  }, [incident]);

  let statusMessage: React.JSX.Element | null = null;
  if (isSending) {
    statusMessage = (
      <span
        className='text-xs text-text-400'
        data-testid='crash-report-status'
        role='status'
      >
        {t('client.crash_report.submitting')}
      </span>
    );
  } else if (isSent) {
    statusMessage = (
      <span
        className='text-xs text-signal-green-hi'
        data-testid='crash-report-status'
        role='status'
      >
        {t('client.crash_report.sent', {
          reportId: snapshot.reportId ?? '—',
        })}
      </span>
    );
  } else if (snapshot.status === 'failed') {
    statusMessage = (
      <span
        className='text-xs text-signal-red-hi'
        data-testid='crash-report-status'
        role='status'
      >
        {t('client.crash_report.failed')}
      </span>
    );
  } else if (snapshot.status === 'limited') {
    statusMessage = (
      <span
        className='text-xs text-signal-amber-hi'
        data-testid='crash-report-status'
        role='status'
      >
        {t('client.crash_report.limited')}
      </span>
    );
  }

  return (
    <div
      className='mt-3 flex flex-wrap items-center gap-2'
      data-testid='crash-report-action'
    >
      <Button
        variant='ghost'
        size='sm'
        onClick={submit}
        disabled={isSending || isSent}
        loading={isSending}
        data-testid='crash-report-submit'
      >
        {snapshot.status === 'failed'
          ? t('client.crash_report.retry')
          : t('client.crash_report.submit')}
      </Button>
      {statusMessage}
    </div>
  );
}
