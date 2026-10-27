import {
  assertJsonPayloadSize,
  assertSessionRoute,
  canonicalStableStringify,
  contractError,
  isErrorCode,
  isJsonValue,
  isPlatformError,
  PlatformError,
  type SessionRoute,
  toErrorEnvelope,
} from '@board-game/contracts';
import type { ClientSessionTransport } from './ClientSessionStore.js';
import type { GameEntryRuntime, GameViewer } from './runtime.js';

const VERSION = 1;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const METHODS = [
  'getPlayerView',
  'getEvents',
  'resume',
  'submitCommand',
  'queryOptions',
] as const;
type Method = (typeof METHODS)[number];
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw contractError('INVALID_REQUEST', 'client.iframe.origin_invalid');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== value)
    throw contractError('INVALID_REQUEST', 'client.iframe.origin_invalid');
  return parsed.origin;
}

function validViewer(value: unknown): value is GameViewer {
  if (!record(value)) return false;
  return (
    hasOnlyKeys(value, [
      'principalId',
      'accountPrincipalId',
      'seatId',
      'identityKey',
    ]) &&
    (value.principalId === undefined ||
      typeof value.principalId === 'string') &&
    (value.accountPrincipalId === undefined ||
      typeof value.accountPrincipalId === 'string') &&
    (value.seatId === undefined || typeof value.seatId === 'string') &&
    (value.identityKey === null || typeof value.identityKey === 'string') &&
    Object.hasOwn(value, 'identityKey')
  );
}

function validNavigation(value: unknown): value is {
  readonly platformHref: string;
  readonly replayHref: string;
} {
  return (
    record(value) &&
    hasOnlyKeys(value, ['platformHref', 'replayHref']) &&
    typeof value.platformHref === 'string' &&
    typeof value.replayHref === 'string'
  );
}

function jsonErrorEnvelope(error: unknown): Record<string, unknown> {
  const envelope = toErrorEnvelope(error);
  return {
    code: envelope.code,
    messageKey: envelope.messageKey,
    retryable: envelope.retryable,
    ...(envelope.requestId !== undefined
      ? { requestId: envelope.requestId }
      : {}),
    ...(envelope.details !== undefined ? { details: envelope.details } : {}),
  };
}

function validErrorEnvelope(value: unknown): value is {
  readonly code: string;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly outcome?: 'unknown';
} {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      'code',
      'messageKey',
      'retryable',
      'requestId',
      'details',
      'outcome',
    ]) &&
    isErrorCode(value.code) &&
    typeof value.messageKey === 'string' &&
    typeof value.retryable === 'boolean' &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.details === undefined || isJsonValue(value.details)) &&
    (value.outcome === undefined || value.outcome === 'unknown')
  );
}

