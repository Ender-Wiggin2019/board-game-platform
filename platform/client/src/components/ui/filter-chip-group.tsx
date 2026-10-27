import { cn } from '@/lib/cn';

export interface IFilterChipOption<T extends string | number> {
  label: string;
  value: T;
}

/** Track and chip styles shared by every compact toggle-chip control. */
export const chipTrackClassName =
  'inline-flex gap-1 rounded-[6px] bg-[var(--surface-instrument)]/60 p-1';

export function chipClassName(active: boolean): string {
  return cn(
    'cursor-pointer rounded-[4px] active:brightness-90 px-3 py-1 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none',
    active
      ? 'bg-accent-500/20 text-text-100 hover:bg-accent-500/30'
      : 'text-text-400 hover:bg-surface-raised hover:text-text-200',
  );
}

/**
 * A labelled row of toggle chips for one filter dimension.
 *
 * Multi-select by design: each chip is independent, and selecting none means
 * "no filter on this dimension" — so a player can watch for 3- AND 4-player
 * tables at once without a separate "all" entry to reason about.
 *
 * Styling matches the statistics-page filter rows so the lobby does not
 * introduce a second visual language for the same interaction.
 */
export function FilterChipGroup<T extends string | number>({
  label,
  options,
  selected,
  onToggle,
  testId,
}: {
  label: string;
  options: ReadonlyArray<IFilterChipOption<T>>;
  selected: ReadonlyArray<T>;
  onToggle: (value: T) => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      className='flex flex-wrap items-center gap-2'
      data-testid={testId}
      role='group'
      aria-label={label}
    >
      <span className='micro-label shrink-0 text-text-500'>{label}</span>
      <div className={cn(chipTrackClassName, 'flex-wrap')}>
        {options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button
              key={String(option.value)}
              type='button'
              aria-pressed={active}
              onClick={() => onToggle(option.value)}
              data-testid={testId ? `${testId}-${option.value}` : undefined}
              className={chipClassName(active)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
