import { useQuery } from '@tanstack/react-query';
import { shouldRetryHttpQuery } from '../api/httpClient.js';
import { platformApi } from '../api/platformApi.js';
import { useAuthStore } from '../stores/authStore.js';

export const PLATFORM_SHELL_SUMMARY_QUERY_KEY = [
  'platform',
  'shell-summary',
] as const;

/**
 * The shell summary is a server-owned snapshot. React Query refetches it after
 * focus and reconnect events; it deliberately has no fixed polling interval.
 */
export function usePlatformShellSummary(enabled = true) {
  const authenticated = useAuthStore(
    (state) => state.isAuthenticated && !state.sessionExpired,
  );
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const queryKey = [
    ...PLATFORM_SHELL_SUMMARY_QUERY_KEY,
    userId,
    authEpoch,
  ] as const;
  return useQuery({
    queryKey,
    queryFn: () => platformApi.shellSummary(),
    enabled: enabled && authenticated,
    refetchInterval: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    staleTime: 15_000,
    retry: shouldRetryHttpQuery,
  });
}
