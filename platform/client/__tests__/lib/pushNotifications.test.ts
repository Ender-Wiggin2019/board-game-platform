import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disablePushNotifications,
  disconnectLocalPushNotifications,
  disconnectPushNotifications,
  enablePushNotifications,
  getPushAvailability,
  isIosDevice,
  isStandaloneDisplay,
  refreshPushSubscription,
  urlBase64ToUint8Array,
} from '@/lib/pushNotifications';
import { useAuthStore } from '@/stores/authStore.js';

const pushApiMocks = vi.hoisted(() => ({
  enable: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/api/pushApi', () => ({
  pushApi: pushApiMocks,
}));

/**
 * iOS only exposes Web Push to a web app launched from the Home Screen. In a
 * Safari tab `PushManager` is absent, so the difference between "this browser
 * can't" and "install it first" has to be reported accurately — otherwise the
 * settings UI shows a toggle that silently does nothing.
 */

const ORIGINAL_UA = navigator.userAgent;

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true,
  });
}

function setTouchPoints(value: number): void {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value,
    configurable: true,
  });
}

function setStandalone(value: boolean | undefined): void {
  Object.defineProperty(navigator, 'standalone', {
    value,
    configurable: true,
  });
}

function setPushApiPresent(present: boolean): void {
  vi.stubGlobal('isSecureContext', true);
  if (present) {
    // Only its presence on `window` matters to the detection code.
    vi.stubGlobal('PushManager', function PushManager() {
      return undefined;
    });
    vi.stubGlobal('Notification', { permission: 'default' });
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {},
      configurable: true,
    });
  } else {
    vi.stubGlobal('PushManager', undefined);
    // Deleting the key is what a real unsupported browser looks like.
    Reflect.deleteProperty(window as unknown as object, 'PushManager');
  }
}

function setDisplayMode(standalone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
  }));
}

afterEach(() => {
  setUserAgent(ORIGINAL_UA);
  setTouchPoints(0);
  setStandalone(undefined);
  Reflect.deleteProperty(navigator as unknown as object, 'serviceWorker');
  vi.unstubAllGlobals();
  pushApiMocks.enable.mockReset();
  pushApiMocks.subscribe.mockReset();
  pushApiMocks.unsubscribe.mockReset();
  useAuthStore.getState().logout();
});

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

describe('isIosDevice', () => {
  it('detects iPhone', () => {
    setUserAgent(IPHONE_UA);
    expect(isIosDevice()).toBe(true);
  });

  it('detects iPadOS behind its desktop user agent', () => {
    // iPadOS 13+ claims to be a Mac; touch points are the only tell.
    setUserAgent(IPAD_DESKTOP_UA);
    setTouchPoints(5);
    expect(isIosDevice()).toBe(true);
  });

  it('does not mistake a real Mac for iOS', () => {
    setUserAgent(IPAD_DESKTOP_UA);
    setTouchPoints(0);
    expect(isIosDevice()).toBe(false);
  });

  it('does not treat Android as iOS', () => {
    setUserAgent(CHROME_UA);
    expect(isIosDevice()).toBe(false);
  });
});

