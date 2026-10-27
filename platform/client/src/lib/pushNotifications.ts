import type { IHttpClientError } from '@/api/httpClient.js';
import { pushApi } from '@/api/pushApi';
import { registerAuthLogoutCleanup } from '@/hooks/useAuth.js';
import { logDebug } from '@/lib/debugLog.js';
import { runWhileActive } from '@/lib/pushCleanup.js';
import { isSameAuthSession, useAuthStore } from '@/stores/authStore.js';

export { disconnectLocalPushNotifications } from '@/lib/pushCleanup.js';

/**
 * Web Push enrolment.
 *
 * iOS is the constrained case and drives the shape of this module. Safari only
 * exposes push to a web app launched from the Home Screen — in a normal tab
 * `PushManager` is absent entirely, so the UI has to distinguish "your browser
 * can't do this" from "add it to your Home Screen first". Getting that wrong
 * produces a toggle that silently does nothing, which is worse than no toggle.
 */

export type TPushBlocker =
  /** iOS specifically: supported, but only once installed to the Home Screen. */
  | 'needs-install'
  /** Web Push is exposed only in a secure browsing context. */
  | 'insecure-context'
  /** The browser or browsing mode does not expose Service Workers. */
  | 'service-worker-unavailable'
  /** The browser or device does not expose the Push API. */
  | 'push-api-unavailable'
  /** The browser or browsing mode does not expose the Notifications API. */
  | 'notifications-api-unavailable'
  /** The user previously denied notifications; only they can undo it. */
  | 'denied'
  /** Server has no VAPID keys configured. */
  | 'server-unconfigured';

export type TPushEnableFailure =
  | TPushBlocker
  /** The permission prompt was closed without a decision. */
  | 'permission-dismissed'
  /** The browser failed before it could present or resolve the prompt. */
  | 'permission-request-failed'
  /** A Service Worker API exists, but its active registration did not load. */
  | 'service-worker-not-ready'
  /** The browser or operating system rejected subscription creation. */
  | 'subscription-not-allowed'
  /** The browser could not reach its own push delivery service. */
  | 'subscription-service-unavailable'
  /** The browser failed to create or rotate a subscription for another reason. */
  | 'subscription-failed'
  /** The browser returned a placeholder endpoint that cannot receive push. */
  | 'invalid-push-endpoint'
  /** The server rejected the shape or endpoint produced by the browser. */
  | 'server-registration-rejected'
  /** The subscription could not be saved because the server was unavailable. */
  | 'server-registration-unavailable'
  /** The account opt-in request was rejected by the server. */
  | 'server-enable-rejected'
  /** The account opt-in request could not reach the server. */
  | 'server-enable-unavailable'
  /** The account changed while an explicit opt-in was still in flight. */
  | 'session-changed';

export type TPushEnableResult =
  | {
      ok: true;
      /** The account is enabled for online notifications only when present. */
      mode?: 'online-only';
      /** Optional diagnostic for a best-effort Web Push failure. */
      reason?: TPushEnableFailure;
    }
  | { ok: false; reason: TPushEnableFailure };

