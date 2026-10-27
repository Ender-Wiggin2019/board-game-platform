import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerSW = vi.fn();
const toast = vi.fn();

async function flushUpdateCheck(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('../../src/pwa/swRegistration', () => ({
  registerServiceWorker: registerSW,
}));

vi.mock('@/components/ui/toast', () => ({
  toast,
}));

describe('registerPwa', () => {
  beforeEach(() => {
    vi.resetModules();
    // resetModules re-creates the i18n module, which boots in zh-CN by
    // default; seed the saved language so re-imported modules resolve the
    // English copy this suite asserts.
    window.localStorage.setItem(
      'seti-settings',
      JSON.stringify({ state: { language: 'en' } }),
    );
    registerSW.mockReset();
    toast.mockReset();
    registerSW.mockReturnValue(vi.fn());
    window.history.replaceState({}, '', '/');
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  it('registers the service worker only when the browser supports it', async () => {
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();

    expect(registerSW).toHaveBeenCalledWith(
      expect.objectContaining({ immediate: true }),
    );

    cleanup();
  });

  it('auto-applies app-shell updates outside game routes', async () => {
    window.history.replaceState({}, '', '/lobby');
    const updateServiceWorker = vi.fn();
    registerSW.mockReturnValue(updateServiceWorker);
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];
      options.onNeedRefresh();

      expect(updateServiceWorker).toHaveBeenCalledWith(true);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('checks for service worker updates after registration', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    registerSW.mockReturnValue(vi.fn());
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];

      options.onRegisteredSW('/sw.js', { update });
      await flushUpdateCheck();

      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('rechecks for service worker updates when the app resumes', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    registerSW.mockReturnValue(vi.fn());
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];

      options.onRegisteredSW('/sw.js', { update });
      await flushUpdateCheck();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await flushUpdateCheck();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await flushUpdateCheck();

      window.dispatchEvent(new Event('online'));
      await flushUpdateCheck();

      window.history.pushState({}, '', '/lobby');
      await flushUpdateCheck();

      expect(update).toHaveBeenCalledTimes(4);
    } finally {
      cleanup();
    }
  });

  it('auto-applies app-shell updates on game routes', async () => {
    window.history.replaceState({}, '', '/game/game-1');
    const updateServiceWorker = vi.fn();
    registerSW.mockReturnValue(updateServiceWorker);
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];
      options.onNeedRefresh();

      expect(updateServiceWorker).toHaveBeenCalledWith(true);
      expect(toast).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('does not reapply a game-route update after navigating away', async () => {
    window.history.replaceState({}, '', '/game/game-1');
    const updateServiceWorker = vi.fn();
    registerSW.mockReturnValue(updateServiceWorker);
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];
      options.onNeedRefresh();

      expect(updateServiceWorker).toHaveBeenCalledTimes(1);

      window.history.pushState({}, '', '/lobby');

      expect(updateServiceWorker).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('reports app-shell offline readiness and connection status changes', async () => {
    const { registerPwa } = await import('../../src/pwa/registerPwa');

    const cleanup = registerPwa();
    try {
      const options = registerSW.mock.calls[0]?.[0];
      options.onOfflineReady();
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));

      expect(toast.mock.calls.map((call) => call[0].title)).toEqual([
        'Mission interface saved for offline launch',
        'You are offline',
        'Back online',
      ]);
    } finally {
      cleanup();
    }
  });
});
