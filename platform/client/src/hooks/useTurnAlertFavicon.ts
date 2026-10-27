import { useEffect } from 'react';

/**
 * One step per corner. Four corners at 450ms is a revolution every 1.8s — a
 * deliberate turn rather than a flicker.
 */
const FLASH_INTERVAL_MS = 450;

/**
 * Canvas size, and the resolution the alert frames are composed at.
 *
 * Deliberately much larger than the ~16px a tab strip shows. index.html declares
 * `favicon.ico sizes="any"`, and that file is 256x256 — so normally the browser
 * downscales 256 to 16 and the dish stays crisp. Composing at 32 instead handed
 * the browser a 32px image to downscale, which washed out the antenna and thin
 * edges: the icon measured the same size (both sources frame the artwork at 75%
 * of tile width) but read as small and blurry, reported as "图标还是非常小".
 *
 * Composing at 128 from a 128px source lets the browser do the same kind of
 * high-ratio downscale it does for the .ico, so the dish looks exactly as it does
 * when no alert is showing.
 */
const ICON_CANVAS_PX = 128;

/**
 * Triangle leg length, as a fraction of the tile.
 *
 * The triangle used to sit BESIDE the icon, splitting the tile (17 badge + 15
 * icon) and leaving the icon at under half of it. The icon now fills the tile
 * untouched and the triangle overlays one corner, so nothing about the base icon
 * changes when an alert starts; a mark simply appears on it.
 *
 * Just under half the tile keeps the mark ~7px once a tab strip downscales to 16,
 * which stays visible without burying the artwork.
 */
const TRIANGLE_FRACTION = 0.44;

/**
 * Triangle colour.
 *
 * Rendered every candidate at 16px over all four corners, on both a dark and a
 * light tab strip, and picked from that:
 *
 * - Orange (what this used to be) is the ICON'S OWN accent, fine when the
 *   triangle sat on empty space beside the icon, but it merges into the dish base
 *   now that it overlays the artwork.
 * - Black — the original request, matching BGA — works on a light tab but
 *   disappears on a dark one in the top-left corner, where the icon is
 *   transparent sky. BGA's icon has an opaque background; ours does not.
 * - White vanishes on a light tab.
 *
 * Red is legible in all four corners on both themes, and is absent from the
 * icon's palette so it never reads as part of the artwork.
 */
const BADGE_COLOR = '#dc2626';
/**
 * High-resolution copy of the tab artwork, exported from favicon.ico so the
 * framing matches exactly (artwork at 75% of tile width). Composing from the
 * 32px PNG instead left the downscaled result visibly softer than the icon the
 * browser normally draws from the 256px .ico.
 *
 * A PNG rather than favicon.ico itself: drawing .ico to a canvas is not reliable
 * across browsers, and a tainted or undecodable source makes renderFrames bail
 * out and the alert disappear entirely.
 */
const BASE_ICON_HREF = '/favicon-alert-source.png';
/** Marks the <link> this hook owns, so cleanup only removes its own element. */
const MANAGED_ATTR = 'data-turn-alert';

/** Which corner of the tile holds the triangle's right angle. */
type TCorner = 'tl' | 'tr' | 'br' | 'bl';

/** Clockwise, as requested: top-left, top-right, bottom-right, bottom-left. */
const CORNER_CYCLE: readonly TCorner[] = ['tl', 'tr', 'br', 'bl'];

/**
 * The triangle is a square cut along its diagonal, so its right angle sits in one
 * corner and the hypotenuse runs across to the two neighbours.
 */
function trianglePath(
  ctx: CanvasRenderingContext2D,
  corner: TCorner,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const points: Record<TCorner, Array<[number, number]>> = {
    tl: [
      [x0, y0],
      [x1, y0],
      [x0, y1],
    ],
    tr: [
      [x1, y0],
      [x1, y1],
      [x0, y0],
    ],
    br: [
      [x1, y1],
      [x0, y1],
      [x1, y0],
    ],
    bl: [
      [x0, y1],
      [x0, y0],
      [x1, y1],
    ],
  };
  const [first, ...rest] = points[corner];
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const [x, y] of rest) {
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * One frame per corner: the icon at full size, the triangle over one of its
 * corners.
 *
 * The icon is drawn identically in EVERY frame, at the tile's full size, so it
 * neither blinks nor shrinks when an alert starts — only the triangle moves.
 */
function renderFrames(source: HTMLImageElement | null): string[] | null {
  const size = ICON_CANVAS_PX;
  const triangle = Math.round(size * TRIANGLE_FRACTION);

  const drawIcon = (ctx: CanvasRenderingContext2D): void => {
    if (source && source.naturalWidth > 0) {
      // Full tile: the same picture the browser shows when nothing is pending.
      ctx.drawImage(source, 0, 0, size, size);
    } else {
      // No base image: a solid mark still gives the triangle something to sit on.
      ctx.fillStyle = '#f0a63c';
      ctx.fillRect(0, 0, size, size);
    }
  };

  /** Corner square the triangle's right angle occupies. */
  const cornerBox = (corner: TCorner) => {
    const far = size - triangle;
    const x0 = corner === 'tl' || corner === 'bl' ? 0 : far;
    const y0 = corner === 'tl' || corner === 'tr' ? 0 : far;
    return { x0, y0, x1: x0 + triangle, y1: y0 + triangle };
  };

  const frames: string[] = [];
  for (const corner of CORNER_CYCLE) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    drawIcon(ctx);

    // No backing square: the triangle carries its own contrast (see BADGE_COLOR).
    const box = cornerBox(corner);
    ctx.fillStyle = BADGE_COLOR;
    trianglePath(ctx, corner, box.x0, box.y0, box.x1, box.y1);

    try {
      frames.push(canvas.toDataURL('image/png'));
    } catch {
      return null;
    }
  }
  return frames.length === CORNER_CYCLE.length ? frames : null;
}

