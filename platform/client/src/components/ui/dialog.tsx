import { X } from 'lucide-react';
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { UI_Z_INDEX } from '@/styles/zIndex';

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Dialog — modal surface.
 *
 * The overlay settles the current view behind a raised mission surface.
 * Content owns its own max width so large player tools can breathe while
 * small confirms stay compact.
 */
interface IDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  ariaLabel?: string;
  dismissible?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  children,
  ariaLabel,
  dismissible = true,
}: IDialogProps): React.JSX.Element | null {
  const overlayRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const dismissibleRef = useRef(dismissible);
  onOpenChangeRef.current = onOpenChange;
  dismissibleRef.current = dismissible;

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        dismissible &&
        (e.target === overlayRef.current || e.target === surfaceRef.current)
      ) {
        onOpenChange(false);
      }
    },
    [dismissible, onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const surface = surfaceRef.current;
    const focusableElements = surface?.querySelectorAll<HTMLElement>(
      DIALOG_FOCUSABLE_SELECTOR,
    );
    const initialFocus = surface?.querySelector<HTMLElement>(
      '[data-dialog-initial-focus]',
    );
    (initialFocus ?? focusableElements?.[0] ?? surface)?.focus();

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (dismissibleRef.current) onOpenChangeRef.current(false);
        return;
      }
      if (e.key !== 'Tab' || !surfaceRef.current) return;

      const focusable = Array.from(
        surfaceRef.current.querySelectorAll<HTMLElement>(
          DIALOG_FOCUSABLE_SELECTOR,
        ),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        surfaceRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (
        e.shiftKey &&
        (activeElement === first || !surfaceRef.current.contains(activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (activeElement === last || !surfaceRef.current.contains(activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    // Lock page scroll while open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prev;
      const previouslyFocused = previouslyFocusedRef.current;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={overlayRef}
      onClick={(event) => {
        event.stopPropagation();
        handleOverlayClick(event);
      }}
      data-testid='dialog-overlay'
      style={{ zIndex: UI_Z_INDEX.dialog }}
      className={cn(
        'fixed inset-0 flex items-center justify-center p-4',
        'bg-[oklch(0.05_0.015_260/0.86)]',
        'backdrop-blur-[2px]',
        'animate-overlay-fade-in',
      )}
    >
      <div
        ref={surfaceRef}
        className='w-full animate-panel-rise'
        role='dialog'
        aria-modal='true'
        aria-label={ariaLabel}
        tabIndex={-1}
        data-dialog-surface='raised'
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

type TDialogContentProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * `reading` gives long, read-only content a wide, edge-to-edge surface and
   * makes its scroll region the initial keyboard focus target.
   */
  variant?: 'default' | 'reading' | 'form';
  /** Optional secondary reading below the actions, with its own bounded scroll. */
  supplement?: React.ReactNode;
  /**
   * Optional decorative sprite painted as a top header-band with a gradient
   * fade into the solid surface color. Matches the lobby card treatment so
   * dialogs feel cohesive with the page they were opened from.
   */
  scene?: string;
  sceneObjectPosition?: React.CSSProperties['objectPosition'];
  /**
   * Height of the scene band in pixels. Defaults to 160 — wider/taller forms
   * may want 200 so the title still has a generous canvas to sit over.
   */
  sceneHeight?: number;
  /**
   * When provided, renders a close X button in the top-right corner
   * of the dialog. Users expect this as a standard dismissal affordance.
   */
  onClose?: () => void;
  closeLabel?: string;
};

export function DialogContent({
  className,
  children,
  scene,
  sceneObjectPosition,
  sceneHeight = 160,
  onClose,
  closeLabel = 'Close dialog',
  variant = 'default',
  supplement,
  ...props
}: TDialogContentProps): React.JSX.Element {
  const sections = Children.toArray(children);
  const fixedHeader =
    variant === 'default'
      ? sections.filter(
          (child) => isValidElement(child) && child.type === DialogHeader,
        )
      : [];
  const fixedFooter =
    variant === 'default'
      ? sections.filter(
          (child) => isValidElement(child) && child.type === DialogFooter,
        )
      : [];
  const body =
    variant === 'default'
      ? sections.filter(
          (child) =>
            !isValidElement(child) ||
            (child.type !== DialogHeader && child.type !== DialogFooter),
        )
      : children;

  return (
    <div
      className={cn(
        // Cap to the viewport and lay out as a column so the close X and the
        // scene band stay pinned while a tall body (e.g. a long hand-card list
        // in the resource-exchange dialog) scrolls instead of pushing the X
        // off-screen.
        'relative mx-auto flex w-full flex-col overflow-hidden',
        variant === 'reading'
          ? 'max-h-[min(80dvh,calc(100dvh-6rem))] max-w-6xl p-0'
          : variant === 'form'
            ? 'max-h-[calc(100dvh-2rem)] max-w-lg p-0'
            : 'max-h-[calc(100dvh-2rem)] max-w-lg p-6',
        'rounded-[8px]',
        'surface-raised',
        'shadow-instrument',
        className,
      )}
      data-surface='raised'
      data-dialog-scene={scene ? 'true' : 'false'}
      data-dialog-layout={variant === 'form' ? 'fixed-sections' : 'scroll-body'}
      {...props}
    >
      {onClose ? (
        <button
          type='button'
          data-testid='dialog-close'
          aria-label={closeLabel}
          onClick={onClose}
          // z-20 so the X also outranks anything the `form` variant renders as
          // a direct sibling, which gets no isolating scroll wrapper.
          className='absolute right-3 top-3 z-20 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-text-400 transition-colors hover:bg-surface-700/50 hover:text-text-100'
        >
          <X aria-hidden size={16} />
        </button>
      ) : null}
      {scene ? (
        <div
          aria-hidden
          data-testid='dialog-scene'
          className='pointer-events-none absolute inset-x-0 top-0 overflow-hidden'
          style={{ height: `${sceneHeight}px` }}
        >
          <img
            src={scene}
            alt=''
            className='h-full w-full select-none object-cover scale-[1.12] origin-center'
            style={{ objectPosition: sceneObjectPosition }}
          />
          <span
            className='absolute inset-0'
            style={{
              backgroundImage:
                'linear-gradient(to bottom, color-mix(in oklab, var(--surface-raised) 18%, transparent) 0%, color-mix(in oklab, var(--surface-raised) 40%, transparent) 55%, var(--surface-raised) 100%)',
            }}
          />
        </div>
      ) : null}
      {fixedHeader}
      {variant === 'form' ? (
        children
      ) : (
        <div
          // `isolate` is load-bearing, not cosmetic. Without it this wrapper is
          // positioned at `z-index: auto`, so it forms no stacking context and
          // a `z-10` inside the body (e.g. PlayerAidList's sticky header) lands
          // in the same context as the close X — equal z-index, later in the
          // DOM, so the header paints over the X and the dialog cannot be
          // closed by tapping it. Isolating contains content z-indexes here.
          className='relative isolate min-h-0 flex-1 overflow-y-auto'
          data-dialog-body
          data-dialog-initial-focus={variant === 'reading' ? true : undefined}
          data-testid={
            variant === 'reading' ? 'dialog-reading-body' : undefined
          }
          tabIndex={variant === 'reading' ? 0 : undefined}
        >
          {body}
        </div>
      )}
      {fixedFooter}
      {supplement ? (
        <div
          data-dialog-supplement
          className='relative isolate mt-4 min-h-0 max-h-[min(25dvh,12rem)] shrink-0 overflow-y-auto border-t border-surface-700 pt-4 text-sm leading-relaxed text-text-300'
        >
          {supplement}
        </div>
      ) : null}
    </div>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-dialog-header
      className={cn(
        'relative z-10 shrink-0 flex flex-col gap-1.5 mb-5',
        className,
      )}
      {...props}
    />
  );
}

export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('relative min-h-0 flex-1 overflow-y-auto', className)}
      data-dialog-body
      data-testid='dialog-body'
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2
      data-dialog-title
      className={cn(
        'font-display text-lg font-medium text-text-100 leading-tight tracking-tight',
        '[[data-dialog-scene=true]_&]:[text-shadow:0_1px_10px_rgba(1,15,30,0.7)]',
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return (
    <p
      className={cn(
        'text-sm text-text-500 leading-relaxed',
        '[[data-dialog-scene=true]_&]:text-text-300',
        '[[data-dialog-scene=true]_&]:[text-shadow:0_1px_8px_rgba(1,15,30,0.6)]',
        className,
      )}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-dialog-footer
      className={cn(
        'relative z-10 mt-6 shrink-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}
