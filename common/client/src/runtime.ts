import type { JsonValue, SessionRoute } from '@board-game/contracts';
import type { ClientSessionTransport } from './ClientSessionStore.js';
import type { GameDeveloperConsoleRuntime } from './DeveloperConsole.js';

/** The host-provided HTTP surface available to game client adapters. */
export interface GameHttpClient {
  readonly get: <T>(url: string) => Promise<{ readonly data: T }>;
  readonly post: <T>(
    url: string,
    body: JsonValue,
  ) => Promise<{ readonly data: T }>;
}

/** Host lifecycle signals used by the client session provider. */
export interface GameSessionSignals {
  readonly subscribeRevision: (
    sessionId: string,
    listener: (change: { readonly revision: number }) => void,
  ) => () => void;
  readonly setForeground: (sessionId: string, active: boolean) => void;
  readonly isConnected?: boolean;
}

export interface GameViewer {
  readonly principalId?: string;
  /** Account principal used for authentication before a synthetic seat is selected. */
  readonly accountPrincipalId?: string;
  /** Selected public participant seat used by a hot-seat session, when any. */
  readonly seatId?: string;
  /** Opaque key used to fence account/session changes in local stores. */
  readonly identityKey: string | null;
}

export interface GameNavigation {
  readonly platformHref: string;
  /** Authoritative room backing this native session, when supplied by the host. */
  readonly roomHref?: string;
  readonly replayHref: (route: SessionRoute) => string;
  /** Host-owned feedback destination, optionally prefilled for a session. */
  readonly feedbackHref?: (route?: SessionRoute) => string;
  readonly navigate?: (
    target: 'platform' | 'replay',
    route?: SessionRoute,
  ) => void;
}

export interface GameSessionHost {
  readonly signals: GameSessionSignals;
  /** Currently selected synthetic seat for this session, when any. */
  readonly selectedSeatId?: string;
  /** Select a public controlled seat; the host owns the resulting transport reload. */
  readonly selectSeat?: (seatId: string | undefined) => void;
  readonly createTransport: <
    Command extends JsonValue = JsonValue,
    Query extends JsonValue = JsonValue,
    Answer extends JsonValue = JsonValue,
    View extends JsonValue = JsonValue,
  >(
    route: SessionRoute,
    seatId?: string,
  ) => ClientSessionTransport<Command, Query, Answer, View>;
}

/** Runtime capabilities injected by the application composition root. */
export interface GameEntryRuntime {
  /** Optional operator tools, authorized by the host independently of player input. */
  readonly developerConsole?: GameDeveloperConsoleRuntime;
  /** Reports a contained event/async failure to the active game's error boundary. */
  readonly reportError?: (error: unknown) => void;
  /** Retained for game-owned platform extensions during migration. */
  readonly http: GameHttpClient;
  readonly session: GameSessionHost;
  /** Compatibility field; new entries should use session.signals. */
  readonly signals: GameSessionSignals;
  readonly viewer: GameViewer;
  readonly navigation: GameNavigation;
}
