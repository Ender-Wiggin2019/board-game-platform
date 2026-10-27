import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

/**
 * Button — the interactive workhorse.
 * Three visual languages for three levels of intent:
 *  - `primary`  → energy-orange filled control. Main CTAs.
 *  - `ghost`    → quiet surface. Secondary actions, filters, chips.
 *  - `danger`   → red filled control. Destructive / game-ending only.
 *  - `link`     → text-only, for inline or subtle nav.
 */
const buttonVariants = cva(
  [
    // Structural
    'relative inline-flex cursor-pointer items-center justify-center gap-2',
    'font-body font-medium whitespace-nowrap select-none',
    'transition-[background,box-shadow,color,transform] duration-150',
    // No focus decoration; hover and pressed states provide feedback.
    'focus-visible:outline-none',
    // Disabled
    'disabled:cursor-not-allowed disabled:opacity-50',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: [
          // Refine v2 primary: compact energy-orange face, no glow.
          'text-[var(--lobby-orbit-white)]',
          'bg-[var(--lobby-energy-orange)]',
          'hover:bg-[#ff7a2b]',
          'active:bg-[#d95519]',
          'active:translate-y-px',
        ],
        ghost: [
          // Secondary action: a quiet surface with clear pointer feedback.
          'text-text-100',
          'bg-surface-700',
          'aria-pressed:bg-accent-500/20 aria-pressed:text-text-100 aria-pressed:hover:bg-accent-500/30',
          'hover:bg-surface-700 hover:brightness-110',
          'active:bg-surface-800/80',
          'active:translate-y-px',
        ],
        choice: [
          'border border-accent-500 bg-accent-500/20 text-text-100',
          'hover:border-accent-400 hover:bg-accent-500/30',
          'active:bg-accent-500/15 active:translate-y-px',
        ],
        danger: [
          'text-[oklch(0.98_0.02_28)]',
          'bg-[var(--signal-red)]',
          'hover:brightness-110',
          'active:translate-y-px',
        ],
        link: [
          'bg-transparent border-transparent shadow-none',
          'text-accent-400 hover:text-text-100',
          'underline-offset-4 hover:underline',
          'px-0 py-0 h-auto',
        ],
      },
      size: {
        sm: 'h-8 px-3 rounded-[4px] text-xs',
        md: 'h-10 px-4 rounded-[5px] text-sm',
        lg: 'h-12 px-6 rounded-[6px] text-sm tracking-wide',
        icon: 'h-10 w-10 rounded-[5px] p-0',
        iconSm: 'h-7 w-7 rounded-[4px] p-0',
      },
      wrap: {
        true: 'h-auto min-h-10 whitespace-normal py-2',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

type TButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    loadingLabel?: string;
  };

export function Button({
  className,
  children,
  disabled,
  loading = false,
  loadingLabel,
  variant,
  size,
  wrap,
  type = 'button',
  ...props
}: TButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, wrap }), className)}
      {...props}
    >
      {loading ? (
        <Loader2
          aria-hidden
          className='h-3.5 w-3.5 shrink-0 animate-spin'
          data-testid='button-loading-spinner'
        />
      ) : null}
      {loading ? (
        loadingLabel ? (
          <span className='sr-only'>{loadingLabel}</span>
        ) : (
          <LocalizedLoadingLabel />
        )
      ) : null}
      {children}
    </button>
  );
}

function LocalizedLoadingLabel(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  return <span className='sr-only'>{t('client.common.loading')}</span>;
}

export { buttonVariants };
