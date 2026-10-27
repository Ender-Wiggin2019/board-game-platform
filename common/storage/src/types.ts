import type {
  AutomationFailure,
  EventSource,
  JsonValue,
  Participant,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';

export type StorageSessionStatus = SessionStatus;

export type SessionId = SessionRoute['sessionId'];
export type OwnershipEpoch = SessionRoute['ownershipEpoch'];

/** A participant copied into a session at start; it is never read from a room. */
export type FrozenParticipant = Readonly<Participant>;

/** The durable, bounded recovery record for one session. */
export interface SessionHead {
  readonly route: SessionRoute;
  readonly startId: string;
  /** Admission generation; omitted only for legacy heads created before it was persisted. */
  readonly startGeneration?: number;
  readonly startDigest: string;
  readonly status: StorageSessionStatus;
  readonly revision: number;
  readonly encodedState: JsonValue;
  readonly schemaVersion: number;
  readonly participants: readonly FrozenParticipant[];
  /** A reviewed platform-safe projection; private game state must not be put here. */
  readonly summary: JsonValue;
  readonly logicalTime: number;
  /** One server-derived deadline generation, if this session has a timer. */
  readonly deadline?: SessionDeadline;
  /** Safe diagnostic metadata for a terminal automated-seat failure. */
  readonly automationFailure?: AutomationFailure;
  /** Set once and retained so activation retries return the same response. */
  readonly activatedAt?: number;
  /** Latest persisted event sequence; it is independent from command revision. */
  readonly eventSequence: number;
}

export interface SessionDeadline {
  readonly deadlineId: string;
  readonly dueAt: number;
}

/**
 * A server-selected automated command prepared outside the head transaction.
 * The record is private and keyed by decisionId so a retry after an unknown
 * command outcome reuses the original payload.
 */
export interface AutomationDecision {
  readonly sessionId: SessionId;
  readonly decisionId: string;
  readonly commandId: string;
  readonly deadlineId: string;
  readonly expectedRevision: number;
  readonly seatId: string;
  readonly turnId: string;
  readonly command: JsonValue;
  readonly createdAt: number;
}

/**
 * Private evidence for one automation or player command. This is deliberately
 * not a DomainEvent: it may contain encoded authoritative state and an
 * actor-private input, and is therefore only readable through diagnostics.
 */
export type AutomationTraceOutcome =
  | 'deciding'
  | 'decided'
  | 'executed'
  | 'rejected'
  | 'timeout'
  | 'failed';

export type PrivateCommandTraceKind = 'automation' | 'command';

/** Per-session private trace retention guardrails. */
export const AUTOMATION_TRACE_MAX_COUNT = 128;
export const AUTOMATION_TRACE_MAX_BYTES = 16 * 1024 * 1024;
export const AUTOMATION_TRACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export interface AutomationTrace {
  readonly kind: PrivateCommandTraceKind;
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly decisionId: string;
  readonly commandId: string;
  readonly deadlineId: string;
  readonly releaseId: string;
  /** `player-command` for human traces; policy id for automation traces. */
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly expectedRevision: number;
  readonly seatId: string;
  readonly turnId: string;
  /** Exact encoded state immediately before policy execution. */
  readonly state: JsonValue;
  /** Exact actor-scoped input passed to the policy. */
  readonly input: JsonValue;
  readonly schemaVersion: number;
  readonly options: JsonValue;
  readonly command?: JsonValue;
  readonly diagnostics?: JsonValue;
  readonly outcome: AutomationTraceOutcome;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly createdAt: number;
  /** First committed public event produced by this command, when any. */
  readonly eventSequenceStart?: number;
  /** Number of committed public events produced by this command. */
  readonly eventSequenceCount?: number;
}

export interface AutomationTraceReadOptions {
  readonly limit: number;
  readonly afterCreatedAt?: number;
  readonly kind?: PrivateCommandTraceKind;
  readonly now?: number;
}

/** Generic name used by diagnostics; retained alias keeps automation callers stable. */
export type PrivateCommandTrace = AutomationTrace;

export interface DueSession {
  readonly sessionId: SessionId;
  readonly route: SessionRoute;
  readonly revision: number;
  readonly deadline: SessionDeadline;
}

export interface SessionOwner {
  /** Ownership epochs are stable across process restarts and change on transfer. */
  readonly ownershipEpoch: string;
  /** Kept for diagnostics; the epoch is the concurrency token. */
  readonly ownerId?: string;
}

export interface HeadWriteOptions {
  /** Defaults to the head revision observed by the transaction. */
  readonly expectedRevision?: number;
  /** Defaults to the transaction owner's epoch. */
  readonly ownershipEpoch?: string;
}

export type ReceiptStatus = 'accepted' | 'rejected' | 'unknown' | 'tombstone';
export type ResultRetention = 'replayable' | 'ephemeral-result';

export interface ReceiptError {
  readonly code: string;
  readonly messageKey: string;
  readonly retryable: boolean;
}

/**
 * Only retry metadata is retained. The command, result, view, and private error
 * details are deliberately absent from this record.
 */
export interface CommandReceipt {
  readonly sessionId: SessionId;
  readonly commandId: string;
  readonly actorPrincipalId: string;
  readonly inputHash: string;
  readonly status: ReceiptStatus;
  readonly resultRetention: ResultRetention;
  readonly persistedRevision?: number;
  readonly persistedAt?: number;
  readonly error?: ReceiptError;
}

export type ReceiptInput = CommandReceipt;

export interface DomainEvent {
  readonly eventId: string;
  readonly sessionId: SessionId;
  /** Stable logical stream producer, never a process or connection id. */
  readonly producerId: string;
  readonly aggregateSequence: number;
  readonly schemaVersion: number;
  readonly sourceRelease: string;
  /** Private event data. It must not be used as a platform projection. */
  readonly payload: JsonValue;
  /** Safe source marker; private command input stays in the bounded trace store. */
  readonly source?: EventSource;
  readonly logicalTime: number;
  readonly occurredAt?: number;
}

export interface OutboxRecord {
  readonly outboxId: string;
  readonly sessionId: SessionId;
  readonly producerId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly sourceRelease: string;
  readonly payload: JsonValue;
  readonly aggregateSequence?: number;
  readonly createdAt: number;
  readonly deliveredAt?: number;
  readonly attempts: number;
  readonly nextAttemptAt?: number;
}

export interface OutboxReadOptions {
  readonly limit: number;
  readonly producerId?: string;
  readonly sessionId?: SessionId;
  readonly now?: number;
}

export interface OutboxKey {
  readonly sessionId: SessionId;
  readonly outboxId: string;
}

export interface EventReadOptions {
  readonly afterSequence?: number;
  readonly limit: number;
}

export interface DueSessionReadOptions {
  readonly limit: number;
  readonly now?: number;
  readonly backendBindingId?: string;
  readonly storageBindingId?: string;
  readonly releaseId?: string;
  /** Host scheduler partition; automation deadlines use the reserved prefix. */
  readonly deadlineKind?: 'system' | 'automation';
}

export interface TerminalCleanupOptions {
  readonly requireTerminal?: boolean;
}

export interface SessionCreateOptions {
  readonly initialOutbox?: readonly OutboxRecord[];
  /** Initial private domain events committed with the session head. */
  readonly initialEvents?: readonly DomainEvent[];
}

export interface StorageCapabilities {
  readonly sharedUnitOfWork: false;
  readonly serializableTransactions: true;
  readonly boundedResumeReads: true;
  readonly durable: boolean;
}
