import { Info } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { AnchoredTooltip } from '@/components/ui/anchored-tooltip';

/** The same help affordance works with a pointer, keyboard or touch. */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): React.JSX.Element {
  const id = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchorRef}
        type='button'
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-500 transition-colors hover:text-accent-400 focus-visible:outline-none'
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Info size={15} aria-hidden />
      </button>
      <AnchoredTooltip
        anchorRef={anchorRef}
        open={open}
        id={id}
        className='w-72 border border-[var(--metal-edge)] p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-text-200'
      >
        {children}
      </AnchoredTooltip>
    </>
  );
}
