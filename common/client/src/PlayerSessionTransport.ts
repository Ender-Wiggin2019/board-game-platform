import {
  assertSessionRoute,
  canonicalStableStringify,
  contractError,
  isErrorCode,
  isJsonValue,
  type JsonValue,
  PlatformError,
  type SessionRoute,
} from '@board-game/contracts';
import type { ClientSessionTransport } from './ClientSessionStore.js';

/** Returned by the authenticated platform connection endpoint. */
export interface PlayerConnection {
  readonly playerEndpoint: string;
  readonly route: SessionRoute;
  readonly token: string;
  readonly expiresAt: number;
}

export interface PlayerSessionTransportOptions {
  readonly route: SessionRoute;
  readonly connect: () => Promise<PlayerConnection>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLocalhost?: boolean;
}

export class PlayerTransportError extends Error {
  readonly outcome = 'unknown';
  constructor(readonly code: 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE') {
    super(`client.player.${code.toLowerCase()}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keeps the frozen route and command intent intact through connection failures. */
export function createPlayerSessionTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>(
  options: PlayerSessionTransportOptions,
): ClientSessionTransport<Command, Query, Answer, View> {
  assertSessionRoute(options.route);
  const route = structuredClone(options.route);
  const routeKey = canonicalStableStringify(route);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  )
    throw contractError('INVALID_REQUEST', 'client.player.limits_invalid');
  let connection: PlayerConnection | undefined;
  let connecting: Promise<PlayerConnection> | undefined;

  async function authorize(): Promise<PlayerConnection> {
    // Valid credentials continue to work when the platform is temporarily offline.
    if (connection && connection.expiresAt > now()) return connection;
    if (!connecting) {
      connecting = options
        .connect()
        .then((received) => {
          assertSessionRoute(received.route);
          if (canonicalStableStringify(received.route) !== routeKey)
            throw contractError('FORBIDDEN', 'client.player.route_mismatch');
          const url = new URL(received.playerEndpoint);
          const local = ['127.0.0.1', 'localhost', '[::1]'].includes(
            url.hostname,
          );
          if (
            (url.protocol !== 'https:' &&
              !(
                options.allowInsecureLocalhost &&
                local &&
                url.protocol === 'http:'
              )) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw contractError(
              'INVALID_REQUEST',
              'client.player.endpoint_invalid',
            );
          if (
            typeof received.token !== 'string' ||
            !received.token ||
            received.token.length > 16 * 1024 ||
            !Number.isSafeInteger(received.expiresAt) ||
            received.expiresAt <= now()
          )
            throw contractError(
              'UNAUTHENTICATED',
              'client.player.credential_expired',
            );
          connection = structuredClone(received);
          return connection;
        })
        .finally(() => {
          connecting = undefined;
        });
    }
    return connecting;
  }

  async function call<T>(
    operation: string,
    input: { readonly route: SessionRoute },
  ): Promise<T> {
    if (
      canonicalStableStringify(input.route) !== routeKey ||
      Object.hasOwn(input, 'accessContext')
    )
      throw contractError('FORBIDDEN', 'client.player.route_mismatch');
    const credential = await authorize();
    const body = JSON.stringify({ protocolVersion: 1, request: input });
    if (new TextEncoder().encode(body).byteLength > 512 * 1024)
      throw contractError(
        'PAYLOAD_TOO_LARGE',
        'client.player.request_too_large',
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(
          `${credential.playerEndpoint.replace(/\/$/, '')}/v1/${operation}`,
          {
            method: 'POST',
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${credential.token}`,
            },
            body,
            signal: controller.signal,
          },
        );
      } catch {
        throw new PlayerTransportError(
          controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PlayerTransportError('INVALID_RESPONSE');
      let size = 0;
      let text = '';
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) {
            await reader.cancel();
            throw new PlayerTransportError('INVALID_RESPONSE');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        if (error instanceof PlayerTransportError) throw error;
        throw new PlayerTransportError(
          controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
        );
      } finally {
        reader.releaseLock();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new PlayerTransportError('INVALID_RESPONSE');
      }
      if (!record(parsed) || parsed.protocolVersion !== 1)
        throw new PlayerTransportError('INVALID_RESPONSE');
      if (!response.ok) {
        if (response.status === 401 && connection === credential)
          connection = undefined;
        const error = parsed.error;
        if (
          !record(error) ||
          !isErrorCode(error.code) ||
          typeof error.messageKey !== 'string' ||
          typeof error.retryable !== 'boolean'
        )
          throw new PlayerTransportError('INVALID_RESPONSE');
        throw new PlatformError({
          code: error.code,
          messageKey: error.messageKey,
          retryable: error.retryable,
        });
      }
      if (!isJsonValue(parsed.response))
        throw new PlayerTransportError('INVALID_RESPONSE');
      return parsed.response as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getPlayerView: (request) => call('getPlayerView', request),
    getEvents: (request) => call('getEvents', request),
    resume: (request) => call('resume', request),
    submitCommand: (request) => call('submitCommand', request),
    queryOptions: (request) => call('queryOptions', request),
  };
}
