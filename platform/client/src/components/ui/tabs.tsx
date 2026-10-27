import { createContext, useContext, useId, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tabs — instrumentation-style segmented control.
 * Inactive segments are muted text on dark; the active segment has
 * a soft lift (lighter surface + hairline) so the eye locks on.
 * A single copper-orange under-line marker confirms selection.
 */
interface ITabsContext {
  value: string;
  onChange: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<ITabsContext | null>(null);

function useTabsContext(): ITabsContext {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs components must be used within <Tabs>');
  return ctx;
}

interface ITabsProps {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
}: ITabsProps): React.JSX.Element {
  const [internal, setInternal] = useState(defaultValue);
  const baseId = useId();
  const current = value ?? internal;
  const handleChange = (v: string): void => {
    setInternal(v);
    onValueChange?.(v);
  };
  return (
    <TabsContext.Provider
      value={{ value: current, onChange: handleChange, baseId }}
    >
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

interface ITabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function TabsList({
  children,
  className,
  ...props
}: ITabsListProps): React.JSX.Element {
  return (
    <div
      {...props}
      role='tablist'
      className={cn(
        'inline-flex items-center gap-0.5 p-1',
        'rounded-[6px]',
        'bg-surface-instrument/70',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface ITabsTriggerProps
  extends Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'children' | 'value'
  > {
  value: string;
  children: React.ReactNode;
}

export function TabsTrigger({
  value,
  children,
  className,
  ...props
}: ITabsTriggerProps): React.JSX.Element {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;
  return (
    <button
      {...props}
      type='button'
      role='tab'
      id={`${ctx.baseId}-trigger-${value}`}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      aria-selected={isActive}
      onClick={() => ctx.onChange(value)}
      className={cn(
        'relative inline-flex cursor-pointer items-center justify-center whitespace-nowrap active:brightness-90',
        'px-3 py-1.5',
        'rounded-[4px]',
        'font-body text-sm font-medium',
        'transition-[background,color] duration-150',
        'focus-visible:outline-none',
        isActive
          ? ['bg-accent-500/20 text-text-100 hover:bg-accent-500/30']
          : [
              'border-0',
              'text-text-500 hover:text-text-300',
              'hover:bg-[oklch(0.18_0.025_260)]',
            ],
        className,
      )}
    >
      {children}
      {/* Active underline marker — a single interaction-accent tick. */}
      {isActive && (
        <span
          aria-hidden
          className='pointer-events-none absolute bottom-[-2px] left-1/2 h-[2px] w-6 -translate-x-1/2 rounded-full bg-accent-500'
        />
      )}
    </button>
  );
}

interface ITabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  /** Keep inactive content mounted while hiding it from layout and assistive UI. */
  keepMounted?: boolean;
}

export function TabsContent({
  value,
  children,
  className,
  keepMounted = false,
}: ITabsContentProps): React.JSX.Element | null {
  const ctx = useTabsContext();
  const isActive = ctx.value === value;
  if (!isActive && !keepMounted) return null;
  return (
    <div
      role='tabpanel'
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-trigger-${value}`}
      data-state={isActive ? 'active' : 'inactive'}
      hidden={!isActive}
      className={cn('mt-3 animate-instrument-fade-in', className)}
    >
      {children}
    </div>
  );
}
