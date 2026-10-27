import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import { useEffect, useRef } from 'react';
import { pushApi } from '../api/pushApi.js';
import { refreshPushSubscription } from '../lib/pushNotifications.js';
import { isCurrentAuthSession, useAuthStore } from '../stores/authStore.js';
import { useCurrentUser } from './useAuth.js';
import { effectiveAuthRole } from './usePermissions.js';

/** Repairs an already-enabled browser push subscription once per account. */
export function usePlatformPushSubscriptionRefresh(): void {
  const { data: currentUser } = useCurrentUser();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const attemptedFor = useRef<string | null>(null);
  const wantsPush = currentUser?.preferences?.pushNotificationsEnabled === true;
  const canUsePush = can(effectiveAuthRole(currentUser), ECapability.GAME_PLAY);
  const attemptKey =
    wantsPush && canUsePush && currentUser?.id
      ? `${authEpoch}:${currentUser.id}`
      : null;

  useEffect(() => {
    if (!attemptKey || attemptedFor.current === attemptKey) return;
    attemptedFor.current = attemptKey;
    const requestSession = useAuthStore.getState();
    void (async () => {
      try {
        const config = await pushApi.getConfig();
        if (!isCurrentAuthSession(requestSession)) return;
        if (!config.configured || !config.publicKey) return;
        await refreshPushSubscription(config.publicKey);
      } catch {
        // Push refresh is opportunistic and must not block application startup.
      }
    })();
  }, [attemptKey]);
}
