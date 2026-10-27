/** Trusted issue queues; the server resolves the queue from session evidence. */
export const PLATFORM_FEEDBACK_KINDS = ['game', 'ai'] as const;
export type TPlatformFeedbackKind = (typeof PLATFORM_FEEDBACK_KINDS)[number];

/** Scope for the operator queue that is not attached to a game session. */
export const PLATFORM_FEEDBACK_SCOPES = ['platform'] as const;
export type TPlatformFeedbackScope = (typeof PLATFORM_FEEDBACK_SCOPES)[number];

/** Categories accepted by the platform feedback endpoint. */
export const PLATFORM_FEEDBACK_CATEGORIES = [
  'bug',
  'rules',
  'ux',
  'other',
  'behavior',
  'optimization',
] as const;
export type TPlatformFeedbackCategory =
  (typeof PLATFORM_FEEDBACK_CATEGORIES)[number];

/** Operator states for a platform feedback report. */
export const PLATFORM_FEEDBACK_STATUSES = [
  'open',
  'triaged',
  'resolved',
  'ignored',
] as const;
export type TPlatformFeedbackStatus =
  (typeof PLATFORM_FEEDBACK_STATUSES)[number];

/** A bounded event projection supplied by a registered game Host. */
export interface IPlatformNativeDiagnosticEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly payload: unknown;
  /** Safe source classification; no policy id or private AI data. */
  readonly source?: {
    readonly kind: 'human' | 'ai' | 'automa' | 'system';
    readonly seatId?: string;
    /** Opaque server trace reference; no private state is included. */
    readonly traceId?: string;
  };
}

/**
 * Safe native session evidence. It contains the Host's public summary and
 * projected events only; encoded game state is never part of this contract.
 */
export interface IPlatformNativeDiagnostics {
  readonly kind: 'native-session';
  readonly sessionId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly status:
    | 'suspended'
    | 'active'
    | 'paused'
    | 'completed'
    | 'cancelled';
  readonly sourceRevision: number;
  readonly updatedAt: number;
  readonly summary: unknown;
  readonly events: readonly IPlatformNativeDiagnosticEvent[];
}

/** Private, operator-only evidence for one AI/automa decision or player command. */
export type TPlatformAutomationTraceKind = 'automation' | 'command';

export type TPlatformAutomationTraceOutcome =
  | 'deciding'
  | 'decided'
  | 'executed'
  | 'rejected'
  | 'timeout'
  | 'failed';

export interface IPlatformAutomationTrace {
  readonly kind: TPlatformAutomationTraceKind;
  readonly sessionId: string;
  readonly traceId: string;
  readonly decisionId: string;
  readonly commandId: string;
  readonly deadlineId: string;
  readonly releaseId: string;
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly expectedRevision: number;
  readonly seatId: string;
  readonly turnId: string;
  readonly state: unknown;
  readonly input: unknown;
  readonly schemaVersion: number;
  readonly options: unknown;
  readonly command?: unknown;
  readonly diagnostics?: unknown;
  readonly outcome: TPlatformAutomationTraceOutcome;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly createdAt: number;
  readonly eventSequenceStart?: number;
  readonly eventSequenceCount?: number;
}

/** Dry-run result; no command is submitted to the authoritative Host. */
export interface IPlatformAutomationReplayResult {
  readonly traceKind: TPlatformAutomationTraceKind;
  readonly traceId: string;
  readonly decisionId: string;
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly command?: unknown;
  readonly diagnostics?: unknown;
  readonly durationMs: number;
  readonly inputDigest: string;
  readonly legal: boolean;
  readonly error?: {
    readonly code: string;
    readonly messageKey: string;
  };
}

/** Authenticated platform feedback submission. */
export interface IPlatformFeedbackSubmitRequest {
  /** Stable client event key used for safe retries. */
  readonly eventId: string;
  /** Client hint only; the server derives the final queue from trusted evidence. */
  readonly kind?: TPlatformFeedbackKind;
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  /** Optional AI-only expected behavior or improvement target. */
  readonly expectedBehavior?: string;
  readonly gameId?: string;
  readonly target?: {
    readonly kind: 'native-session';
    readonly sessionId: string;
    readonly eventSequence?: number;
  };
}

/** Persisted feedback returned to its author and platform operators. */
export interface IPlatformFeedbackReport {
  readonly reportId: string;
  readonly eventId: string;
  readonly sourceRecordId: string;
  readonly reporterId: string;
  readonly kind: TPlatformFeedbackKind;
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  readonly expectedBehavior?: string;
  readonly gameId?: string;
  readonly releaseId?: string;
  readonly sessionId?: string;
  /** Trusted Host event selected by the reporter, when a native session is targeted. */
  readonly eventSequence?: number;
  readonly traceId?: string;
  /** Whether an operator-only durable snapshot was retained for this trace. */
  readonly traceEvidenceAvailable?: boolean;
  readonly nativeDiagnostics?: IPlatformNativeDiagnostics;
  readonly clientCrash?: IClientCrashReport;
  readonly status: TPlatformFeedbackStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** List projection that keeps crash and native diagnostic payloads out of queues. */
export type IPlatformFeedbackReportSummary = Omit<
  IPlatformFeedbackReport,
  'nativeDiagnostics' | 'clientCrash'
>;

export interface IPlatformFeedbackListResponse {
  readonly items: readonly IPlatformFeedbackReportSummary[];
  readonly total: number;
}

import type { IClientCrashReport } from './clientCrash.js';
