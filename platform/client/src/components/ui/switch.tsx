import { cn } from '@/lib/cn';

/**
 * Switch — toggle with a metal track and a copper-orange active state.
 * Off state is a dark well with a hairline metal rim and a dimmed bead.
 * On state fills the track with the interaction accent (#D76429) and
 * lights the bead in white.
 */
interface ISwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'data-testid': dataTestId,
}: ISwitchProps): React.JSX.Element {
  return (
    <button
      type='button'
      id={id}
      role='switch'
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={dataTestId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        // Track
        'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center',
        'rounded-full p-px',
        'border border-[color:var(--metal-edge)]',
        'shadow-hairline-inset',
        'transition-[background-color,box-shadow,border-color] duration-200',
        // Off vs on — share the selection accent with tabs and filters.
        checked
          ? cn('bg-accent-500', 'border-accent-400', 'shadow-hairline-inset')
          : 'bg-[var(--surface-void)]',
        'focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {/* Thumb — bevelled metal bead */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-[18px] w-[18px] rounded-full',
          'shadow-[inset_0_-1px_0_oklch(0.60_0.02_260/0.4),0_1px_2px_oklch(0.08_0.018_260/0.6)]',
          'transition-[transform,background-color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]',
          checked ? 'translate-x-[18px] bg-white' : 'translate-x-0 bg-text-500',
        )}
      />
    </button>
  );
}
