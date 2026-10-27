import { useEffect } from 'react';
import { platformSocket } from '../api/platformSocket.js';
import { useAuthStore } from '../stores/authStore.js';

/** The platform, rather than an installed game, owns its authenticated transport. */
export function PlatformSocketLifecycle(): null {
  const token = useAuthStore((state) =>
    state.isAuthenticated && !state.sessionExpired ? state.token : null,
  );
  const epoch = useAuthStore((state) => state.authEpoch);
  useEffect(() => {
    platformSocket.updateToken(token, epoch);
  }, [token, epoch]);
  useEffect(() => () => platformSocket.disconnect(), []);
  return null;
}
