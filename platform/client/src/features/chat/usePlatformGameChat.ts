import {
  GAME_CHAT_HISTORY_LIMIT,
  type IGameChatHistoryPayload,
  type IGameChatMessage,
  type IGameChatReadState,
} from '@board-platform/contracts/types/protocol/gameChat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPlatformRequestId, platformApi } from '@/api/platformApi';
import { platformSocket } from '@/api/platformSocket';
import { usePlatformConfiguration } from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';
import type { IUseGameChatResult } from './chatTypes.js';

const READ_RECEIPT_DELAY_MS = 500;
const CHAT_FALLBACK_POLL_MS = 5_000;
const SEND_RETRY_BASE_MS = 750;
const SEND_RETRY_MAX_MS = 10_000;

const EMPTY_READ_STATE: IGameChatReadState = {
  readThroughSeq: 0,
  throughSeq: 0,
  unreadCount: 0,
};

interface IPendingReadReceipt {
  readonly messageId: string;
  readonly sequence: number;
}

interface IPendingSend {
  readonly requestId: string;
  readonly body: string;
  readonly attempt: number;
}

/**
 * Platform chat is a durable HTTP read/write surface. The Socket.IO channel
 * carries only a sequence hint; a hint always causes an authoritative snapshot
 * read, so the browser never merges untrusted chat payloads.
 */
export type TPlatformChatTarget = 'session' | 'room';

/**
 * Shared durable chat state for native sessions and waiting rooms.  The target
 * chooses the authenticated HTTP/socket surface; the state machine stays one
 * authority so retry, read cursors, and lifecycle fencing cannot drift.
 */