export interface IPushAvailability {
  /** Local Notification + Service Worker support is enough for online alerts. */
  usable: boolean;
  /** A VAPID key and browser Push API are both available for offline alerts. */
  webPushUsable: boolean;
  blocker?: TPushBlocker;
  /** True on iOS/iPadOS, where the Home Screen requirement applies. */
  isIos: boolean;
  /** True when running as an installed web app rather than a browser tab. */
  isStandalone: boolean;
  permission: NotificationPermission | 'unavailable';
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS Safari reports installed web apps through a non-standard flag; other
  // browsers use the display-mode media query.
  const iosStandalone = (
    window.navigator as Navigator & { standalone?: boolean }
  ).standalone;
  if (iosStandalone === true) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports a desktop UA; touch points disambiguate it from a Mac.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

interface IPushCapabilities {
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
}

const SERVICE_WORKER_READY_TIMEOUT_MS = 3_000;
const PUSH_OPERATION_TIMEOUT_MS = 5_000;

let enableGeneration = 0;
let accountEnableInFlight: Promise<void> | null = null;

function getPushCapabilities(): IPushCapabilities {
  const hasWindow = typeof window !== 'undefined';
  const hasNavigator = typeof navigator !== 'undefined';
  return {
    secureContext: hasWindow && window.isSecureContext === true,
    serviceWorker: hasNavigator && 'serviceWorker' in navigator,
    pushManager: hasWindow && 'PushManager' in window,
    notifications: hasWindow && 'Notification' in window,
  };
}

function hasPushApi(): boolean {
  const capabilities = getPushCapabilities();
  return Object.values(capabilities).every(Boolean);
}

/**
 * Why push can or cannot be enabled here. `serverConfigured` comes from
 * `/push/config` so a missing VAPID key is reported as such instead of looking
 * like a browser problem.
 */
export function getPushAvailability(
  serverConfigured: boolean,
): IPushAvailability {
  const isIos = isIosDevice();
  const isStandalone = isStandaloneDisplay();
  const capabilities = getPushCapabilities();
  const permission: NotificationPermission | 'unavailable' =
    capabilities.notifications ? Notification.permission : 'unavailable';

  const base: Pick<IPushAvailability, 'isIos' | 'isStandalone' | 'permission'> =
    { isIos, isStandalone, permission };

  if (isIos && !isStandalone) {
    return {
      ...base,
      usable: false,
      webPushUsable: false,
      blocker: 'needs-install',
    };
  }
  if (!capabilities.secureContext) {
    return {
      ...base,
      usable: false,
      webPushUsable: false,
      blocker: 'insecure-context',
    };
  }
  if (!capabilities.serviceWorker) {
    return {
      ...base,
      usable: false,
      webPushUsable: false,
      blocker: 'service-worker-unavailable',
    };
  }
  if (!capabilities.notifications) {
    return {
      ...base,
      usable: false,
      webPushUsable: false,
      blocker: 'notifications-api-unavailable',
    };
  }
  if (permission === 'denied') {
    return {
      ...base,
      usable: false,
      webPushUsable: false,
      blocker: 'denied',
    };
  }
  return {
    ...base,
    usable: true,
    webPushUsable: capabilities.pushManager && serverConfigured,
  };
}

/** VAPID keys travel as base64url; `applicationServerKey` needs raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  // Backed by an explicit ArrayBuffer: `applicationServerKey` requires a
  // BufferSource over ArrayBuffer, not the wider ArrayBufferLike.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  error: Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(error), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timeout);
        reject(reason);
      },
    );
  });
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  // `ready` resolves only once a worker is active, which is required before
  // subscribing. A broken worker must not hold the opt-in UI indefinitely.
  try {
    return await withTimeout(
      navigator.serviceWorker.ready,
      SERVICE_WORKER_READY_TIMEOUT_MS,
      new PushRegistrationError('service-worker-not-ready'),
    );
  } catch (error) {
    if (error instanceof PushRegistrationError) throw error;
    throw new PushRegistrationError('service-worker-not-ready');
  }
}

async function createSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  return withTimeout(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }),
    PUSH_OPERATION_TIMEOUT_MS,
    new PushRegistrationError('subscription-service-unavailable'),
  );
}

class PushRegistrationError extends Error {
  public constructor(public readonly reason: TPushEnableFailure) {
    super(reason);
    this.name = 'PushRegistrationError';
  }
}

function browserSubscriptionFailure(error: unknown): PushRegistrationError {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError') {
    return new PushRegistrationError('subscription-not-allowed');
  }
  if (name === 'AbortError' || name === 'NetworkError') {
    return new PushRegistrationError('subscription-service-unavailable');
  }
  return new PushRegistrationError('subscription-failed');
}

function serverRegistrationFailure(error: unknown): PushRegistrationError {
  const status = (error as IHttpClientError | undefined)?.status;
  return new PushRegistrationError(
    typeof status === 'number' && status >= 400 && status < 500
      ? 'server-registration-rejected'
      : 'server-registration-unavailable',
  );
}

function serverEnableFailure(error: unknown): PushRegistrationError {
  const status = (error as IHttpClientError | undefined)?.status;
  return new PushRegistrationError(
    typeof status === 'number' && status >= 400 && status < 500
      ? 'server-enable-rejected'
      : 'server-enable-unavailable',
  );
}

function isInvalidBrowserEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol !== 'https:' || url.hostname.endsWith('.invalid');
  } catch {
    return true;
  }
}

async function rejectInvalidBrowserEndpoint(
  subscription: PushSubscription,
): Promise<void> {
  if (!isInvalidBrowserEndpoint(subscription.endpoint)) return;
  try {
    await subscription.unsubscribe();
  } catch {
    // The unusable endpoint must still be reported even if browser cleanup
    // fails; no request containing it is sent to our server.
  }
  throw new PushRegistrationError('invalid-push-endpoint');
}

async function getBrowserSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  try {
    const existing = await withTimeout(
      registration.pushManager.getSubscription(),
      PUSH_OPERATION_TIMEOUT_MS,
      new PushRegistrationError('subscription-service-unavailable'),
    );
    return existing ?? (await createSubscription(registration, publicKey));
  } catch (error) {
    if (error instanceof PushRegistrationError) throw error;
    throw browserSubscriptionFailure(error);
  }
}

async function saveBrowserSubscription(
  subscription: PushSubscription,
  mode: 'enable' | 'refresh',
  isCurrentSession: () => boolean,
): Promise<void> {
  if (!isCurrentSession()) {
    throw new PushRegistrationError('session-changed');
  }
  try {
    await pushApi.subscribe(subscription.toJSON(), mode);
    if (!isCurrentSession()) {
      throw new PushRegistrationError('session-changed');
    }
  } catch (error) {
    if (error instanceof PushRegistrationError) throw error;
    throw serverRegistrationFailure(error);
  }
}

/**
 * Register a browser subscription for the current account. A 409 means this
 * endpoint still belongs to a previous account on the device; rotate the
 * browser subscription so an already queued notification cannot cross users.
 */
async function registerForCurrentAccount(
  registration: ServiceWorkerRegistration,
  publicKey: string,
  mode: 'enable' | 'refresh',
  isCurrentSession: () => boolean = () => true,
): Promise<PushSubscription> {
  if (!isCurrentSession()) {
    throw new PushRegistrationError('session-changed');
  }
  const subscription = await getBrowserSubscription(registration, publicKey);
  if (!isCurrentSession()) {
    throw new PushRegistrationError('session-changed');
  }
  await rejectInvalidBrowserEndpoint(subscription);

  try {
    if (!isCurrentSession()) {
      throw new PushRegistrationError('session-changed');
    }
    await pushApi.subscribe(subscription.toJSON(), mode);
    if (!isCurrentSession()) {
      throw new PushRegistrationError('session-changed');
    }
    return subscription;
  } catch (error) {
    if (error instanceof PushRegistrationError) throw error;
    if ((error as IHttpClientError | undefined)?.status !== 409) {
      throw serverRegistrationFailure(error);
    }

    let rotated: PushSubscription;
    try {
      await subscription.unsubscribe();
      if (!isCurrentSession()) {
        throw new PushRegistrationError('session-changed');
      }
      rotated = await createSubscription(registration, publicKey);
    } catch (rotationError) {
      if (rotationError instanceof PushRegistrationError) throw rotationError;
      throw browserSubscriptionFailure(rotationError);
    }
    await rejectInvalidBrowserEndpoint(rotated);
    await saveBrowserSubscription(rotated, mode, isCurrentSession);
    return rotated;
  }
}

/**
 * Ask for permission and register this device.
 *
 * Must be called from a user gesture: both iOS and Chrome reject or penalise
 * permission prompts that are not tied to a tap.
 */
export async function enablePushNotifications(
  publicKey?: string | null,
): Promise<TPushEnableResult> {
  const generation = ++enableGeneration;
  const requestSession = useAuthStore.getState();
  const isCurrentSession = () => isSameAuthSession(requestSession);
  const isCurrentEnable = () =>
    generation === enableGeneration && isCurrentSession();
  const hasPublicKey = typeof publicKey === 'string' && publicKey.length > 0;
  const availability = getPushAvailability(hasPublicKey);
  if (!availability.usable) {
    return {
      ok: false,
      reason: availability.blocker ?? 'subscription-failed',
    };
  }

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    logDebug('warn', 'push', 'permission request failed');
    return { ok: false, reason: 'permission-request-failed' };
  }
  if (permission !== 'granted') {
    logDebug('info', 'push', 'permission not granted', { permission });
    return {
      ok: false,
      reason: permission === 'denied' ? 'denied' : 'permission-dismissed',
    };
  }
  if (!isCurrentEnable()) {
    return { ok: false, reason: 'session-changed' };
  }

