import type {
  AccessContext,
  BackendPort,
  JsonValue,
  MatchAdmission,
  ModeDefinition,
  Participant,
  PlatformRoom,
  PublicStartStatus,
  SessionRoute,
} from '@board-game/contracts';

export interface ReleaseBinding {
  readonly gameId: string;
  readonly releaseId: string;
  readonly mode: ModeDefinition;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly backend: BackendPort;
  readonly validateSetup: (setup: JsonValue) => void;
}

/** No access tokens or credentials are retained with a start operation. */
export interface StartOperation extends PublicStartStatus {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly initiatedBy: string;
  readonly startGeneration: number;
  readonly setup: JsonValue;
  readonly seed: string;
  readonly admission: MatchAdmission;
}

export interface RoomTransaction {
  getRoom(): PlatformRoom;
  setRoom(room: PlatformRoom): void;
  getStart(): StartOperation | null;
  setStart(start: StartOperation): void;
}

export interface RoomListOptions {
  readonly gameId?: string;
  /** Optional lifecycle filter applied before visibility and pagination. */
  readonly status?: PlatformRoom['status'];
  readonly limit?: number;
  /** Opaque room id cursor; results are ordered by room id ascending. */
  readonly cursor?: string;
}

export interface RoomListRequest extends RoomListOptions {
  readonly principalId: string;
}

export interface RoomListResult {
  readonly rooms: readonly PlatformRoom[];
  readonly nextCursor?: string;
}

export interface AdmissionStore {
  createRoom(room: PlatformRoom): Promise<void>;
  getRoom(id: string): Promise<PlatformRoom | null>;
  listRooms(request: RoomListRequest): Promise<RoomListResult>;
  getStart(roomId: string): Promise<StartOperation | null>;
  /** Persisted start lookup used to authorize by the canonical session id. */
  getStartBySession(sessionId: string): Promise<StartOperation | null>;
  /** The route lookup is the authority for both backend and legacy-session routing. */
  getAdmission(sessionId: string): Promise<MatchAdmission | null>;
  /** Batch route lookup used by bounded session-directory pages. */
  getAdmissions(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, MatchAdmission>>;
  transaction<T>(
    roomId: string,
    work: (tx: RoomTransaction) => Promise<T>,
  ): Promise<T>;
  listPending(limit: number): Promise<readonly StartOperation[]>;
}

export interface AdmissionPolicy {
  readonly rating: MatchAdmission['rating'];
  readonly validityPolicyVersion: string;
}

export interface DirectSessionInput {
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  readonly setup: JsonValue;
  readonly seed?: string;
  readonly requestId: string;
}

/**
 * Server-owned match admission. This is intentionally separate from the
 * browser room/start APIs: matchmaking or a daily challenge supplies the frozen roster,
 * policy and seed, while the coordinator still owns the Host lifecycle.
 */
export interface MatchedSessionInput {
  readonly roomId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId: string;
  readonly setup: JsonValue;
  readonly seed: string;
  readonly participants: readonly Participant[];
  readonly policy: AdmissionPolicy;
}

export interface AdmissionCoordinatorOptions {
  readonly store: AdmissionStore;
  /** Select only registered and enabled releases; never accept a browser backend URL. */
  readonly resolveRelease: (
    gameId: string,
    modeId: string,
    releaseId: string,
  ) => ReleaseBinding;
  readonly resolveBackend: (route: SessionRoute) => BackendPort;
  /** Rechecks current account eligibility, grants and invitation/access policy. */
  readonly authorize: (
    principalId: string,
    room: PlatformRoom,
    action: 'create' | 'join' | 'edit' | 'start' | 'cancel' | 'read',
  ) => Promise<boolean>;
  readonly freezePolicy: (room: PlatformRoom) => Promise<AdmissionPolicy>;
  /** Server-owned scenarios may pin a reproducible seed once, before creating the durable start. */
  readonly freezeSeed?: (room: PlatformRoom) => Promise<string>;
  /** Server-owned policy for games whose room settings permit starting when full. */
  readonly automaticStart?: (room: PlatformRoom) => boolean;
  /**
   * Resolves safe public profiles immediately before the roster is frozen.
   * The coordinator verifies that identity, seat and team stay unchanged.
   */
  readonly freezeParticipants?: (
    room: PlatformRoom,
  ) => Promise<readonly Participant[]>;
  /** Supplies fresh server-derived control scopes when a durable start is recovered. */
  readonly accessForStart: (
    operation: StartOperation,
  ) => Promise<AccessContext>;
  readonly now?: () => number;
  readonly newId?: () => string;
}
