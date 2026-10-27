import type {
  ClientSessionTransport,
  GameHttpClient,
} from '@board-game/client';
import {
  createSessionTransport,
  type GameHttpClientLike,
} from '@board-game/client';
import type {
  GetStatusRequest as ContractGetStatusRequest,
  JsonValue,
  OperationStatus,
  SessionRoute,
} from '@board-game/contracts';
import {
  assertSessionRoute,
  contractError,
  isErrorCode,
} from '@board-game/contracts';

export type PlatformHttpClient = GameHttpClient;

export type PlatformRouteDescriptorStatus =
  | 'suspended'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'paused'
  | 'creating'
  | 'activating'
  | 'cancelling';

export interface PlatformRouteDescriptor {
  readonly authority: 'platform';
  readonly route: SessionRoute;
  readonly roomId?: string;
  readonly status: PlatformRouteDescriptorStatus;
}

export type PlatformRouteProbe =
  | {
      readonly kind: 'platform';
      readonly descriptor: PlatformRouteDescriptor;
    }
  | { readonly kind: 'legacy' };

export type PlatformSessionTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> = ClientSessionTransport<Command, Query, Answer, View>;

export type PlatformReplayStatusRequest = Omit<
  ContractGetStatusRequest,
  'accessContext'
>;

export type PlatformReplayTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> = PlatformSessionTransport<Command, Query, Answer, View> & {
  readonly getStatus: (
    request: PlatformReplayStatusRequest,
  ) => Promise<OperationStatus>;
};

const PLATFORM_SESSION_PATH = '/platform/sessions';

function sessionPath(
  route: SessionRoute,
  operation: string,
  seatId?: string,
): string {
  const path = `${PLATFORM_SESSION_PATH}/${encodeURIComponent(route.sessionId)}/${operation}`;
  return seatId === undefined
    ? path
    : `${path}?seatId=${encodeURIComponent(seatId)}`;
}

function sessionPathForId(sessionId: string, operation: string): string {
  return `${PLATFORM_SESSION_PATH}/${encodeURIComponent(sessionId)}/${operation}`;
}

