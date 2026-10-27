import type {
  JsonValue,
  PlatformRoom,
  PlatformRoomInvitation,
  PlatformRoomView,
  PublicPlayerProfile,
  RoomAccessGrantState,
  RoomControllerCapabilities,
  RoomSeatControllerInput,
} from '@board-game/contracts';
import type { AdmissionStore, RoomTransaction } from '../admission/types.js';

export interface RoomSecurityRecord {
  /** Stored only in the room-security relation; never copied into a room DTO. */
  readonly passwordHash?: string;
}

/**
 * Immutable receipt for a caller's room-creation intent. It is kept outside
 * the mutable room document so retries never compare against changed room
 * state, and it survives physical room deletion.
 */
export interface RoomCreateReceipt {
  readonly principalId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly roomId: string;
  /** Strong hash of the original password; plaintext is never persisted. */
  readonly originalPasswordHash?: string;
}

export interface RoomAccessGrant {
  readonly grantId: string;
  readonly roomId: string;
  readonly principalId: string;
  readonly seatId?: string;
  readonly state: RoomAccessGrantState;
}

export interface RoomAccessSnapshot {
  readonly security: RoomSecurityRecord;
  readonly grants: readonly RoomAccessGrant[];
}

export interface RoomManagementTransaction extends RoomTransaction {
  getSecurity(): RoomSecurityRecord;
  setSecurity(value: RoomSecurityRecord): void;
  getGrants(): readonly RoomAccessGrant[];
  setGrant(value: RoomAccessGrant): void;
  deleteGrant(grantId: string): void;
}

/** Admission persistence with atomic private room-access state. */
export interface RoomManagementStore extends AdmissionStore {
  createRoomWithAccess(
    room: PlatformRoom,
    security: RoomSecurityRecord,
    initialGrants?: readonly RoomAccessGrant[],
    receipt?: RoomCreateReceipt,
  ): Promise<void>;
  getRoomCreateReceipt(
    principalId: string,
    requestId: string,
  ): Promise<RoomCreateReceipt | null>;
  getRoomAccess(roomId: string): Promise<RoomAccessSnapshot>;
  /** Batch access lookup used by bounded room-list pages. */
  getRoomAccessMany(
    roomIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomAccessSnapshot>>;
  transactionWithAccess<T>(
    roomId: string,
    work: (tx: RoomManagementTransaction) => Promise<T>,
  ): Promise<T>;
  /** Returns pending grants for open rooms, ordered by room id for pagination. */
  listPendingRoomInvitations?: (
    request: RoomInvitationListRequest,
  ) => Promise<RoomInvitationCandidateList>;
}

export interface RoomInvitationListRequest {
  readonly principalId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RoomInvitationCandidate {
  readonly room: PlatformRoom;
  readonly grant: RoomAccessGrant;
}

export interface RoomInvitationCandidateList {
  readonly items: readonly RoomInvitationCandidate[];
  readonly nextCursor?: string;
}

export interface RoomInvitationListResult {
  readonly items: readonly PlatformRoomInvitation[];
  readonly nextCursor?: string;
}

export interface RoomModeLimits {
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly entry: 'room' | 'direct-solo';
  readonly platformRating?: boolean;
  readonly validateSetup: (setup: JsonValue) => void;
}

export type RoomManagementAction =
  | 'read'
  | 'create'
  | 'join'
  | 'edit'
  | 'delete'
  | 'invite'
  | 'kick'
  | 'read-invitation'
  | 'decline';

export interface RoomManagementPolicy {
  readonly resolveMode: (
    gameId: string,
    modeId: string,
    releaseId: string,
  ) => RoomModeLimits;
  /** Resolve the effective room capacity from the frozen room setup. */
  readonly resolveCapacity?: (room: PlatformRoom) => number;
  /** Return a safe public profile to enable bots for this room, or null to disable them. */
  readonly createBotProfile?: (
    room: PlatformRoom,
  ) => PublicPlayerProfile | null;
  /** Release-scoped controllers available for this room's mode and setup. */
  readonly controllers?: (room: PlatformRoom) => RoomControllerCapabilities;
  /** Validates and normalizes only the registered provider's options. */
  readonly controllerOptions?: (
    room: PlatformRoom,
    input: Exclude<RoomSeatControllerInput, { readonly kind: 'hotseat' }>,
  ) => JsonValue;
  readonly authorize: (
    principalId: string,
    room: PlatformRoom,
    action: RoomManagementAction,
    access?: RoomAccessSnapshot,
  ) => Promise<boolean>;
  /** Rechecks current friendship and target account eligibility in the caller's DB context. */
  readonly authorizeInvite: (
    ownerId: string,
    inviteeId: string,
    room: PlatformRoom,
  ) => Promise<boolean>;
  readonly hashPassword?: (password: string) => Promise<string>;
  readonly verifyPassword?: (
    passwordHash: string,
    password: string,
  ) => Promise<boolean>;
  /** SETI supplies its palette policy; generic games may omit colors. */
  readonly validateColor?: (
    color: string,
    room: PlatformRoom,
    principalId: string,
  ) => string;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface RoomCreateInput {
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  /** Caller idempotency key; omitted by legacy clients. */
  readonly requestId?: string;
  readonly visibility: PlatformRoom['visibility'];
  readonly setup: JsonValue;
  readonly seed?: string;
  readonly name?: string;
  readonly password?: string;
  /** Optional initial appearance color for the creating member. */
  readonly color?: string;
}

export interface RoomManagementListOptions {
  readonly gameId?: string;
  readonly status?: PlatformRoom['status'];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface RoomListViewResult {
  readonly rooms: readonly PlatformRoomView[];
  readonly nextCursor?: string;
}

export interface RoomJoinInput {
  readonly password?: string;
  readonly color?: string;
}

export interface RoomInviteInput {
  readonly principalId: string;
  /** An explicit seat reserves capacity. Omitted means access only. */
  readonly seatId?: string;
}
