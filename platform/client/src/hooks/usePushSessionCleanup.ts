import { useEffect, useRef } from 'react';
import { disconnectLocalPushNotifications } from '../lib/pushCleanup.js';
import { useAuthStore } from '../stores/authStore.js';

/** Remove this browser's endpoint whenever any code path ends the session. */
export function usePushSessionCleanup(): void {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const wasAuthenticated = useRef(isAuthenticated);
  const initialized = useRef(false);

  useEffect(() => {
    // Also clean on an unauthenticated initial load: a previous session may
    // have expired while this app was closed, leaving a browser subscription.
    if (
      !isAuthenticated &&
      (!initialized.current || wasAuthenticated.current)
    ) {
      void disconnectLocalPushNotifications();
    }
    initialized.current = true;
    wasAuthenticated.current = isAuthenticated;
  }, [isAuthenticated]);
}