function replayPath(route: SessionRoute, operation: string): string {
  return sessionPath(route, `replay/${operation}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRouteDescriptor(
  value: unknown,
  sessionId: string,
): asserts value is PlatformRouteDescriptor {
  if (!isRecord(value) || value.authority !== 'platform') {
    throw new Error('platform.route.descriptor.invalid');
  }
  assertSessionRoute(value.route);
  if (
    value.roomId !== undefined &&
    (typeof value.roomId !== 'string' || value.roomId.length === 0)
  ) {
    throw new Error('platform.route.room.invalid');
  }
  if (value.route.sessionId !== sessionId) {
    throw new Error('platform.route.descriptor.mismatch');
  }
  if (
    value.status !== 'suspended' &&
    value.status !== 'active' &&
    value.status !== 'completed' &&
    value.status !== 'cancelled' &&
    value.status !== 'paused' &&
    value.status !== 'creating' &&
    value.status !== 'activating' &&
    value.status !== 'cancelling'
  ) {
    throw new Error('platform.route.descriptor.invalid');
  }
}

function responsePlatformError(error: unknown): {
  readonly code?: string;
  readonly messageKey?: string;
} {
  if (!isRecord(error)) return {};
  const normalized = error as {
    readonly responseCode?: unknown;
    readonly responseMessageKey?: unknown;
    readonly response?: { readonly data?: unknown };
    readonly envelope?: {
      readonly code?: unknown;
      readonly messageKey?: unknown;
    };
  };
  if (
    typeof normalized.responseCode === 'string' ||
    typeof normalized.responseMessageKey === 'string'
  ) {
    return {
      ...(typeof normalized.responseCode === 'string'
        ? { code: normalized.responseCode }
        : {}),
      ...(typeof normalized.responseMessageKey === 'string'
        ? { messageKey: normalized.responseMessageKey }
        : {}),
    };
  }
  const responseData = normalized.response?.data;
  if (isRecord(responseData)) {
    return {
      ...(typeof responseData.code === 'string'
        ? { code: responseData.code }
        : {}),
      ...(typeof responseData.messageKey === 'string'
        ? { messageKey: responseData.messageKey }
        : {}),
    };
  }
  if (isRecord(normalized.envelope)) {
    return {
      ...(typeof normalized.envelope.code === 'string'
        ? { code: normalized.envelope.code }
        : {}),
      ...(typeof normalized.envelope.messageKey === 'string'
        ? { messageKey: normalized.envelope.messageKey }
        : {}),
    };
  }
  return {};
}

/** Preserve network uncertainty while normalizing authenticated HTTP rejections. */
export function normalizePlatformRequestError(error: unknown): unknown {
  const envelope = responsePlatformError(error);
  const status = isRecord(error) ? error.status : undefined;
  const code = isErrorCode(envelope.code)
    ? envelope.code
    : status === 401
      ? 'UNAUTHENTICATED'
      : status === 403
        ? 'FORBIDDEN'
        : undefined;
  return code
    ? contractError(
        code,
        envelope.messageKey ?? 'platform.client.requestRejected',
        code === 'STALE_REVISION' ||
          code === 'RATE_LIMITED' ||
          code === 'CONFLICT',
      )
    : error;
}

export function isPlatformSessionNotFound(error: unknown): boolean {
  const response = responsePlatformError(error);
  return (
    response.code === 'NOT_FOUND' &&
    response.messageKey === 'platform.gateway.session.notFound'
  );
}

export async function probePlatformRoute(
  sessionId: string,
  client: PlatformHttpClient,
  mode: 'live' | 'replay' = 'live',
): Promise<PlatformRouteProbe> {
  try {
    const response = await client.get<PlatformRouteDescriptor>(
      sessionPathForId(sessionId, mode === 'replay' ? 'replay/route' : 'route'),
    );
    assertRouteDescriptor(response.data, sessionId);
    return { kind: 'platform', descriptor: response.data };
  } catch (error) {
    if (isPlatformSessionNotFound(error)) return { kind: 'legacy' };
    throw error;
  }
}

/** Probe the read-only replay authority without falling back to a live route. */
export function probePlatformReplayRoute(
  sessionId: string,
  client: PlatformHttpClient,
): Promise<PlatformRouteProbe> {
  return probePlatformRoute(sessionId, client, 'replay');
}

/**
 * Bind the generic common transport to the authenticated platform gateway.
 * The optional route argument is retained for old callers; request routes are
 * still taken from each operation so the session store remains authoritative.
 */
export function createPlatformSessionTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>(
  client: PlatformHttpClient,
  _route?: SessionRoute,
  seatId?: string,
): PlatformSessionTransport<Command, Query, Answer, View> {
  return createSessionTransport<Command, Query, Answer, View>(
    client as GameHttpClientLike,
    {
      path: (route, operation) => sessionPath(route, operation, seatId),
      normalizeError: normalizePlatformRequestError,
    },
  );
}

function replayStatusBody(request: PlatformReplayStatusRequest): JsonValue {
  return {
    ...(request.startId === undefined ? {} : { startId: request.startId }),
    ...(request.commandId === undefined
      ? {}
      : { commandId: request.commandId }),
  };
}

/**
 * Bind the completed-session, read-only replay authority.  Replay requests
 * never exchange a player credential and deliberately have no command route.
 */
export function createPlatformReplayTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>(
  client: PlatformHttpClient,
): PlatformReplayTransport<Command, Query, Answer, View> {
  const transport = createSessionTransport<Command, Query, Answer, View>(
    client as GameHttpClientLike,
    {
      path: (route, operation) => replayPath(route, operation),
      normalizeError: normalizePlatformRequestError,
    },
  );
  return {
    ...transport,
    submitCommand: async () => {
      throw contractError('FORBIDDEN', 'platform.replay.commandsForbidden');
    },
    getStatus: async (request) => {
      try {
        return (
          await client.post<OperationStatus>(
            replayPath(request.route, 'status'),
            replayStatusBody(request),
          )
        ).data;
      } catch (error) {
        throw normalizePlatformRequestError(error);
      }
    },
  };
}
