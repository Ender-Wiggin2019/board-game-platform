/** The server's presence state for a player in one room. */
export type TPlayerPresenceStatus = 'in-room' | 'online' | 'offline';

export interface IRoomPresencePlayer {
  userId: string;
  status: TPlayerPresenceStatus;
}

/** Full room roster snapshot sent to sockets subscribed to that room. */
export interface IRoomPresencePayload {
  gameId: string;
  players: IRoomPresencePlayer[];
}

/** Connection state for a participant in an authenticated native session. */
export type TPlatformSessionPresenceStatus = 'online' | 'away' | 'offline';

export interface IPlatformSessionPresencePlayer {
  readonly principalId: string;
  /** Frozen admission seat; clients must not derive this from roster order. */
  readonly seatId: string;
  /** online means an active native foreground lease; away means connected elsewhere. */
  readonly status: TPlatformSessionPresenceStatus;
}

/** Safe, authenticated native-session presence snapshot. */
export interface IPlatformSessionPresencePayload {
  readonly sessionId: string;
  readonly sessionStatus:
    | 'suspended'
    | 'active'
    | 'paused'
    | 'completed'
    | 'cancelled';
  readonly players: readonly IPlatformSessionPresencePlayer[];
}