/** A dedicated MessagePort exposes only one authorized session to a different-origin document. */
export function attachIframeSessionBridge(options: {
  readonly window: Window;
  readonly frame: HTMLIFrameElement;
  readonly origin: string;
  readonly route: SessionRoute;
  readonly runtime: GameEntryRuntime;
  readonly kind: 'live' | 'spectate' | 'replay' | 'end';
  readonly onReady?: () => void;
  readonly onError?: (error: unknown) => void;
}): () => void {
  const targetOrigin = origin(options.origin);
  if (targetOrigin === options.window.location.origin)
    throw contractError('FORBIDDEN', 'client.iframe.separate_origin_required');
  assertSessionRoute(options.route);
  const route = structuredClone(options.route);
  const routeKey = canonicalStableStringify(route);
  const transport = options.runtime.session.createTransport(route);
  let port: MessagePort | undefined;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const inFlight = new Set<string>();
  const send = (value: unknown) => {
    if (!closed) port?.postMessage(value);
  };
  const receive = async (event: MessageEvent) => {
    const message: unknown = event.data;
    if (
      !record(message) ||
      message.type !== 'request' ||
      typeof message.id !== 'string' ||
      message.id.length > 128
    )
      return;
    const id = message.id;
    let claimed = false;
    try {
      assertJsonPayloadSize(message, MAX_REQUEST_BYTES);
      if (inFlight.size >= 32 || inFlight.has(id))
        throw contractError('RATE_LIMITED', 'client.iframe.busy', true);
      inFlight.add(id);
      claimed = true;
      if (message.method === 'navigate') {
        if (message.target !== 'platform' && message.target !== 'replay')
          throw contractError('FORBIDDEN', 'client.iframe.navigation_denied');
        options.runtime.navigation.navigate?.(message.target, route);
        send({ type: 'response', id, response: null });
        return;
      }
      if (
        !METHODS.includes(message.method as Method) ||
        !record(message.request) ||
        Object.hasOwn(message.request, 'accessContext') ||
        canonicalStableStringify(message.request.route) !== routeKey
      )
        throw contractError('FORBIDDEN', 'client.iframe.request_denied');
      const invoke = transport[message.method as Method] as (
        input: never,
      ) => Promise<unknown>;
      const response = await invoke({
        ...message.request,
        protocolVersion: 1,
        route,
      } as never);
      if (!isJsonValue(response))
        throw contractError('INTERNAL', 'client.iframe.response_invalid');
      assertJsonPayloadSize(response, MAX_RESPONSE_BYTES);
      send({ type: 'response', id, response });
    } catch (error) {
      const unknown =
        !isPlatformError(error) && record(error) && error.outcome === 'unknown';
      send({
        type: 'response',
        id,
        error: unknown
          ? {
              code: 'NETWORK',
              messageKey: 'client.iframe.network',
              retryable: true,
              outcome: 'unknown',
            }
          : jsonErrorEnvelope(error),
      });
    } finally {
      if (claimed) inFlight.delete(id);
    }
  };
  const initialize = (event: MessageEvent) => {
    if (
      closed ||
      port ||
      event.source !== options.frame.contentWindow ||
      event.origin !== targetOrigin
    )
      return;
    const data: unknown = event.data;
    try {
      assertJsonPayloadSize(data, MAX_HANDSHAKE_BYTES);
    } catch {
      return;
    }
    if (
      !record(data) ||
      data.type !== 'board-game:ready' ||
      data.version !== VERSION ||
      data.gameId !== route.gameId ||
      data.releaseId !== route.releaseId ||
      !hasOnlyKeys(data, ['type', 'version', 'gameId', 'releaseId'])
    )
      return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (message) => {
      void receive(message);
    };
    port.onmessageerror = () =>
      options.onError?.(new Error('client.iframe.message_invalid'));
    port.start();
    options.frame.contentWindow?.postMessage(
      {
        type: 'board-game:init',
        version: VERSION,
        route,
        kind: options.kind,
        viewer: {
          ...(options.runtime.viewer.principalId !== undefined
            ? { principalId: options.runtime.viewer.principalId }
            : {}),
          ...(options.runtime.viewer.accountPrincipalId !== undefined
            ? { accountPrincipalId: options.runtime.viewer.accountPrincipalId }
            : {}),
          ...(options.runtime.viewer.seatId !== undefined
            ? { seatId: options.runtime.viewer.seatId }
            : {}),
          identityKey: options.runtime.viewer.identityKey,
        },
        navigation: {
          platformHref: options.runtime.navigation.platformHref,
          replayHref: options.runtime.navigation.replayHref(route),
        },
      },
      targetOrigin,
      [channel.port2],
    );
    unsubscribe = options.runtime.session.signals.subscribeRevision(
      route.sessionId,
      (change) => send({ type: 'revision', revision: change.revision }),
    );
    options.runtime.session.signals.setForeground(route.sessionId, true);
    options.onReady?.();
  };
  options.window.addEventListener('message', initialize);
  return () => {
    closed = true;
    options.window.removeEventListener('message', initialize);
    unsubscribe?.();
    options.runtime.session.signals.setForeground(route.sessionId, false);
    if (port) {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
    }
    inFlight.clear();
  };
}

export interface IframeGameConnection {
  readonly route: SessionRoute;
  readonly kind: 'live' | 'spectate' | 'replay' | 'end';
  readonly runtime: GameEntryRuntime;
  close(): void;
}

