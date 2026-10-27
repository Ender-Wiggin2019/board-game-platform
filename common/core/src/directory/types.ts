import type {
  CompletionReplayRef,
  HistoryPolicy,
  JsonValue,
  MatchAdmission,
  Participant,
  ParticipantController,
  PublicPlayerProfile,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import type { AdmissionStore } from '../admission/types.js';
import type { InboxEnvelope } from '../inbox/types.js';

export const DIRECTORY_SCHEMA_VERSION = 1 as const;

/** Facts retained by the platform directory are deliberately narrower than game facts. */
export type SessionDirectoryFactKind =
  | 'SessionCreated'
  | 'SessionActivated'
  | 'SessionSummaryChanged'
  | 'SessionCompleted'
  | 'SessionControlled';

export type SessionControlAction = 'pause' | 'resume' | 'cancel';

export interface DirectoryParticipant {
  readonly principalId: string;
  readonly seatId: string;
  readonly teamId?: string;
  /** Missing values are legacy human participants. */
  readonly controller?: ParticipantController;
  readonly controlledBy?: string;
  readonly controllerId?: string;
  readonly controllerOptions?: JsonValue;
  readonly publicProfile?: PublicPlayerProfile;
}

export interface SessionDirectoryRecord {
  readonly sessionId: string;
  readonly admissionId: string;
  readonly route: SessionRoute;
  readonly visibility: 'public' | 'private';
  readonly participants: readonly DirectoryParticipant[];
  readonly status: SessionStatus;
  /** The latest source aggregate sequence accepted by the projection. */
  readonly latestAggregateSequence: number;
  readonly summary?: JsonValue;
  /** Retained only when the admission retention policy explicitly permits it. */
  readonly result?: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionDirectoryFactPayload {
  /** A host-produced safe summary; raw state and private events are rejected. */
  readonly summary?: JsonValue;
  /** A completed result, subject to the retention resolver. */
  readonly result?: JsonValue;
  /** Optional public roster projection, which must match the frozen admission. */
  readonly participants?: readonly DirectoryParticipant[];
  /** Optional status for a summary update. Lifecycle facts set status themselves. */
  readonly status?: SessionStatus;
  /** Host control lifecycle action. It is accepted only for SessionControlled. */
  readonly action?: SessionControlAction;
  /** Host completion metadata; validated but never retained in the projection. */
  readonly resultRevision?: number;
  readonly endedAt?: number;
  /** Validated completion metadata; only the CompletionRecord owner retains it. */
  readonly replayRef?: CompletionReplayRef;
  /** Host progress metadata; safe but not retained separately. */
  readonly progress?: JsonValue;
  /** Host actor metadata; accepted for source compatibility and never retained. */
  readonly principalId?: string;
}

export type SessionDirectoryEnvelope = Pick<
  InboxEnvelope,
  | 'producerId'
  | 'eventId'
  | 'sessionId'
  | 'kind'
  | 'schemaVersion'
  | 'sourceRelease'
  | 'payload'
  | 'aggregateSequence'
  | 'occurredAt'
  | 'receivedAt'
  | 'digest'
>;

export type DirectoryRetention =
  | HistoryPolicy
  | {
      readonly retainSummary: boolean;
      readonly retainResult: boolean;
    };

export type DirectoryRetentionResolver = (
  admission: MatchAdmission,
) => DirectoryRetention | Promise<DirectoryRetention>;

export interface SessionDirectoryAdmissionLookup {
  getAdmission(sessionId: string): Promise<MatchAdmission | null>;
}

export interface SessionDirectoryOptions {
  /** Trusted platform admission lookup; browser routes are never accepted. */
  readonly admission:
    | Pick<AdmissionStore, 'getAdmission'>
    | SessionDirectoryAdmissionLookup;
  /** Mode history is not guessed; the host/server supplies this frozen policy. */
  readonly retentionResolver: DirectoryRetentionResolver;
  readonly now?: () => number;
}

export interface SessionDirectoryCapabilities {
  readonly durable: boolean;
  readonly serializableTransactions: boolean;
  readonly boundedReads: boolean;
}

export interface SessionDirectoryCursor {
  readonly updatedAt: number;
  readonly sessionId: string;
}

export interface SessionDirectoryListOptions {
  readonly gameId?: string;
  readonly status?: SessionStatus;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionDirectoryPage {
  readonly items: readonly SessionDirectoryRecord[];
  readonly nextCursor?: string;
}

export interface SessionDirectoryStore {
  readonly capabilities: SessionDirectoryCapabilities;
  applyFact(
    envelope: SessionDirectoryEnvelope,
  ): Promise<SessionDirectoryRecord>;
  getSession(sessionId: string): Promise<SessionDirectoryRecord | null>;
  listForPrincipal(
    principalId: string,
    options?: SessionDirectoryListOptions,
  ): Promise<SessionDirectoryPage>;
  listPublic(
    gameId: string,
    options?: Omit<SessionDirectoryListOptions, 'gameId'>,
  ): Promise<SessionDirectoryPage>;
  close(): Promise<void>;
}

/** Public service name used by platform callers; storage drivers implement it. */
export type SessionDirectory = SessionDirectoryStore;

export type FrozenDirectoryParticipant = Participant;
