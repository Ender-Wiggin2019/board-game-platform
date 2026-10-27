import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogSnapshot } from '@/lib/debugLog';
import { forceReloadLatestVersion } from '@/lib/forceReloadLatestVersion';
import {
  installStaleChunkRecovery,
  isChunkLoadFailure,
} from '@/lib/staleChunkRecovery';

vi.mock('@/lib/forceReloadLatestVersion', () => ({
  forceReloadLatestVersion: vi.fn().mockResolvedValue(undefined),
}));

/**
 * A redeploy deletes the content-hashed chunks an already-open tab knows about,
 * so navigating to a `lazy()` route (the score page) then 404s and renders
 * nothing at all — report a8a5f140's blank page with an error buffer containing
 * no errors. Reloading fixes it, but only if it cannot loop.
 */

function createStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

const teardowns: Array<() => void> = [];

afterEach(() => {
  while (teardowns.length) {
    teardowns.pop()?.();
  }
});

function install(overrides: Parameters<typeof installStaleChunkRecovery>[0]) {
  const teardown = installStaleChunkRecovery(overrides);
  teardowns.push(teardown);
  return teardown;
}

describe('isChunkLoadFailure', () => {
  it('recognises stylesheet preload failures as resource failures', () => {
    expect(
      isChunkLoadFailure('Unable to preload CSS for /assets/main-6d8xgxuG.css'),
    ).toBe(true);
  });

  it('recognises the dynamic-import failures browsers actually emit', () => {
    expect(
      isChunkLoadFailure(
        'Failed to fetch dynamically imported module: https://x/assets/GameEndPage-abc.js',
      ),
    ).toBe(true);
    expect(isChunkLoadFailure('ChunkLoadError: Loading chunk 5 failed')).toBe(
      true,
    );
    // Must not hijack unrelated rejections — reloading on those would throw the
    // player out of a game for no reason.
    expect(isChunkLoadFailure('Network request failed')).toBe(false);
    expect(isChunkLoadFailure('Cannot read properties of undefined')).toBe(
      false,
    );
  });
});

describe('installStaleChunkRecovery', () => {
  it('uses fresh-version recovery instead of reloading a cached app shell', () => {
    install({ now: () => 1_000, storage: createStorage() });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(forceReloadLatestVersion).toHaveBeenCalledOnce();
  });

  it('reloads when a lazy chunk is missing', () => {
    const reload = vi.fn();
    const storage = createStorage();
    install({ reload, now: () => 1_000, storage });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not cancel Vite's original preload rejection", () => {
    const reload = vi.fn();
    const storage = createStorage();
    install({ reload, now: () => 1_000, storage });

    const event = new Event('vite:preloadError', {
      cancelable: true,
    }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error(
      'Failed to fetch dynamically imported module: /assets/GamePage-abc.js',
    );
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload for application exceptions during module evaluation', () => {
    const reload = vi.fn();
    install({ reload, now: () => 1_000, storage: createStorage() });
    const event = new Event('vite:preloadError', {
      cancelable: true,
    }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error('Application startup failed');

    window.dispatchEvent(event);

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not cancel the rejection after a recent recovery attempt', () => {
    const reload = vi.fn();
    const storage = createStorage({ 'seti:stale-chunk-reload-at': '5000' });
    install({ reload, now: () => 10_000, storage });

    const event = new Event('vite:preloadError', {
      cancelable: true,
    }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error(
      'Failed to fetch dynamically imported module: /assets/GamePage-abc.js',
    );
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when React.lazy rejects instead of emitting preloadError', () => {
    const reload = vi.fn();
    const storage = createStorage();
    install({ reload, now: () => 1_000, storage });

    const event = new Event('unhandledrejection') as Event & {
      reason?: unknown;
    };
    event.reason = new Error(
      'Failed to fetch dynamically imported module: /assets/GameEndPage-abc.js',
    );
    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores rejections that are not chunk failures', () => {
    const reload = vi.fn();
    install({ reload, now: () => 1_000, storage: createStorage() });

    const event = new Event('unhandledrejection') as Event & {
      reason?: unknown;
    };
    event.reason = new Error('some game logic blew up');
    window.dispatchEvent(event);

    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload twice for the same failure, which would loop forever', () => {
    const reload = vi.fn();
    // A prior attempt 5s ago: the reload happened and the chunk is STILL gone.
    const storage = createStorage({ 'seti:stale-chunk-reload-at': '5000' });
    install({ reload, now: () => 10_000, storage });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).not.toHaveBeenCalled();
    // The dead end must still be diagnosable from a bug report.
    const entry = getLogSnapshot().find(
      (item) => item.source === 'stale-chunk' && item.level === 'error',
    );
    expect(entry, 'a permanent failure must be logged').toBeDefined();
  });

  it('recovers again once the cooldown has passed', () => {
    const reload = vi.fn();
    const storage = createStorage({ 'seti:stale-chunk-reload-at': '5000' });
    install({ reload, now: () => 5_000 + 30_001, storage });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('records the attempt so the reloaded page can detect a loop', () => {
    const reload = vi.fn();
    const storage = createStorage();
    install({ reload, now: () => 4_242, storage });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(storage.map.get('seti:stale-chunk-reload-at')).toBe('4242');
  });

  it('refuses to reload when storage is unavailable, since loops cannot be detected', () => {
    const reload = vi.fn();
    install({ reload, now: () => 1_000, storage: undefined });

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).not.toHaveBeenCalled();
  });

  it('stops listening after teardown', () => {
    const reload = vi.fn();
    const teardown = install({
      reload,
      now: () => 1_000,
      storage: createStorage(),
    });
    teardown();

    window.dispatchEvent(new Event('vite:preloadError'));

    expect(reload).not.toHaveBeenCalled();
  });
});
