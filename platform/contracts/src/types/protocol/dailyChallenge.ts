import type { JsonValue } from '@board-game/contracts';

/** Durable state of one account's attempt for one immutable daily snapshot. */
export const PLATFORM_DAILY_CHALLENGE_ATTEMPT_STATUSES = [
  'starting',
  'started',
  'completed',
  'abandoned',
] as const;
export type TPlatformDailyChallengeAttemptStatus =
  (typeof PLATFORM_DAILY_CHALLENGE_ATTEMPT_STATUSES)[number];

/** Publication is a server-owned decision; clients cannot claim public state. */
export const PLATFORM_DAILY_CHALLENGE_PUBLICATION_STATES = [
  'pending',
  'public',
  'anonymous',
] as const;
export type TPlatformDailyChallengePublication =
  (typeof PLATFORM_DAILY_CHALLENGE_PUBLICATION_STATES)[number];

/** SETI-compatible public boards. */
export const PLATFORM_DAILY_CHALLENGE_LEADERBOARD_BOARDS = [
  'firstLook',
  'overall',
  'grinder',
] as const;
export type TPlatformDailyChallengeLeaderboardBoard =
  (typeof PLATFORM_DAILY_CHALLENGE_LEADERBOARD_BOARDS)[number];

/** The date/setup/seed tuple frozen before a daily session is admitted. */
export interface IPlatformDailyChallengeSnapshot {
  readonly gameId: string;
  readonly releaseId: string;
  readonly modeId: string;
  readonly challengeDate: string;
  readonly seed: string;
  readonly setup: JsonValue;
  /** Game-owned safe presentation of the frozen settings, when provided. */
  readonly publicSettings?: JsonValue;
  readonly settingsRevision: number;
  readonly createdAt: string;
  /** Server-side eligibility cutoff, once this challenge is finalized. */
  readonly eligibilityCutoffAt?: string;
  /** Immutable publication/finalization time, when finalized. */
  readonly finalizedAt?: string;
}

/** One result projected by the game-owned daily score adapter. */
export interface IPlatformDailyChallengeAttempt {
  readonly attemptId: string;
  readonly challengeDate: string;
  readonly attemptNumber: number;
  readonly sessionId?: string;
  readonly status: TPlatformDailyChallengeAttemptStatus;
  readonly score?: number;
  readonly result?: JsonValue;
  /** Server-controlled publication state. */
  readonly publicationState: TPlatformDailyChallengePublication;
  readonly autoPublishAt?: string;
  readonly publicationSelectedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

export interface IPlatformDailyChallengeTodayResponse {
  readonly challenge: IPlatformDailyChallengeSnapshot;
  readonly activeAttempt?: IPlatformDailyChallengeAttempt;
  readonly latestAttempt?: IPlatformDailyChallengeAttempt;
  readonly attempts: readonly IPlatformDailyChallengeAttempt[];
  readonly attemptCount: number;
  readonly leaderboards: IPlatformDailyChallengeLeaderboardsResponse;
  readonly historyDates: readonly string[];
  readonly nextRefreshAt: string;
  /** @deprecated Use activeAttempt/latestAttempt. */
  readonly attempt?: IPlatformDailyChallengeAttempt;
}

export interface IPlatformDailyChallengeStartResponse {
  readonly challenge: IPlatformDailyChallengeSnapshot;
  readonly attempt: IPlatformDailyChallengeAttempt;
  readonly start: {
    readonly startId: string;
    readonly sessionId: string;
    readonly roomId: string;
    readonly state:
      | 'creating'
      | 'activating'
      | 'cancelling'
      | 'active'
      | 'cancelled';
  };
}

export interface IPlatformDailyChallengeScoreLeaderboardEntry {
  readonly rank: number;
  /** Stable opaque key safe for anonymous public entries. */
  readonly entryKey: string;
  readonly principalId?: string;
  readonly displayName?: string;
  readonly publicationState: Extract<
    TPlatformDailyChallengePublication,
    'public' | 'anonymous'
  >;
  readonly isCurrentUser?: boolean;
  /** Present only when this viewer is allowed to open the retained replay. */
  readonly sessionId?: string;
  readonly attemptNumber: number;
  readonly score: number;
  readonly startedAt?: string;
  readonly completedAt: string;
  readonly result?: JsonValue;
  readonly replayAvailable?: boolean;
}

export interface IPlatformDailyChallengeGrinderLeaderboardEntry {
  readonly rank: number;
  readonly entryKey: string;
  readonly principalId?: string;
  readonly displayName?: string;
  readonly publicationState: Extract<
    TPlatformDailyChallengePublication,
    'public' | 'anonymous'
  >;
  readonly isCurrentUser?: boolean;
  readonly attemptCount: number;
  readonly completedCount: number;
  readonly bestScore?: number;
  readonly latestCompletedAt?: string;
}

export interface IPlatformDailyChallengeScoreLeaderboardResponse {
  readonly date: string;
  readonly top: readonly IPlatformDailyChallengeScoreLeaderboardEntry[];
  readonly me?: IPlatformDailyChallengeScoreLeaderboardEntry;
}

export interface IPlatformDailyChallengeGrinderLeaderboardResponse {
  readonly date: string;
  readonly top: readonly IPlatformDailyChallengeGrinderLeaderboardEntry[];
  readonly me?: IPlatformDailyChallengeGrinderLeaderboardEntry;
}

export interface IPlatformDailyChallengeLeaderboardsResponse {
  readonly date: string;
  readonly firstLook: IPlatformDailyChallengeScoreLeaderboardResponse;
  readonly overall: IPlatformDailyChallengeScoreLeaderboardResponse;
  readonly grinder: IPlatformDailyChallengeGrinderLeaderboardResponse;
}

/**
 * Public leaderboard payload. The canonical shape is the three SETI-compatible
 * boards above. `entries` remains an optional alias for old callers.
 */
export interface IPlatformDailyChallengeLeaderboardResponse
  extends IPlatformDailyChallengeLeaderboardsResponse {
  readonly challengeDate: string;
  readonly finalizedAt?: string;
  readonly nextRefreshAt?: string;
  /** @deprecated Use one of firstLook/overall/grinder. */
  readonly entries: readonly IPlatformDailyChallengeLeaderboardEntry[];
}

/** @deprecated Use IPlatformDailyChallengeScoreLeaderboardEntry. */
export interface IPlatformDailyChallengeLeaderboardEntry
  extends IPlatformDailyChallengeScoreLeaderboardEntry {}

/** Template used for future snapshots. Existing snapshots never change. */
export interface IPlatformDailyChallengeSettings {
  readonly gameId: string;
  readonly releaseId: string;
  readonly settings: JsonValue;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface IPlatformDailyChallengeSettingsPatch {
  readonly settings: JsonValue;
  readonly expectedRevision?: number;
}
