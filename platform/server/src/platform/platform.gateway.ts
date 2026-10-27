import { contractError, toErrorEnvelope } from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type {
  IBrowserNotificationPayload,
  TPlatformNotificationEvent,
} from '@board-platform/contracts';
import { Inject, type OnModuleDestroy, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Socket } from 'socket.io';
import {
  type IPrincipal,
  PrincipalResolver,
} from '@/auth/PrincipalResolver.js';
import { MailForegroundPresenceService } from '@/mail/mail-foreground-presence.service.js';
import { platformNotificationTarget } from '@/notifications/notification-target.js';
import { PushService } from '@/notifications/push.service.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';

interface Subscription {
  socket: Socket;
  reference: PlatformIdentityReference;
  targetId: string;
  targetKind: 'session' | 'room';
  expiresAt: number;
  revision: number;
  pendingRevision: number;
  chatSequence: number;
  pendingChatSequence: number;
  pending?: Promise<void>;
}

interface SocketAuthentication {
  token: string;
  principal: IPrincipal;
  pending?: Promise<IPrincipal | null>;
}

function targetId(
  input: unknown,
  key: 'sessionId' | 'roomId' = 'sessionId',
): string {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !(key in input)
  )
    throw contractError('INVALID_REQUEST', 'platform.request.identifier');
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > 256)
    throw contractError('INVALID_REQUEST', 'platform.request.identifier');
  return value;
}

