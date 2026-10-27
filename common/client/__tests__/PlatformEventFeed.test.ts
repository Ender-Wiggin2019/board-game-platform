import type { GetEventsResponse, SessionRoute } from '@board-game/contracts';
import { MAX_EVENT_READ_LIMIT } from '@board-game/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ClientSessionTransport } from '../src/ClientSessionStore.js';
import {
  PLATFORM_EVENT_FEED_MAX_BYTES,
  PLATFORM_EVENT_FEED_MAX_EVENTS,
  PlatformEventFeed,
} from '../src/PlatformEventFeed.js';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'room',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'ownership-1',
};

function event(sequence: number, payload: string | number = sequence) {
  return {
    sequence,
    eventId: `event-${sequence}`,
    payload,
  } as const;
}

function response(
  events: readonly ReturnType<typeof event>[],
  options: Partial<
    Pick<
      GetEventsResponse,
      'audienceKey' | 'viewEpoch' | 'nextSequence' | 'hasMore' | 'resetRequired'
    >
  > = {},
): GetEventsResponse {
  return {
    gameId: route.gameId,
    sessionId: route.sessionId,
    releaseId: route.releaseId,
    audienceKey: options.audienceKey ?? 'audience-a',
    viewEpoch: options.viewEpoch ?? 'epoch-a',
    nextSequence: options.nextSequence ?? events.at(-1)?.sequence ?? 0,
    hasMore: options.hasMore ?? false,
    events,
    resetRequired: options.resetRequired ?? false,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function transport(
  getEvents: ClientSessionTransport['getEvents'],
): ClientSessionTransport {
  return {
    getPlayerView: vi.fn(async () => {
      throw new Error('unused');
    }),
    getEvents,
    resume: vi.fn(async () => {
      throw new Error('unused');
    }),
    submitCommand: vi.fn(async () => {
      throw new Error('unused');
    }),
    queryOptions: vi.fn(async () => {
      throw new Error('unused');
    }),
  };
}

describe('PlatformEventFeed', () => {
  it('retains a bounded count and exposes the oldest retained sequence', async () => {
    const feed = new PlatformEventFeed(
      route,
      transport(
        vi.fn(async () =>
          response(
            Array.from({ length: 600 }, (_, index) => event(index + 1)),
            { nextSequence: 600, hasMore: false },
          ),
        ),
      ),
    );

    await feed.read({ limit: 200 });

    const state = feed.getState();
    expect(state.events).toHaveLength(PLATFORM_EVENT_FEED_MAX_EVENTS);
    expect(state.oldestSequence).toBe(101);
    expect(state.truncated).toBe(true);
    expect(state.nextSequence).toBe(600);
  });

  it('evicts by encoded bytes as well as count', async () => {
    const events = [
      event(1, 'a'.repeat(800_000)),
      event(2, 'b'.repeat(800_000)),
      event(3, 'c'.repeat(800_000)),
    ];
    const feed = new PlatformEventFeed(
      route,
      transport(vi.fn(async () => response(events))),
    );

    await feed.read();

    const state = feed.getState();
    const retainedBytes = new TextEncoder().encode(
      JSON.stringify(state.events),
    ).byteLength;
    expect(state.events.length).toBeLessThan(events.length);
    expect(retainedBytes).toBeLessThanOrEqual(PLATFORM_EVENT_FEED_MAX_BYTES);
    expect(state.oldestSequence).toBe(2);
    expect(state.truncated).toBe(true);
  });

  it('keeps the server cursor when an explicit older page overlaps the retained window', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(
        response([event(1), event(2), event(3), event(4)], {
          nextSequence: 4,
          hasMore: true,
        }),
      )
      .mockResolvedValueOnce(
        response([event(1), event(2)], { nextSequence: 2, hasMore: false }),
      )
      .mockResolvedValueOnce(
        response([event(5), event(6)], { nextSequence: 6, hasMore: false }),
      );
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read();
    await feed.read({ afterSequence: 0 });
    expect(feed.getState()).toMatchObject({ nextSequence: 4, hasMore: true });
    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);

    await feed.read();
    expect(feed.getState()).toMatchObject({ nextSequence: 6, hasMore: false });
    expect(getEvents).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      route,
      afterSequence: 4,
      limit: 200,
      viewEpoch: 'epoch-a',
    });
  });

  it('supports replacing a bounded history window and advancing it independently', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(response([event(9)], { nextSequence: 9 }))
      .mockResolvedValueOnce(
        response([event(1), event(2)], { nextSequence: 2, hasMore: true }),
      )
      .mockResolvedValueOnce(
        response([event(3), event(4)], { nextSequence: 4, hasMore: false }),
      );
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read();
    await feed.read({ afterSequence: 0, replace: true, window: 'history' });
    expect(feed.getState()).toMatchObject({
      window: 'history',
      nextSequence: 2,
      oldestSequence: 1,
    });

    await feed.read();
    expect(feed.getState()).toMatchObject({
      window: 'history',
      nextSequence: 4,
      oldestSequence: 1,
    });
    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('restores the committed latest window after an earliest-page failure and retries that page', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(
        response([event(3), event(4)], { nextSequence: 4, hasMore: true }),
      )
      .mockRejectedValueOnce(new Error('earliest page unavailable'))
      .mockResolvedValueOnce(
        response([event(1), event(2)], { nextSequence: 2, hasMore: false }),
      );
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read();
    const committed = feed.getState();
    await expect(
      feed.read({ afterSequence: 0, replace: true, window: 'history' }),
    ).rejects.toThrow('earliest page unavailable');

    expect(feed.getState()).toMatchObject({
      window: 'latest',
      nextSequence: committed.nextSequence,
      hasMore: committed.hasMore,
      oldestSequence: committed.oldestSequence,
      failedRead: {
        afterSequence: 0,
        limit: MAX_EVENT_READ_LIMIT,
        viewEpoch: 'epoch-a',
        replace: true,
        window: 'history',
      },
    });
    expect(feed.getState().events).toEqual(committed.events);

    const failedRead = feed.getState().failedRead;
    if (!failedRead) throw new Error('Missing failed event read');
    await feed.read(failedRead);
    expect(getEvents).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      route,
      afterSequence: 0,
      limit: MAX_EVENT_READ_LIMIT,
      viewEpoch: 'epoch-a',
    });
    expect(feed.getState()).toMatchObject({
      window: 'history',
      failedRead: null,
      oldestSequence: 1,
    });
  });

  it('restores the committed history window after a latest-page failure and retries that page', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(
        response([event(1), event(2)], { nextSequence: 2, hasMore: true }),
      )
      .mockRejectedValueOnce(new Error('latest page unavailable'))
      .mockResolvedValueOnce(response([event(9)], { nextSequence: 9 }));
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read({ afterSequence: 0, replace: true, window: 'history' });
    const committed = feed.getState();
    await expect(
      feed.read({ afterSequence: 2, replace: true, window: 'latest' }),
    ).rejects.toThrow('latest page unavailable');

    expect(feed.getState()).toMatchObject({
      window: 'history',
      nextSequence: committed.nextSequence,
      hasMore: committed.hasMore,
      oldestSequence: committed.oldestSequence,
      failedRead: {
        afterSequence: 2,
        limit: MAX_EVENT_READ_LIMIT,
        viewEpoch: 'epoch-a',
        replace: true,
        window: 'latest',
      },
    });
    expect(feed.getState().events).toEqual(committed.events);

    const failedRead = feed.getState().failedRead;
    if (!failedRead) throw new Error('Missing failed event read');
    await feed.read(failedRead);
    expect(getEvents).toHaveBeenLastCalledWith({
      protocolVersion: 1,
      route,
      afterSequence: 2,
      limit: MAX_EVENT_READ_LIMIT,
      viewEpoch: 'epoch-a',
    });
    expect(feed.getState()).toMatchObject({
      window: 'latest',
      failedRead: null,
      oldestSequence: 9,
    });
  });

  it('exposes loading and failure state, then clears the failure on retry', async () => {
    const getEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(response([event(1)]));
    const feed = new PlatformEventFeed(route, transport(getEvents));
    const states: boolean[] = [];
    feed.subscribe((state) => states.push(state.loading));

    await expect(feed.read()).rejects.toThrow('network down');
    expect(feed.getState().loading).toBe(false);
    expect(feed.getState().error?.message).toBe('network down');
    expect(feed.getState().failedRead).toEqual({
      afterSequence: 0,
      limit: MAX_EVENT_READ_LIMIT,
    });

    await feed.read();
    expect(feed.getState()).toMatchObject({ loading: false, error: null });
    expect(states).toEqual([false, true, false, true, false]);
  });

  it('fences overlapping reads so a late older page cannot replace newer state', async () => {
    const first = deferred<GetEventsResponse>();
    const second = deferred<GetEventsResponse>();
    const getEvents = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const feed = new PlatformEventFeed(route, transport(getEvents));
    const listener = vi.fn();

    feed.subscribe(listener);
    const firstRead = feed.read();
    const secondRead = feed.read();
    second.resolve(response([event(2)], { nextSequence: 2 }));
    await secondRead;
    first.resolve(response([event(1)], { nextSequence: 1 }));
    await firstRead;

    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([2]);
    expect(feed.getState().nextSequence).toBe(2);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('ignores a late failure from an older overlapping read', async () => {
    const first = deferred<GetEventsResponse>();
    const second = deferred<GetEventsResponse>();
    const getEvents = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const feed = new PlatformEventFeed(route, transport(getEvents));

    const firstRead = feed.read({
      afterSequence: 0,
      replace: true,
      window: 'history',
    });
    const secondRead = feed.read({
      afterSequence: 0,
      replace: true,
      window: 'latest',
    });
    second.resolve(response([event(2)], { nextSequence: 2 }));
    await secondRead;
    first.reject(new Error('late older failure'));
    await expect(firstRead).rejects.toThrow('late older failure');

    expect(feed.getState()).toMatchObject({
      window: 'latest',
      nextSequence: 2,
      failedRead: null,
      error: null,
    });
    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([2]);
  });

  it('uses the committed window when a no-window read completes during an older history read', async () => {
    const pendingHistory = deferred<GetEventsResponse>();
    const pendingLatest = deferred<GetEventsResponse>();
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(response([event(1)], { nextSequence: 1 }))
      .mockImplementationOnce(() => pendingHistory.promise)
      .mockImplementationOnce(() => pendingLatest.promise);
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read();
    const historyRead = feed.read({
      afterSequence: 0,
      replace: true,
      window: 'history',
    });
    const latestRead = feed.read();
    pendingLatest.resolve(response([event(2)], { nextSequence: 2 }));
    await latestRead;
    pendingHistory.reject(new Error('late history failure'));
    await expect(historyRead).rejects.toThrow('late history failure');

    expect(feed.getState()).toMatchObject({
      window: 'latest',
      nextSequence: 2,
      failedRead: null,
      error: null,
    });
    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([
      1, 2,
    ]);
  });

  it('resets retained private state when the server audience changes', async () => {
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(
        response([event(1), event(2)], { nextSequence: 2 }),
      )
      .mockResolvedValueOnce(
        response([event(9)], {
          audienceKey: 'audience-b',
          viewEpoch: 'epoch-b',
          nextSequence: 9,
        }),
      );
    const feed = new PlatformEventFeed(route, transport(getEvents));

    await feed.read();
    await feed.read();

    expect(feed.getState()).toMatchObject({
      audienceKey: 'audience-b',
      viewEpoch: 'epoch-b',
      oldestSequence: 9,
      truncated: false,
    });
    expect(feed.getState().events.map(({ sequence }) => sequence)).toEqual([9]);
  });

  it('does not notify or apply a pending read after disposal', async () => {
    const pending = deferred<GetEventsResponse>();
    const feed = new PlatformEventFeed(
      route,
      transport(vi.fn(() => pending.promise)),
    );
    const listener = vi.fn();
    feed.subscribe(listener);
    const read = feed.read();
    feed.dispose();
    pending.resolve(response([event(1)]));
    await read;

    expect(listener).toHaveBeenCalledTimes(2);
    expect(feed.getState().events).toEqual([]);
    await expect(feed.read()).rejects.toThrow('platform.eventFeed.closed');
  });
  it('clears history on revocation and rejects a late authorized response from the old epoch', async () => {
    const late = deferred<GetEventsResponse>();
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce(response([event(1, 'private')]))
      .mockImplementationOnce(() => late.promise);
    const feed = new PlatformEventFeed(route, transport(getEvents));
    await feed.read();
    const pending = feed.read();
    feed.reset();
    late.resolve(response([event(2, 'old-private')]));
    await pending;
    expect(feed.getState()).toMatchObject({
      events: [],
      audienceKey: null,
      loading: false,
      failedRead: null,
    });
  });

  it('fences a late failed read after revocation', async () => {
    const late = deferred<GetEventsResponse>();
    const feed = new PlatformEventFeed(
      route,
      transport(vi.fn(() => late.promise)),
    );
    const pending = feed.read({
      afterSequence: 0,
      replace: true,
      window: 'history',
    });
    feed.reset();
    late.reject(new Error('old-private failure'));
    await expect(pending).rejects.toThrow('old-private failure');

    expect(feed.getState()).toMatchObject({
      events: [],
      audienceKey: null,
      loading: false,
      window: 'latest',
      failedRead: null,
    });
  });
});
