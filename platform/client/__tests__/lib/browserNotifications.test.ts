import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showBrowserNotification } from '../../src/lib/browserNotifications.js';

const showNotification = vi.fn();
const constructNotification = vi.fn();
const getRegistration = vi.fn();
const payload = {
  title: 'Your turn',
  body: 'Board game',
  url: '/game/current',
  tag: 'turn:current',
};

beforeEach(() => {
  showNotification.mockReset().mockResolvedValue(undefined);
  getRegistration
    .mockReset()
    .mockResolvedValue({ active: {}, showNotification });
  constructNotification.mockReset();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
  vi.stubGlobal(
    'Notification',
    class {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(title: string, options: NotificationOptions) {
        constructNotification(title, options);
      }
    },
  );
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState({}, '', '/game/current');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('online browser notifications', () => {
  it('shows through the existing service worker without a push subscription', async () => {
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      true,
    );
    expect(showNotification).toHaveBeenCalledWith(
      'Your turn',
      expect.objectContaining({
        tag: 'turn:current',
        renotify: true,
        data: { url: `${window.location.origin}/game/current` },
      }),
    );
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it('acknowledges without a notification if this game regained focus', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      true,
    );
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('rechecks focus after querying the service worker', async () => {
    getRegistration.mockImplementation(async () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      return { active: {}, showNotification };
    });
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      true,
    );
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a delivery when its account session ended during worker lookup', async () => {
    let active = true;
    getRegistration.mockImplementation(async () => {
      active = false;
      return { active: {}, showNotification };
    });
    await expect(showBrowserNotification(payload, () => active)).resolves.toBe(
      false,
    );
    expect(showNotification).not.toHaveBeenCalled();
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it('supports a desktop tab without an active service worker', async () => {
    getRegistration.mockResolvedValue(undefined);
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      true,
    );
    expect(constructNotification).toHaveBeenCalledOnce();
  });

  it('does not show notifications without permission or for another origin', async () => {
    await expect(
      showBrowserNotification(
        { ...payload, url: 'https://other.example/' },
        () => true,
      ),
    ).resolves.toBe(false);
    vi.stubGlobal('Notification', { permission: 'denied' });
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      false,
    );
    expect(showNotification).not.toHaveBeenCalled();
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it('reports display failure so delivery can fall back to Web Push', async () => {
    showNotification.mockRejectedValue(new Error('Permission revoked'));
    await expect(showBrowserNotification(payload, () => true)).resolves.toBe(
      false,
    );
  });
});
