import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

/** Keeps a failed refresh recoverable without replacing the last loaded view. */
export function QueryRefreshNotice({
  onRetry,
  retrying = false,
}: {
  readonly onRetry: () => void;
  readonly retrying?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <div
      role='alert'
      className='flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-surface-instrument px-4 py-3 text-sm text-text-400'
    >
      <span>{t('status.refresh_error')}</span>
      <Button
        type='button'
        size='sm'
        variant='ghost'
        onClick={onRetry}
        loading={retrying}
      >
        {t('status.retry')}
      </Button>
    </div>
  );
}