describe('isStandaloneDisplay', () => {
  it('trusts the iOS-specific navigator.standalone flag', () => {
    setStandalone(true);
    setDisplayMode(false);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('falls back to the display-mode media query', () => {
    setStandalone(undefined);
    setDisplayMode(true);
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('reports a plain browser tab as not standalone', () => {
    setStandalone(false);
    setDisplayMode(false);
    expect(isStandaloneDisplay()).toBe(false);
  });
});

describe('getPushAvailability', () => {
  it('tells iOS Safari users in a tab to install, not that it is unsupported', () => {
    setUserAgent(IPHONE_UA);
    setStandalone(false);
    setDisplayMode(false);
    setPushApiPresent(false);

    const availability = getPushAvailability(true);

    expect(availability.usable).toBe(false);
    // The actionable message. 'unsupported' here would be a dead end for a
    // user whose device supports push perfectly well once installed.
    expect(availability.blocker).toBe('needs-install');
    expect(availability.isIos).toBe(true);
  });

  it('does not persist opt-in from an iOS browser tab', async () => {
    setUserAgent(IPHONE_UA);
    setStandalone(false);
    setDisplayMode(false);
    setPushApiPresent(false);

    await expect(enablePushNotifications('QQ')).resolves.toEqual({
      ok: false,
      reason: 'needs-install',
    });
    expect(pushApiMocks.enable).not.toHaveBeenCalled();
  });

  it('reports an insecure browsing context', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(false);
    setPushApiPresent(true);
    vi.stubGlobal('isSecureContext', false);

    expect(getPushAvailability(true).blocker).toBe('insecure-context');
  });

  it('reports a missing Service Worker API', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(false);
    setPushApiPresent(true);
    Reflect.deleteProperty(navigator as unknown as object, 'serviceWorker');

    expect(getPushAvailability(true).blocker).toBe(
      'service-worker-unavailable',
    );
  });

  it('reports a missing Web Push API', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(false);
    setPushApiPresent(true);
    vi.stubGlobal('PushManager', undefined);
    Reflect.deleteProperty(window as unknown as object, 'PushManager');

    expect(getPushAvailability(true)).toMatchObject({
      usable: true,
      webPushUsable: false,
    });
    expect(getPushAvailability(true).blocker).toBeUndefined();
  });

  it('reports a missing Notifications API', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(false);
    setPushApiPresent(true);
    vi.stubGlobal('Notification', undefined);
    Reflect.deleteProperty(window as unknown as object, 'Notification');

    expect(getPushAvailability(true).blocker).toBe(
      'notifications-api-unavailable',
    );
  });

  it('is usable in an installed iOS web app', () => {
    setUserAgent(IPHONE_UA);
    setStandalone(true);
    setDisplayMode(true);
    setPushApiPresent(true);

    expect(getPushAvailability(true)).toMatchObject({
      usable: true,
      isIos: true,
      isStandalone: true,
    });
  });

  it('surfaces a denied permission rather than silently failing later', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(true);
    setPushApiPresent(true);
    vi.stubGlobal('Notification', { permission: 'denied' });

    expect(getPushAvailability(true).blocker).toBe('denied');
  });

  it('distinguishes a server with no VAPID keys from a browser problem', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(true);
    setPushApiPresent(true);

    expect(getPushAvailability(false)).toMatchObject({
      usable: true,
      webPushUsable: false,
    });
    expect(getPushAvailability(false).blocker).toBeUndefined();
  });

  it('keeps desktop notification opt-in available without the Web Push API', () => {
    setUserAgent(CHROME_UA);
    setDisplayMode(false);
    setPushApiPresent(true);
    vi.stubGlobal('PushManager', undefined);
    Reflect.deleteProperty(window as unknown as object, 'PushManager');

    expect(getPushAvailability(true)).toMatchObject({
      usable: true,
      webPushUsable: false,
    });
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes base64url, including the chars that differ from base64', () => {
    // '-' and '_' must map to '+' and '/', or applicationServerKey is garbage
    // and subscribe() throws an opaque error.
    const decoded = urlBase64ToUint8Array('-_8');
    expect(Array.from(decoded)).toEqual([251, 255]);
  });

  it('handles keys needing padding', () => {
    expect(Array.from(urlBase64ToUint8Array('QQ'))).toEqual([65]);
  });
});

