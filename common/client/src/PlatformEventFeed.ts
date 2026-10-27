import {
  type GetEventsResponse,
  isJsonValue,
  type JsonValue,
  MAX_EVENT_READ_LIMIT,
  type ProjectedEvent,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  ClientGetEventsRequest,
  ClientSessionTransport,
} from './ClientSessionStore.js';

/** The feed retains a finite window even when a caller pages through a long log. */
export const PLATFORM_EVENT_FEED_MAX_EVENTS = 500;
export const PLATFORM_EVENT_FEED_MAX_BYTES = 2 * 1024 * 1024;

export type PlatformEventFeedWindow = 'latest' | 'history';

export interface PlatformEventReadOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
  readonly viewEpoch?: string;
  /** Replace the bounded window instead of merging this page into it. */
  readonly replace?: boolean;
  /** The browsing window represented by a replacement read. */
  readonly window?: PlatformEventFeedWindow;
}

export interface PlatformEventFeedState {
  readonly audienceKey: string | null;
  readonly viewEpoch: string | null;
  readonly window: PlatformEventFeedWindow;
  /** The exact bounded read that most recently failed, if any. */
  readonly failedRead: PlatformEventReadOptions | null;
  /** Forward cursor returned by the server. It is independent of local eviction. */
  readonly nextSequence: number;
  readonly hasMore: boolean;
  readonly resetRequired: boolean;
  /** Sequence of the oldest retained event, or null when the window is empty. */
  readonly oldestSequence: number | null;
  /** True once retention evicted an event because of a local bound. */
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
  /** Public projected events, ordered by the server sequence. */
  readonly events: readonly ProjectedEvent[];
}

export type PlatformEventFeedListener = (state: PlatformEventFeedState) => void;

const EMPTY_STATE: PlatformEventFeedState = {
  audienceKey: null,
  viewEpoch: null,
  window: 'latest',
  failedRead: null,
  nextSequence: 0,
  hasMore: false,
  resetRequired: false,
  oldestSequence: null,
  truncated: false,
  loading: false,
  error: null,
  events: [],
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function encodedEventBytes(event: ProjectedEvent): number {
  const encoded = JSON.stringify(event);
  if (encoded === undefined)
    throw new Error('platform.eventFeed.event.invalid');
  return new TextEncoder().encode(encoded).byteLength;
}

function assertValidReadInput(options: PlatformEventReadOptions): void {
  const afterSequence = options.afterSequence ?? 0;
  const limit = options.limit ?? MAX_EVENT_READ_LIMIT;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error('platform.eventFeed.afterSequence.invalid');
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_EVENT_READ_LIMIT
  ) {
    throw new Error('platform.eventFeed.limit.invalid');
  }
  if (options.viewEpoch !== undefined && options.viewEpoch.length === 0) {
    throw new Error('platform.eventFeed.viewEpoch.invalid');
  }
  if (
    options.window !== undefined &&
    options.window !== 'latest' &&
    options.window !== 'history'
  ) {
    throw new Error('platform.eventFeed.window.invalid');
  }
}

function assertResponseRoute(
  response: GetEventsResponse,
  route: SessionRoute,
): void {
  if (
    response.gameId !== route.gameId ||
    response.sessionId !== route.sessionId ||
    response.releaseId !== route.releaseId ||
    !Number.isSafeInteger(response.nextSequence) ||
    response.nextSequence < 0 ||
    typeof response.audienceKey !== 'string' ||
    typeof response.viewEpoch !== 'string' ||
    typeof response.hasMore !== 'boolean' ||
    typeof response.resetRequired !== 'boolean' ||
    !Array.isArray(response.events)
  ) {
    throw new Error('platform.eventFeed.response.invalid');
  }
  for (const event of response.events) {
    if (
      !event ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      typeof event.eventId !== 'string' ||
      !isJsonValue(event.payload)
    ) {
      throw new Error('platform.eventFeed.event.invalid');
    }
  }
}

/**
 * Bounded public event reads for a platform session. A platform page owns one
 * feed and can read the next server-authorized page when the history view needs
 * it. The feed never subscribes to the legacy socket receiver.
 */