export function usePlatformChat(
  targetId: string | null,
  target: TPlatformChatTarget,
  canSend = true,
): IUseGameChatResult {
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const targetCanSend =
    targetId !== null && targetId !== '' && (target === 'session' || canSend);
  const identityKey = `${authEpoch}:${currentUserId ?? ''}`;
  const [messages, setMessages] = useState<IGameChatMessage[]>([]);
  const [open, setOpenState] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const messagesRef = useRef<IGameChatMessage[]>([]);
  const openRef = useRef(false);
  const readStateRef = useRef<IGameChatReadState>(EMPTY_READ_STATE);
  const optimisticReadThroughRef = useRef(0);
  const pendingReadRef = useRef<IPendingReadReceipt | null>(null);
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSendRef = useRef<IPendingSend | null>(null);
  const sendRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycleRef = useRef(0);
  const snapshotRequestRef = useRef<Promise<void> | null>(null);
  const pendingHintSequenceRef = useRef(0);
  const appliedHintSequenceRef = useRef(0);

  const clearReadTimer = useCallback((): void => {
    if (readTimerRef.current === null) return;
    clearTimeout(readTimerRef.current);
    readTimerRef.current = null;
  }, []);

  const clearSendRetryTimer = useCallback((): void => {
    if (sendRetryTimerRef.current === null) return;
    clearTimeout(sendRetryTimerRef.current);
    sendRetryTimerRef.current = null;
  }, []);

  const applyUnreadCount = useCallback(
    (nextMessages: IGameChatMessage[], state: IGameChatReadState): void => {
      if (openRef.current) {
        setUnreadCount(0);
        return;
      }
      const optimisticReadThrough = optimisticReadThroughRef.current;
      if (optimisticReadThrough >= state.throughSeq) {
        setUnreadCount(0);
        return;
      }
      const unreadFromSnapshot =
        optimisticReadThrough > state.readThroughSeq
          ? nextMessages.filter(
              (message) =>
                message.sequence > optimisticReadThrough &&
                message.sequence <= state.throughSeq &&
                message.senderUserId !== currentUserId,
            ).length
          : state.unreadCount;
      const liveUnread = nextMessages.filter(
        (message) =>
          message.sequence > state.throughSeq &&
          message.senderUserId !== currentUserId,
      ).length;
      setUnreadCount(
        Math.min(GAME_CHAT_HISTORY_LIMIT, unreadFromSnapshot + liveUnread),
      );
    },
    [currentUserId],
  );

  const applySnapshot = useCallback(
    (payload: IGameChatHistoryPayload): void => {
      const nextMessages = [...payload.messages].sort(
        (left, right) => left.sequence - right.sequence,
      );
      messagesRef.current = nextMessages;
      readStateRef.current = payload.readState;
      setMessages(nextMessages);
      applyUnreadCount(nextMessages, payload.readState);
    },
    [applyUnreadCount],
  );

  const flushReadReceipt = useCallback((): void => {
    clearReadTimer();
    const pending = pendingReadRef.current;
    if (!pending || !targetId || !currentUserId) return;
    pendingReadRef.current = null;
    const lifecycle = lifecycleRef.current;
    void platformApi[
      target === 'session' ? 'markChatRead' : 'markRoomChatRead'
    ](targetId, pending.messageId)
      .then((state) => {
        if (lifecycle !== lifecycleRef.current) return;
        readStateRef.current = state;
        optimisticReadThroughRef.current = Math.max(
          optimisticReadThroughRef.current,
          state.readThroughSeq,
        );
        applyUnreadCount(messagesRef.current, state);
      })
      .catch(() => {
        if (lifecycle !== lifecycleRef.current) return;
        pendingReadRef.current = pending;
      });
  }, [applyUnreadCount, clearReadTimer, currentUserId, target, targetId]);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    if (!targetId || (target === 'session' && !currentUserId)) return;
    if (snapshotRequestRef.current) return snapshotRequestRef.current;
    const lifecycle = lifecycleRef.current;
    const requestedTargetId = targetId;
    const request = platformApi[
      target === 'session' ? 'getChat' : 'getRoomChat'
    ](requestedTargetId)
      .then((payload) => {
        if (
          lifecycle !== lifecycleRef.current ||
          requestedTargetId !== targetId ||
          payload.gameId !== requestedTargetId
        ) {
          return;
        }
        applySnapshot(payload);
        appliedHintSequenceRef.current = Math.max(
          appliedHintSequenceRef.current,
          payload.readState.throughSeq,
        );
        if (openRef.current) {
          const latest = messagesRef.current.at(-1);
          if (latest && latest.sequence > optimisticReadThroughRef.current) {
            pendingReadRef.current = {
              messageId: latest.id,
              sequence: latest.sequence,
            };
            flushReadReceipt();
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (snapshotRequestRef.current === request) {
          snapshotRequestRef.current = null;
          if (
            lifecycle === lifecycleRef.current &&
            pendingHintSequenceRef.current > appliedHintSequenceRef.current
          ) {
            pendingHintSequenceRef.current = 0;
            void loadSnapshot();
          }
        }
      });
    snapshotRequestRef.current = request;
    return request;
  }, [applySnapshot, currentUserId, target, targetId]);

  const markReadThrough = useCallback(
    (
      message: IGameChatMessage | undefined,
      delivery: 'immediate' | 'trailing' = 'trailing',
    ): void => {
      if (!message || !targetId || !currentUserId) return;
      if (message.sequence <= optimisticReadThroughRef.current) {
        if (delivery === 'immediate') flushReadReceipt();
        return;
      }
      optimisticReadThroughRef.current = message.sequence;
      pendingReadRef.current = {
        messageId: message.id,
        sequence: message.sequence,
      };
      setUnreadCount(0);
      if (delivery === 'immediate') {
        flushReadReceipt();
        return;
      }
      clearReadTimer();
      readTimerRef.current = setTimeout(
        flushReadReceipt,
        READ_RECEIPT_DELAY_MS,
      );
    },
    [clearReadTimer, currentUserId, flushReadReceipt, targetId],
  );

  const setOpen = useCallback(
    (nextOpen: boolean): void => {
      openRef.current = nextOpen;
      setOpenState(nextOpen);
      if (nextOpen) {
        setUnreadCount(0);
        markReadThrough(messagesRef.current.at(-1), 'immediate');
      } else {
        flushReadReceipt();
        applyUnreadCount(messagesRef.current, readStateRef.current);
      }
    },
    [applyUnreadCount, flushReadReceipt, markReadThrough],
  );

  const sendPending = useCallback(
    (intent: IPendingSend): void => {
      if (
        pendingSendRef.current !== intent ||
        !targetId ||
        !currentUserId ||
        !targetCanSend
      ) {
        return;
      }
      const lifecycle = lifecycleRef.current;
      void platformApi[target === 'session' ? 'sendChat' : 'sendRoomChat'](
        targetId,
        intent.requestId,
        intent.body,
      )
        .then((message) => {
          if (
            lifecycle !== lifecycleRef.current ||
            pendingSendRef.current !== intent
          ) {
            return;
          }
          pendingSendRef.current = null;
          const nextMessages = mergeChatMessages(messagesRef.current, [
            message,
          ]);
          messagesRef.current = nextMessages;
          setMessages(nextMessages);
          applyUnreadCount(nextMessages, readStateRef.current);
          void loadSnapshot();
        })
        .catch((error: unknown) => {
          if (
            lifecycle !== lifecycleRef.current ||
            pendingSendRef.current !== intent
          ) {
            return;
          }
          const status = readErrorStatus(error);
          const retryableStatus =
            status === undefined ||
            status >= 500 ||
            status === 408 ||
            status === 429;
          if (!retryableStatus) {
            pendingSendRef.current = null;
            return;
          }
          clearSendRetryTimer();
          const nextIntent: IPendingSend = {
            ...intent,
            attempt: intent.attempt + 1,
          };
          pendingSendRef.current = nextIntent;
          const delay = Math.min(
            SEND_RETRY_BASE_MS * 2 ** intent.attempt,
            SEND_RETRY_MAX_MS,
          );
          sendRetryTimerRef.current = setTimeout(() => {
            sendRetryTimerRef.current = null;
            sendPending(nextIntent);
          }, delay);
        });
    },
    [
      applyUnreadCount,
      clearSendRetryTimer,
      currentUserId,
      loadSnapshot,
      target,
      targetCanSend,
      targetId,
    ],
  );

  const sendMessage = useCallback(
    (body: string): void => {
      const trimmed = body.trim();
      if (!targetId || !currentUserId || !targetCanSend || !trimmed) return;
      if (pendingSendRef.current) return;
      const intent: IPendingSend = {
        requestId: createPlatformRequestId(),
        body: trimmed,
        attempt: 0,
      };
      pendingSendRef.current = intent;
      sendPending(intent);
    },
    [currentUserId, sendPending, targetCanSend, targetId],
  );

  useEffect(() => {
    lifecycleRef.current += 1;
    messagesRef.current = [];
    readStateRef.current = EMPTY_READ_STATE;
    optimisticReadThroughRef.current = 0;
    pendingReadRef.current = null;
    pendingSendRef.current = null;
    pendingHintSequenceRef.current = 0;
    appliedHintSequenceRef.current = 0;
    snapshotRequestRef.current = null;
    clearReadTimer();
    clearSendRetryTimer();
    openRef.current = false;
    setMessages([]);
    setOpenState(false);
    setUnreadCount(0);
  }, [clearReadTimer, clearSendRetryTimer, identityKey, target, targetId]);

  useEffect(() => {
    if (targetCanSend) return;
    pendingSendRef.current = null;
    clearSendRetryTimer();
  }, [clearSendRetryTimer, targetCanSend]);

  useEffect(() => {
    if (!targetId || (target === 'session' && !currentUserId)) {
      return undefined;
    }
    void loadSnapshot();
    const onHint = ({ sequence }: { sequence: number }): void => {
      pendingHintSequenceRef.current = Math.max(
        pendingHintSequenceRef.current,
        sequence,
      );
      void loadSnapshot();
    };
    const stop =
      target === 'session'
        ? platformSocket.onPlatformChatChanged(targetId, onHint)
        : platformSocket.onPlatformRoomChatChanged(targetId, onHint);
    const refresh = (): void => {
      if (
        typeof document === 'undefined' ||
        document.visibilityState === 'visible'
      ) {
        void loadSnapshot();
      }
    };
    const poll =
      typeof window === 'undefined'
        ? null
        : window.setInterval(refresh, CHAT_FALLBACK_POLL_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', refresh);
    }
    return () => {
      stop();
      if (poll !== null) window.clearInterval(poll);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', refresh);
      }
      flushReadReceipt();
      clearSendRetryTimer();
      lifecycleRef.current += 1;
    };
  }, [
    clearSendRetryTimer,
    currentUserId,
    flushReadReceipt,
    loadSnapshot,
    target,
    targetId,
  ]);

  useEffect(
    () => () => {
      lifecycleRef.current += 1;
      clearReadTimer();
      clearSendRetryTimer();
    },
    [clearReadTimer, clearSendRetryTimer],
  );

  return useMemo(
    () => ({
      messages,
      open,
      unreadCount,
      setOpen,
      sendMessage,
      canSend: targetCanSend,
    }),
    [messages, open, sendMessage, setOpen, targetCanSend, unreadCount],
  );
}

export function usePlatformGameChat(
  sessionId: string | null,
): IUseGameChatResult {
  const { features } = usePlatformConfiguration();
  return usePlatformChat(features.chat ? sessionId : null, 'session');
}

function mergeChatMessages(
  current: IGameChatMessage[],
  incoming: IGameChatMessage[],
): IGameChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort(
    (left, right) => left.sequence - right.sequence,
  );
}

function readErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status)
    ? status
    : undefined;
}
