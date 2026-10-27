import type {
  IBrowserNotificationPayload,
  TPlatformNotificationEvent,
} from '@board-platform/contracts';
import { io, type Socket } from 'socket.io-client';
import { CLIENT_ENV } from '../config/env.js';
import { emitSessionEnd } from './sessionEnd.js';

export interface IPlatformChangedPayload {
  readonly sessionId: string;
  readonly revision: number;
}

export interface IPlatformChatChangedPayload {
  readonly sessionId: string;
  readonly sequence: number;
}

export interface IPlatformRoomChatChangedPayload {
  readonly roomId: string;
  readonly sequence: number;
}

export interface IPlatformSubscriptionError {
  readonly code: string;
  readonly messageKey: string;
  readonly retryable: boolean;
}

export type TPlatformSubscriptionAck =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: IPlatformSubscriptionError };

export type TPlatformChangedHandler = (
  payload: IPlatformChangedPayload,
) => void;

export type TPlatformChatChangedHandler = (
  payload: IPlatformChatChangedPayload,
) => void;

export type TPlatformRoomChatChangedHandler = (
  payload: IPlatformRoomChatChangedPayload,
) => void;

export type TPlatformNotificationHandler = (
  payload: TPlatformNotificationEvent,
) => void;

export type TPlatformBrowserNotificationHandler = (
  payload: IBrowserNotificationPayload,
  acknowledge: (shown: boolean) => void,
) => void;

type TUntypedSocketListener = (...args: unknown[]) => void;

interface IUntypedSocket {
  on: (event: string, handler: TUntypedSocketListener) => void;
  off: (event: string, handler: TUntypedSocketListener) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

interface IManagerSocket {
  on: (event: string, handler: TUntypedSocketListener) => void;
  off: (event: string, handler: TUntypedSocketListener) => void;
}

function isPlatformChangedPayload(
  payload: unknown,
): payload is IPlatformChangedPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as {
    sessionId?: unknown;
    revision?: unknown;
  };
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0
  );
}

function isPlatformChatChangedPayload(
  payload: unknown,
): payload is IPlatformChatChangedPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as {
    sessionId?: unknown;
    sequence?: unknown;
  };
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim().length > 0 &&
    typeof candidate.sequence === 'number' &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence >= 0
  );
}

function isPlatformRoomChatChangedPayload(
  payload: unknown,
): payload is IPlatformRoomChatChangedPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as {
    roomId?: unknown;
    sequence?: unknown;
  };
  return (
    typeof candidate.roomId === 'string' &&
    candidate.roomId.trim().length > 0 &&
    typeof candidate.sequence === 'number' &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence >= 0
  );
}

function isPlatformNotificationPayload(
  payload: unknown,
): payload is TPlatformNotificationEvent {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as {
    kind?: unknown;
    message?: unknown;
    notification?: unknown;
  };
  if (candidate.kind === 'message')
    return typeof candidate.message === 'object' && candidate.message !== null;
  if (candidate.kind === 'shell') return true;
  if (candidate.kind === 'game')
    return (
      typeof (candidate as { gameId?: unknown }).gameId === 'string' &&
      typeof (candidate as { type?: unknown }).type === 'string' &&
      'payload' in candidate
    );
  if (candidate.kind !== 'browser') return false;
  if (
    typeof candidate.notification !== 'object' ||
    candidate.notification === null
  )
    return false;
  const notification = candidate.notification as {
    title?: unknown;
    body?: unknown;
    url?: unknown;
    tag?: unknown;
  };
  return (
    typeof notification.title === 'string' &&
    typeof notification.body === 'string' &&
    (notification.url === undefined || typeof notification.url === 'string') &&
    (notification.tag === undefined || typeof notification.tag === 'string')
  );
}

function isBrowserNotificationPayload(
  payload: unknown,
): payload is IBrowserNotificationPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as {
    title?: unknown;
    body?: unknown;
    url?: unknown;
    tag?: unknown;
  };
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.body === 'string' &&
    (candidate.url === undefined || typeof candidate.url === 'string') &&
    (candidate.tag === undefined || typeof candidate.tag === 'string')
  );
}

