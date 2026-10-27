import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type IPlatformChangedPayload,
  PlatformSocket,
  platformNamespaceUrl,
} from '../../src/api/platformSocket.js';
import { onSessionEnd } from '../../src/api/sessionEnd.js';

vi.mock('socket.io-client', () => ({ io: vi.fn(() => createMockSocket()) }));

type THandler = (...args: unknown[]) => void;

interface IMockSocket {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> };
  handlers: Map<string, Set<THandler>>;
}

function createMockSocket(connected = true): IMockSocket {
  const handlers = new Map<string, Set<THandler>>();
  const managerHandlers = new Map<string, Set<THandler>>();
  const manager = {
    on: vi.fn((event: string, handler: THandler) => {
      const set = managerHandlers.get(event) ?? new Set<THandler>();
      set.add(handler);
      managerHandlers.set(event, set);
    }),
    off: vi.fn((event: string, handler: THandler) => {
      managerHandlers.get(event)?.delete(handler);
    }),
  };
  const socket: IMockSocket = {
    connected,
    on: vi.fn((event: string, handler: THandler) => {
      const set = handlers.get(event) ?? new Set<THandler>();
      set.add(handler);
      handlers.set(event, set);
    }),
    off: vi.fn((event: string, handler: THandler) => {
      handlers.get(event)?.delete(handler);
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      if (
        event !== 'platform:subscribe' &&
        event !== 'platform:room-subscribe'
      ) {
        return;
      }
      const acknowledge = args.at(-1);
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    }),
    disconnect: vi.fn(),
    connect: vi.fn(),
    io: manager,
    handlers,
  };
  return socket;
}

function emitSocketEvent(
  socket: IMockSocket,
  event: string,
  payload: unknown,
): void {
  for (const handler of socket.handlers.get(event) ?? []) handler(payload);
}