/** The document's own icon links, detached while the alert is showing. */
type TParkedIcons = Array<{ link: HTMLLinkElement; next: Node | null }>;

/**
 * Take the document's icon links out of the head.
 *
 * Required, not tidiness: index.html declares `favicon.ico` with `sizes="any"`,
 * which browsers prefer over a same-rel PNG. Simply appending an alert icon left
 * the tab unchanged — the DOM cycled but the visible favicon never did.
 */
function parkDocumentIcons(): TParkedIcons {
  const parked: TParkedIcons = [];
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel~="icon"]',
  )) {
    if (link.hasAttribute(MANAGED_ATTR)) continue;
    parked.push({ link, next: link.nextSibling });
    link.remove();
  }
  return parked;
}

/** Put the document's own icon links back where they were. */
function restoreDocumentIcons(parked: TParkedIcons): void {
  for (const { link, next } of parked) {
    if (next && next.parentNode === document.head) {
      document.head.insertBefore(link, next);
    } else {
      document.head.append(link);
    }
  }
}

/** Show the alert icon, as the only icon link in the document. */
function setIcon(href: string): void {
  for (const stale of document.querySelectorAll(`link[${MANAGED_ATTR}]`)) {
    stale.remove();
  }
  const link = document.createElement('link');
  link.setAttribute('rel', 'icon');
  link.setAttribute('type', 'image/png');
  link.setAttribute(MANAGED_ATTR, '');
  link.setAttribute('href', href);
  document.head.append(link);
}

/** Remove this hook's icon link. */
function clearIcon(): void {
  for (const stale of document.querySelectorAll(`link[${MANAGED_ATTR}]`)) {
    stale.remove();
  }
}

/**
 * Flash the browser tab icon while the game is waiting on this player.
 *
 * Runs off game state rather than window focus, so it keeps flashing while the
 * player is on another tab — the point being that a turn-based game can hand you
 * the turn long after you looked away.
 *
 * The icon itself stays put at its normal size and never blinks. The alert is a
 * right-isoceles triangle — a square cut along its diagonal — overlaid on the
 * icon, its right angle stepping clockwise around the four corners. Reported: the
 * previous on/off dimming of the whole icon "takes seconds of staring to notice"
 * — motion plus a shape that was not there before reads peripherally in a way a
 * brightness change does not. An earlier revision put the triangle in its own
 * square beside the icon, which shrank the icon to under half the tile and made
 * it unreadable; overlaying keeps the icon intact.
 *
 * Swaps a dedicated <link rel="icon"> in and out rather than mutating the
 * existing links' href: browsers do not reliably repaint the tab when an
 * already-present icon link merely changes href.
 */
export function useTurnAlertFavicon(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') {
      return;
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    let parked: TParkedIcons = [];

    const start = (source: HTMLImageElement | null): void => {
      if (cancelled) return;
      const frames = renderFrames(source);
      if (!frames) return;

      // Own the icon slot for the duration, otherwise favicon.ico wins.
      parked = parkDocumentIcons();
      // Frames are pre-rendered, so each tick is only a link swap — this runs in
      // a background tab, where per-tick canvas work would be pure waste.
      let index = 0;
      setIcon(frames[0]);
      timer = setInterval(() => {
        index = (index + 1) % frames.length;
        setIcon(frames[index]);
      }, FLASH_INTERVAL_MS);
    };

    const image = new Image();
    const begin = (): void => start(image);
    image.onload = begin;
    // Still flash (a solid mark) if the base icon cannot be fetched.
    image.onerror = () => start(null);
    image.src = BASE_ICON_HREF;
    // A cached favicon can finish decoding before the handlers above get a
    // chance to fire, in which case `onload` never runs — so check after
    // assigning src, which is when `complete` becomes meaningful.
    if (image.complete && image.naturalWidth > 0) {
      image.onload = null;
      begin();
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearInterval(timer);
      }
      clearIcon();
      restoreDocumentIcons(parked);
      parked = [];
    };
  }, [active]);
}