  const accountEnable = pushApi.enable();
  accountEnableInFlight = accountEnable;
  try {
    await accountEnable;
  } catch (error) {
    if (!isCurrentEnable()) {
      return { ok: false, reason: 'session-changed' };
    }
    const classified = serverEnableFailure(error);
    logDebug('warn', 'push', 'account enable failed', {
      reason: classified.reason,
    });
    return { ok: false, reason: classified.reason };
  } finally {
    if (accountEnableInFlight === accountEnable) accountEnableInFlight = null;
  }
  if (!isCurrentEnable()) {
    return { ok: false, reason: 'session-changed' };
  }

  if (!availability.webPushUsable || !publicKey) {
    logDebug('info', 'push', 'enabled for online notifications only');
    return {
      ok: true,
      mode: 'online-only',
      reason: !hasPublicKey ? 'server-unconfigured' : 'push-api-unavailable',
    };
  }

  try {
    const registration = await getRegistration();
    const subscription = await registerForCurrentAccount(
      registration,
      publicKey,
      // The account preference was persisted above. A delayed browser
      // subscription must never turn an account back on after an opt-out.
      'refresh',
      isCurrentEnable,
    );
    logDebug('info', 'push', 'subscribed', {
      endpoint: subscription.endpoint.slice(0, 40),
    });
    return { ok: true };
  } catch (error) {
    const reason =
      error instanceof PushRegistrationError
        ? error.reason
        : 'subscription-failed';
    if (!isCurrentEnable()) {
      return { ok: false, reason: 'session-changed' };
    }
    if (reason === 'session-changed') {
      return { ok: false, reason };
    }
    // Account opt-in is already durable, so an unavailable push service is a
    // degraded delivery mode rather than a failed enable. The `refresh` mode
    // above makes any late completion conditional on that durable opt-in.
    logDebug(
      'warn',
      'push',
      'Web Push unavailable; using online notifications',
      {
        reason,
      },
    );
    return { ok: true, mode: 'online-only', reason };
  }
}

