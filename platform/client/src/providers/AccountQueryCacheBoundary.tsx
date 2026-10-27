import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery';
import { useAuthStore } from '@/stores/authStore';

function currentSessionIdentity(
  session: ReturnType<typeof useAuthStore.getState>,
): string {
  if (!session.isAuthenticated || !session.user) return '';
  return `${session.user.id}:${session.authEpoch}`;
}

/** Clears account-scoped queries synchronously whenever the auth session changes. */
export function AccountQueryCacheBoundary(): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    let previousSession = useAuthStore.getState();
    let previousIdentity = currentSessionIdentity(previousSession);
    return useAuthStore.subscribe((session) => {
      const nextIdentity = currentSessionIdentity(session);
      if (nextIdentity === previousIdentity) {
        if (
          session.user &&
          session.user !== previousSession.user &&
          queryClient.getQueryData(accountProfileQueryKey()) !== session.user
        ) {
          queryClient.setQueryData(accountProfileQueryKey(), session.user);
        }
      } else {
        queryClient.clear();
      }
      previousSession = session;
      previousIdentity = nextIdentity;
    });
  }, [queryClient]);

  return null;
}