/** The isolated game uses the same ClientSessionStore through this transport adapter. */
export function connectIframeGame(options: {
  readonly window: Window;
  readonly parentOrigin: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly timeoutMs?: number;
}): Promise<IframeGameConnection> {
  const parentOrigin = origin(options.parentOrigin);
  if (
    parentOrigin === options.window.location.origin ||
    options.window.parent === options.window
  )
    return Promise.reject(
      contractError('FORBIDDEN', 'client.iframe.separate_origin_required'),
    );
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(
      contractError('INVALID_REQUEST', 'client.iframe.timeout_invalid'),
    );
  return new Promise((resolve, reject) => {
    const waiting = setTimeout(() => {
      options.window.removeEventListener('message', initialize);
      reject(new Error('client.iframe.handshake_timeout'));
    }, timeoutMs);
    const initialize = (event: MessageEvent) => {
      if (
        event.source !== options.window.parent ||
        event.origin !== parentOrigin
      )
        return;
      const data: unknown = event.data;
      if (
        !record(data) ||
        data.type !== 'board-game:init' ||
        data.version !== VERSION ||
        event.ports.length !== 1
      )
        return;
      try {
        assertJsonPayloadSize(data, MAX_HANDSHAKE_BYTES);
        assertSessionRoute(data.route);
        if (
          data.route.gameId !== options.gameId ||
          data.route.releaseId !== options.releaseId ||
          !['live', 'spectate', 'replay', 'end'].includes(
            data.kind as string,
          ) ||
          !validViewer(data.viewer) ||
          !validNavigation(data.navigation) ||
          !hasOnlyKeys(data, [
            'type',
            'version',
            'route',
            'kind',
            'viewer',
            'navigation',
          ])
        )
          throw contractError('FORBIDDEN', 'client.iframe.identity_mismatch');
      } catch (error) {
        clearTimeout(waiting);
        options.window.removeEventListener('message', initialize);
        reject(error);
        return;
      }
      clearTimeout(waiting);
      options.window.removeEventListener('message', initialize);
      const route = structuredClone(data.route as SessionRoute);
      const routeKey = canonicalStableStringify(route);
      const port = event.ports[0];
      const pending = new Map<
        string,
        {
          resolve: (value: unknown) => void;
          reject: (error: unknown) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      const listeners = new Set<(change: { revision: number }) => void>();
      let sequence = 0;
      let closed = false;
      const rejectPending = (error: unknown): void => {
        for (const operation of pending.values()) {
          clearTimeout(operation.timer);
          operation.reject(error);
        }
        pending.clear();
      };
      port.onmessage = (message: MessageEvent) => {
        const value: unknown = message.data;
        if (!record(value)) return;
        try {
          assertJsonPayloadSize(value, MAX_RESPONSE_BYTES);
        } catch {
          return;
        }
        if (
          value.type === 'revision' &&
          hasOnlyKeys(value, ['type', 'revision']) &&
          Number.isSafeInteger(value.revision)
        ) {
          listeners.forEach((listener) =>
            listener({ revision: value.revision as number }),
          );
          return;
        }
        if (
          value.type !== 'response' ||
          typeof value.id !== 'string' ||
          value.id.length > 128 ||
          !hasOnlyKeys(value, ['type', 'id', 'response', 'error'])
        )
          return;
        const operation = pending.get(value.id);
        if (!operation) return;
        clearTimeout(operation.timer);
        pending.delete(value.id);
        const hasResponse = Object.hasOwn(value, 'response');
        const hasError = Object.hasOwn(value, 'error');
        if (hasResponse === hasError) {
          operation.reject(new Error('client.iframe.response_invalid'));
        } else if (hasError) {
          if (!validErrorEnvelope(value.error)) {
            operation.reject(new Error('client.iframe.response_invalid'));
            return;
          }
          operation.reject(
            value.error.outcome === 'unknown'
              ? Object.assign(new Error('client.iframe.network'), {
                  code: 'NETWORK',
                  outcome: 'unknown',
                })
              : new PlatformError(
                  value.error as unknown as ConstructorParameters<
                    typeof PlatformError
                  >[0],
                ),
          );
        } else if (isJsonValue(value.response)) {
          operation.resolve(value.response);
        } else {
          operation.reject(new Error('client.iframe.response_invalid'));
        }
      };
      port.onmessageerror = () => {
        rejectPending(
          Object.assign(new Error('client.iframe.network'), {
            code: 'NETWORK',
            outcome: 'unknown',
          }),
        );
      };
      port.start();
      const call = <T>(
        method: string,
        request?: unknown,
        target?: string,
      ): Promise<T> => {
        if (closed)
          return Promise.reject(
            Object.assign(new Error('client.iframe.closed'), {
              code: 'ABORTED',
              outcome: 'unknown',
            }),
          );
        if (pending.size >= 32)
          return Promise.reject(
            contractError('RATE_LIMITED', 'client.iframe.busy', true),
          );
        if (
          request &&
          (!record(request) ||
            canonicalStableStringify(request.route) !== routeKey)
        )
          return Promise.reject(
            contractError('FORBIDDEN', 'client.iframe.route_mismatch'),
          );
        try {
          assertJsonPayloadSize(
            {
              type: 'request',
              id: 'pending',
              method,
              ...(request ? { request } : {}),
              ...(target ? { target } : {}),
            },
            MAX_REQUEST_BYTES,
          );
        } catch (error) {
          return Promise.reject(error);
        }
        const id = String(++sequence);
        return new Promise<T>((resolveCall, rejectCall) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCall(
              Object.assign(new Error('client.iframe.timeout'), {
                code: 'TIMEOUT',
                outcome: 'unknown',
              }),
            );
          }, timeoutMs);
          pending.set(id, {
            resolve: resolveCall as (value: unknown) => void,
            reject: rejectCall,
            timer,
          });
          port.postMessage({
            type: 'request',
            id,
            method,
            ...(request ? { request } : {}),
            ...(target ? { target } : {}),
          });
        });
      };
      const transport: ClientSessionTransport = {
        getPlayerView: (request) => call('getPlayerView', request),
        getEvents: (request) => call('getEvents', request),
        resume: (request) => call('resume', request),
        submitCommand: (request) => call('submitCommand', request),
        queryOptions: (request) => call('queryOptions', request),
      };
      const signals = {
        isConnected: false,
        subscribeRevision: (
          _sessionId: string,
          listener: (change: { revision: number }) => void,
        ) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        setForeground: () => undefined,
      };
      const navigation = data.navigation as Record<string, unknown>;
      const runtime: GameEntryRuntime = {
        http: {
          get: async () => {
            throw contractError('NOT_READY', 'client.iframe.http_unavailable');
          },
          post: async () => {
            throw contractError('NOT_READY', 'client.iframe.http_unavailable');
          },
        },
        session: {
          signals,
          createTransport: (requestedRoute) => {
            if (canonicalStableStringify(requestedRoute) !== routeKey)
              throw contractError('FORBIDDEN', 'client.iframe.route_mismatch');
            return transport as ReturnType<
              GameEntryRuntime['session']['createTransport']
            > as never;
          },
        },
        signals,
        viewer: data.viewer as unknown as GameViewer,
        navigation: {
          platformHref: String(navigation.platformHref),
          replayHref: () => String(navigation.replayHref),
          navigate: (target) => {
            void call('navigate', undefined, target).catch(() => undefined);
          },
        },
      };
      resolve({
        route,
        kind: data.kind as IframeGameConnection['kind'],
        runtime,
        close() {
          if (closed) return;
          closed = true;
          port.onmessageerror = null;
          port.close();
          port.onmessage = null;
          rejectPending(
            Object.assign(new Error('client.iframe.closed'), {
              code: 'ABORTED',
              outcome: 'unknown',
            }),
          );
          listeners.clear();
        },
      });
    };
    options.window.addEventListener('message', initialize);
    options.window.parent.postMessage(
      {
        type: 'board-game:ready',
        version: VERSION,
        gameId: options.gameId,
        releaseId: options.releaseId,
      },
      parentOrigin,
    );
  });
}
