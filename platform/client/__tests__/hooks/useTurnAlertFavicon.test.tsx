import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTurnAlertFavicon } from '@/hooks/useTurnAlertFavicon';

/**
 * jsdom has no canvas backend — `getContext('2d')` returns null, which makes the
 * hook bail out before it ever touches the icon. So these tests stub the canvas
 * pipeline: a context whose draw calls are recorded, and a `toDataURL` that
 * fingerprints what was drawn. That makes the four corner frames
 * distinguishable, which is the only way jsdom can assert the animation at all.
 */
type TStubCall = string;

let drawCalls: TStubCall[] = [];
let originalCreateElement: typeof document.createElement;

function installCanvasStub(): void {
  originalCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((
    tagName: string,
    options?: ElementCreationOptions,
  ) => {
    const element = originalCreateElement(tagName, options);
    if (tagName !== 'canvas') return element;

    const calls: TStubCall[] = [];
    const canvas = element as HTMLCanvasElement;
    canvas.getContext = ((kind: string) => {
      if (kind !== '2d') return null;
      return {
        drawImage: () => calls.push('drawImage'),
        fillRect: () => calls.push('fillRect'),
        // The triangle is a path, and its vertices are the only thing that
        // distinguishes one frame from another — so record them.
        beginPath: () => calls.push('begin'),
        moveTo: (x: number, y: number) => calls.push(`m${x},${y}`),
        lineTo: (x: number, y: number) => calls.push(`l${x},${y}`),
        closePath: () => undefined,
        fill: () => calls.push('fill'),
        set fillStyle(_value: string) {
          /* recorded via fillRect / fill */
        },
        get fillStyle() {
          return '';
        },
      } as unknown as CanvasRenderingContext2D;
    }) as HTMLCanvasElement['getContext'];
    // Encode what was painted, so a frame that should be empty cannot be
    // mistaken for one that drew the icon.
    canvas.toDataURL = () => {
      drawCalls.push(calls.join(',') || 'empty');
      return `data:image/png;base64,${calls.join('+') || 'EMPTY'}`;
    };
    return canvas;
  }) as typeof document.createElement);
}

/** The href of the icon link the hook currently owns. */
function currentIconHref(): string | null {
  const managed = document.querySelector<HTMLLinkElement>(
    'link[data-turn-alert]',
  );
  return managed?.getAttribute('href') ?? null;
}

beforeEach(() => {
  drawCalls = [];
  vi.useFakeTimers();
  installCanvasStub();
  // A cached favicon: `complete` is true straight away, so the hook starts
  // synchronously without waiting on a load event jsdom will never fire.
  Object.defineProperty(globalThis.Image.prototype, 'complete', {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(globalThis.Image.prototype, 'naturalWidth', {
    configurable: true,
    get: () => 32,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const link of document.querySelectorAll('link[rel~="icon"]')) {
    link.remove();
  }
});

describe('useTurnAlertFavicon', () => {
  it('steps the triangle clockwise through four corners', () => {
    renderHook(() => useTurnAlertFavicon(true));

    // Four frames, pre-rendered up front so each tick is only a link swap.
    expect(drawCalls).toHaveLength(4);
    // Every frame draws the icon: it is steady now and must never blink out.
    for (const frame of drawCalls) {
      expect(frame).toContain('drawImage');
      expect(frame).toContain('fill');
    }

    // The four frames must differ, or there is no animation — they differ only in
    // where the triangle's right angle sits.
    expect(new Set(drawCalls).size).toBe(4);

    const seen = [currentIconHref()];
    for (let step = 0; step < 3; step += 1) {
      vi.advanceTimersByTime(450);
      seen.push(currentIconHref());
    }
    expect(new Set(seen).size).toBe(4);

    // And it cycles rather than stopping on the last corner.
    vi.advanceTimersByTime(450);
    expect(currentIconHref()).toBe(seen[0]);
  });

  it('never blanks the icon', () => {
    renderHook(() => useTurnAlertFavicon(true));

    // The old behaviour alternated with a fully transparent frame, which is the
    // dimming the report called too subtle to notice.
    for (let step = 0; step < 8; step += 1) {
      expect(currentIconHref()).toContain('drawImage');
      vi.advanceTimersByTime(450);
    }
  });

  it('keeps exactly one icon link while flashing', () => {
    const ico = document.createElement('link');
    ico.setAttribute('rel', 'icon');
    ico.setAttribute('sizes', 'any');
    ico.setAttribute('href', '/favicon.ico');
    document.head.append(ico);

    renderHook(() => useTurnAlertFavicon(true));

    // favicon.ico declares sizes="any" and would outrank a same-rel PNG, so it
    // has to be out of the document for the alert to be visible at all.
    for (let i = 0; i < 4; i += 1) {
      expect(document.querySelectorAll('link[rel~="icon"]')).toHaveLength(1);
      expect(document.head.contains(ico)).toBe(false);
      vi.advanceTimersByTime(450);
    }
  });

  it('restores the document icons and stops flashing on unmount', () => {
    const ico = document.createElement('link');
    ico.setAttribute('rel', 'icon');
    ico.setAttribute('sizes', 'any');
    ico.setAttribute('href', '/favicon.ico');
    document.head.append(ico);

    const { unmount } = renderHook(() => useTurnAlertFavicon(true));
    unmount();

    expect(document.querySelectorAll('link[data-turn-alert]')).toHaveLength(0);
    expect(document.head.contains(ico)).toBe(true);
    expect(ico.getAttribute('href')).toBe('/favicon.ico');

    // No further frames after cleanup: a leaked interval would keep hiding the
    // player's icon long after their turn ended.
    const framesAfterUnmount = drawCalls.length;
    vi.advanceTimersByTime(2700);
    expect(drawCalls).toHaveLength(framesAfterUnmount);
    expect(document.querySelectorAll('link[data-turn-alert]')).toHaveLength(0);
  });

  it('does nothing while no game is waiting on the player', () => {
    renderHook(() => useTurnAlertFavicon(false));

    expect(drawCalls).toEqual([]);
    expect(currentIconHref()).toBeNull();

    vi.advanceTimersByTime(2700);
    expect(currentIconHref()).toBeNull();
  });
});
