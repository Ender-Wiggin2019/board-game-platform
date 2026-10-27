import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { type IToast, useToastStore } from '@/components/ui/toastStore';
import { cn } from '@/lib/cn';
import { UI_Z_INDEX } from '@/styles/zIndex';

export { toast, useToastStore } from '@/components/ui/toastStore';

/**
 * Toast — ephemeral status messages, styled as mission-log entries.
 * Each toast is a hairline-metal panel with a single colored accent
 * stripe on the *bottom* (instrument underline; never a left stripe,
 * which is the #1 AI design tell and explicitly banned).
 */
const ACCENT_LINE: Record<NonNullable<IToast['variant']>, string> = {
  default: 'oklch(0.68 0.11 240)',
  success: 'oklch(0.75 0.16 160)',
  warning: 'oklch(0.78 0.16 78)',
  error: 'oklch(0.68 0.18 28)',
};

const ACCENT_TEXT: Record<NonNullable<IToast['variant']>, string> = {
  default: 'text-text-100',
  success: 'text-[oklch(0.90_0.12_160)]',
  warning: 'text-[oklch(0.92_0.14_78)]',
  error: 'text-[oklch(0.88_0.14_28)]',
};

function ToastItem({
  toast: t,
  onDismiss,
}: {
  toast: IToast;
  onDismiss: () => void;
}): React.JSX.Element {
  const { t: translate } = useTranslation('platform-common');
  useEffect(() => {
    if (t.duration === null) {
      return;
    }
    const timer = setTimeout(onDismiss, t.duration ?? 4000);
    return () => clearTimeout(timer);
  }, [t.duration, onDismiss]);

  const variant = t.variant ?? 'default';

  return (
    <div
      role='status'
      aria-live='polite'
      className={cn(
        'pointer-events-auto relative flex w-full max-w-sm items-start gap-3',
        'rounded-[6px] overflow-hidden',
        'bg-surface-900/95 backdrop-blur-sm',
        'shadow-instrument',
        'p-4',
        'animate-panel-rise',
      )}
    >
      {/* Bottom accent line — instrument underline (explicitly NOT a left stripe). */}
      <span
        aria-hidden
        className='pointer-events-none absolute inset-x-0 bottom-0 h-px'
        style={{
          background: ACCENT_LINE[variant],
        }}
      />
      <div className='flex-1 min-w-0'>
        <p
          className={cn(
            'font-body text-sm font-medium leading-snug',
            ACCENT_TEXT[variant],
          )}
        >
          {t.title}
        </p>
        {t.description && (
          <p className='mt-1 text-xs leading-relaxed text-text-500'>
            {t.description}
          </p>
        )}
        {t.action && (
          <button
            type='button'
            onClick={t.action.onClick}
            className={cn(
              'mt-2 inline-flex items-center rounded-sm px-2 py-1 text-xs font-medium',
              ' text-text-100',
              'transition-colors hover:bg-surface-800',
            )}
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type='button'
        onClick={onDismiss}
        className='-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-sm text-text-500 transition-colors hover:bg-surface-800 hover:text-text-100'
        aria-label={translate('client.toast.dismiss', {
          defaultValue: 'Dismiss',
        })}
      >
        <X aria-hidden size={14} />
      </button>
    </div>
  );
}

export function Toaster(): React.JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || toasts.length === 0) return null;

  return createPortal(
    <div
      className='fixed bottom-4 right-4 flex flex-col-reverse gap-2 pointer-events-none'
      style={{ zIndex: UI_Z_INDEX.toast }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => removeToast(t.id)} />
      ))}
    </div>,
    document.body,
  );
}