function normalizePlatformSubscriptionAck(
  payload: unknown,
): TPlatformSubscriptionAck {
  if (typeof payload !== 'object' || payload === null) {
    return invalidSubscriptionAck();
  }
  const candidate = payload as {
    ok?: unknown;
    error?: {
      code?: unknown;
      messageKey?: unknown;
      retryable?: unknown;
    };
  };
  if (candidate.ok === true) return { ok: true };
  if (
    candidate.ok === false &&
    typeof candidate.error?.code === 'string' &&
    typeof candidate.error.messageKey === 'string' &&
    typeof candidate.error.retryable === 'boolean'
  ) {
    return {
      ok: false,
      error: {
        code: candidate.error.code,
        messageKey: candidate.error.messageKey,
        retryable: candidate.error.retryable,
      },
    };
  }
  return invalidSubscriptionAck();
}

function invalidSubscriptionAck(): TPlatformSubscriptionAck {
  return {
    ok: false,
    error: {
      code: 'INVALID_ACK',
      messageKey: 'platform.client.invalidSubscriptionAck',
      retryable: false,
    },
  };
}

export function platformNamespaceUrl(baseUrl: string): string {
  return new URL('/platform', baseUrl).toString();
}

/**
 * Owns the platform event surface on its independent Socket.IO namespace.
 * Subscription handlers survive a socket replacement and are re-admitted after
 * `connect`.
 */
export class PlatformSocket {
  private socket: Socket | null = null;
  private authToken: string | null = null;
  private authEpoch = 0;
  private readonly sessionHandlers = new Map<
    string,
    Set<TPlatformChangedHandler>
  >();
  private readonly chatSessionHandlers = new Map<
    string,
    Set<TPlatformChatChangedHandler>
  >();
  private readonly roomChatHandlers = new Map<
    string,
    Set<TPlatformRoomChatChangedHandler>
  >();
  private readonly notificationHandlers =
    new Set<TPlatformNotificationHandler>();
  private readonly browserNotificationHandlers =
    new Set<TPlatformBrowserNotificationHandler>();
  private readonly connectedHandlers = new Set<() => void>();
  private readonly socketSessionHandlers = new WeakMap<
    Socket,
    Map<string, TUntypedSocketListener>
  >();
  private readonly socketChatSessionHandlers = new WeakMap<
    Socket,
    Map<string, TUntypedSocketListener>
  >();
  private readonly socketRoomChatHandlers = new WeakMap<
    Socket,
    Map<string, TUntypedSocketListener>
  >();
  private readonly socketNotificationHandlers = new WeakMap<
    Socket,
    TUntypedSocketListener
  >();
  private readonly socketBrowserNotificationHandlers = new WeakMap<
    Socket,
    TUntypedSocketListener
  >();
  private readonly socketConnectHandlers = new WeakMap<
    Socket,
    TUntypedSocketListener
  >();
  private readonly socketDisconnectHandlers = new WeakMap<
    Socket,
    TUntypedSocketListener
  >();
  private readonly socketErrorHandlers = new WeakMap<
    Socket,
    TUntypedSocketListener
  >();
  private reconnectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectRetryAttempts = 0;