describe('subscription lifecycle', () => {
  function makeSubscription(endpoint: string): PushSubscription {
    return {
      endpoint,
      toJSON: () => ({ endpoint }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    } as unknown as PushSubscription;
  }

  function setPushRegistration(registration: object): void {
    setPushApiPresent(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        ready: Promise.resolve(registration),
        getRegistration: vi.fn().mockResolvedValue(registration),
      },
      configurable: true,
    });
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });
  }

  it('saves account opt-in and falls back to online-only without PushManager', async () => {
    setPushRegistration({ pushManager: {} });
    vi.stubGlobal('PushManager', undefined);
    Reflect.deleteProperty(window as unknown as object, 'PushManager');

    await expect(enablePushNotifications('QQ')).resolves.toMatchObject({
      ok: true,
      mode: 'online-only',
      reason: 'push-api-unavailable',
    });
    expect(pushApiMocks.enable).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
  });

  it('saves account opt-in and falls back to online-only without a VAPID key', async () => {
    setPushRegistration({ pushManager: {} });

    await expect(enablePushNotifications(undefined)).resolves.toMatchObject({
      ok: true,
      mode: 'online-only',
      reason: 'server-unconfigured',
    });
    expect(pushApiMocks.enable).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'server-enable-rejected'],
    [503, 'server-enable-unavailable'],
  ] as const)(
    'does not claim enabled when account opt-in returns %s',
    async (status, reason) => {
      setPushRegistration({ pushManager: {} });
      pushApiMocks.enable.mockRejectedValue(
        Object.assign(new Error('enable failed'), { status }),
      );

      await expect(enablePushNotifications('QQ')).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
    },
  );

  it('rotates a subscription when the endpoint belongs to another account', async () => {
    const existing = {
      endpoint: 'https://fcm.googleapis.com/old',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/old' }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const rotated = {
      endpoint: 'https://fcm.googleapis.com/new',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/new' }),
      unsubscribe: vi.fn(),
    };
    const registration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(existing),
        subscribe: vi.fn().mockResolvedValue(rotated),
      },
    };
    setPushRegistration(registration);
    pushApiMocks.subscribe
      .mockRejectedValueOnce(
        Object.assign(new Error('conflict'), { status: 409 }),
      )
      .mockResolvedValueOnce(undefined);

    await expect(enablePushNotifications('QQ')).resolves.toEqual({ ok: true });

    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.subscribe).toHaveBeenLastCalledWith(
      rotated.toJSON(),
      'refresh',
    );
  });

  it.each([
    ['NotAllowedError', 'subscription-not-allowed'],
    ['AbortError', 'subscription-service-unavailable'],
    ['InvalidStateError', 'subscription-failed'],
  ] as const)(
    'classifies a browser %s instead of throwing a generic enable error',
    async (errorName, reason) => {
      const error = new Error('browser-specific detail');
      error.name = errorName;
      const registration = {
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockRejectedValue(error),
        },
      };
      setPushRegistration(registration);

      await expect(enablePushNotifications('QQ')).resolves.toMatchObject({
        ok: true,
        mode: 'online-only',
        reason,
      });
    },
  );

  it('does not let a delayed subscription reverse a completed opt-out', async () => {
    let resolveSubscription:
      | ((subscription: PushSubscription | null) => void)
      | undefined;
    const subscription = makeSubscription('https://fcm.googleapis.com/current');
    const preference = { enabled: false };
    const getSubscription = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<PushSubscription | null>((resolve) => {
            resolveSubscription = resolve;
          }),
      )
      .mockResolvedValueOnce(null);
    setPushRegistration({ pushManager: { getSubscription } });
    pushApiMocks.enable.mockImplementation(async () => {
      preference.enabled = true;
    });
    pushApiMocks.unsubscribe.mockImplementation(async () => {
      preference.enabled = false;
    });
    pushApiMocks.subscribe.mockImplementation(async (_payload, mode) => {
      if (mode === 'enable') preference.enabled = true;
    });

    const enabling = enablePushNotifications('QQ');
    await vi.waitFor(() => expect(pushApiMocks.enable).toHaveBeenCalled());
    await disablePushNotifications();
    resolveSubscription?.(subscription);

    await expect(enabling).resolves.toEqual({
      ok: false,
      reason: 'session-changed',
    });
    expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
    expect(preference.enabled).toBe(false);
  });

  it('identifies the invalid endpoint returned by affected Android Edge versions', async () => {
    const subscription = makeSubscription(
      'https://permanently-removed.invalid/subscription',
    );
    setPushRegistration({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(subscription),
      },
    });

    await expect(enablePushNotifications('QQ')).resolves.toMatchObject({
      ok: true,
      mode: 'online-only',
      reason: 'invalid-push-endpoint',
    });
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
  });

  it('does not opt out a new account while waiting for the previous enable', async () => {
    useAuthStore.getState().login('token-a', {
      id: 'user-a',
      name: 'A',
      email: 'a@example.com',
    });
    setPushRegistration({ pushManager: {} });
    let resolveEnable: (() => void) | undefined;
    pushApiMocks.enable.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEnable = resolve;
        }),
    );
    const enabling = enablePushNotifications(null);
    await vi.waitFor(() => expect(pushApiMocks.enable).toHaveBeenCalled());
    const disabling = disablePushNotifications();
    const disabled = expect(disabling).rejects.toMatchObject({
      reason: 'session-changed',
    });
    useAuthStore.getState().login('token-b', {
      id: 'user-b',
      name: 'B',
      email: 'b@example.com',
    });
    resolveEnable?.();
    await disabled;
    await expect(enabling).resolves.toEqual({
      ok: false,
      reason: 'session-changed',
    });
    expect(pushApiMocks.unsubscribe).not.toHaveBeenCalled();
  });

  it('does not register a delayed refresh for a different account', async () => {
    useAuthStore.getState().login('token-a', {
      id: 'user-a',
      name: 'A',
      email: 'a@example.com',
    });
    let resolveSubscription:
      | ((value: PushSubscription | null) => void)
      | undefined;
    const getSubscription = vi.fn(
      () =>
        new Promise<PushSubscription | null>((resolve) => {
          resolveSubscription = resolve;
        }),
    );
    setPushRegistration({ pushManager: { getSubscription } });
    const refreshing = refreshPushSubscription('QQ');
    await vi.waitFor(() => expect(getSubscription).toHaveBeenCalled());
    useAuthStore.getState().login('token-b', {
      id: 'user-b',
      name: 'B',
      email: 'b@example.com',
    });
    resolveSubscription?.(
      makeSubscription('https://fcm.googleapis.com/current'),
    );
    await refreshing;
    expect(pushApiMocks.subscribe).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'server-registration-rejected'],
    [503, 'server-registration-unavailable'],
  ] as const)(
    'distinguishes a server %s response while saving the subscription',
    async (status, reason) => {
      const subscription = makeSubscription(
        'https://fcm.googleapis.com/current',
      );
      setPushRegistration({
        pushManager: {
          getSubscription: vi.fn().mockResolvedValue(subscription),
        },
      });
      pushApiMocks.subscribe.mockRejectedValue(
        Object.assign(new Error('server detail'), { status }),
      );

      await expect(enablePushNotifications('QQ')).resolves.toMatchObject({
        ok: true,
        mode: 'online-only',
        reason,
      });
    },
  );

  it('reports a Service Worker that fails before subscription', async () => {
    setPushApiPresent(true);
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: Promise.reject(new Error('worker startup failed')) },
      configurable: true,
    });
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    });

    await expect(enablePushNotifications('QQ')).resolves.toMatchObject({
      ok: true,
      mode: 'online-only',
      reason: 'service-worker-not-ready',
    });
  });

  it('distinguishes dismissing the permission prompt from denying it', async () => {
    setPushApiPresent(true);
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('default'),
    });

    await expect(enablePushNotifications('QQ')).resolves.toEqual({
      ok: false,
      reason: 'permission-dismissed',
    });
    expect(pushApiMocks.enable).not.toHaveBeenCalled();
  });

  it('reports when the browser cannot request notification permission', async () => {
    setPushApiPresent(true);
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi
        .fn()
        .mockRejectedValue(new Error('permission API failed')),
    });

    await expect(enablePushNotifications('QQ')).resolves.toEqual({
      ok: false,
      reason: 'permission-request-failed',
    });
    expect(pushApiMocks.enable).not.toHaveBeenCalled();
  });

  it('does not enable a different account after a permission prompt crosses sessions', async () => {
    useAuthStore.getState().login('token-a', {
      id: 'user-a',
      name: 'A',
      email: 'a@example.com',
    });
    setPushApiPresent(true);
    let resolvePermission:
      | ((permission: NotificationPermission) => void)
      | undefined;
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () =>
        new Promise<NotificationPermission>((resolve) => {
          resolvePermission = resolve;
        }),
    });

    const enabling = enablePushNotifications('QQ');
    useAuthStore.getState().login('token-b', {
      id: 'user-b',
      name: 'B',
      email: 'b@example.com',
    });
    resolvePermission?.('granted');

    await expect(enabling).resolves.toEqual({
      ok: false,
      reason: 'session-changed',
    });
    expect(pushApiMocks.enable).not.toHaveBeenCalled();
  });

  it('marks launch-time registration as a non-enabling refresh', async () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/current',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/current' }),
      unsubscribe: vi.fn(),
    };
    setPushRegistration({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
      },
    });

    await refreshPushSubscription('QQ');

    expect(pushApiMocks.subscribe).toHaveBeenCalledWith(
      subscription.toJSON(),
      'refresh',
    );
  });

  it('turns off every account device while cancelling the local subscription', async () => {
    const subscription = {
      endpoint: 'https://web.push.apple.com/local',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    setPushRegistration({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
      },
    });

    await disablePushNotifications();

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.unsubscribe).toHaveBeenCalledWith();
  });

  it('turns off the account even when this browser has no Push API', async () => {
    setPushApiPresent(false);

    await disablePushNotifications();

    expect(pushApiMocks.unsubscribe).toHaveBeenCalledWith();
  });

  it('turns off the account when local subscription removal fails', async () => {
    const subscription = {
      endpoint: 'https://web.push.apple.com/local',
      unsubscribe: vi.fn().mockRejectedValue(new Error('browser failure')),
    };
    setPushRegistration({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
      },
    });

    await disablePushNotifications();

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.unsubscribe).toHaveBeenCalledWith();
  });

  it('cleans only the current device during logout', async () => {
    const subscription = {
      endpoint: 'https://web.push.apple.com/local',
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    setPushRegistration({
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(subscription),
      },
    });

    await disconnectPushNotifications();

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMocks.unsubscribe).toHaveBeenCalledWith(
      subscription.endpoint,
      2_000,
    );
  });

  it('caps automatic local cleanup when the service worker hangs', async () => {
    vi.useFakeTimers();
    try {
      setPushApiPresent(true);
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistration: () => new Promise(() => undefined) },
        configurable: true,
      });

      const cleanup = disconnectLocalPushNotifications();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(cleanup).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not perform late cleanup after its timeout expires', async () => {
    vi.useFakeTimers();
    try {
      setPushApiPresent(true);
      let resolveRegistration:
        | ((registration: ServiceWorkerRegistration) => void)
        | undefined;
      const getSubscription = vi.fn();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          getRegistration: () =>
            new Promise<ServiceWorkerRegistration>((resolve) => {
              resolveRegistration = resolve;
            }),
        },
        configurable: true,
      });

      const cleanup = disconnectLocalPushNotifications();
      await vi.advanceTimersByTimeAsync(2_000);
      await cleanup;

      resolveRegistration?.({ pushManager: { getSubscription } } as never);
      await Promise.resolve();

      expect(getSubscription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
