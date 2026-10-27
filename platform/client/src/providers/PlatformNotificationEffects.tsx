import {
  EMessageSeverity,
  type IUserMessage,
} from '@board-platform/contracts/types/protocol/messages';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { platformSocket } from '../api/platformSocket.js';
import { toast } from '../components/ui/toast.js';
import { usePlatformBrowserNotifications } from '../hooks/usePlatformBrowserNotifications.js';
import { usePlatformPushSubscriptionRefresh } from '../hooks/usePlatformPushSubscriptionRefresh.js';
import { resolvePlatformMessageText } from '../lib/i18nMessage.js';
import { isCurrentAuthSession, useAuthStore } from '../stores/authStore.js';
import { usePlatformNotificationOwnership } from './PlatformNotificationOwnership.js';

/** Platform-owned account notification effects shared by every installed game. */
export function PlatformNotificationEffects(): null {
  usePlatformBrowserNotifications();
  usePlatformPushSubscriptionRefresh();
  usePlatformMessageNotifications();
  return null;
}

function usePlatformMessageNotifications(): void {
  const token = useAuthStore((state) => state.token);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const queryClient = useQueryClient();
  const { t } = useTranslation('common');
  const notificationOwnership = usePlatformNotificationOwnership();
  const translationRef = useRef(t);
  translationRef.current = t;

  useEffect(() => {
    if (!token || !isAuthenticated) return;
    const requestSession = useAuthStore.getState();
    const unsubscribe = platformSocket.onPlatformNotification((event) => {
      if (!isCurrentAuthSession(requestSession)) return;

      if (event.kind !== 'message') return;

      const message = readUserMessage(event.message);
      if (!message) return;
      const content = message.content as Record<string, unknown>;
      const invalidations = [
        queryClient.invalidateQueries({ queryKey: ['messages', 'inbox'] }),
        queryClient.invalidateQueries({
          queryKey: ['messages', 'unread-count'],
        }),
      ];
      if (
        Array.isArray(content.achievementBadgeIds) &&
        content.achievementBadgeIds.length > 0
      ) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: ['platform', 'game-achievements'],
          }),
        );
      }
      void Promise.all(invalidations);

      const title = resolvePlatformMessageText(
        translationRef.current,
        content.title,
      );
      const body = resolvePlatformMessageText(
        translationRef.current,
        content.kind === 'plain' ? content.body : content.intro,
      );
      const hasRichAchievementOwner =
        Array.isArray(content.achievementBadgeIds) &&
        content.achievementBadgeIds.length > 0 &&
        notificationOwnership.hasNotificationOwner(
          typeof content.gameId === 'string' ? content.gameId : undefined,
          'achievement',
          content,
        );
      if (!title || !body || hasRichAchievementOwner) return;
      toast({
        title,
        description: body,
        variant:
          message.severity === EMessageSeverity.CRITICAL
            ? 'error'
            : message.severity === EMessageSeverity.WARNING
              ? 'warning'
              : message.severity === EMessageSeverity.SUCCESS
                ? 'success'
                : 'default',
      });
    });
    return unsubscribe;
  }, [
    authEpoch,
    isAuthenticated,
    notificationOwnership,
    queryClient,
    token,
    userId,
  ]);
}

function readUserMessage(value: unknown): IUserMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const message = value as Partial<IUserMessage>;
  if (
    typeof message.content !== 'object' ||
    message.content === null ||
    Array.isArray(message.content) ||
    typeof message.severity !== 'string'
  )
    return null;
  return message as IUserMessage;
}
