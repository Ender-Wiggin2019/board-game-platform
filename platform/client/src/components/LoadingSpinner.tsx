import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

interface ILoadingSpinnerProps {
  label?: string;
  /** Compact feedback in a flow, or centered within a content region. */
  variant?: 'inline' | 'block';
  className?: string;
}

export function LoadingSpinner(props: ILoadingSpinnerProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const variant = props.variant ?? 'inline';
  const label = props.label ?? t('client.common.loading');

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 text-sm leading-relaxed text-text-400',
        variant === 'block' && 'flex w-full justify-center py-6',
        props.className,
      )}
      role='status'
      aria-live='polite'
    >
      <Loader2 aria-hidden className='h-4 w-4 shrink-0 animate-spin' />
      <span>{label}</span>
    </div>
  );
}
