import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import { useEffect } from 'react';
import { platformSocket } from '../api/platformSocket.js';
import {
  canShowBrowserNotifications,
  showBrowserNotification,
} from '../lib/browserNotifications.js';
import { useAuthStore } from '../stores/authStore.js';
import { useCurrentUser } from './useAuth.js';
import { effectiveAuthRole } from './usePermissions.js';

/** Registers the platform-owned online notification receiver for this tab. */
export function usePlatformBrowserNotifications(): void {
  const { data: user } = useCurrentUser();
  const token = useAuthStore((state) => state.token);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = user?.id;
  const enabled =
    user?.preferences?.pushNotificationsEnabled === true &&
    can(effectiveAuthRole(user), ECapability.GAME_PLAY);

  useEffect(() => {
    if (!enabled || !userId || !token) return;
    let active = true;
    const epoch = authEpoch;
    const isActive = () => {
      const state = useAuthStore.getState();
      return (
        active &&
        state.authEpoch === epoch &&
        state.user?.id === userId &&
        state.isAuthenticated
      );
    };
    const stop = platformSocket.onPlatformBrowserNotification(
      (payload, acknowledge) => {
        void showBrowserNotification(payload, isActive).then(acknowledge);
      },
    );
    const report = () => {
      platformSocket.setPlatformNotificationsReady(
        isActive() && canShowBrowserNotifications(),
      );
    };
    const stopConnected = platformSocket.onConnected(report);
    report();
    window.addEventListener('focus', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      active = false;
      platformSocket.setPlatformNotificationsReady(false);
      stop();
      stopConnected();
      window.removeEventListener('focus', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [authEpoch, enabled, token, userId]);
}
