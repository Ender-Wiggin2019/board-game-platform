import type { GameSessionSignals } from '@board-game/client';
import {
  type ApplyViewDelta,
  type ClientCommandIntent,
  type ClientSessionState,
  ClientSessionStore,
  type ClientSessionTransport,
  PlatformEventFeed,
  type PlatformEventFeedState,
  type PlatformEventReadOptions,
} from '@board-game/client';
import type {
  CommandPrecondition,
  GetEventsResponse,
  JsonValue,
  QueryOptionsResponse,
  SessionRoute,
  SubmitCommandResponse,
} from '@board-game/contracts';
import { MAX_EVENT_READ_LIMIT } from '@board-game/contracts';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const PLATFORM_FALLBACK_POLL_MS = 5_000;

export interface GameSessionProviderProps<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  /** Frozen route selected by the authenticated platform session resolver. */
  readonly route: SessionRoute;
  readonly transport: ClientSessionTransport<Command, Query, Answer, View>;
  /** Opaque client identity marker; it never enters a platform request. */
  readonly identityKey?: string | null;
  /** Host-provided revision and foreground signals. */
  readonly signals?: GameSessionSignals;
  readonly applyDelta?: ApplyViewDelta<View>;
  readonly loadOnMount?: boolean;
  readonly children: ReactNode;
}

export interface GameSessionContextValue<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  readonly route: SessionRoute;
  readonly state: ClientSessionState<Command, Answer, View>;
  readonly events: PlatformEventFeedState;
  readonly store: ClientSessionStore<Command, Query, Answer, View>;
  readonly load: () => Promise<void>;
  readonly resume: () => Promise<void>;
  /** Refresh the same authoritative store after a revision hint. */
  readonly invalidate: (revision?: number) => Promise<void>;
  readonly submitCommand: (
    intent: ClientCommandIntent<Command>,
  ) => Promise<SubmitCommandResponse<View>>;
  /** Submit a game action using the snapshot prompt fence by default. */
  readonly submitAction: (
    commandId: string,
    command: Command,
    explicitPrecondition?: CommandPrecondition,
  ) => Promise<SubmitCommandResponse<View>>;
  readonly retryPending: () => Promise<SubmitCommandResponse<View>>;
  readonly queryOptions: (
    query: Query,
    revision?: number,
  ) => Promise<QueryOptionsResponse<Answer>>;
  readonly readEvents: (
    options?: PlatformEventReadOptions,
  ) => Promise<GetEventsResponse>;
}

const GameSessionContext = createContext<GameSessionContextValue | null>(null);

const ROUTE_KEYS: readonly (keyof SessionRoute)[] = [
  'gameId',
  'modeId',
  'sessionId',
  'releaseId',
  'backendBindingId',
  'storageBindingId',
  'ownershipEpoch',
];

function routeKey(route: SessionRoute): string {
  return ROUTE_KEYS.map((key) => `${String(key)}:${String(route[key])}`).join(
    '|',
  );
}

/**
 * Opt-in provider for a platform-owned session.  It creates one
 * ClientSessionStore and one bounded public event feed for the pinned route;
 * it never attaches legacy Socket.IO state, event, or narrative handlers.
 */
export function GameSessionProvider<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>({
  route,
  identityKey,
  ...props
}: GameSessionProviderProps<Command, Query, Answer, View>): React.JSX.Element {
  return (
    <GameSessionProviderInstance
      key={JSON.stringify([routeKey(route), identityKey ?? null])}
      route={route}
      identityKey={identityKey}
      {...props}
    />
  );
}

