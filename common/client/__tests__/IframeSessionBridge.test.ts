import type { SessionRoute } from '@board-game/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSessionTransport } from '../src/ClientSessionStore.js';
import {
  attachIframeSessionBridge,
  connectIframeGame,
} from '../src/IframeSessionBridge.js';
import type { GameEntryRuntime } from '../src/runtime.js';

const route: SessionRoute = {
  gameId: 'counter',
  modeId: 'room',
  sessionId: 'session-1',
  releaseId: 'counter-v1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

class TestPort {
  peer?: TestPort;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  closed = false;
  start(): void {
    // The browser starts a transferred port; this fake delivers synchronously.
  }
  close(): void {
    this.closed = true;
  }
  postMessage(data: unknown): void {
    if (this.closed || this.peer?.closed) return;
    queueMicrotask(() => this.peer?.onmessage?.({ data } as MessageEvent));
  }
}

class TestMessageChannel {
  readonly port1 = new TestPort();
  readonly port2 = new TestPort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

interface TestWindowTarget {
  postMessage(data: unknown, targetOrigin: string, transfer?: TestPort[]): void;
}

class TestWindow {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  parent: TestWindowTarget = this as unknown as TestWindowTarget;
  constructor(readonly location: { origin: string }) {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'message')
      this.listeners.add(listener as (event: MessageEvent) => void);
  }
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) {
    if (type === 'message')
      this.listeners.delete(listener as (event: MessageEvent) => void);
  }
  dispatch(
    source: object,
    origin: string,
    data: unknown,
    ports: TestPort[] = [],
  ) {
    const event = { source, origin, data, ports } as unknown as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }
}

function connectWindows() {
  const host = new TestWindow({ origin: 'https://shell.example' });
  const game = new TestWindow({ origin: 'https://game.example' });
  const hostTarget: TestWindowTarget = {
    postMessage(data, _targetOrigin, transfer) {
      host.dispatch(gameTarget, game.location.origin, data, transfer);
    },
  };
  const gameTarget: TestWindowTarget = {
    postMessage(data, _targetOrigin, transfer) {
      game.dispatch(hostTarget, host.location.origin, data, transfer);
    },
  };
  host.parent = hostTarget;
  game.parent = hostTarget;
  return {
    host,
    game,
    frame: { contentWindow: gameTarget } as unknown as HTMLIFrameElement,
  };
}

function runtime(transport: ClientSessionTransport): {
  runtime: GameEntryRuntime;
  foreground: boolean[];
} {
  const foreground: boolean[] = [];
  const signals = {
    subscribeRevision: () => () => undefined,
    setForeground: (_sessionId: string, active: boolean) =>
      foreground.push(active),
  };
  return {
    foreground,
    runtime: {
      http: {
        get: async <T>() => ({ data: null as T }),
        post: async <T>() => ({ data: null as T }),
      },
      session: { signals, createTransport: () => transport as never },
      signals,
      viewer: { principalId: 'player-1', identityKey: 'account-1' },
      navigation: {
        platformHref: '/games/counter/lobby',
        replayHref: () => '/games/counter/replay/session-1',
      },
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('MessageChannel', TestMessageChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('iframe session bridge', () => {
  it('handshakes only across the exact origin and exposes the session transport', async () => {
    const windows = connectWindows();
    const calls: unknown[] = [];
    const rawTransport = {
      getPlayerView: vi.fn(async (request) => {
        calls.push(request);
        return { revision: 1, value: 'counter' };
      }),
      getEvents: vi.fn(async () => ({ events: [] })),
      resume: vi.fn(async () => ({ kind: 'snapshot', view: null })),
      submitCommand: vi.fn(async () => ({ receipt: { status: 'accepted' } })),
      queryOptions: vi.fn(async () => ({ answer: { options: [] } })),
    };
    const transport = rawTransport as unknown as ClientSessionTransport;
    const { runtime: hostRuntime, foreground } = runtime(transport);
    const detach = attachIframeSessionBridge({
      window: windows.host as unknown as Window,
      frame: windows.frame,
      origin: 'https://game.example',
      route,
      runtime: hostRuntime,
      kind: 'live',
    });
    const connection = await connectIframeGame({
      window: windows.game as unknown as Window,
      parentOrigin: 'https://shell.example',
      gameId: route.gameId,
      releaseId: route.releaseId,
      timeoutMs: 200,
    });
    const response = await connection.runtime.session
      .createTransport(route)
      .getPlayerView({ protocolVersion: 1, route });
    expect(response).toEqual({ revision: 1, value: 'counter' });
    expect(calls[0]).toEqual({ protocolVersion: 1, route });
    expect(foreground).toEqual([true]);
    await expect(connection.runtime.http.get('/private')).rejects.toThrow(
      'client.iframe.http_unavailable',
    );
    connection.close();
    detach();
    expect(foreground).toEqual([true, false]);
  });

  it('rejects access context and route changes', async () => {
    const windows = connectWindows();
    const transport = {
      getPlayerView: vi.fn(async () => ({ ok: true })),
      getEvents: vi.fn(async () => ({ events: [] })),
      resume: vi.fn(async () => ({ ok: true })),
      submitCommand: vi.fn(async () => ({ ok: true })),
      queryOptions: vi.fn(async () => ({ ok: true })),
    } as unknown as ClientSessionTransport;
    const { runtime: hostRuntime } = runtime(transport);
    const detach = attachIframeSessionBridge({
      window: windows.host as unknown as Window,
      frame: windows.frame,
      origin: 'https://game.example',
      route,
      runtime: hostRuntime,
      kind: 'spectate',
    });
    const connection = await connectIframeGame({
      window: windows.game as unknown as Window,
      parentOrigin: 'https://shell.example',
      gameId: route.gameId,
      releaseId: route.releaseId,
      timeoutMs: 200,
    });
    expect(() =>
      connection.runtime.session.createTransport({
        ...route,
        sessionId: 'other',
      }),
    ).toThrow('client.iframe.route_mismatch');
    await expect(
      connection.runtime.session.createTransport(route).getPlayerView({
        protocolVersion: 1,
        route,
        accessContext: { principalId: 'forged' },
      } as never),
    ).rejects.toThrow('client.iframe.request_denied');
    expect(transport.getPlayerView).not.toHaveBeenCalled();
    connection.close();
    detach();
  });

  it('rejects same-origin embedding and malformed origins', async () => {
    const windows = connectWindows();
    await expect(
      connectIframeGame({
        window: windows.game as unknown as Window,
        parentOrigin: 'https://game.example',
        gameId: route.gameId,
        releaseId: route.releaseId,
        timeoutMs: 10,
      }),
    ).rejects.toThrow('client.iframe.separate_origin_required');
    expect(() =>
      attachIframeSessionBridge({
        window: windows.host as unknown as Window,
        frame: windows.frame,
        origin: 'not-an-origin',
        route,
        runtime: runtime({} as ClientSessionTransport).runtime,
        kind: 'live',
      }),
    ).toThrow('client.iframe.origin_invalid');
  });
});