/** Uses a platform-only namespace; it never sends or owns game state. */
@WebSocketGateway({ cors: { origin: '*' }, namespace: '/platform' })
export class PlatformGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly principal: PrincipalResolver;
  private readonly foreground: MailForegroundPresenceService;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly userSockets = new Map<string, Set<Socket>>();
  private readonly socketUsers = new WeakMap<Socket, string>();
  private readonly socketAuthentications = new WeakMap<
    Socket,
    SocketAuthentication
  >();
  private readonly pendingConnections = new WeakMap<
    Socket,
    Promise<IPrincipal | null>
  >();
  private readonly connectionGenerations = new WeakMap<Socket, number>();
  private readonly notificationReadyGenerations = new WeakMap<Socket, number>();
  private readonly notificationReadySockets = new Set<Socket>();
  private readonly generations = new WeakMap<Socket, number>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeAccountChanged: () => void;
  private readonly unsubscribeChat: () => void;
  private readonly unsubscribeRoomChat: () => void;
  private readonly removeOnlineDelivery?: () => void;

  constructor(
    @Inject(PlatformApplicationRuntime)
    private readonly runtime: PlatformApplicationRuntime,
    @Inject(JwtService) jwt: JwtService,
    @Inject(DRIZZLE_DB) db: NodePgDatabase,
    @Optional() @Inject(PushService) push?: PushService,
  ) {
    this.principal = new PrincipalResolver(jwt, db);
    this.foreground = new MailForegroundPresenceService(db);
    this.unsubscribe = runtime.onSessionChanged((id, revision) => {
      void this.publish(id, revision);
    });
    this.unsubscribeAccountChanged = runtime.onAccountChanged(
      (principalIds) => {
        for (const principalId of principalIds)
          this.notifyShellChanged(principalId);
      },
    );
    this.unsubscribeChat = runtime.chat.subscribe(({ sessionId, message }) => {
      void this.publishChat(sessionId, message.sequence);
    });
    this.unsubscribeRoomChat = runtime.roomChat.subscribe(
      ({ roomId, message }) => {
        void this.publishRoomChat(roomId, message.sequence);
      },
    );
    this.removeOnlineDelivery = push?.addOnlineDelivery((userId, payload) =>
      this.deliverOnlineNotification(userId, payload),
    );
  }

  async handleConnection(socket: Socket): Promise<void> {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > 16_384) {
      socket.disconnect(true);
      return;
    }
    const generation = (this.connectionGenerations.get(socket) ?? 0) + 1;
    this.connectionGenerations.set(socket, generation);
    const pending = this.authenticateConnection(socket, token, generation);
    this.pendingConnections.set(socket, pending);
    try {
      await pending;
    } finally {
      if (this.pendingConnections.get(socket) === pending)
        this.pendingConnections.delete(socket);
    }
  }

  private async authenticateConnection(
    socket: Socket,
    token: string,
    generation: number,
  ): Promise<IPrincipal | null> {
    try {
      const principal = await this.principal.resolveToken(token);
      if (
        !socket.connected ||
        this.connectionGenerations.get(socket) !== generation
      )
        return null;
      this.socketAuthentications.set(socket, { token, principal });
      this.socketUsers.set(socket, principal.sub);
      const sockets = this.userSockets.get(principal.sub) ?? new Set<Socket>();
      sockets.add(socket);
      this.userSockets.set(principal.sub, sockets);
      this.notifyShellChanged(principal.sub);
      return principal;
    } catch {
      if (
        socket.connected &&
        this.connectionGenerations.get(socket) === generation
      )
        this.dropSocket(socket, true);
      return null;
    }
  }

  @SubscribeMessage('platform:notification-ready')
  async notificationReady(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    const enabled =
      typeof input === 'object' &&
      input !== null &&
      !Array.isArray(input) &&
      Object.keys(input).every((key) => key === 'enabled') &&
      (input as { enabled?: unknown }).enabled === true;
    const generation = (this.notificationReadyGenerations.get(socket) ?? 0) + 1;
    this.notificationReadyGenerations.set(socket, generation);
    if (enabled) {
      const connectedPrincipal = await this.awaitConnection(socket);
      const principal = connectedPrincipal
        ? await this.authorizeSocket(socket)
        : null;
      if (this.notificationReadyGenerations.get(socket) !== generation)
        return { ok: true as const };
      if (
        principal &&
        socket.connected &&
        this.socketUsers.get(socket) === principal.sub
      )
        this.notificationReadySockets.add(socket);
      else this.notificationReadySockets.delete(socket);
    } else this.notificationReadySockets.delete(socket);
    return { ok: true as const };
  }

  private awaitConnection(socket: Socket): Promise<IPrincipal | null> {
    const pending = this.pendingConnections.get(socket);
    if (pending) return pending;
    return Promise.resolve(
      this.socketAuthentications.get(socket)?.principal ?? null,
    );
  }

  @SubscribeMessage('platform:subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    return this.subscribeTo(socket, input, 'session');
  }

  @SubscribeMessage('platform:room-subscribe')
  subscribeRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    return this.subscribeTo(socket, input, 'room');
  }

  private async subscribeTo(
    socket: Socket,
    input: unknown,
    kind: 'session' | 'room',
  ) {
    const generation = this.invalidate(socket);
    try {
      const id = targetId(input, kind === 'room' ? 'roomId' : 'sessionId');
      const token: unknown = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length > 16_384)
        throw contractError('UNAUTHENTICATED', 'platform.identity.required');
      let principal;
      try {
        principal = await this.principal.resolveToken(token);
      } catch {
        throw contractError('UNAUTHENTICATED', 'platform.identity.inactive');
      }
      const reference = {
        principalId: principal.sub,
        authSessionId: principal.sid,
      };
      if (kind === 'room')
        await this.runtime.authorizeRoomChat(reference, id, 'read');
      else await this.runtime.sessions.descriptor(reference, id);
      if (!socket.connected || this.generations.get(socket) !== generation)
        throw contractError('CONFLICT', 'platform.subscription.replaced');
      this.subscriptions.set(socket.id, {
        socket,
        reference,
        targetId: id,
        targetKind: kind,
        expiresAt: principal.exp * 1000,
        revision: -1,
        pendingRevision: -1,
        chatSequence: -1,
        pendingChatSequence: -1,
      });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: toErrorEnvelope(error) };
    }
  }

  @SubscribeMessage('platform:unsubscribe')
  unsubscribeSession(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    return this.unsubscribeFrom(socket, input, 'session');
  }

  @SubscribeMessage('platform:room-unsubscribe')
  unsubscribeRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    return this.unsubscribeFrom(socket, input, 'room');
  }

  private unsubscribeFrom(
    socket: Socket,
    input: unknown,
    kind: 'session' | 'room',
  ) {
    try {
      const id = targetId(input, kind === 'room' ? 'roomId' : 'sessionId');
      const existing = this.subscriptions.get(socket.id);
      if (
        !existing ||
        (existing.targetId === id && existing.targetKind === kind)
      )
        this.invalidate(socket);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: toErrorEnvelope(error) };
    }
  }

  @SubscribeMessage('platform:foreground')
  async foregroundHeartbeat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() input: unknown,
  ) {
    try {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => !['sessionId', 'active'].includes(key),
        ) ||
        !('active' in input) ||
        typeof input.active !== 'boolean'
      )
        throw contractError('INVALID_REQUEST', 'platform.request.foreground');
      const id = targetId({
        sessionId: 'sessionId' in input ? input.sessionId : undefined,
      });
      const subscription = this.subscriptions.get(socket.id);
      if (
        !subscription ||
        subscription.targetId !== id ||
        subscription.targetKind !== 'session' ||
        Date.now() >= subscription.expiresAt ||
        !socket.connected
      )
        throw contractError('FORBIDDEN', 'platform.subscription.required');
      // A hidden tab stops renewing; it must not erase another tab's active lease.
      if (input.active) {
        await this.runtime.sessions.descriptor(subscription.reference, id);
        if (this.subscriptions.get(socket.id) !== subscription)
          throw contractError('CONFLICT', 'platform.subscription.replaced');
        await this.foreground.touchTarget(
          subscription.reference.principalId,
          platformNotificationTarget(id),
        );
      }
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: toErrorEnvelope(error) };
    }
  }

  handleDisconnect(socket: Socket) {
    this.dropSocket(socket);
  }

  private dropSocket(socket: Socket, disconnect = false): void {
    this.connectionGenerations.set(
      socket,
      (this.connectionGenerations.get(socket) ?? 0) + 1,
    );
    this.notificationReadyGenerations.set(
      socket,
      (this.notificationReadyGenerations.get(socket) ?? 0) + 1,
    );
    this.notificationReadySockets.delete(socket);
    this.pendingConnections.delete(socket);
    this.socketAuthentications.delete(socket);
    const userId = this.socketUsers.get(socket);
    this.socketUsers.delete(socket);
    if (userId) {
      const sockets = this.userSockets.get(userId);
      sockets?.delete(socket);
      if (sockets?.size === 0) this.userSockets.delete(userId);
    }
    this.invalidate(socket);
    if (disconnect && socket.connected) socket.disconnect(true);
  }

  onModuleDestroy() {
    this.unsubscribe();
    this.unsubscribeAccountChanged();
    this.unsubscribeChat();
    this.unsubscribeRoomChat();
    this.removeOnlineDelivery?.();
    this.notificationReadySockets.clear();
    this.userSockets.clear();
    for (const { socket } of this.subscriptions.values())
      this.invalidate(socket);
  }

  publish(id: string, revision: number): Promise<void> {
    return this.enqueue(id, revision, 'game');
  }

  publishChat(id: string, sequence: number): Promise<void> {
    return this.enqueue(id, sequence, 'chat');
  }

  publishRoomChat(id: string, sequence: number): Promise<void> {
    return this.enqueue(id, sequence, 'room-chat');
  }

  /** Broadcast a durable message through the platform account namespace. */
  broadcastGlobalMessage(message: unknown): void {
    this.emitNotificationToAll({ kind: 'message', message });
  }

  /** Deliver a durable message to every platform socket for one account. */
  sendMessageToUser(userId: string, message: unknown): void {
    this.emitNotificationToUser(userId, { kind: 'message', message });
  }

  /** Sends an account-scoped cache invalidation hint to every live tab. */
  notifyShellChanged(userId: string): void {
    this.emitNotificationToUser(userId, { kind: 'shell' });
  }

  /** Delivers a game-owned account event without exposing game imports here. */
  sendGameEventToUser(
    userId: string,
    gameId: string,
    type: string,
    payload: unknown,
  ): void {
    this.emitNotificationToUser(userId, {
      kind: 'game',
      gameId,
      type,
      payload,
    });
  }

  private emitNotificationToAll(event: TPlatformNotificationEvent): void {
    for (const sockets of this.userSockets.values())
      for (const socket of sockets) {
        void this.emitNotificationToSocket(socket, event);
      }
  }

  private emitNotificationToUser(
    userId: string,
    event: TPlatformNotificationEvent,
  ): void {
    for (const socket of this.userSockets.get(userId) ?? [])
      void this.emitNotificationToSocket(socket, event, userId);
  }

  private async emitNotificationToSocket(
    socket: Socket,
    event: TPlatformNotificationEvent,
    expectedUserId?: string,
  ): Promise<void> {
    const principal = await this.authorizeSocket(socket);
    if (
      !principal ||
      (expectedUserId !== undefined && principal.sub !== expectedUserId) ||
      !socket.connected
    )
      return;
    socket.emit('platform:notification', event);
  }

  private async authorizeSocket(socket: Socket): Promise<IPrincipal | null> {
    const authentication = this.socketAuthentications.get(socket);
    if (!authentication || !socket.connected) return null;
    const token = socket.handshake.auth?.token;
    if (token !== authentication.token) {
      this.dropSocket(socket, true);
      return null;
    }
    if (authentication.pending) return authentication.pending;
    const pending = this.principal
      .resolveToken(authentication.token)
      .then((principal) => {
        if (
          !socket.connected ||
          this.socketAuthentications.get(socket) !== authentication ||
          this.socketUsers.get(socket) !== principal.sub ||
          principal.exp * 1000 <= Date.now()
        )
          return null;
        authentication.principal = principal;
        return principal;
      })
      .catch(() => null)
      .finally(() => {
        if (authentication.pending === pending)
          authentication.pending = undefined;
      });
    authentication.pending = pending;
    const principal = await pending;
    if (!principal) this.dropSocket(socket, true);
    return principal;
  }

  private async deliverOnlineNotification(
    userId: string,
    payload: IBrowserNotificationPayload,
  ): Promise<boolean> {
    for (const socket of this.notificationReadySockets) {
      if (!socket.connected) {
        this.notificationReadySockets.delete(socket);
        continue;
      }
      if (this.socketUsers.get(socket) !== userId) continue;
      const readyGeneration = this.notificationReadyGenerations.get(socket);
      const principal = await this.authorizeSocket(socket);
      if (
        !principal ||
        this.notificationReadyGenerations.get(socket) !== readyGeneration ||
        !this.notificationReadySockets.has(socket) ||
        !socket.connected ||
        this.socketUsers.get(socket) !== userId ||
        principal.sub !== userId
      )
        continue;
      try {
        const response = await socket
          .timeout(10_000)
          .emitWithAck('platform:notification:show', payload);
        if (response === true) return true;
      } catch {
        // Try another ready tab before falling back to external push.
      }
    }
    return false;
  }

  private async enqueue(
    id: string,
    sequence: number,
    kind: 'game' | 'chat' | 'room-chat',
  ): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return;
    const pending: Promise<void>[] = [];
    for (const subscription of this.subscriptions.values()) {
      if (
        subscription.targetId !== id ||
        subscription.targetKind !== (kind === 'room-chat' ? 'room' : 'session')
      )
        continue;
      if (kind === 'game') {
        if (sequence <= subscription.revision) continue;
        subscription.pendingRevision = Math.max(
          subscription.pendingRevision,
          sequence,
        );
      } else {
        if (sequence <= subscription.chatSequence) continue;
        subscription.pendingChatSequence = Math.max(
          subscription.pendingChatSequence,
          sequence,
        );
      }
      subscription.pending ??= this.flush(subscription).finally(() => {
        subscription.pending = undefined;
      });
      pending.push(subscription.pending);
    }
    await Promise.all(pending);
  }

  private async flush(subscription: Subscription): Promise<void> {
    const { socket, targetId: id, reference } = subscription;
    try {
      while (
        subscription.pendingRevision > subscription.revision ||
        subscription.pendingChatSequence > subscription.chatSequence
      ) {
        if (Date.now() >= subscription.expiresAt || !socket.connected) {
          this.invalidate(socket);
          return;
        }
        // Recheck revocation and private-room access before every hint, not just on join.
        if (subscription.targetKind === 'room')
          await this.runtime.authorizeRoomChat(reference, id, 'read');
        else await this.runtime.sessions.descriptor(reference, id);
        if (this.subscriptions.get(socket.id) !== subscription) return;
        if (subscription.pendingRevision > subscription.revision) {
          subscription.revision = subscription.pendingRevision;
          socket.emit('platform:changed', {
            sessionId: id,
            revision: subscription.revision,
          });
        }
        if (subscription.pendingChatSequence > subscription.chatSequence) {
          subscription.chatSequence = subscription.pendingChatSequence;
          if (subscription.targetKind === 'room')
            socket.emit('platform:room-chat-changed', {
              roomId: id,
              sequence: subscription.chatSequence,
            });
          else
            socket.emit('platform:chat-changed', {
              sessionId: id,
              sequence: subscription.chatSequence,
            });
        }
      }
    } catch {
      if (this.subscriptions.get(socket.id) === subscription)
        this.invalidate(socket);
    }
  }

  private invalidate(socket: Socket): number {
    const generation = (this.generations.get(socket) ?? 0) + 1;
    this.generations.set(socket, generation);
    this.subscriptions.delete(socket.id);
    return generation;
  }
}
