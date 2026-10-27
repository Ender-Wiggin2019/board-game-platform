import { toast } from '@/components/ui/toast.js';
import i18n from '@/i18n.js';
import { registerServiceWorker } from './swRegistration';

type TCleanup = () => void;

let activeCleanup: TCleanup | null = null;
const noop: TCleanup = () => undefined;
const pwaNavigationEvent = 'seti:pwa-navigation';

function t(key: string, defaultValue: string): string {
  return i18n.t(key, { defaultValue, ns: 'platform-common' });
}

function canRegisterServiceWorker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  );
}

function emitPwaNavigation(): void {
  window.dispatchEvent(new Event(pwaNavigationEvent));
}

function listenForPwaNavigation(listener: () => void): TCleanup {
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;

  const wrappedPushState = function pushState(
    this: History,
    ...args: Parameters<History['pushState']>
  ): ReturnType<History['pushState']> {
    const result = originalPushState.apply(this, args);
    emitPwaNavigation();
    return result;
  } as History['pushState'];

  const wrappedReplaceState = function replaceState(
    this: History,
    ...args: Parameters<History['replaceState']>
  ): ReturnType<History['replaceState']> {
    const result = originalReplaceState.apply(this, args);
    emitPwaNavigation();
    return result;
  } as History['replaceState'];

  window.history.pushState = wrappedPushState;
  window.history.replaceState = wrappedReplaceState;
  window.addEventListener('popstate', listener);
  window.addEventListener(pwaNavigationEvent, listener);

  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(pwaNavigationEvent, listener);
    if (window.history.pushState === wrappedPushState) {
      window.history.pushState = originalPushState;
    }
    if (window.history.replaceState === wrappedReplaceState) {
      window.history.replaceState = originalReplaceState;
    }
  };
}

export function registerPwa(): TCleanup {
  if (!canRegisterServiceWorker()) {
    return noop;
  }

  if (activeCleanup) {
    return activeCleanup;
  }

  let hasPendingUpdate = false;
  let isApplyingUpdate = false;
  let serviceWorkerRegistration: ServiceWorkerRegistration | undefined;
  let isCheckingForUpdate = false;
  const checkForServiceWorkerUpdate = (): void => {
    if (!serviceWorkerRegistration || isCheckingForUpdate || isApplyingUpdate) {
      return;
    }

    isCheckingForUpdate = true;
    void serviceWorkerRegistration
      .update()
      .catch(() => undefined)
      .finally(() => {
        isCheckingForUpdate = false;
      });
  };
  const applyUpdate = (): void => {
    if (isApplyingUpdate) return;
    isApplyingUpdate = true;
    hasPendingUpdate = false;
    void updateServiceWorker(true);
  };
  const applyPendingUpdate = (): void => {
    if (!hasPendingUpdate) return;
    applyUpdate();
  };

  const updateServiceWorker = registerServiceWorker({
    immediate: true,
    onRegisteredSW(_swScriptUrl, registration) {
      serviceWorkerRegistration = registration;
      checkForServiceWorkerUpdate();
    },
    onNeedRefresh() {
      hasPendingUpdate = true;
      applyPendingUpdate();
    },
    onNeedReload() {
      window.location.reload();
    },
    onOfflineReady() {
      toast({
        title: t(
          'client.pwa.offlineReady.title',
          'Mission interface saved for offline launch',
        ),
        description: t(
          'client.pwa.offlineReady.description',
          'The installed app can open its cached shell without a network connection.',
        ),
        variant: 'success',
      });
    },
  });

  const handleOffline = (): void => {
    toast({
      title: t('client.requestRecovery.offline.title', 'You are offline'),
      description: t(
        'client.requestRecovery.offline.description',
        'Try again once you are online.',
      ),
      variant: 'warning',
    });
  };

  const handleOnline = (): void => {
    checkForServiceWorkerUpdate();
    toast({
      title: t('client.pwa.online.title', 'Back online'),
      description: t('client.pwa.online.description', 'Reconnecting…'),
      variant: 'success',
    });
  };

  const handleVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') {
      checkForServiceWorkerUpdate();
    }
  };

  window.addEventListener('offline', handleOffline);
  window.addEventListener('online', handleOnline);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  const cleanupPwaNavigation = listenForPwaNavigation(() => {
    checkForServiceWorkerUpdate();
    applyPendingUpdate();
  });

  activeCleanup = () => {
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    cleanupPwaNavigation();
    activeCleanup = null;
  };

  return activeCleanup;
}