export class PlatformEventFeed<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  private readonly route: SessionRoute;
  private readonly transport: ClientSessionTransport<
    Command,
    Query,
    Answer,
    View
  >;
  private readonly listeners = new Set<PlatformEventFeedListener>();
  private state: PlatformEventFeedState = EMPTY_STATE;
  /** The browsing window represented by the last successfully applied page. */
  private committedWindow: PlatformEventFeedWindow = EMPTY_STATE.window;
  private generation = 0;
  private operation = 0;
  private disposed = false;

  public constructor(
    route: SessionRoute,
    transport: ClientSessionTransport<Command, Query, Answer, View>,
  ) {
    this.route = copy(route);
    this.transport = transport;
  }

  public getState(): PlatformEventFeedState {
    return copy(this.state);
  }

  public subscribe(listener: PlatformEventFeedListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  public async read(
    options: PlatformEventReadOptions = {},
  ): Promise<GetEventsResponse> {
    if (this.disposed) throw new Error('platform.eventFeed.closed');
    assertValidReadInput(options);
    const generation = this.generation;
    const operation = ++this.operation;
    const afterSequence = options.afterSequence ?? this.state.nextSequence;
    const limit = options.limit ?? MAX_EVENT_READ_LIMIT;
    const viewEpoch =
      options.viewEpoch === undefined
        ? this.state.viewEpoch === null
          ? undefined
          : this.state.viewEpoch
        : options.viewEpoch;
    const request: ClientGetEventsRequest = {
      protocolVersion: 1,
      route: copy(this.route),
      afterSequence,
      limit,
      ...(viewEpoch === undefined ? {} : { viewEpoch }),
    };
    const failedRead: PlatformEventReadOptions = {
      afterSequence,
      limit,
      ...(viewEpoch === undefined ? {} : { viewEpoch }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
      ...(options.window === undefined ? {} : { window: options.window }),
    };
    this.setState({
      loading: true,
      error: null,
      ...(options.window === undefined ? {} : { window: options.window }),
    });
    try {
      const response = await this.transport.getEvents(copy(request));
      if (
        this.disposed ||
        generation !== this.generation ||
        operation !== this.operation
      ) {
        return copy(response);
      }
      assertResponseRoute(response, this.route);
      this.apply(response, options.replace === true, options.window);
      return copy(response);
    } catch (error) {
      if (
        !this.disposed &&
        generation === this.generation &&
        operation === this.operation
      ) {
        this.setState({
          loading: false,
          error: errorFrom(error),
          window: this.committedWindow,
          failedRead: copy(failedRead),
        });
      }
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.operation += 1;
    this.listeners.clear();
  }

  /** Revocation clears projected history and fences any in-flight response. */
  public reset(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.operation += 1;
    this.committedWindow = EMPTY_STATE.window;
    this.state = EMPTY_STATE;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private setState(update: Partial<PlatformEventFeedState>): void {
    this.state = { ...this.state, ...update };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private apply(
    response: GetEventsResponse,
    replace: boolean,
    requestedWindow: PlatformEventFeedWindow | undefined,
  ): void {
    const audienceChanged =
      this.state.audienceKey !== null &&
      (this.state.audienceKey !== response.audienceKey ||
        this.state.viewEpoch !== response.viewEpoch);
    const reset = replace || response.resetRequired || audienceChanged;
    const eventsById = new Map(
      (reset ? [] : this.state.events).map((event) => [event.eventId, event]),
    );
    for (const event of response.events) {
      eventsById.set(event.eventId, copy(event));
    }
    const sortedEvents = [...eventsById.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    let retainedBytes = sortedEvents.reduce(
      (total, event) => total + encodedEventBytes(event),
      0,
    );
    let truncated = reset ? false : this.state.truncated;
    while (
      sortedEvents.length > PLATFORM_EVENT_FEED_MAX_EVENTS ||
      retainedBytes > PLATFORM_EVENT_FEED_MAX_BYTES
    ) {
      const evicted = sortedEvents.shift();
      if (evicted === undefined) break;
      retainedBytes -= encodedEventBytes(evicted);
      truncated = true;
    }
    const advancesCursor = response.nextSequence >= this.state.nextSequence;
    const nextSequence =
      reset || advancesCursor ? response.nextSequence : this.state.nextSequence;
    const hasMore =
      reset || advancesCursor ? response.hasMore : this.state.hasMore;
    const window =
      requestedWindow ??
      (replace
        ? 'history'
        : audienceChanged || response.resetRequired
          ? 'latest'
          : this.committedWindow);
    this.committedWindow = window;
    this.state = {
      audienceKey: response.audienceKey,
      viewEpoch: response.viewEpoch,
      window,
      failedRead: null,
      nextSequence,
      hasMore,
      resetRequired: response.resetRequired,
      oldestSequence: sortedEvents[0]?.sequence ?? null,
      truncated,
      loading: false,
      error: null,
      events: sortedEvents,
    };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}