  get instance(): Socket | null {
    return this.socket;
  }

  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Connect the platform namespace, retaining logical platform handlers. */
  connect(token: string, authEpoch = this.authEpoch): Socket {
    if (this.socket && this.authToken === token) {
      const socket = this.socket;
      this.authEpoch = authEpoch;
      this.authToken = token;
      this.unbindSocketHandlers(socket);
      this.bindSocketHandlers(socket);
      return socket;
    }
    if (this.socket) this.disconnect();

    const socket = io(platformNamespaceUrl(CLIENT_ENV.VITE_WS_URL), {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    this.socket = socket;
    this.authEpoch = authEpoch;
    this.authToken = token;
    this.bindSocketHandlers(socket);
    return socket;
  }

  /** Update credentials without duplicating the platform socket. */
  updateToken(token: string | null, authEpoch = this.authEpoch): Socket | null {
    if (!token) {
      this.disconnect();
      this.authEpoch = Math.max(this.authEpoch, authEpoch);
      return null;
    }
    return this.connect(token, authEpoch);
  }

  private bindSocketHandlers(socket: Socket): void {
    const authEpoch = this.authEpoch;
    const connect = (() => {
      if (this.socket !== socket) return;
      this.clearReconnectRetry();
      for (const handler of this.connectedHandlers) handler();
      void this.resubscribe(socket);
    }) as TUntypedSocketListener;
    this.socketConnectHandlers.set(socket, connect);
    this.toUntypedSocket(socket).on('connect', connect);
    const disconnect = ((reason: unknown) => {
      if (
        reason !== 'io server disconnect' ||
        this.authEpoch !== authEpoch ||
        this.socket !== socket
      )
        return;
      const hadSession = this.authToken !== null;
      this.disconnect();
      if (hadSession) emitSessionEnd({ reason: 'server-disconnect' });
    }) as TUntypedSocketListener;
    this.socketDisconnectHandlers.set(socket, disconnect);
    this.toUntypedSocket(socket).on('disconnect', disconnect);
    for (const sessionId of this.platformSessionIds()) {
      this.bindPlatformSessionHandler(socket, sessionId);
    }
    for (const sessionId of this.platformChatSessionIds()) {
      this.bindPlatformChatSessionHandler(socket, sessionId);
    }
    for (const roomId of this.platformRoomChatIds()) {
      this.bindPlatformRoomChatHandler(socket, roomId);
    }
    this.bindPlatformNotificationHandler(socket);
    this.bindPlatformBrowserNotificationHandler(socket);
    this.bindReconnectHandlers(socket);
    if (socket.connected) {
      this.clearReconnectRetry();
      void this.resubscribe(socket);
    }
  }

  disconnect(): void {
    const socket = this.socket;
    if (socket) {
      this.unbindSocketHandlers(socket);
      this.socket = null;
      socket.disconnect();
    }
    this.authToken = null;
    this.authEpoch += 1;
    this.clearReconnectRetry();
  }

  onPlatformChanged(
    sessionId: string,
    handler: TPlatformChangedHandler,
  ): () => void {
    const normalizedSessionId = this.requireId(sessionId, 'SessionId');
    const wasEmpty = !this.hasPlatformHandlers(normalizedSessionId);
    const handlers =
      this.sessionHandlers.get(normalizedSessionId) ??
      new Set<TPlatformChangedHandler>();
    handlers.add(handler);
    this.sessionHandlers.set(normalizedSessionId, handlers);
    const socket = this.socket;
    if (socket) {
      this.bindPlatformSessionHandler(socket, normalizedSessionId);
      if (wasEmpty && socket.connected)
        void this.sendPlatformSubscribe(socket, normalizedSessionId);
    }
    return () => {
      const current = this.sessionHandlers.get(normalizedSessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size > 0) return;
      this.sessionHandlers.delete(normalizedSessionId);
      const currentSocket = this.socket;
      if (!currentSocket) return;
      this.unbindPlatformSessionHandler(currentSocket, normalizedSessionId);
      if (
        !this.hasPlatformHandlers(normalizedSessionId) &&
        currentSocket.connected
      ) {
        currentSocket.emit('platform:unsubscribe', {
          sessionId: normalizedSessionId,
        });
      }
    };
  }

  onPlatformChatChanged(
    sessionId: string,
    handler: TPlatformChatChangedHandler,
  ): () => void {
    const normalizedSessionId = this.requireId(sessionId, 'SessionId');
    const wasEmpty = !this.hasPlatformHandlers(normalizedSessionId);
    const handlers =
      this.chatSessionHandlers.get(normalizedSessionId) ??
      new Set<TPlatformChatChangedHandler>();
    handlers.add(handler);
    this.chatSessionHandlers.set(normalizedSessionId, handlers);
    const socket = this.socket;
    if (socket) {
      this.bindPlatformChatSessionHandler(socket, normalizedSessionId);
      if (wasEmpty && socket.connected)
        void this.sendPlatformSubscribe(socket, normalizedSessionId);
    }
    return () => {
      const current = this.chatSessionHandlers.get(normalizedSessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size > 0) return;
      this.chatSessionHandlers.delete(normalizedSessionId);
      const currentSocket = this.socket;
      if (!currentSocket) return;
      this.unbindPlatformChatSessionHandler(currentSocket, normalizedSessionId);
      if (
        !this.hasPlatformHandlers(normalizedSessionId) &&
        currentSocket.connected
      ) {
        currentSocket.emit('platform:unsubscribe', {
          sessionId: normalizedSessionId,
        });
      }
    };
  }

  onPlatformRoomChatChanged(
    roomId: string,
    handler: TPlatformRoomChatChangedHandler,
  ): () => void {
    const normalizedRoomId = this.requireId(roomId, 'RoomId');
    const handlers =
      this.roomChatHandlers.get(normalizedRoomId) ??
      new Set<TPlatformRoomChatChangedHandler>();
    const wasEmpty = handlers.size === 0;
    handlers.add(handler);
    this.roomChatHandlers.set(normalizedRoomId, handlers);
    const socket = this.socket;
    if (socket) {
      this.bindPlatformRoomChatHandler(socket, normalizedRoomId);
      if (wasEmpty && socket.connected)
        void this.sendPlatformRoomSubscribe(socket, normalizedRoomId);
    }
    return () => {
      const current = this.roomChatHandlers.get(normalizedRoomId);
      if (!current) return;
      current.delete(handler);
      if (current.size > 0) return;
      this.roomChatHandlers.delete(normalizedRoomId);
      const currentSocket = this.socket;
      if (!currentSocket) return;
      this.unbindPlatformRoomChatHandler(currentSocket, normalizedRoomId);
      if (currentSocket.connected) {
        currentSocket.emit('platform:room-unsubscribe', {
          roomId: normalizedRoomId,
        });
      }
    };
  }

  onPlatformNotification(handler: TPlatformNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    if (this.socket) this.bindPlatformNotificationHandler(this.socket);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onPlatformBrowserNotification(
    handler: TPlatformBrowserNotificationHandler,
  ): () => void {
    this.browserNotificationHandlers.add(handler);
    if (this.socket) this.bindPlatformBrowserNotificationHandler(this.socket);
    return () => {
      this.browserNotificationHandlers.delete(handler);
    };
  }

  onConnected(handler: () => void): () => void {
    this.connectedHandlers.add(handler);
    return () => {
      this.connectedHandlers.delete(handler);
    };
  }

  setPlatformNotificationsReady(enabled: boolean): void {
    if (!this.socket?.connected) return;
    this.socket.emit('platform:notification-ready', { enabled });
  }

  subscribePlatform(sessionId: string): Promise<TPlatformSubscriptionAck> {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          messageKey: 'platform.client.invalidSessionId',
          retryable: false,
        },
      });
    }
    const socket = this.socket;
    if (!socket || !socket.connected) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'NOT_CONNECTED',
          messageKey: 'platform.client.socketNotConnected',
          retryable: true,
        },
      });
    }
    return this.sendPlatformSubscribe(socket, normalizedSessionId);
  }

  unsubscribePlatform(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) return;
    this.socket?.emit('platform:unsubscribe', {
      sessionId: normalizedSessionId,
    });
  }

  setPlatformForeground(sessionId: string, active: boolean): void {
    const normalizedSessionId = sessionId.trim();
    if (
      normalizedSessionId.length === 0 ||
      !this.socket?.connected ||
      !this.hasPlatformHandlers(normalizedSessionId)
    )
      return;
    this.socket.emit('platform:foreground', {
      sessionId: normalizedSessionId,
      active,
    });
  }

  private requireId(value: string, label: string): string {
    const normalized = value.trim();
    if (normalized.length === 0) {
      throw new Error(`platform.client.invalid${label}`);
    }
    return normalized;
  }

  private hasPlatformHandlers(sessionId: string): boolean {
    return (
      (this.sessionHandlers.get(sessionId)?.size ?? 0) > 0 ||
      (this.chatSessionHandlers.get(sessionId)?.size ?? 0) > 0
    );
  }

  private platformSessionIds(): Set<string> {
    return new Set([
      ...this.sessionHandlers.keys(),
      ...this.chatSessionHandlers.keys(),
    ]);
  }

  private platformChatSessionIds(): Set<string> {
    return new Set(this.chatSessionHandlers.keys());
  }

  private platformRoomChatIds(): Set<string> {
    return new Set(this.roomChatHandlers.keys());
  }

  private async resubscribe(socket: Socket): Promise<void> {
    for (const sessionId of this.platformSessionIds()) {
      await this.sendPlatformSubscribe(socket, sessionId);
    }
    for (const roomId of this.platformRoomChatIds()) {
      await this.sendPlatformRoomSubscribe(socket, roomId);
    }
  }

  private sendPlatformSubscribe(
    socket: Socket,
    sessionId: string,
  ): Promise<TPlatformSubscriptionAck> {
    const authEpoch = this.authEpoch;
    return new Promise((resolve) => {
      this.toUntypedSocket(socket).emit(
        'platform:subscribe',
        { sessionId },
        (ack: unknown) =>
          resolve(
            this.authEpoch !== authEpoch || this.socket !== socket
              ? staleSubscriptionAck()
              : normalizePlatformSubscriptionAck(ack),
          ),
      );
    });
  }

  private sendPlatformRoomSubscribe(
    socket: Socket,
    roomId: string,
  ): Promise<TPlatformSubscriptionAck> {
    const authEpoch = this.authEpoch;
    return new Promise((resolve) => {
      this.toUntypedSocket(socket).emit(
        'platform:room-subscribe',
        { roomId },
        (ack: unknown) =>
          resolve(
            this.authEpoch !== authEpoch || this.socket !== socket
              ? staleSubscriptionAck()
              : normalizePlatformSubscriptionAck(ack),
          ),
      );
    });
  }

  private bindPlatformSessionHandler(socket: Socket, sessionId: string): void {
    const handlers = this.socketSessionHandlers.get(socket) ?? new Map();
    if (handlers.has(sessionId)) return;
    const authEpoch = this.authEpoch;
    const listener = ((payload: unknown) => {
      if (
        this.authEpoch !== authEpoch ||
        this.socket !== socket ||
        !isPlatformChangedPayload(payload) ||
        payload.sessionId !== sessionId
      )
        return;
      for (const handler of this.sessionHandlers.get(sessionId) ?? []) {
        handler({
          sessionId: payload.sessionId,
          revision: payload.revision,
        });
      }
    }) as TUntypedSocketListener;
    handlers.set(sessionId, listener);
    this.socketSessionHandlers.set(socket, handlers);
    this.toUntypedSocket(socket).on('platform:changed', listener);
  }

  private unbindPlatformSessionHandler(
    socket: Socket,
    sessionId: string,
  ): void {
    const handlers = this.socketSessionHandlers.get(socket);
    const listener = handlers?.get(sessionId);
    if (!listener) return;
    this.toUntypedSocket(socket).off('platform:changed', listener);
    handlers?.delete(sessionId);
    if (handlers?.size === 0) this.socketSessionHandlers.delete(socket);
  }

  private bindPlatformChatSessionHandler(
    socket: Socket,
    sessionId: string,
  ): void {
    const handlers =
      this.socketChatSessionHandlers.get(socket) ??
      new Map<string, TUntypedSocketListener>();
    if (handlers.has(sessionId)) return;
    const authEpoch = this.authEpoch;
    const listener = ((payload: unknown) => {
      if (
        this.authEpoch !== authEpoch ||
        this.socket !== socket ||
        !isPlatformChatChangedPayload(payload) ||
        payload.sessionId !== sessionId
      )
        return;
      for (const handler of this.chatSessionHandlers.get(sessionId) ?? []) {
        handler({
          sessionId: payload.sessionId,
          sequence: payload.sequence,
        });
      }
    }) as TUntypedSocketListener;
    handlers.set(sessionId, listener);
    this.socketChatSessionHandlers.set(socket, handlers);
    this.toUntypedSocket(socket).on('platform:chat-changed', listener);
  }

  private unbindPlatformChatSessionHandler(
    socket: Socket,
    sessionId: string,
  ): void {
    const handlers = this.socketChatSessionHandlers.get(socket);
    const listener = handlers?.get(sessionId);
    if (!listener) return;
    this.toUntypedSocket(socket).off('platform:chat-changed', listener);
    handlers?.delete(sessionId);
    if (handlers?.size === 0) this.socketChatSessionHandlers.delete(socket);
  }

  private bindPlatformRoomChatHandler(socket: Socket, roomId: string): void {
    const handlers =
      this.socketRoomChatHandlers.get(socket) ??
      new Map<string, TUntypedSocketListener>();
    if (handlers.has(roomId)) return;
    const authEpoch = this.authEpoch;
    const listener = ((payload: unknown) => {
      if (
        this.authEpoch !== authEpoch ||
        this.socket !== socket ||
        !isPlatformRoomChatChangedPayload(payload) ||
        payload.roomId !== roomId
      )
        return;
      for (const handler of this.roomChatHandlers.get(roomId) ?? []) {
        handler({ roomId: payload.roomId, sequence: payload.sequence });
      }
    }) as TUntypedSocketListener;
    handlers.set(roomId, listener);
    this.socketRoomChatHandlers.set(socket, handlers);
    this.toUntypedSocket(socket).on('platform:room-chat-changed', listener);
  }

  private unbindPlatformRoomChatHandler(socket: Socket, roomId: string): void {
    const handlers = this.socketRoomChatHandlers.get(socket);
    const listener = handlers?.get(roomId);
    if (!listener) return;
    this.toUntypedSocket(socket).off('platform:room-chat-changed', listener);
    handlers?.delete(roomId);
    if (handlers?.size === 0) this.socketRoomChatHandlers.delete(socket);
  }

  private bindPlatformNotificationHandler(socket: Socket): void {
    if (this.socketNotificationHandlers.has(socket)) return;
    const authEpoch = this.authEpoch;
    const listener = ((payload: unknown) => {
      if (
        this.authEpoch !== authEpoch ||
        this.socket !== socket ||
        !isPlatformNotificationPayload(payload)
      )
        return;
      for (const handler of this.notificationHandlers) handler(payload);
    }) as TUntypedSocketListener;
    this.socketNotificationHandlers.set(socket, listener);
    this.toUntypedSocket(socket).on('platform:notification', listener);
  }

  private bindPlatformBrowserNotificationHandler(socket: Socket): void {
    if (this.socketBrowserNotificationHandlers.has(socket)) return;
    const authEpoch = this.authEpoch;
    const listener = ((payload: unknown, acknowledge: unknown) => {
      if (
        this.authEpoch !== authEpoch ||
        this.socket !== socket ||
        !isBrowserNotificationPayload(payload)
      )
        return;
      const ack =
        typeof acknowledge === 'function'
          ? (value: boolean) => (acknowledge as (value: boolean) => void)(value)
          : () => undefined;
      for (const handler of this.browserNotificationHandlers)
        handler(payload, ack);
    }) as TUntypedSocketListener;
    this.socketBrowserNotificationHandlers.set(socket, listener);
    this.toUntypedSocket(socket).on('platform:notification:show', listener);
  }

  private unbindPlatformNotificationHandler(socket: Socket): void {
    const listener = this.socketNotificationHandlers.get(socket);
    if (!listener) return;
    this.toUntypedSocket(socket).off('platform:notification', listener);
    this.socketNotificationHandlers.delete(socket);
  }

  private unbindPlatformBrowserNotificationHandler(socket: Socket): void {
    const listener = this.socketBrowserNotificationHandlers.get(socket);
    if (!listener) return;
    this.toUntypedSocket(socket).off('platform:notification:show', listener);
    this.socketBrowserNotificationHandlers.delete(socket);
  }

  private unbindSocketHandlers(socket: Socket): void {
    const connect = this.socketConnectHandlers.get(socket);
    if (connect) {
      this.toUntypedSocket(socket).off('connect', connect);
      this.socketConnectHandlers.delete(socket);
    }
    const disconnect = this.socketDisconnectHandlers.get(socket);
    if (disconnect) {
      this.toUntypedSocket(socket).off('disconnect', disconnect);
      this.socketDisconnectHandlers.delete(socket);
    }
    for (const sessionId of this.socketSessionHandlers.get(socket)?.keys() ??
      []) {
      this.unbindPlatformSessionHandler(socket, sessionId);
    }
    for (const sessionId of this.socketChatSessionHandlers
      .get(socket)
      ?.keys() ?? []) {
      this.unbindPlatformChatSessionHandler(socket, sessionId);
    }
    for (const roomId of this.socketRoomChatHandlers.get(socket)?.keys() ??
      []) {
      this.unbindPlatformRoomChatHandler(socket, roomId);
    }
    this.unbindPlatformNotificationHandler(socket);
    this.unbindPlatformBrowserNotificationHandler(socket);
    this.unbindReconnectHandlers(socket);
  }

  private bindReconnectHandlers(socket: Socket): void {
    const untyped = this.toUntypedSocket(socket);
    const onConnectError = (() => {
      this.scheduleReconnectRetry(socket);
    }) as TUntypedSocketListener;
    untyped.on('connect_error', onConnectError);
    const manager = this.managerSocket(socket);
    manager?.on('reconnect_failed', onConnectError);
    this.socketErrorHandlers.set(socket, onConnectError);
  }

  private unbindReconnectHandlers(socket: Socket): void {
    const handler = this.socketErrorHandlers.get(socket);
    if (!handler) return;
    this.toUntypedSocket(socket).off('connect_error', handler);
    this.managerSocket(socket)?.off('reconnect_failed', handler);
    this.socketErrorHandlers.delete(socket);
  }

  private scheduleReconnectRetry(socket: Socket): void {
    if (this.reconnectRetryTimer || this.socket !== socket) return;
    const delayMs = Math.min(2_000 * 2 ** this.reconnectRetryAttempts, 30_000);
    this.reconnectRetryAttempts += 1;
    this.reconnectRetryTimer = setTimeout(() => {
      this.reconnectRetryTimer = null;
      if (this.socket !== socket || socket.connected) return;
      socket.connect();
      this.scheduleReconnectRetry(socket);
    }, delayMs);
  }

  private clearReconnectRetry(): void {
    if (this.reconnectRetryTimer) {
      clearTimeout(this.reconnectRetryTimer);
      this.reconnectRetryTimer = null;
    }
    this.reconnectRetryAttempts = 0;
  }

  private toUntypedSocket(socket: Socket): IUntypedSocket {
    return socket as unknown as IUntypedSocket;
  }

  private managerSocket(socket: Socket): IManagerSocket | null {
    return (socket as unknown as { io?: IManagerSocket }).io ?? null;
  }
}

function staleSubscriptionAck(): TPlatformSubscriptionAck {
  return {
    ok: false,
    error: {
      code: 'STALE_SESSION',
      messageKey: 'platform.client.staleSession',
      retryable: true,
    },
  };
}

export const platformSocket = new PlatformSocket();
