import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { platformSocket } from '../../api/platformSocket.js';
import type { GameShellBadges } from '../../GameClientRegistration.js';
import {
  PLATFORM_SHELL_SUMMARY_QUERY_KEY,
  usePlatformShellSummary,
} from '../../hooks/usePlatformShellSummary.js';

const empty: GameShellBadges = {
  friendPendingCount: 0,
  actionRequiredCount: 0,
  waitingReadyCount: 0,
  unreadCount: 0,
};
const Context = createContext<GameShellBadges>(empty);

export function useShellBadges(): GameShellBadges {
  return useContext(Context);
}

/**
 * Presents the platform-owned account snapshot to the shell. The platform
 * query is the only badge source.
 */
export function ShellBadgesProvider({ children }: { children: ReactNode }) {
  const summary = usePlatformShellSummary();
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: PLATFORM_SHELL_SUMMARY_QUERY_KEY,
      });
    };
    const stopNotification = platformSocket.onPlatformNotification(refresh);
    const stopConnected = platformSocket.onConnected(refresh);
    refresh();
    return () => {
      stopNotification();
      stopConnected();
    };
  }, [queryClient]);
  const notifications = summary.data?.notifications;
  const games = summary.data?.games;
  const badges: GameShellBadges = {
    friendPendingCount:
      (notifications?.friendRequests.incoming ?? 0) +
      (notifications?.gameInvitations.pending ?? 0),
    actionRequiredCount: games?.actionRequired ?? 0,
    waitingReadyCount: games?.waitingReady ?? 0,
    unreadCount: notifications?.messages.unread ?? 0,
  };

  return <Context.Provider value={badges}>{children}</Context.Provider>;
}
