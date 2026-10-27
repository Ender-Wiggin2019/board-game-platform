import type { ErrorComponentProps } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CrashReportAction } from '@/components/CrashReportAction';
import { FullScreenStatus } from '@/components/FullScreenStatus.js';
import { captureCrash, type ICrashIncident } from '@/lib/crashReporter';
import { forceReloadLatestVersion } from '@/lib/forceReloadLatestVersion.js';
import { isChunkLoadFailure } from '@/lib/staleChunkRecovery';

interface IRouteErrorPageProps extends ErrorComponentProps {
  onReload?: () => Promise<void> | void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown route error';
}

function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) return error.stack;
  if (typeof error !== 'object' || error === null || !('stack' in error)) {
    return undefined;
  }
  const stack = error.stack;
  return typeof stack === 'string' && stack.length > 0 ? stack : undefined;
}

export function isDynamicImportError(error: unknown): boolean {
  return isChunkLoadFailure(getErrorMessage(error));
}

export function RouteErrorPage({
  error,
  reset,
  onReload = forceReloadLatestVersion,
}: IRouteErrorPageProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const [incident, setIncident] = useState<ICrashIncident | null>(null);
  const needsLatestVersion = isDynamicImportError(error);
  const variant = needsLatestVersion ? 'version' : 'generic';
  const errorMessage = getErrorMessage(error);
  const errorStack = getErrorStack(error);

  useEffect(() => {
    setIncident(captureCrash(error, { source: 'route' }));
  }, [error]);

  return (
    <FullScreenStatus
      state='error'
      label={t(`client.route_error.${variant}.title`)}
      description={t(`client.route_error.${variant}.description`)}
      action={{
        label: needsLatestVersion
          ? t('client.route_error.version.reload')
          : t('client.common.retry'),
        onClick: needsLatestVersion ? onReload : reset,
      }}
      secondaryAction={{ label: t('client.route_error.home'), href: '/' }}
    >
      <details
        data-testid='route-error-details'
        className='group mt-7 border-t border-[color:var(--metal-edge-soft)] pt-4 text-left'
      >
        <summary className='flex cursor-pointer list-none items-center justify-between gap-4 text-xs font-medium text-text-500 transition-colors hover:text-text-300'>
          <span>{t('client.route_error.technical_details')}</span>
          <ChevronDown
            aria-hidden
            className='h-4 w-4 transition-transform duration-200 group-open:rotate-180'
          />
        </summary>
        <div className='mt-3 rounded-[5px] bg-[oklch(0.045_0.012_260/0.84)] p-3'>
          <code className='block break-all font-mono text-[0.7rem] leading-5 text-[oklch(0.72_0.04_235)]'>
            {errorMessage}
          </code>
          {errorStack ? (
            <pre
              data-testid='route-error-stack'
              className='mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-[color:var(--metal-edge-soft)] pt-3 font-mono text-[0.65rem] leading-5 text-[oklch(0.62_0.04_235)]'
            >
              {errorStack}
            </pre>
          ) : null}
        </div>
      </details>
      {incident ? <CrashReportAction incident={incident} /> : null}
    </FullScreenStatus>
  );
}
