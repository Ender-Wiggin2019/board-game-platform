import 'reflect-metadata';
import { contractError } from '@board-game/contracts';
import type { IBrowserNotificationPayload } from '@board-platform/contracts';
import type { JwtService } from '@nestjs/jwt';
import { GATEWAY_OPTIONS } from '@nestjs/websockets/constants';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Socket } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type IPrincipal,
  PrincipalResolver,
} from '@/auth/PrincipalResolver.js';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformGateway } from '@/platform/platform.gateway.js';

type OnlineDelivery = (
  userId: string,
  payload: IBrowserNotificationPayload,
) => Promise<boolean>;

function createSocket(id: string, token = 'signed-token') {
  const show = vi.fn().mockResolvedValue(false);
  const emit = vi.fn();
  const socket = {
    id,
    connected: true,
    handshake: { auth: { token } },
    emit,
    timeout: vi.fn(() => ({ emitWithAck: show })),
    disconnect: vi.fn(),
  } as unknown as Socket;
  return { socket, show, emit };
}

function setup({ withPush = false }: { withPush?: boolean } = {}) {
  vi.spyOn(PrincipalResolver.prototype, 'resolveToken').mockResolvedValue({
    sub: 'user',
    sid: 'auth-session',
    exp: Math.floor(Date.now() / 1000) + 3600,
  } as IPrincipal);
  const descriptor = vi.fn().mockResolvedValue({ authority: 'platform' });
  const dispose = vi.fn();
  const accountDispose = vi.fn();
  const authorizeRoomChat = vi.fn().mockResolvedValue(undefined);
  let onlineDelivery: OnlineDelivery | undefined;
  const push = withPush
    ? {
        addOnlineDelivery: (handler: OnlineDelivery) => {
          onlineDelivery = handler;
          return vi.fn();
        },
      }
    : undefined;
  const runtime = {
    sessions: { descriptor },
    chat: { subscribe: vi.fn(() => vi.fn()) },
    roomChat: { subscribe: vi.fn(() => vi.fn()) },
    authorizeRoomChat,
    onSessionChanged: vi.fn(() => dispose),
    onAccountChanged: vi.fn(() => accountDispose),
  };
  const gateway = new PlatformGateway(
    runtime as unknown as PlatformApplicationRuntime,
    {} as JwtService,
    {} as NodePgDatabase,
    push as never,
  );
  const { socket } = createSocket('socket');
  return {
    gateway,
    socket,
    descriptor,
    dispose,
    accountDispose,
    authorizeRoomChat,
    onlineDelivery: () => onlineDelivery,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('platform realtime invalidation', () => {
  it('is registered on the independent platform namespace', () => {
    expect(Reflect.getMetadata(GATEWAY_OPTIONS, PlatformGateway)).toMatchObject(
      { namespace: '/platform' },
    );
  });

  it('delivers account shell invalidation to every target tab without a session subscription', async () => {
    const { gateway, descriptor } = setup();
    const accountA = createSocket('socket-a', 'token-a');
    const accountATab = createSocket('socket-a-tab', 'token-a-tab');
    const accountB = createSocket('socket-b', 'token-b');
    vi.mocked(PrincipalResolver.prototype.resolveToken).mockImplementation(
      async (token) =>
        ({
          sub: token === 'token-b' ? 'user-b' : 'user-a',
          sid: `session-${token}`,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }) as IPrincipal,
    );

    await Promise.all([
      gateway.handleConnection(accountA.socket),
      gateway.handleConnection(accountATab.socket),
      gateway.handleConnection(accountB.socket),
    ]);
    await vi.waitFor(() =>
      expect(accountA.emit).toHaveBeenCalledWith('platform:notification', {
        kind: 'shell',
      }),
    );
    await vi.waitFor(() =>
      expect(accountATab.emit).toHaveBeenCalledWith('platform:notification', {
        kind: 'shell',
      }),
    );
    await vi.waitFor(() =>
      expect(accountB.emit).toHaveBeenCalledWith('platform:notification', {
        kind: 'shell',
      }),
    );
    accountA.emit.mockClear();
    accountATab.emit.mockClear();
    accountB.emit.mockClear();
    gateway.notifyShellChanged('user-a');

    await vi.waitFor(() =>
      expect(accountA.socket.emit).toHaveBeenCalledExactlyOnceWith(
        'platform:notification',
        { kind: 'shell' },
      ),
    );
    expect(accountATab.socket.emit).toHaveBeenCalledExactlyOnceWith(
      'platform:notification',
      { kind: 'shell' },
    );
    expect(accountB.socket.emit).not.toHaveBeenCalled();
    expect(descriptor).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('keeps room chat hints separate and revokes subscriptions after a private-room kick', async () => {
    const { gateway, socket, authorizeRoomChat } = setup();
    expect(await gateway.subscribeRoom(socket, { roomId: 'private' })).toEqual({
      ok: true,
    });
    await gateway.publishChat('private', 1);
    expect(socket.emit).not.toHaveBeenCalled();
    await gateway.publishRoomChat('private', 2);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith(
      'platform:room-chat-changed',
      { roomId: 'private', sequence: 2 },
    );
    authorizeRoomChat.mockRejectedValue(contractError('FORBIDDEN', 'denied'));
    await gateway.publishRoomChat('private', 3);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    gateway.onModuleDestroy();
  });
  it('sends only a chat cursor and rechecks current audience authorization', async () => {
    const { gateway, socket, descriptor } = setup();
    await gateway.subscribe(socket, { sessionId: 'private' });
    await gateway.publishChat('private', 4);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith(
      'platform:chat-changed',
      { sessionId: 'private', sequence: 4 },
    );
    descriptor.mockRejectedValue(contractError('FORBIDDEN', 'denied'));
    await gateway.publishChat('private', 5);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    gateway.onModuleDestroy();
  });

  it('authorizes subscriptions and hints; sends only a monotonically increasing revision', async () => {
    const { gateway, socket, descriptor } = setup();
    expect(await gateway.subscribe(socket, { sessionId: 'session' })).toEqual({
      ok: true,
    });
    await gateway.publish('other', 1);
    await gateway.publish('session', 3);
    await gateway.publish('session', 2);
    expect(descriptor).toHaveBeenCalledTimes(2);
    expect(descriptor).toHaveBeenLastCalledWith(
      { principalId: 'user', authSessionId: 'auth-session' },
      'session',
    );
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith('platform:changed', {
      sessionId: 'session',
      revision: 3,
    });
    gateway.onModuleDestroy();
  });

  it('stops hints after current authorization is revoked', async () => {
    const { gateway, socket, descriptor } = setup();
    await gateway.subscribe(socket, { sessionId: 'private' });
    descriptor.mockRejectedValue(contractError('FORBIDDEN', 'denied'));
    await gateway.publish('private', 1);
    descriptor.mockResolvedValue({ authority: 'platform' });
    await gateway.publish('private', 2);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(descriptor).toHaveBeenCalledTimes(2);
    gateway.onModuleDestroy();
  });

  it('fences a delayed authorization result after unsubscribe or disconnect', async () => {
    const { gateway, socket, descriptor } = setup();
    let resolve!: (value: unknown) => void;
    descriptor.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const subscribing = gateway.subscribe(socket, { sessionId: 'session' });
    await vi.waitFor(() => expect(descriptor).toHaveBeenCalled());
    gateway.unsubscribeSession(socket, { sessionId: 'session' });
    resolve({ authority: 'platform' });
    expect(await subscribing).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    await gateway.publish('session', 1);
    expect(socket.emit).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('coalesces concurrent hints and fences a queued hint when the subscription changes', async () => {
    const { gateway, socket, descriptor } = setup();
    await gateway.subscribe(socket, { sessionId: 'first' });
    let resolve!: (value: unknown) => void;
    descriptor.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = gateway.publish('first', 1);
    const second = gateway.publish('first', 2);
    resolve({ authority: 'platform' });
    await Promise.all([first, second]);
    expect(socket.emit).toHaveBeenCalledExactlyOnceWith('platform:changed', {
      sessionId: 'first',
      revision: 2,
    });
    await gateway.subscribe(socket, { sessionId: 'second' });
    await gateway.publish('first', 3);
    gateway.handleDisconnect(socket);
    await gateway.publish('second', 1);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    gateway.onModuleDestroy();
  });

  it('rejects malformed input and refuses expired hint delivery', async () => {
    const { gateway, socket, descriptor, dispose } = setup();
    expect(
      await gateway.subscribe(socket, { sessionId: 'x', route: {} }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(descriptor).not.toHaveBeenCalled();
    vi.mocked(PrincipalResolver.prototype.resolveToken).mockResolvedValue({
      sub: 'user',
      sid: 'auth-session',
      exp: Math.floor(Date.now() / 1000) - 1,
    } as IPrincipal);
    await gateway.subscribe(socket, { sessionId: 'session' });
    await gateway.publish('session', 1);
    expect(socket.emit).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('waits for connection authentication before accepting notification readiness', async () => {
    const { gateway, socket, onlineDelivery } = setup({ withPush: true });
    let resolve!: (principal: IPrincipal) => void;
    vi.mocked(PrincipalResolver.prototype.resolveToken)
      .mockImplementationOnce(() => new Promise((done) => (resolve = done)))
      .mockResolvedValue({
        sub: 'user',
        sid: 'auth-session',
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as IPrincipal);

    const connecting = gateway.handleConnection(socket);
    const ready = gateway.notificationReady(socket, { enabled: true });
    resolve({
      sub: 'user',
      sid: 'auth-session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as IPrincipal);
    await Promise.all([connecting, ready]);

    const delivery = onlineDelivery();
    expect(delivery).toBeDefined();
    expect(await delivery?.('user', { title: 'Title', body: 'Body' })).toBe(
      false,
    );
    gateway.onModuleDestroy();
  });

  it('sends a shell invalidation after registering an authenticated socket', async () => {
    const { gateway, socket } = setup();
    await gateway.handleConnection(socket);

    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        'platform:notification',
        { kind: 'shell' },
      ),
    );
    gateway.onModuleDestroy();
  });

  it('does not let stale readiness clear a newer ready request', async () => {
    const { gateway, onlineDelivery } = setup({ withPush: true });
    const { socket, show } = createSocket('socket-race');
    const principal = {
      sub: 'user',
      sid: 'auth-session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as IPrincipal;
    await gateway.handleConnection(socket);

    let authorizeCalls = 0;
    let resolveFirst!: (value: IPrincipal | null) => void;
    const gatewayInternals = gateway as unknown as {
      authorizeSocket: (
        currentSocket: Socket,
      ) => Promise<IPrincipal | null>;
    };
    vi.spyOn(gatewayInternals, 'authorizeSocket').mockImplementation(() => {
      authorizeCalls += 1;
      if (authorizeCalls === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return Promise.resolve(principal);
    });

    const stale = gateway.notificationReady(socket, { enabled: true });
    await vi.waitFor(() => expect(authorizeCalls).toBe(1));
    await gateway.notificationReady(socket, { enabled: true });
    show.mockResolvedValue(true);
    resolveFirst(principal);
    await stale;

    const delivery = onlineDelivery();
    expect(delivery).toBeDefined();
    expect(await delivery?.('user', { title: 'A', body: 'A' })).toBe(true);
    expect(show).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
  });

  it('does not keep a revoked account notification-ready', async () => {
    const { gateway, onlineDelivery } = setup({ withPush: true });
    const { socket } = createSocket('socket-a', 'token-a');
    let revoked = false;
    vi.mocked(PrincipalResolver.prototype.resolveToken).mockImplementation(
      async () => {
        if (revoked) throw new Error('revoked');
        return {
          sub: 'user-a',
          sid: 'session-a',
          exp: Math.floor(Date.now() / 1000) + 3600,
        } as IPrincipal;
      },
    );
    await gateway.handleConnection(socket);
    revoked = true;
    await gateway.notificationReady(socket, { enabled: true });

    const delivery = onlineDelivery();
    expect(delivery).toBeDefined();
    expect(await delivery?.('user-a', { title: 'A', body: 'A' })).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    gateway.onModuleDestroy();
  });

  it('does not clear another account readiness while delivering online notifications', async () => {
    const { gateway, onlineDelivery } = setup({ withPush: true });
    const accountA = createSocket('socket-a', 'token-a');
    const accountB = createSocket('socket-b', 'token-b');
    vi.mocked(PrincipalResolver.prototype.resolveToken).mockImplementation(
      async (token) =>
        ({
          sub: token === 'token-a' ? 'user-a' : 'user-b',
          sid: `session-${token}`,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }) as IPrincipal,
    );
    await Promise.all([
      gateway.handleConnection(accountA.socket),
      gateway.handleConnection(accountB.socket),
    ]);
    await Promise.all([
      gateway.notificationReady(accountA.socket, { enabled: true }),
      gateway.notificationReady(accountB.socket, { enabled: true }),
    ]);
    accountA.show.mockResolvedValue(false);
    accountB.show.mockResolvedValue(true);

    const delivery = onlineDelivery();
    expect(delivery).toBeDefined();
    expect(await delivery?.('user-a', { title: 'A', body: 'A' })).toBe(false);
    expect(await delivery?.('user-b', { title: 'B', body: 'B' })).toBe(true);
    expect(accountB.show).toHaveBeenCalledOnce();
    gateway.onModuleDestroy();
  });

  it('rechecks readiness after authorization before delivering online notifications', async () => {
    const { gateway, onlineDelivery } = setup({ withPush: true });
    const { socket, show } = createSocket('socket-stale-ready');
    const principal = {
      sub: 'user',
      sid: 'auth-session',
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as IPrincipal;
    await gateway.handleConnection(socket);
    await gateway.notificationReady(socket, { enabled: true });

    let resolveAuthorization!: (value: IPrincipal | null) => void;
    const gatewayInternals = gateway as unknown as {
      authorizeSocket: (
        currentSocket: Socket,
      ) => Promise<IPrincipal | null>;
    };
    vi.spyOn(gatewayInternals, 'authorizeSocket').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAuthorization = resolve;
        }),
    );

    const delivery = onlineDelivery();
    expect(delivery).toBeDefined();
    const delivering = delivery?.('user', { title: 'A', body: 'A' });
    await vi.waitFor(() => expect(resolveAuthorization).toBeTypeOf('function'));
    await gateway.notificationReady(socket, { enabled: false });
    resolveAuthorization(principal);

    expect(await delivering).toBe(false);
    expect(show).not.toHaveBeenCalled();
    gateway.onModuleDestroy();
  });

  it('rechecks account authority before broadcasting and drops revoked sockets', async () => {
    const { gateway } = setup();
    const accountA = createSocket('socket-a', 'token-a');
    const accountB = createSocket('socket-b', 'token-b');
    let revoked = false;
    vi.mocked(PrincipalResolver.prototype.resolveToken).mockImplementation(
      async (token) => {
        if (revoked && token === 'token-a') throw new Error('revoked');
        return {
          sub: token === 'token-a' ? 'user-a' : 'user-b',
          sid: `session-${token}`,
          exp: Math.floor(Date.now() / 1000) + 3600,
        } as IPrincipal;
      },
    );
    await Promise.all([
      gateway.handleConnection(accountA.socket),
      gateway.handleConnection(accountB.socket),
    ]);
    await vi.waitFor(() =>
      expect(accountA.emit).toHaveBeenCalledWith('platform:notification', {
        kind: 'shell',
      }),
    );
    await vi.waitFor(() =>
      expect(accountB.emit).toHaveBeenCalledWith('platform:notification', {
        kind: 'shell',
      }),
    );
    accountA.emit.mockClear();
    accountB.emit.mockClear();
    revoked = true;
    gateway.broadcastGlobalMessage({ id: 'message' });
    await vi.waitFor(() =>
      expect(accountA.socket.disconnect).toHaveBeenCalledWith(true),
    );
    await vi.waitFor(() =>
      expect(accountB.socket.emit).toHaveBeenCalledExactlyOnceWith(
        'platform:notification',
        { kind: 'message', message: { id: 'message' } },
      ),
    );
    expect(accountA.socket.emit).not.toHaveBeenCalledWith(
      'platform:notification',
      expect.anything(),
    );
    gateway.onModuleDestroy();
  });
});