/** Unregister this device and drop the account's stored subscriptions. */
export async function disablePushNotifications(): Promise<void> {
  const requestSession = useAuthStore.getState();
  const isCurrentSession = () => isSameAuthSession(requestSession);
  enableGeneration += 1;
  const pendingEnable = accountEnableInFlight;
  if (pendingEnable) await pendingEnable.catch(() => undefined);
  if (!isCurrentSession()) throw new PushRegistrationError('session-changed');
  if (hasPushApi()) {
    await runWhileActive(async (isActive) => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!isActive() || !isCurrentSession()) return;
        const subscription = await registration?.pushManager.getSubscription();
        if (!isActive() || !isCurrentSession()) return;
        await subscription?.unsubscribe();
      } catch (error) {
        // Server-side opt-out is authoritative and must still happen when a
        // browser refuses or fails to remove its local subscription.
        logDebug('warn', 'push', 'local disable cleanup failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, 2_000);
  }
  // The preference and switch are account-level, so turning them off must stop
  // every registered device, not just the browser where the switch was used.
  if (!isCurrentSession()) throw new PushRegistrationError('session-changed');
  await pushApi.unsubscribe();
}

/** Best-effort cleanup for a shared device before its account token is lost. */
export async function disconnectPushNotifications(
  isCurrentSession: () => boolean = () => true,
): Promise<void> {
  enableGeneration += 1;
  if (!hasPushApi()) return;
  await runWhileActive(async (isActive) => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!isActive() || !isCurrentSession()) return;
      const subscription = await registration?.pushManager.getSubscription();
      if (!isActive() || !isCurrentSession() || !subscription) return;

      await Promise.allSettled([
        subscription.unsubscribe(),
        pushApi.unsubscribe(subscription.endpoint, 2_000),
      ]);
    } catch (error) {
      logDebug('warn', 'push', 'logout subscription cleanup failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, 2_000);
}

/**
 * Re-register on launch when already enabled.
 *
 * iOS invalidates subscriptions readily (app deleted and re-added, long
 * inactivity, OS updates), and the browser does not tell us. Without this a
 * player stays "enabled" in preferences while silently receiving nothing.
 */
export async function refreshPushSubscription(
  publicKey: string,
): Promise<void> {
  if (!hasPushApi() || Notification.permission !== 'granted') return;
  const requestSession = useAuthStore.getState();
  try {
    const registration = await getRegistration();
    await registerForCurrentAccount(registration, publicKey, 'refresh', () =>
      isSameAuthSession(requestSession),
    );
  } catch (error) {
    logDebug('warn', 'push', 'subscription refresh failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

registerAuthLogoutCleanup(disconnectPushNotifications);
