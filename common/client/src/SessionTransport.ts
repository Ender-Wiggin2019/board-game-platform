import type {
  GetEventsResponse,
  JsonValue,
  PlayerViewEnvelope,
  QueryOptionsResponse,
  ResumeResult,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import type {
  ClientGetEventsRequest,
  ClientGetPlayerViewRequest,
  ClientQueryOptionsRequest,
  ClientResumeRequest,
  ClientSessionTransport,
  ClientSubmitCommandRequest,
} from './ClientSessionStore.js';

export interface GameHttpClientLike {
  readonly get: <T>(url: string) => Promise<{ readonly data: T }>;
  readonly post: <T>(
    url: string,
    body: JsonValue,
  ) => Promise<{ readonly data: T }>;
}

export interface SessionTransportOptions {
  /** Build the operation URL from the frozen route supplied by the store. */
  readonly path: (route: SessionRoute, operation: string) => string;
  /** Preserve network uncertainty while adapting host-specific errors. */
  readonly normalizeError?: (error: unknown) => unknown;
}

function postBody(
  request:
    | ClientResumeRequest
    | ClientSubmitCommandRequest<JsonValue>
    | ClientQueryOptionsRequest<JsonValue>
    | ClientGetEventsRequest,
): JsonValue {
  if ('commandId' in request) {
    return {
      commandId: request.commandId,
      precondition: request.precondition,
      command: request.command,
    };
  }
  if ('revision' in request) {
    return {
      revision: request.revision,
      query: request.query,
    };
  }
  if ('afterSequence' in request) {
    return {
      afterSequence: request.afterSequence,
      limit: request.limit,
      ...(request.viewEpoch === undefined
        ? {}
        : { viewEpoch: request.viewEpoch }),
    };
  }
  return {
    ...(request.viewerEpoch === undefined
      ? {}
      : { viewerEpoch: request.viewerEpoch }),
    ...(request.streamCursor === undefined
      ? {}
      : { streamCursor: request.streamCursor }),
  };
}

export function createSessionTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>(
  client: GameHttpClientLike,
  options: SessionTransportOptions,
): ClientSessionTransport<Command, Query, Answer, View> {
  async function responseData<T>(
    request: Promise<{ readonly data: T }>,
  ): Promise<T> {
    try {
      return (await request).data;
    } catch (error) {
      throw options.normalizeError?.(error) ?? error;
    }
  }

  return {
    getPlayerView: async (
      request: ClientGetPlayerViewRequest,
    ): Promise<PlayerViewEnvelope<View>> =>
      responseData(
        client.get<PlayerViewEnvelope<View>>(
          options.path(request.route, 'view'),
        ),
      ),
    getEvents: async (
      request: ClientGetEventsRequest,
    ): Promise<GetEventsResponse> =>
      responseData(
        client.post<GetEventsResponse>(
          options.path(request.route, 'events'),
          postBody(request),
        ),
      ),
    resume: async (request: ClientResumeRequest): Promise<ResumeResult<View>> =>
      responseData(
        client.post<ResumeResult<View>>(
          options.path(request.route, 'resume'),
          postBody(request),
        ),
      ),
    submitCommand: async (
      request: ClientSubmitCommandRequest<Command>,
    ): Promise<SubmitCommandResponse<View>> =>
      responseData(
        client.post<SubmitCommandResponse<View>>(
          options.path(request.route, 'commands'),
          postBody(request as ClientSubmitCommandRequest<JsonValue>),
        ),
      ),
    queryOptions: async (
      request: ClientQueryOptionsRequest<Query>,
    ): Promise<QueryOptionsResponse<Answer>> =>
      responseData(
        client.post<QueryOptionsResponse<Answer>>(
          options.path(request.route, 'query'),
          postBody(request as ClientQueryOptionsRequest<JsonValue>),
        ),
      ),
  };
}
