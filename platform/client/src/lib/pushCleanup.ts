import { logDebug } from './debugLog.js';

function hasPushApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Stop awaiting after a deadline and invalidate delayed continuations so they
 * cannot act on a different account that signs in after cleanup returns.
 */
export async function runWhileActive(
  run: (isActive: () => boolean) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let active = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const task = run(() => active);
  await Promise.race([
    task,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  active = false;
  if (timeout !== undefined) clearTimeout(timeout);
}

/** Cancel the browser endpoint after any logout path, including automatic 401s. */
export async function disconnectLocalPushNotifications(): Promise<void> {
  if (!hasPushApi()) return;
  await runWhileActive(async (isActive) => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!isActive()) return;
      const subscription = await registration?.pushManager.getSubscription();
      if (!isActive()) return;
      await subscription?.unsubscribe();
    } catch (error) {
      logDebug('warn', 'push', 'local logout subscription cleanup failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, 2_000);
}
