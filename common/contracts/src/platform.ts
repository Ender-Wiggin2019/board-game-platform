import type { JsonValue } from './json.js';
import type { AutomationControllerDescriptor } from './turns.js';
import type { HistoryPolicy, Participant, SessionRoute } from './types.js';

export type RoomSeatControllerInput =
  | { readonly kind: 'hotseat'; readonly displayName?: string }
  | {
      readonly kind: 'ai' | 'automa';
      readonly controllerId: string;
      readonly options?: JsonValue;
    };

export interface RoomControllerCapabilities {
  readonly hotseat: boolean;
  readonly automation: readonly AutomationControllerDescriptor[];
}

export interface RoomMember extends Participant {
  readonly ready: boolean;
}

export interface PlatformRoom {
  readonly id: string;
  readonly ownerId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  /** Safe room label; credentials and private access grants never live here. */
  readonly name?: string;
  readonly visibility: 'public' | 'private';
  readonly setup: JsonValue;
  /** Optional platform-owned preset, frozen into the start independently of game setup. */
  readonly seed?: string;
  readonly members: readonly RoomMember[];
  readonly revision: number;
  readonly startGeneration: number;
  readonly status: 'open' | 'starting' | 'started' | 'closed';
  readonly route?: SessionRoute;
}

export type RoomAccessGrantState = 'pending' | 'accepted' | 'revoked';

/** Safe public metadata returned by the room management facade. */
export interface PlatformRoomReservation {
  readonly grantId: string;
  readonly principalId: string;
  readonly seatId?: string;
  readonly state: Exclude<RoomAccessGrantState, 'revoked'>;
}

export interface PlatformRoomPublicMetadata {
  readonly name?: string;
  readonly passwordProtected: boolean;
  readonly capacity: number;
  readonly memberCount: number;
  /** Omitted when the game does not expose a bot profile factory. */
  readonly botsAllowed?: boolean;
  readonly controllers?: RoomControllerCapabilities;
  /** Present only for a member or owner; public readers receive no principals. */
  readonly reservations?: readonly PlatformRoomReservation[];
}

/** Room response with safe access metadata and no password material. */
export interface PlatformRoomView extends PlatformRoom {
  readonly metadata: PlatformRoomPublicMetadata;
}

/** Safe incoming room invitation metadata; credentials and private room access stay server-side. */
export interface PlatformRoomInvitation {
  readonly grantId: string;
  readonly roomId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  readonly roomName?: string;
  readonly ownerId: string;
  readonly ownerName?: string;
  readonly reservedSeatId?: string;
}

export interface PlatformRoomInvitationList {
  readonly items: readonly PlatformRoomInvitation[];
  readonly nextCursor?: string;
}

/** Policy identifiers are frozen by the platform, never supplied by a game command. */
export interface MatchAdmission {
  readonly id: string;
  readonly route: SessionRoute;
  readonly participants: readonly Participant[];
  readonly visibility: PlatformRoom['visibility'];
  readonly rating: null | {
    readonly poolId: string;
    readonly policyVersion: string;
    readonly progressionPolicyVersion: string;
    readonly seasonId: string | null;
  };
  /** Frozen for new admissions; older records may omit this until migrated. */
  readonly historyPolicy?: HistoryPolicy;
  readonly validityPolicyVersion: string;
  readonly createdAt: number;
}

export interface PublicStartStatus {
  readonly startId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly state:
    | 'creating'
    | 'activating'
    | 'cancelling'
    | 'active'
    | 'cancelled';
  readonly route: SessionRoute;
}
