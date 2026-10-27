import type {
  GameEntryRuntime,
  GameHttpClient,
  GameNavigation,
  GameSessionSignals,
  GameViewer,
} from '@board-game/client';
import {
  createPlayerSessionTransport,
  type PlayerConnection,
} from '@board-game/client';
import type { SessionRoute } from '@board-game/contracts';
import { httpClient } from './api/httpClient.js';
import { platformSocket } from './api/platformSocket.js';
import { createPlatformSessionTransport } from './PlatformSessionTransport.js';
import { useAuthStore } from './stores/authStore.js';

export type {
  GameEntryRuntime,
  GameHttpClient,
  GameNavigation,
  GameSessionSignals,
  GameViewer,
};

/** Transitional alias for platform-owned callers. */
export type PlatformSessionSignals = GameSessionSignals;

export interface BrowserPlatformRuntimeOptions {
  /** Use the authenticated platform-issued player credential instead of the proxy gateway. */
  readonly directSessions?: boolean;
  /** The entry kind may override this for spectate/replay; player is the safe default. */
  readonly sessionMode?: PlatformConnectionMode;
}

export type PlatformConnectionMode = 'player' | 'viewer';

type ModeAwareSessionHost = GameEntryRuntime['session'] & {
  readonly createTransportForMode?: (
    mode: PlatformConnectionMode,
    route: SessionRoute,
    seatId?: string,
  ) => ReturnType<GameEntryRuntime['session']['createTransport']>;
};

function connectionPath(sessionId: string): string {
  return `/platform/sessions/${encodeURIComponent(sessionId)}/connection`;
}

async function connectPlayer(
  route: SessionRoute,
  seatId: string | undefined,
  mode: PlatformConnectionMode,
): Promise<PlayerConnection> {
  const response = await httpClient.post<PlayerConnection>(
    connectionPath(route.sessionId),
    { mode },
    {
      // A game binding can be offline while platform results remain readable.
      // The session UI owns this failure; it must not cover the platform shell.
      showServerUpdateDialog: false,
      ...(seatId === undefined ? {} : { params: { seatId } }),
    },
  );
  return response.data;
}

/** Add the authoritative entry kind to a direct-session runtime when needed. */
export function withPlatformConnectionMode(
  runtime: GameEntryRuntime,
  mode: PlatformConnectionMode,
): GameEntryRuntime {
  const session = runtime.session as ModeAwareSessionHost;
  if (!session.createTransportForMode) return runtime;
  return {
    ...runtime,
    session: {
      ...session,
      createTransport: (route, seatId) =>
        session.createTransportForMode?.(mode, route, seatId) ??
        session.createTransport(route, seatId),
    } as GameEntryRuntime['session'],
  };
}

/** Both games share the existing authenticated HTTP client, account store and platform socket. */
export function createBrowserPlatformRuntime(
  options: BrowserPlatformRuntimeOptions = {},
): GameEntryRuntime {
  const signals: GameSessionSignals = {
    subscribeRevision(sessionId, listener) {
      return platformSocket.onPlatformChanged(sessionId, listener);
    },
    setForeground(sessionId, active) {
      platformSocket.setPlatformForeground(sessionId, active);
    },
    get isConnected() {
      return platformSocket.isConnected;
    },
  };
  const http: GameHttpClient = httpClient;
  const directSessions = options.directSessions === true;
  const sessionMode = options.sessionMode ?? 'player';
  let selectedSeatId: string | undefined;
  const createTransportForMode = <
    Command extends
      import('@board-game/contracts').JsonValue = import('@board-game/contracts').JsonValue,
    Query extends
      import('@board-game/contracts').JsonValue = import('@board-game/contracts').JsonValue,
    Answer extends
      import('@board-game/contracts').JsonValue = import('@board-game/contracts').JsonValue,
    View extends
      import('@board-game/contracts').JsonValue = import('@board-game/contracts').JsonValue,
  >(
    mode: PlatformConnectionMode,
    route: SessionRoute,
    seatId?: string,
  ) =>
    directSessions
      ? createPlayerSessionTransport<Command, Query, Answer, View>({
          route,
          connect: () => connectPlayer(route, seatId, mode),
          allowInsecureLocalhost: true,
        })
      : createPlatformSessionTransport<Command, Query, Answer, View>(
          http,
          route,
          seatId,
        );
  return {
    http,
    signals,
    session: {
      signals,
      get selectedSeatId() {
        return selectedSeatId;
      },
      selectSeat(seatId) {
        selectedSeatId = seatId;
      },
      createTransport(route, seatId) {
        return createTransportForMode(sessionMode, route, seatId);
      },
      createTransportForMode,
    } as GameEntryRuntime['session'],
    viewer: {
      get principalId() {
        return useAuthStore.getState().user?.id;
      },
      get accountPrincipalId() {
        return useAuthStore.getState().user?.id;
      },
      get identityKey() {
        const state = useAuthStore.getState();
        return state.user ? `${state.authEpoch}:${state.user.id}` : null;
      },
    },
    navigation: {
      platformHref: '/',
      feedbackHref: (route) =>
        route
          ? `/platform/feedback?gameId=${encodeURIComponent(route.gameId)}&sessionId=${encodeURIComponent(route.sessionId)}`
          : '/platform/feedback',
      replayHref: (route) =>
        `/game/${encodeURIComponent(route.sessionId)}/replay`,
      navigate(target, route) {
        window.location.assign(
          target === 'replay' && route
            ? `/game/${encodeURIComponent(route.sessionId)}/replay`
            : route
              ? `/games/${encodeURIComponent(route.gameId)}/lobby`
              : '/',
        );
      },
    },
  };
}
