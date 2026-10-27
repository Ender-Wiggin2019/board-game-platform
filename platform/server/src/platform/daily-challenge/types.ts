import type {
  DailyChallengePrepared,
  GameResult,
  JsonValue,
  MatchAdmission,
  Participant,
} from '@board-game/contracts';
import type {
  IPlatformDailyChallengeAttempt,
  IPlatformDailyChallengeGrinderLeaderboardEntry,
  IPlatformDailyChallengeGrinderLeaderboardResponse,
  IPlatformDailyChallengeLeaderboardEntry,
  IPlatformDailyChallengeLeaderboardsResponse,
  IPlatformDailyChallengeScoreLeaderboardResponse,
  IPlatformDailyChallengeSettings,
  IPlatformDailyChallengeSnapshot,
  TPlatformDailyChallengeLeaderboardBoard,
  TPlatformDailyChallengePublication,
} from '@board-platform/contracts';

export interface DailyChallengeScore {
  readonly score: number;
  /** A bounded, game-owned result projection safe for the leaderboard. */
  readonly result?: JsonValue;
}

export type DailyChallengePrepare = DailyChallengePrepared;

/** Release-pinned, platform-owned daily reward policy. */
export interface DailyChallengeRewardTier {
  readonly percent: number;
  readonly quantity: number;
}

export interface DailyChallengeRewardPolicy {
  readonly modeId: string;
  readonly definitionVersion: string;
  readonly asset: string;
  readonly tiers: readonly DailyChallengeRewardTier[];
  readonly participationQuantity: number;
  readonly sourceKeyPrefix: string;
}

export interface DailyChallengeRewardAward {
  readonly principalId: string;
  readonly awardId: string;
  readonly tier: 'daily';
  readonly sourceRecordId: string;
  readonly quantity: number;
}

export interface DailyChallengeRewardPlan {
  readonly gameId: string;
  readonly challengeDate: string;
  readonly eligibilityCutoffAt: string;
  readonly policy: DailyChallengeRewardPolicy;
  readonly awards: readonly DailyChallengeRewardAward[];
  readonly digest: string;
}

export interface DailyChallengeParticipantContext {
  readonly principalId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly challengeDate: string;
  readonly setup: JsonValue;
  readonly settings: JsonValue;
}

/** Game-owned policy registered against one exact platform release. */
export interface DailyChallengeRegistration {
  readonly gameId: string;
  readonly releaseId: string;
  readonly modeId: string;
  readonly playerCount: number;
  readonly timezone?: string;
  readonly validityPolicyVersion?: string;
  readonly rewardPolicy?: DailyChallengeRewardPolicy;
  readonly settings: {
    readonly defaults: JsonValue;
    readonly validate: (settings: JsonValue) => void | Promise<void>;
    /** Optional async validation used by a remote game service. */
    readonly validateAsync?: (settings: JsonValue) => Promise<void>;
  };
  /** Projects frozen settings into a bounded, client-safe presentation. */
  readonly publicSettings?: (
    settings: JsonValue,
  ) => JsonValue | Promise<JsonValue>;
  /** Atomic remote preparation of the frozen date tuple. */
  readonly prepare?: (
    challengeDate: string,
    settings: JsonValue,
  ) => DailyChallengePrepare | Promise<DailyChallengePrepare>;
  readonly seedForDate: (
    challengeDate: string,
    settings: JsonValue,
  ) => string | Promise<string>;
  readonly setupForDate: (
    challengeDate: string,
    settings: JsonValue,
  ) => JsonValue | Promise<JsonValue>;
  readonly validateSetup: (setup: JsonValue) => void | Promise<void>;
  readonly participants: (
    context: DailyChallengeParticipantContext,
  ) => readonly Participant[] | Promise<readonly Participant[]>;
  readonly score: (
    result: GameResult,
    admission: MatchAdmission,
  ) => DailyChallengeScore | null | Promise<DailyChallengeScore | null>;
}

export interface DailyChallengeSnapshotRecord
  extends IPlatformDailyChallengeSnapshot {
  readonly settings: JsonValue;
  readonly rewardPolicy?: DailyChallengeRewardPolicy;
  readonly rewardPlan?: DailyChallengeRewardPlan;
  readonly rewardsSettledAt?: string;
}

export interface DailyChallengeAttemptRecord
  extends IPlatformDailyChallengeAttempt {
  readonly gameId: string;
  readonly releaseId: string;
  readonly modeId: string;
  readonly principalId: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly participants: readonly Participant[];
  /** Internal completion idempotency evidence; never serialized publicly. */
  readonly completionDigest?: string;
}

/** Internal replay grant evidence; never serialized as a public leaderboard row. */
export interface DailyChallengeReplayEligibility {
  readonly attempt: DailyChallengeAttemptRecord;
  readonly snapshot: DailyChallengeSnapshotRecord;
}

export interface DailyChallengeAbandonInput {
  readonly attemptId: string;
  readonly abandonedAt?: Date;
}

export interface DailyChallengePublicationInput {
  readonly attemptId: string;
  readonly publicationState: Exclude<
    TPlatformDailyChallengePublication,
    'pending'
  >;
  readonly publicationSelectedAt?: Date;
}

export interface DailyChallengeFinalizeInput {
  readonly gameId: string;
  readonly challengeDate: string;
  /** Optional verification value; finalization never changes a frozen cutoff. */
  readonly eligibilityCutoffAt?: Date;
  readonly finalizedAt?: Date;
}

export interface DailyChallengeRewardsSettledInput {
  readonly gameId: string;
  readonly challengeDate: string;
  readonly planDigest: string;
  readonly settledAt?: Date;
}

export interface DailyChallengeLeaderboardQuery {
  readonly gameId: string;
  readonly challengeDate: string;
  readonly board?: TPlatformDailyChallengeLeaderboardBoard;
  readonly limit?: number;
  readonly principalId?: string;
  /** Internal callers may choose the publication subset before projection. */
  readonly visibility?: 'all' | 'public' | 'anonymous';
}

export interface DailyChallengeSettingsRecord
  extends IPlatformDailyChallengeSettings {}

export interface DailyChallengeLeaderboardRecord
  extends IPlatformDailyChallengeLeaderboardEntry {
  readonly principalId: string;
  /** Internal route key used to authorize a replay audience grant. */
  readonly sessionId?: string;
}

/** Internal score leaderboard response; sessionId is stripped before public projection. */
export interface DailyChallengeScoreLeaderboardResponse
  extends IPlatformDailyChallengeScoreLeaderboardResponse {
  readonly top: readonly DailyChallengeLeaderboardRecord[];
  readonly me?: DailyChallengeLeaderboardRecord;
}

export interface DailyChallengeGrinderRecord
  extends IPlatformDailyChallengeGrinderLeaderboardEntry {
  readonly principalId: string;
}

export interface DailyChallengeLeaderboardsRecord
  extends IPlatformDailyChallengeLeaderboardsResponse {
  readonly firstLook: DailyChallengeScoreLeaderboardResponse;
  readonly overall: DailyChallengeScoreLeaderboardResponse;
  readonly grinder: IPlatformDailyChallengeGrinderLeaderboardResponse;
}

export interface DailyChallengeLeaderboardsQuery
  extends Omit<DailyChallengeLeaderboardQuery, 'board'> {}
