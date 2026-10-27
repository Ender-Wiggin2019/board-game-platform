import type { IBrowserNotificationPayload } from '@board-platform/contracts';

export function canShowBrowserNotifications(): boolean {
  return (
    window.isSecureContext === true &&
    'Notification' in window &&
    Notification.permission === 'granted'
  );
}

/** Display an online notification without contacting the browser's push provider. */
export async function showBrowserNotification(
  payload: IBrowserNotificationPayload,
  isActive: () => boolean,
): Promise<boolean> {
  if (!isActive() || !canShowBrowserNotifications()) return false;
  try {
    const target = new URL(payload.url ?? '/', window.location.origin);
    if (target.origin !== window.location.origin) return false;
    const isViewingGame = () =>
      target.pathname.startsWith('/game/') &&
      target.pathname === window.location.pathname &&
      document.visibilityState === 'visible' &&
      document.hasFocus();
    if (isViewingGame()) return true;

    const registration =
      'serviceWorker' in navigator
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    if (!isActive() || !canShowBrowserNotifications()) return false;
    if (isViewingGame()) return true;
    const options: NotificationOptions & { renotify: boolean } = {
      body: payload.body,
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      icon: '/pwa/icon-192.png',
      data: { url: target.href },
    };
    if (registration?.active) {
      await registration.showNotification(payload.title, options);
    } else {
      const notification = new Notification(payload.title, options);
      notification.onclick = () => {
        notification.close();
        window.focus();
        if (window.location.href !== target.href)
          window.location.assign(target.href);
      };
    }
    return true;
  } catch {
    return false;
  }
}
