import { authApi } from '../api/authApi.js';
import type { IAuthUser } from '../api/types.js';
import { useAuthStore } from '../stores/authStore.js';

export const accountProfileQueryKey = () => ['auth', 'me'] as const;

export async function fetchAccountProfile(
  signal: AbortSignal,
): Promise<IAuthUser> {
  const requestSession = useAuthStore.getState();
  const profile = await authApi.getMe(signal);
  const currentSession = useAuthStore.getState();
  if (
    signal.aborted ||
    currentSession.authEpoch !== requestSession.authEpoch ||
    currentSession.user?.id !== requestSession.user?.id
  ) {
    throw new DOMException('Account session changed', 'AbortError');
  }
  return currentSession.user &&
    (currentSession.user !== requestSession.user ||
      currentSession.token !== requestSession.token)
    ? currentSession.user
    : profile;
}
