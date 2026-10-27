import { logDebug } from '@/lib/debugLog.js';
import { forceReloadLatestVersion } from '@/lib/forceReloadLatestVersion.js';

/**
 * Recover from chunks that no longer exist on the server.
 *
 * Routes such as the score page are `lazy()`, so their JS is fetched on first
 * navigation. Chunk filenames are content-hashed, which means a redeploy
 * deletes the files the currently-open tab knows about. A player who leaves a
 * game open across a deploy and then opens the score page requests a chunk that
 * is now a 404: the dynamic import rejects, Suspense never resolves, and the
 * page is simply blank. Nothing is logged, because the module never ran — which
 * is exactly the shape of report a8a5f140 ("点积分显示空白页", the network tab
 * showing the .js request, and an error buffer with no errors in it).
 *
 * The recovery is to reload, which re-fetches index.html and with it the current
 * chunk names. Reloading is only safe if it cannot become a loop: if the fresh
 * index.html still fails, a naive handler would reload forever. So a reload is
 * attempted at most once per cooldown window, and a second failure inside that
 * window is left alone and logged, so the blank page is at least diagnosable.
 */

/** Marker for "we already tried reloading", surviving the reload itself. */
export const STALE_CHUNK_RECOVERY_KEY = 'seti:stale-chunk-reload-at';
/**
 * How long a recovery attempt suppresses the next one. Long enough to outlast
 * the reload and the failing navigation, short enough that a second deploy
 * later in a long session can still recover.
 */
const RECOVERY_COOLDOWN_MS = 30_000;

export interface IStaleChunkRecoveryDeps {
  reload: () => void;
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}

/** Read the last reload marker without making storage availability required. */
export function readStaleChunkRecoveryAt(
  storage: Pick<Storage, 'getItem'> | undefined,
): string | undefined {
  try {
    const raw = storage?.getItem(STALE_CHUNK_RECOVERY_KEY);
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function defaultDeps(): IStaleChunkRecoveryDeps {
  return {
    reload: () => {
      void forceReloadLatestVersion();
    },
    now: () => Date.now(),
    // Private-mode Safari throws on sessionStorage access; treat as absent.
    storage: (() => {
      try {
        return window.sessionStorage;
      } catch {
        return undefined;
      }
    })(),
  };
}

/** True when `message` looks like a failed dynamic import. */
export function isChunkLoadFailure(message: string): boolean {
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /ChunkLoadError|loading chunk .* failed/i.test(message) ||
    /Unable to preload CSS/i.test(message)
  );
}

function readLastAttempt(
  storage: IStaleChunkRecoveryDeps['storage'],
): number | undefined {
  try {
    const raw = storage?.getItem(STALE_CHUNK_RECOVERY_KEY);
    if (!raw) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Install the handlers. Returns a teardown for tests; production never
 * uninstalls.
 */
export function installStaleChunkRecovery(
  overrides?: Partial<IStaleChunkRecoveryDeps>,
): () => void {
  const deps = { ...defaultDeps(), ...overrides };

  const recover = (reason: string): void => {
    const storage = deps.storage;
    if (!storage) {
      // Loop detection depends on storage surviving the reload. Without it a
      // still-missing chunk would reload forever, which is worse than the blank
      // page we are trying to fix.
      logDebug('error', 'stale-chunk', 'no storage; skipping reload', {
        reason,
      });
      return;
    }
    const last = readLastAttempt(storage);
    const now = deps.now();
    if (last !== undefined && now - last < RECOVERY_COOLDOWN_MS) {
      // Already reloaded and still broken: reloading again would loop, so stop
      // and leave a trace for the bug report instead.
      logDebug(
        'error',
        'stale-chunk',
        'chunk still missing after reload; not retrying',
        { reason },
      );
      return;
    }
    logDebug('warn', 'stale-chunk', 'reloading to recover missing chunk', {
      reason,
    });
    try {
      storage.setItem(STALE_CHUNK_RECOVERY_KEY, String(now));
    } catch {
      // A storage that reads but refuses writes cannot record the attempt, so a
      // reload could not be detected as a repeat. Same reasoning as above.
      logDebug(
        'error',
        'stale-chunk',
        'cannot record attempt; skipping reload',
        {
          reason,
        },
      );
      return;
    }
    deps.reload();
  };

  // Vite's own signal for a failed chunk preload.
  const onPreloadError = (event: Event): void => {
    // Vite rethrows the original import error only when this event remains
    // uncancelled. Cancelling it resolves the dynamic import as undefined,
    // which turns a useful resource error into a misleading lazy export error.
    const detail = (event as Event & { payload?: unknown }).payload;
    const message =
      detail instanceof Error ? detail.message : String(detail ?? '');
    // Vite also emits this event for exceptions thrown by module code.
    if (message && !isChunkLoadFailure(message)) return;
    recover(message || 'vite:preloadError');
  };

  // React.lazy surfaces the failure as an unhandled rejection rather than a
  // preloadError when the import is triggered by rendering.
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? '');
    if (!isChunkLoadFailure(message)) {
      return;
    }
    recover(message);
  };

  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
