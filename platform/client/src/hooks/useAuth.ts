import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { authApi } from '../api/authApi.js';
import type {
  ILoginRequest,
  IRegisterRequest,
  IUpdatePreferencesRequest,
  IUpdateProfileRequest,
} from '../api/types.js';
import { disconnectLocalPushNotifications } from '../lib/pushCleanup.js';
import { isCurrentAuthSession, useAuthStore } from '../stores/authStore.js';
import {
  accountProfileQueryKey,
  fetchAccountProfile,
} from './accountProfileQuery.js';
import {
  getAuthPreferenceExtension,
  runAuthLogoutCleanups,
  subscribeAuthPreferenceExtensions,
} from './authExtensions.js';

export {
  registerAuthLogoutCleanup,
  registerAuthPreferenceExtension,
} from './authExtensions.js';

const MAX_NAVIGATOR_EXPIRY_TIMER_MS = 2_147_000_000;
const EMPTY_PREFERENCE_SNAPSHOT = { isPending: false };
const subscribeToNothing = (): (() => void) => () => undefined;
const getEmptyPreferenceSnapshot = () => EMPTY_PREFERENCE_SNAPSHOT;

export function useCurrentUser() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isRestoring = useAuthStore((s) => s.isRestoring);
  const storedUser = useAuthStore((s) => s.user);

  const query = useQuery({
    queryKey: accountProfileQueryKey(),
    queryFn: async ({ signal }) => {
      const profile = await fetchAccountProfile(signal);
      if (useAuthStore.getState().user !== profile) {
        useAuthStore.getState().setUser(profile);
      }
      return profile;
    },
    enabled: isAuthenticated && !isRestoring,
    staleTime: 5 * 60 * 1000,
  });

  /**
   * Refresh exactly when a finite Navigator grant expires. The permissions
   * hook also falls back immediately from the server projection, while this
   * refresh obtains the authoritative role/access payload for the rest of the
   * client.
   */
  const expiryRefreshKey = useRef<string | null>(null);
  const observedUser = storedUser ?? query.data;
  const navigatorExpiresAt = observedUser?.navigator?.expiresAt;
  useEffect(() => {
    if (
      !isAuthenticated ||
      isRestoring ||
      !observedUser?.navigator?.active ||
      navigatorExpiresAt == null
    ) {
      return;
    }

    const expiryKey = `${observedUser.id}:${String(navigatorExpiresAt)}`;
    if (expiryRefreshKey.current === expiryKey) return;

    const expiresAtMs = new Date(String(navigatorExpiresAt)).getTime();
    if (!Number.isFinite(expiresAtMs)) return;
    let timer: number | undefined;
    const refresh = (): void => {
      if (expiryRefreshKey.current === expiryKey) return;
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs > 0) {
        timer = window.setTimeout(
          refresh,
          Math.min(remainingMs + 50, MAX_NAVIGATOR_EXPIRY_TIMER_MS),
        );
        return;
      }
      expiryRefreshKey.current = expiryKey;
      const current = useAuthStore.getState().user;
      if (current?.id === observedUser.id && current.navigator?.active) {
        useAuthStore.getState().setUser({
          ...current,
          role: current.baseRole ?? 'player',
          navigator: { ...current.navigator, active: false },
        });
      }
      void query.refetch();
    };
    refresh();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    isAuthenticated,
    isRestoring,
    observedUser?.id,
    navigatorExpiresAt,
    observedUser?.navigator?.active,
    query.refetch,
  ]);

  return { ...query, data: storedUser ?? query.data };
}

