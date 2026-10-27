import type { JsonValue } from './json.js';
import type { MatchAdmission } from './platform.js';
import type { GameResult } from './results.js';
import type { Participant, SessionRoute } from './types.js';

/** Terminal state reported by a game service for a session. */
export type PlatformCompletionStatus =
  | 'completed'
  | 'cancelled'
  | 'aborted'
  | 'invalid';

/** Platform-local progress for processing an accepted completion. */
export type CompletionProcessingState =
  | 'received'
  | 'result-stored'
  | 'settling'
  | 'settled'
  | 'conflict';

/** Opaque, immutable pointer to game-owned replay data. */
export interface CompletionReplayRef {
  readonly platformId: string;
  readonly gameId: string;
  readonly sessionId: string;
  readonly replayId: string;
  readonly releaseId: string;
  readonly storageBindingId: string;
  readonly formatVersion: number;
}

/** Public, game-produced achievement facts retained with the completion. */
export interface CompletionAchievementSource {
  readonly principalId: string;
  readonly facts: readonly JsonValue[];
}

/**
 * Source metadata is retained for audit and is not used to derive trust.  The
 * authenticated ingress supplies this identity independently of the payload.
 */
export interface CompletionRecordSource {
  readonly producerId?: string;
  readonly eventId?: string;
  readonly sourceDigest?: string;
}

/** Canonical, platform-owned completion record. */
export interface PlatformCompletionRecord {
  readonly platformId: string;
  readonly admissionId: string;
  readonly route: SessionRoute;
  readonly sessionId: string;
  readonly status: PlatformCompletionStatus;
  readonly resultSchemaVersion: number;
  readonly resultRevision: number;
  /** Source aggregate revision, independent from the result schema revision. */
  readonly sourceRevision: number;
  readonly digest: string;
  readonly participants: readonly Participant[];
  readonly validityPolicyVersion: string;
  readonly rating: MatchAdmission['rating'];
  readonly endedAt: number;
  readonly result?: GameResult;
  readonly replayRef?: CompletionReplayRef;
  /** Only release-approved public facts; private game state is never stored. */
  readonly achievementSources?: readonly CompletionAchievementSource[];
  readonly source?: CompletionRecordSource;
  readonly processingState: CompletionProcessingState;
  readonly attempts: number;
  readonly nextAttemptAt?: number;
  readonly processingError?: string;
  readonly claimOwner?: string;
  readonly claimToken?: string;
  readonly leaseUntil?: number;
  readonly receivedAt: number;
  readonly updatedAt: number;
}

/** Immutable audit entry for an attempted rewrite of an accepted key. */
export interface CompletionRecordConflict {
  readonly conflictId: string;
  readonly platformId: string;
  readonly sessionId: string;
  readonly resultRevision: number;
  readonly existingDigest: string;
  readonly incomingDigest: string;
  readonly incoming: unknown;
  readonly source?: CompletionRecordSource;
  readonly createdAt: number;
}

/** Short aliases used by platform adapters. */
export type CompletionRecord = PlatformCompletionRecord;
export type CompletionConflict = CompletionRecordConflict;
export type ReplayRef = CompletionReplayRef;
