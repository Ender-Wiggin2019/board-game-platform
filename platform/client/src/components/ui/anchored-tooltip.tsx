import type { ReactNode, RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { UI_Z_INDEX } from '@/styles/zIndex';

interface IAnchoredTooltipProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  id: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}

/**
 * A small viewport-owned tooltip surface. The trigger owns open state while
 * this primitive owns portal placement, viewport clamping, and repositioning.
 */
export function AnchoredTooltip({
  anchorRef,
  open,
  id,
  children,
  className,
  testId,
}: IAnchoredTooltipProps): React.JSX.Element | null {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;

    let frame = 0;
    const updatePosition = (): void => {
      const anchor = anchorRef.current;
      const tooltip = tooltipRef.current;
      if (!anchor || !tooltip) return;
      const anchorBounds = anchor.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 8;
      const left = Math.max(
        viewportPadding,
        Math.min(
          anchorBounds.left + (anchorBounds.width - tooltipBounds.width) / 2,
          window.innerWidth - tooltipBounds.width - viewportPadding,
        ),
      );
      const above = anchorBounds.top - tooltipBounds.height - gap;
      const below = anchorBounds.bottom + gap;
      const preferredTop = above >= viewportPadding ? above : below;
      const top = Math.max(
        viewportPadding,
        Math.min(
          preferredTop,
          window.innerHeight - tooltipBounds.height - viewportPadding,
        ),
      );
      setPosition({ left, top });
    };
    const schedulePosition = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };

    updatePosition();
    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(schedulePosition)
        : undefined;
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (tooltipRef.current) observer?.observe(tooltipRef.current);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedulePosition);
      window.removeEventListener('scroll', schedulePosition, true);
      observer?.disconnect();
    };
  }, [anchorRef, open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      role='tooltip'
      data-testid={testId}
      data-visible='true'
      className={cn(
        'pointer-events-none fixed max-w-[calc(100vw-16px)] rounded-[5px] bg-background-950/96 p-2 text-left shadow-[0_10px_24px_rgba(0,0,0,0.55)] backdrop-blur-md',
        className,
      )}
      style={{
        left: position.left,
        top: position.top,
        zIndex: anchorRef.current?.closest('[role="dialog"]')
          ? UI_Z_INDEX.dialog + 1
          : UI_Z_INDEX.popover,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