function GameSessionProviderInstance<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>({
  route,
  transport,
  identityKey = null,
  signals,
  applyDelta,
  loadOnMount = true,
  children,
}: GameSessionProviderProps<Command, Query, Answer, View>): React.JSX.Element {
  const pinnedRouteKey = routeKey(route);
  const store = useMemo(
    () =>
      new ClientSessionStore<Command, Query, Answer, View>({
        route,
        transport,
        applyDelta,
        identityKey,
      }),
    [applyDelta, pinnedRouteKey, transport],
  );
  const eventFeed = useMemo(
    () => new PlatformEventFeed<Command, Query, Answer, View>(route, transport),
    [identityKey, pinnedRouteKey, transport],
  );
  const [state, setState] = useState(() => store.getState());
  const [events, setEvents] = useState<PlatformEventFeedState>(() =>
    eventFeed.getState(),
  );
  const lifecycleEpochs = useRef(new Map<object, number>());
  const loadedKeys = useRef(new Set<string>());
  const resumeInFlight = useRef<Promise<void> | null>(null);
  const pendingHintRevision = useRef<number | null>(null);
  const eventReadSnapshot = useRef<string | null>(null);

  useEffect(() => {
    store.setIdentity(identityKey ?? null);
    setState(store.getState());
    const unsubscribe = store.subscribe(setState);
    const loadKey = `${pinnedRouteKey}:${identityKey ?? ''}`;
    if (loadOnMount && !loadedKeys.current.has(loadKey)) {
      loadedKeys.current.add(loadKey);
      void store.load().catch(() => undefined);
    }
    return unsubscribe;
  }, [identityKey, loadOnMount, pinnedRouteKey, store]);

  useEffect(() => {
    setEvents(eventFeed.getState());
    return eventFeed.subscribe(setEvents);
  }, [eventFeed]);

  useEffect(() => {
    const snapshot = state.snapshot;
    if (!snapshot) {
      eventReadSnapshot.current = null;
      if (eventFeed.getState().audienceKey !== null) eventFeed.reset();
      return;
    }
    const snapshotKey = [
      pinnedRouteKey,
      identityKey ?? '',
      snapshot.audienceKey,
      snapshot.viewEpoch,
      snapshot.revision,
      snapshot.eventSequence ?? '',
    ].join(':');
    if (eventReadSnapshot.current === snapshotKey) return;
    eventReadSnapshot.current = snapshotKey;

    const currentEvents = eventFeed.getState();
    const audienceChanged =
      currentEvents.audienceKey !== null &&
      (currentEvents.audienceKey !== snapshot.audienceKey ||
        currentEvents.viewEpoch !== snapshot.viewEpoch);
    if (currentEvents.window === 'history' && !audienceChanged) return;
    const needsRecentWindow =
      currentEvents.audienceKey === null ||
      audienceChanged ||
      (snapshot.eventSequence !== undefined &&
        snapshot.eventSequence - currentEvents.nextSequence >
          MAX_EVENT_READ_LIMIT);
    const afterSequence = needsRecentWindow
      ? snapshot.eventSequence === undefined
        ? 0
        : Math.max(0, snapshot.eventSequence - MAX_EVENT_READ_LIMIT)
      : currentEvents.nextSequence;
    void eventFeed
      .read({
        afterSequence,
        viewEpoch: snapshot.viewEpoch,
        ...(needsRecentWindow
          ? { replace: true, window: 'latest' as const }
          : {}),
      })
      .catch((error) => {
        store.invalidateAccess(error);
      });
  }, [
    eventFeed,
    identityKey,
    pinnedRouteKey,
    state.snapshot?.audienceKey,
    state.snapshot?.eventSequence,
    state.snapshot?.revision,
    state.snapshot?.viewEpoch,
    store,
  ]);

  useEffect(() => {
    const resources = [store as object, eventFeed as object];
    const epoch = Math.max(
      ...resources.map(
        (resource) => (lifecycleEpochs.current.get(resource) ?? 0) + 1,
      ),
    );
    for (const resource of resources) {
      lifecycleEpochs.current.set(resource, epoch);
    }
    return () => {
      // React StrictMode replays effects without replacing the provider. A
      // microtask fence avoids disposing the live store during that probe,
      // while route changes still dispose the old resources promptly.
      queueMicrotask(() => {
        const stillCurrent = resources.every(
          (resource) => lifecycleEpochs.current.get(resource) === epoch,
        );
        if (!stillCurrent) return;
        for (const resource of resources)
          lifecycleEpochs.current.delete(resource);
        store.dispose();
        eventFeed.dispose();
      });
    };
  }, [eventFeed, store]);

  const invalidate = useCallback(
    (revision?: number): Promise<void> => {
      const refresh = (
        requestedRevision?: number,
        allowFollowUp = true,
      ): Promise<void> => {
        const current = store.getState();
        if (current.status === 'closed') return Promise.resolve();
        const currentRevision = current.snapshot?.revision;
        if (
          requestedRevision !== undefined &&
          (!Number.isSafeInteger(requestedRevision) ||
            (currentRevision !== undefined &&
              requestedRevision <= currentRevision))
        ) {
          return Promise.resolve();
        }
        if (requestedRevision !== undefined) {
          pendingHintRevision.current = Math.max(
            pendingHintRevision.current ?? requestedRevision,
            requestedRevision,
          );
        }
        if (resumeInFlight.current) return resumeInFlight.current;

        const request = store.resume().catch(() => undefined);
        resumeInFlight.current = request;
        void request.finally(() => {
          if (resumeInFlight.current !== request) return;
          resumeInFlight.current = null;
          const pendingRevision = pendingHintRevision.current;
          pendingHintRevision.current = null;
          const nextState = store.getState();
          const nextRevision = nextState.snapshot?.revision;
          // A failed refresh leaves the store in error.  Do not turn one
          // socket hint into an unbounded retry loop.  A successful refresh
          // gets at most one follow-up for hints received while it was in
          // flight; the normal visibility poll/socket hint can retry later.
          if (
            allowFollowUp &&
            nextState.status === 'ready' &&
            pendingRevision !== null &&
            (nextRevision === undefined || pendingRevision > nextRevision)
          ) {
            void refresh(pendingRevision, false);
          }
        });
        return request;
      };
      return refresh(revision);
    },
    [store],
  );

  useEffect(() => {
    if (!signals) return undefined;
    return signals.subscribeRevision(route.sessionId, ({ revision }) => {
      void invalidate(revision);
    });
  }, [identityKey, invalidate, route.sessionId, signals]);

  useEffect(() => {
    if (
      !signals ||
      typeof document === 'undefined' ||
      typeof window === 'undefined'
    )
      return undefined;
    let lastReported: boolean | undefined;
    const isForeground = (): boolean =>
      document.visibilityState === 'visible' && document.hasFocus();
    const report = (active: boolean, force = false): void => {
      if (!force && lastReported === active) return;
      // The platform socket may connect after this provider mounts. Keep the
      // lifecycle listeners alive while disconnected, but leave delivery to
      // the signal adapter and retry on the next forced heartbeat.
      if (signals.isConnected === false) {
        lastReported = undefined;
        return;
      }
      signals.setForeground(route.sessionId, active);
      lastReported = active;
    };
    const refresh = (): void => report(isForeground());
    const hide = (): void => report(false);
    const resume = (): void => report(isForeground(), true);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', refresh);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    const interval = window.setInterval(() => {
      if (isForeground()) report(true, true);
    }, 30_000);
    refresh();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('blur', refresh);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
      if (signals.isConnected !== false)
        signals.setForeground(route.sessionId, false);
    };
  }, [identityKey, route.sessionId, signals]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void invalidate();
    };
    const poll = window.setInterval(
      refreshWhenVisible,
      PLATFORM_FALLBACK_POLL_MS,
    );
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [invalidate]);

  const load = useCallback(() => store.load(), [store]);
  const resume = useCallback(() => store.resume(), [store]);
  const submitCommand = useCallback(
    (intent: ClientCommandIntent<Command>) => store.submitCommand(intent),
    [store],
  );
  const submitAction = useCallback(
    (
      commandId: string,
      command: Command,
      explicitPrecondition?: CommandPrecondition,
    ) => store.submitAction(commandId, command, explicitPrecondition),
    [store],
  );
  const retryPending = useCallback(() => store.retryPending(), [store]);
  const queryOptions = useCallback(
    (query: Query, revision?: number) => store.queryOptions(query, revision),
    [store],
  );
  const readEvents = useCallback(
    async (options?: PlatformEventReadOptions) => {
      try {
        return await eventFeed.read(options);
      } catch (error) {
        store.invalidateAccess(error);
        throw error;
      }
    },
    [eventFeed, store],
  );

  const value = useMemo<GameSessionContextValue<Command, Query, Answer, View>>(
    () => ({
      route: state.route,
      state,
      events,
      store,
      load,
      resume,
      invalidate,
      submitCommand,
      submitAction,
      retryPending,
      queryOptions,
      readEvents,
    }),
    [
      events,
      load,
      invalidate,
      queryOptions,
      readEvents,
      retryPending,
      resume,
      state,
      store,
      submitCommand,
      submitAction,
    ],
  );

  return (
    <GameSessionContext.Provider
      value={value as unknown as GameSessionContextValue}
    >
      {children}
    </GameSessionContext.Provider>
  );
}

export function useGameSession<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
>(): GameSessionContextValue<Command, Query, Answer, View> {
  const context = useContext(GameSessionContext);
  if (!context) {
    throw new Error('useGameSession must be used within GameSessionProvider');
  }
  return context as unknown as GameSessionContextValue<
    Command,
    Query,
    Answer,
    View
  >;
}

/** Compatibility names for legacy game entries during the extraction. */
export type PlatformGameProviderProps<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> = GameSessionProviderProps<Command, Query, Answer, View>;

export type PlatformGameSessionContextValue<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> = GameSessionContextValue<Command, Query, Answer, View>;

export const PlatformGameProvider = GameSessionProvider;
export const usePlatformGameSession = useGameSession;
