import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Badge — small status / label chip.
 *
 * Instrumentation style: compact rectangular status tags from the Game Lobby
 * reference. Colors are semantic tints, not decorative badges.
 *
 * Variant colors reserved for:
 *   default → neutral label
 *   data    → plain white readout (no semantic color — pure data)
 *   accent  → anodized blue (active turn, focused state, CTA)
 *   success → mission accomplished / good signal
 *   warning → degraded signal / resource pressure
 *   danger  → destructive / end-of-game
 *
 * caution / alert / critical are an evenly spaced yellow→orange→deep-red ramp
 * (hue 95 / 51 / 18) for ordered severity, e.g. a finishing position. They are
 * not extra warning and danger colours: reach for them only when several rungs
 * appear side by side and have to be told apart at a glance.
 */
const badgeVariants = cva(
  [
    'inline-flex items-center',
    'rounded-[4px]',
    'px-2.5 py-1',
    'font-body text-xs font-medium',
    'whitespace-nowrap',
    'transition-colors duration-150',
  ],
  {
    variants: {
      variant: {
        default: ['bg-[oklch(0.22_0.025_260)]', 'text-text-300'],
        data: ['bg-transparent', 'text-text-100 tabular-nums'],
        accent: [
          'bg-[oklch(0.32_0.07_240/0.35)]',
          'text-[oklch(0.88_0.10_240)]',
        ],
        info: ['bg-[oklch(0.30_0.08_230/0.34)]', 'text-[oklch(0.88_0.10_230)]'],
        success: [
          'bg-[oklch(0.35_0.09_160/0.30)]',
          'text-[oklch(0.88_0.14_160)]',
        ],
        // Yellower than warning — hue 95 against its 75 — so an ordered ramp can
        // start further from the orange below it. Not a second warning colour.
        caution: [
          'bg-[oklch(0.35_0.10_95/0.32)]',
          'text-[oklch(0.90_0.15_95)]',
        ],
        warning: [
          'bg-[oklch(0.35_0.10_75/0.32)]',
          'text-[oklch(0.88_0.14_75)]',
        ],
        // Sits exactly between warning and danger — hue 51 against their 75 and
        // 28, with lightness and chroma interpolated to match — so the three can
        // carry an ordered severity ramp without a jarring step between them.
        alert: [
          'bg-[oklch(0.35_0.115_51/0.32)]',
          'text-[oklch(0.865_0.15_51)]',
        ],
        danger: ['bg-[oklch(0.35_0.13_28/0.32)]', 'text-[oklch(0.85_0.16_28)]'],
        // Deeper and redder than danger — hue 18 against its 28, darker fill,
        // dimmer text — so the bottom of a warm ramp still separates clearly
        // from `alert` above it.
        critical: [
          'bg-[oklch(0.26_0.14_18/0.48)]',
          'text-[oklch(0.80_0.17_18)]',
        ],
        neutral: ['bg-[oklch(0.18_0.02_260/0.82)]', 'text-text-300'],
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type TBadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export function Badge({
  className,
  variant,
  ...props
}: TBadgeProps): React.JSX.Element {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