describe('PlatformSocket', () => {
  let platform: PlatformSocket;

  beforeEach(() => {
    platform = new PlatformSocket();
  });

  it('builds the platform namespace from the configured websocket origin', () => {
    expect(platformNamespaceUrl('https://game.example.test')).toBe(
      'https://game.example.test/platform',
    );
  });

  it('subscribes and resubscribes platform session and room targets', async () => {
    const socket = platform.connect('token', 0) as unknown as IMockSocket;
    const sessionChanged = vi.fn();
    const roomChanged = vi.fn();

    platform.onPlatformChanged('session-1', sessionChanged);
    platform.onPlatformRoomChatChanged('room-1', roomChanged);

    expect(socket.emit).toHaveBeenCalledWith(
      'platform:subscribe',
      { sessionId: 'session-1' },
      expect.any(Function),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'platform:room-subscribe',
      { roomId: 'room-1' },
      expect.any(Function),
    );

    socket.emit.mockClear();
    emitSocketEvent(socket, 'connect', undefined);
    await vi.waitFor(() =>
      expect(socket.emit).toHaveBeenCalledWith(
        'platform:subscribe',
        { sessionId: 'session-1' },
        expect.any(Function),
      ),
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'platform:room-subscribe',
      { roomId: 'room-1' },
      expect.any(Function),
    );

    emitSocketEvent(socket, 'platform:changed', {
      sessionId: 'session-1',
      revision: 4,
    } satisfies IPlatformChangedPayload);
    emitSocketEvent(socket, 'platform:room-chat-changed', {
      roomId: 'room-1',
      sequence: 3,
    });
    expect(sessionChanged).toHaveBeenCalledWith({
      sessionId: 'session-1',
      revision: 4,
    });
    expect(roomChanged).toHaveBeenCalledWith({
      roomId: 'room-1',
      sequence: 3,
    });
  });

  it('keeps chat hints scoped and only foregrounds an admitted session', () => {
    const socket = platform.connect('token', 0) as unknown as IMockSocket;
    const chatChanged = vi.fn();
    const roomChatChanged = vi.fn();
    platform.onPlatformChatChanged('session-1', chatChanged);
    platform.onPlatformRoomChatChanged('room-1', roomChatChanged);

    emitSocketEvent(socket, 'platform:chat-changed', {
      sessionId: 'other-session',
      sequence: 4,
    });
    emitSocketEvent(socket, 'platform:chat-changed', {
      sessionId: 'session-1',
      sequence: 5,
    });
    emitSocketEvent(socket, 'platform:room-chat-changed', {
      roomId: 'room-1',
      sequence: 6,
    });
    expect(chatChanged).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      sequence: 5,
    });
    expect(roomChatChanged).toHaveBeenCalledExactlyOnceWith({
      roomId: 'room-1',
      sequence: 6,
    });

    socket.emit.mockClear();
    platform.setPlatformForeground('session-1', true);
    expect(socket.emit).toHaveBeenCalledWith('platform:foreground', {
      sessionId: 'session-1',
      active: true,
    });
    socket.emit.mockClear();
    platform.setPlatformForeground('other-session', true);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('rejects stale listeners after an auth epoch socket replacement', () => {
    const first = platform.connect('token-a', 1) as unknown as IMockSocket;
    const changed = vi.fn();
    platform.onPlatformChanged('session-1', changed);
    const oldListener = [...(first.handlers.get('platform:changed') ?? [])][0];
    if (!oldListener) throw new Error('expected old platform listener');

    const second = platform.connect('token-b', 2) as unknown as IMockSocket;
    oldListener({ sessionId: 'session-1', revision: 1 });
    expect(changed).not.toHaveBeenCalled();
    emitSocketEvent(second, 'platform:changed', {
      sessionId: 'session-1',
      revision: 2,
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      revision: 2,
    });
    expect(first.handlers.get('platform:changed')?.size).toBe(0);
  });

  it('ends the current session on a server disconnect and ignores stale sockets', () => {
    const ended = vi.fn();
    const stop = onSessionEnd(ended);
    const first = platform.connect('token-a', 1) as unknown as IMockSocket;
    const staleDisconnect = [
      ...(first.handlers.get('disconnect') ?? []),
    ][0];
    if (!staleDisconnect) throw new Error('expected disconnect listener');

    platform.connect('token-b', 2);
    staleDisconnect('io server disconnect');
    expect(ended).not.toHaveBeenCalled();

    const current = platform.instance as unknown as IMockSocket;
    emitSocketEvent(current, 'disconnect', 'io server disconnect');
    expect(ended).toHaveBeenCalledExactlyOnceWith({
      reason: 'server-disconnect',
    });
    expect(platform.instance).toBeNull();
    stop();
  });

  it('keeps connect and token updates on one socket until logout', () => {
    const first = platform.connect('token-a', 1);
    expect(platform.instance).toBe(first);
    expect(platform.isConnected).toBe(true);

    const same = platform.updateToken('token-a', 2);
    expect(same).toBe(first);
    expect(first.disconnect).not.toHaveBeenCalled();

    platform.updateToken(null, 3);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(platform.instance).toBeNull();
    expect(platform.isConnected).toBe(false);
  });

  it('normalizes subscription acknowledgements to the stable client shape', async () => {
    const socket = platform.connect('token', 0) as unknown as IMockSocket;
    socket.emit.mockImplementation((event: string, ...args: unknown[]) => {
      if (event !== 'platform:subscribe') return;
      const acknowledge = args.at(-1);
      if (typeof acknowledge === 'function') {
        acknowledge({
          ok: false,
          error: {
            code: 'FORBIDDEN',
            messageKey: 'platform.gateway.session.forbidden',
            retryable: false,
            message: 'do not expose this',
          },
        });
      }
    });

    await expect(platform.subscribePlatform('session-1')).resolves.toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        messageKey: 'platform.gateway.session.forbidden',
        retryable: false,
      },
    });
  });
});
