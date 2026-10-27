import { ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';

export interface AchievementGalleryLabels {
  readonly title: ReactNode;
  readonly loading: ReactNode;
  readonly error: ReactNode;
  readonly retry: string;
  readonly summary: (unlocked: number, total: number) => ReactNode;
  readonly expand: string;
  readonly collapse: string;
  readonly earnedTitle: ReactNode;
  readonly earnedSummary: (count: number) => ReactNode;
  readonly noEarned: ReactNode;
  readonly empty: ReactNode;
  readonly filterPlaceholder: string;
  readonly groupSummary?: (unlocked: number, total: number) => ReactNode;
}

export interface AchievementGalleryGroup<Item> {
  readonly id: string;
  readonly title: ReactNode;
  readonly items: readonly Item[];
}

export interface AchievementGalleryItemContext {
  readonly groupId: string;
  readonly surface: 'earned' | 'catalog';
}

export interface AchievementGalleryProps<Item> {
  readonly groups?: readonly AchievementGalleryGroup<Item>[];
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly onRetry?: () => void;
  /** Lets an adapter clear transient item state when the archive closes. */
  readonly onCollapse?: () => void;
  readonly labels: AchievementGalleryLabels;
  readonly getItemId: (item: Item) => string;
  readonly isUnlocked: (item: Item) => boolean;
  readonly getSearchText?: (item: Item) => string;
  readonly renderItem: (
    item: Item,
    context: AchievementGalleryItemContext,
  ) => ReactNode;
  readonly initiallyExpanded?: boolean;
  readonly className?: string;
}

/**
 * Shared achievement collection surface.
 *
 * Games own item identity, privacy and artwork through renderItem. The
 * collection lifecycle and list behavior live here so every game gets the
 * same loading, empty, earned summary, filter and grouped archive behavior.
 */
export function AchievementGallery<Item>({
  groups,
  loading = false,
  error = false,
  onRetry,
  onCollapse,
  labels,
  getItemId,
  isUnlocked,
  getSearchText,
  renderItem,
  initiallyExpanded = false,
  className,
}: AchievementGalleryProps<Item>): React.JSX.Element {
  const archiveId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [filter, setFilter] = useState('');
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const allItems = useMemo(
    () => (groups ?? []).flatMap((group) => group.items),
    [groups],
  );
  const unlockedCount = allItems.filter(isUnlocked).length;
  const earnedItems = allItems.filter(isUnlocked);
  const hasItems = allItems.length > 0;

  if ((loading || error) && !groups) {
    return (
      <section
        className={cn(
          'mission-panel relative overflow-hidden p-5 sm:p-6',
          className,
        )}
        data-testid='achievement-gallery'
      >
        <div className='flex min-h-24 items-center justify-between gap-4'>
          <p className='text-sm text-text-400'>
            {loading && !error ? labels.loading : labels.error}
          </p>
          {error && onRetry ? (
            <Button size='sm' variant='ghost' onClick={onRetry}>
              {labels.retry}
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  if (!groups || !hasItems) {
    return (
      <section
        className={cn(
          'mission-panel relative overflow-hidden p-5 sm:p-6',
          className,
        )}
        data-testid='achievement-gallery'
      >
        <p className='text-sm text-text-500'>{labels.empty}</p>
      </section>
    );
  }

  const visibleGroups = groups.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      matchesFilter(item, normalizedFilter, getSearchText),
    ),
  }));
  const visibleEarnedItems = earnedItems.filter((item) =>
    matchesFilter(item, normalizedFilter, getSearchText),
  );

  return (
    <section
      className={cn(
        'mission-panel relative overflow-hidden p-5 sm:p-6',
        className,
      )}
      data-testid='achievement-gallery'
    >
      <div className='relative z-10 space-y-5'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <button
            type='button'
            aria-controls={archiveId}
            aria-expanded={expanded}
            aria-label={expanded ? labels.collapse : labels.expand}
            className='flex min-w-0 flex-1 rounded-[6px] text-left outline-none transition-colors hover:bg-white/[0.025]'
            onClick={() => {
              if (expanded) {
                onCollapse?.();
                setExpandedGroups(new Set());
              }
              setExpanded((value) => !value);
            }}
          >
            <span className='space-y-1'>
              <span className='flex items-center gap-2'>
                <span className='font-display text-xl font-semibold tracking-[0.06em] text-text-100'>
                  {labels.title}
                </span>
                <ChevronDown
                  className={cn(
                    'h-4 w-4 text-text-400 transition-transform',
                    expanded && 'rotate-180',
                  )}
                  aria-hidden
                />
              </span>
              <span className='block max-w-2xl text-xs leading-5 text-text-400'>
                {labels.summary(unlockedCount, allItems.length)}
              </span>
            </span>
          </button>
          <label className='relative w-full max-w-xs'>
            <span className='sr-only'>{labels.filterPlaceholder}</span>
            <Search
              aria-hidden
              className='pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-500'
            />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={labels.filterPlaceholder}
              className='pl-9'
              data-testid='achievement-filter'
            />
          </label>
        </div>

        <div
          className='space-y-2 border-t border-[color:var(--metal-edge-soft)] pt-4'
          data-testid='achievement-earned'
        >
          <div className='flex items-baseline justify-between gap-3'>
            <h2 className='text-sm font-medium text-text-200'>
              {labels.earnedTitle}
            </h2>
            <span className='font-mono text-[10px] text-text-500'>
              {labels.earnedSummary(visibleEarnedItems.length)}
            </span>
          </div>
          {visibleEarnedItems.length > 0 ? (
            <div className='grid grid-cols-3 gap-3 sm:grid-cols-6 lg:grid-cols-9 xl:grid-cols-12'>
              {visibleEarnedItems.map((item) => {
                const group = groups.find((candidate) =>
                  candidate.items.some(
                    (candidateItem) =>
                      getItemId(candidateItem) === getItemId(item),
                  ),
                );
                return (
                  <div key={`earned:${getItemId(item)}`}>
                    {renderItem(item, {
                      groupId: group?.id ?? 'earned',
                      surface: 'earned',
                    })}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className='text-sm text-text-500'>{labels.noEarned}</p>
          )}
        </div>

        <div id={archiveId} className='space-y-2'>
          {expanded
            ? visibleGroups.map((group) => {
                const unlocked = group.items.filter(isUnlocked).length;
                if (group.items.length === 0) return null;
                const groupExpanded = expandedGroups.has(group.id);
                return (
                  <Disclosure
                    key={group.id}
                    open={groupExpanded}
                    className='rounded-[6px] border border-white/8 bg-background-950/35'
                    summaryClassName='min-h-12 rounded-[6px] px-3 py-3 text-text-300 outline-none transition-colors hover:bg-white/5 active:bg-white/10'
                    onToggle={(event) => {
                      const nextOpen = event.currentTarget.open;
                      setExpandedGroups((current) => {
                        if (current.has(group.id) === nextOpen) return current;
                        const next = new Set(current);
                        if (nextOpen) next.add(group.id);
                        else next.delete(group.id);
                        return next;
                      });
                      if (!nextOpen) onCollapse?.();
                    }}
                    summary={
                      <>
                        <h3 className='flex-1 text-sm font-medium text-text-200'>
                          {group.title}
                        </h3>
                        <span className='font-mono text-[10px] text-text-500'>
                          {labels.groupSummary
                            ? labels.groupSummary(unlocked, group.items.length)
                            : `${unlocked} / ${group.items.length}`}
                        </span>
                      </>
                    }
                  >
                    {groupExpanded ? (
                      <div className='grid grid-cols-3 gap-x-3 gap-y-4 border-t border-white/8 p-3 sm:grid-cols-6 lg:grid-cols-9 xl:grid-cols-12'>
                        {group.items.map((item) => (
                          <div key={getItemId(item)}>
                            {renderItem(item, {
                              groupId: group.id,
                              surface: 'catalog',
                            })}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </Disclosure>
                );
              })
            : null}
        </div>
      </div>
    </section>
  );
}

function matchesFilter<Item>(
  item: Item,
  filter: string,
  getSearchText: ((item: Item) => string) | undefined,
): boolean {
  if (!filter) return true;
  return (getSearchText?.(item) ?? '').toLocaleLowerCase().includes(filter);
}