export function useLogin() {
  return useMutation({
    mutationFn: (data: ILoginRequest) => authApi.login(data),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (data: IRegisterRequest) => authApi.register(data),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((s) => s.setUser);

  return useMutation({
    onMutate: () => useAuthStore.getState(),
    mutationFn: (data: IUpdateProfileRequest) => authApi.updateMe(data),
    onSuccess: (updatedUser, _variables, requestSession) => {
      if (!isCurrentAuthSession(requestSession)) return;
      const currentUser = useAuthStore.getState().user;
      if (!currentUser) return;
      const nextUser = { ...currentUser, name: updatedUser.name };
      setUser(nextUser);
      queryClient.setQueryData(accountProfileQueryKey(), nextUser);
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  const setUser = useAuthStore((state) => state.setUser);
  const preferenceExtension = useSyncExternalStore(
    subscribeAuthPreferenceExtensions,
    getAuthPreferenceExtension,
    getAuthPreferenceExtension,
  );
  const preferenceSnapshot = useSyncExternalStore(
    preferenceExtension?.subscribe ?? subscribeToNothing,
    preferenceExtension?.getSnapshot ?? getEmptyPreferenceSnapshot,
    preferenceExtension?.getSnapshot ?? getEmptyPreferenceSnapshot,
  );
  const [error, setError] = useState<Error | null>(null);
  const [fallbackIsPending, setFallbackIsPending] = useState(false);
  const requestSequence = useRef(0);
  const activeFallbackRequest = useRef<{
    id: number;
    session: ReturnType<typeof useAuthStore.getState>;
  } | null>(null);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const authUserId = useAuthStore((state) => state.user?.id);

  useEffect(() => {
    const activeRequest = activeFallbackRequest.current;
    if (!activeRequest || isCurrentAuthSession(activeRequest.session)) return;

    activeFallbackRequest.current = null;
    requestSequence.current += 1;
    setFallbackIsPending(false);
    setError(null);
  }, [authEpoch, authUserId]);

  const mutateAsync = async (data: IUpdatePreferencesRequest) => {
    const requestSession = useAuthStore.getState();
    const requestId = ++requestSequence.current;
    setError(null);
    if (preferenceExtension) {
      activeFallbackRequest.current = null;
      setFallbackIsPending(false);
    } else {
      activeFallbackRequest.current = {
        id: requestId,
        session: requestSession,
      };
      setFallbackIsPending(true);
    }
    try {
      if (preferenceExtension) {
        return await preferenceExtension.updatePreferences(data);
      }

      const updatedUser = await authApi.updatePreferences(data);
      if (isCurrentAuthSession(requestSession)) {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) return updatedUser;
        const nextUser = {
          ...currentUser,
          preferences: {
            ...currentUser.preferences,
            ...updatedUser.preferences,
          },
        };
        setUser(nextUser);
        queryClient.setQueryData(accountProfileQueryKey(), nextUser);
        void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
      }
      return updatedUser;
    } catch (cause) {
      const nextError =
        cause instanceof Error ? cause : new Error(String(cause));
      if (
        requestId === requestSequence.current &&
        isCurrentAuthSession(requestSession)
      ) {
        setError(nextError);
      }
      throw nextError;
    } finally {
      if (activeFallbackRequest.current?.id === requestId) {
        activeFallbackRequest.current = null;
        setFallbackIsPending(false);
      }
    }
  };

  return {
    mutate: (data: IUpdatePreferencesRequest) => {
      void mutateAsync(data).catch(() => {
        // Consumers using `mutate` observe the exposed error state.
      });
    },
    mutateAsync,
    isPending: preferenceExtension
      ? preferenceSnapshot.isPending
      : fallbackIsPending,
    isError: error !== null,
    error,
    reset: () => setError(null),
  };
}

export function useLogout() {
  const queryClient = useQueryClient();

  return async () => {
    const requestSession = useAuthStore.getState();
    const isLogoutCleanupCurrent = (): boolean => {
      const current = useAuthStore.getState();
      return (
        (current.authEpoch === requestSession.authEpoch &&
          current.user?.id === requestSession.user?.id) ||
        (!current.isAuthenticated &&
          current.authEpoch === requestSession.authEpoch + 1)
      );
    };
    try {
      await authApi.logout();
    } finally {
      const current = useAuthStore.getState();
      if (
        !current.isAuthenticated &&
        current.authEpoch !== requestSession.authEpoch
      ) {
        queryClient.clear();
      }
      await Promise.all([
        disconnectLocalPushNotifications(),
        runAuthLogoutCleanups(isLogoutCleanupCurrent),
      ]);
    }
  };
}
