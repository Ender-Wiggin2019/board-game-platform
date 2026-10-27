import type {
  AchievementCollection,
  GameAssetDefinition,
  GameCapability,
  GameCatalogEntry,
  GameMetadata,
  GamePolicyVersion,
  GameProfileSummary,
  GameRankingSummary,
  GameResult,
  GameWallet,
  JsonValue,
  MatchAdmission,
  Participant,
  PlatformRoom,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import type {
  AwardStore,
  EntitlementStore,
  RatingSettlementRecord,
  RatingSettlementRunner,
} from '@board-game/core';
import type { IPlatformGameShellSummary } from '@board-platform/contracts';
import type { DailyChallengeRegistration } from '../daily-challenge/types.js';

export type {
  GameCapability,
  GameCatalogEntry,
  GameMetadata,
} from '@board-game/contracts';

export interface GameAchievementSource {
  readonly principalId: string;
  readonly facts: readonly JsonValue[];
}

export interface GameCompletionInput {
  /** Route and admission are supplied by the trusted platform boundary. */
  readonly route: SessionRoute;
  readonly admission: MatchAdmission;
  readonly result: GameResult;
  readonly resultRevision: number;
  readonly occurredAt: number;
  readonly achievementSources?: readonly GameAchievementSource[];
}

export interface GameCompletionContext {
  readonly gameId: string;
  readonly releaseId: string;
  readonly sessionId: string;
  readonly resultRevision: number;
  readonly occurredAt: number;
  readonly route: SessionRoute;
  readonly admission: MatchAdmission;
  readonly result: GameResult;
  readonly achievementSources: readonly GameAchievementSource[];
}

export interface GameAchievementWriteRequest extends GameCompletionContext {
  readonly definitionVersion: string;
  readonly sourceRecordId: string;
}

export interface GameAchievementCapability {
  readonly definitionVersion: string;
  /** New games may provide a writer; read-only legacy adapters omit it. */
  readonly consume?: (request: GameAchievementWriteRequest) => Promise<void>;
  readonly read?: (principalId: string) => Promise<AchievementCollection>;
}

export interface GameRewardInstruction {
  readonly rewardId: string;
  readonly asset: string;
  readonly quantity: number;
  readonly metadata?: JsonValue;
}

export interface GameRewardPlan {
  readonly principalId: string;
  readonly awardId: string;
  readonly tier: string;
  readonly rewards: readonly GameRewardInstruction[];
}

export interface GameRewardWriteRequest extends GameCompletionContext {
  readonly definitionVersion: string;
  readonly sourceRecordId: string;
  readonly plans: readonly GameRewardPlan[];
}

export interface GameRewardReceipt {
  readonly principalId: string;
  readonly awardId: string;
  readonly tier: string;
  readonly sourceRecordId: string;
  readonly grantId?: string;
  readonly deliveredRewardIds: readonly string[];
}

export interface GameRewardCapability {
  readonly definitionVersion: string;
  readonly createAwards: (
    context: GameCompletionContext,
  ) => readonly GameRewardPlan[] | Promise<readonly GameRewardPlan[]>;
  /** An installed game can provide its existing authoritative writer. */
  readonly write?: (
    request: GameRewardWriteRequest,
  ) => Promise<readonly GameRewardReceipt[]>;
  readonly readWallet?: (principalId: string) => Promise<GameWallet>;
}

export interface GameRatingWriteRequest extends GameCompletionContext {
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
}

export interface GameRatingPoolPolicy {
  readonly poolId: string;
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
}

export interface GameRatingCapability {
  /** Legacy single-pool shorthand. */
  readonly policyVersion?: string;
  readonly progressionPolicyVersion?: string;
  /** An installed game can expose several frozen admission pools. */
  readonly pools?: readonly GameRatingPoolPolicy[];
  /** Legacy game writers may settle outside the generic core runner. */
  readonly settlement?: 'core' | 'external';
  /** An installed game can provide its existing authoritative settlement writer. */
  readonly settle?: (
    request: GameRatingWriteRequest,
  ) => Promise<JsonValue | null>;
  readonly readRankings?: (
    principalId: string | undefined,
  ) => Promise<GameRankingSummary>;
}

export interface GameRankingCapability {
  readonly read: (
    principalId: string | undefined,
  ) => Promise<GameRankingSummary>;
}

export interface GameProfileCapability {
  readonly read: (
    principalId: string,
  ) => Promise<
    Partial<Pick<GameProfileSummary, 'displayName' | 'stats' | 'rank'>>
  >;
}

/** Aggregate statistics supplied by the game adapter to authorized players/operators. */
export interface GameStatisticsCapability {
  readonly read: (principalId?: string) => Promise<JsonValue>;
}

/** Account-facing counts supplied by a game's authoritative legacy adapter. */
export interface GameShellSummaryCapability {
  readonly read: (
    principalId: string,
  ) => Promise<
    Readonly<
      Pick<
        IPlatformGameShellSummary,
        'gameInvitations' | 'actionRequired' | 'waitingReady'
      >
    >
  >;
}

/**
 * Context supplied by the platform for a safe, release-pinned summary read.
 * The interpreter must remain pure: it cannot load Host state or perform I/O.
 */
export interface GameSessionAttentionContext {
  readonly principalId: string;
  readonly participants: readonly Participant[];
  readonly route: SessionRoute;
  readonly status: SessionStatus;
}

/** Pure game-owned interpretation of one public session summary. */
export interface GameSessionAttentionCapability {
  readonly interpret: (
    summary: JsonValue,
    context: GameSessionAttentionContext,
  ) => boolean;
  /** Exact-release room capacity policy used by the shell waiting count. */
  readonly roomCapacity?: (room: Pick<PlatformRoom, 'setup'>) => number;
}

/** Server-only registration. Functions never cross the JSON catalog boundary. */
export interface GameCapabilityRegistration {
  readonly metadata: GameMetadata;
  readonly releaseId: string;
  readonly capabilities: readonly GameCapability[];
  readonly policyVersions: readonly GamePolicyVersion[];
  readonly assets: readonly GameAssetDefinition[];
  readonly achievements?: GameAchievementCapability;
  readonly rewards?: GameRewardCapability;
  readonly rating?: GameRatingCapability;
  readonly rankings?: GameRankingCapability;
  readonly profile?: GameProfileCapability;
  /** Optional aggregate statistics; functions never cross the catalog boundary. */
  readonly statistics?: GameStatisticsCapability;
  /** Optional immutable-date daily challenge adapter owned by the game. */
  readonly dailyChallenge?: DailyChallengeRegistration;
  /** Optional account shell counts; functions never cross the JSON catalog boundary. */
  readonly shellSummary?: GameShellSummaryCapability;
  /** Optional pure interpretation of public native session summaries. */
  readonly sessionAttention?: GameSessionAttentionCapability;
  readonly wallet?: {
    readonly read: (principalId: string) => Promise<GameWallet>;
  };
}

export interface GameCompletionOutcome {
  readonly gameId: string;
  readonly releaseId: string;
  readonly sessionId: string;
  readonly resultRevision: number;
  readonly achievementProcessed: boolean;
  readonly rewards: readonly GameRewardReceipt[];
  readonly rating: JsonValue | null;
}

export interface GameCapabilityServiceOptions {
  readonly registry: GameCatalogReader & {
    resolve(gameId: string, releaseId: string): GameCapabilityRegistration;
  };
  readonly awards?: AwardStore;
  readonly entitlements?: Pick<EntitlementStore, 'grant' | 'getBalance'>;
  readonly ratings?: RatingSettlementRunner;
}

export interface GameCatalogReader {
  list(): readonly GameCatalogEntry[];
  get(gameId: string, releaseId: string): GameCatalogEntry | null;
}

export type GameRatingSettlement = RatingSettlementRecord;

export function completionSourceRecordId(
  gameId: string,
  sessionId: string,
  resultRevision: number,
  definitionVersion: string,
): string {
  return [
    'game',
    encodeURIComponent(gameId),
    'session',
    encodeURIComponent(sessionId),
    'revision',
    String(resultRevision),
    'definition',
    encodeURIComponent(definitionVersion),
  ].join(':');
}

export function participantIds(
  participants: readonly Participant[],
): ReadonlySet<string> {
  return new Set(participants.map((participant) => participant.principalId));
}

export function ratingPolicies(
  rating: GameRatingCapability,
): readonly GameRatingPoolPolicy[] {
  if (rating.pools !== undefined) return rating.pools;
  if (
    typeof rating.policyVersion !== 'string' ||
    typeof rating.progressionPolicyVersion !== 'string'
  )
    return [];
  return [
    {
      poolId: '*',
      policyVersion: rating.policyVersion,
      progressionPolicyVersion: rating.progressionPolicyVersion,
    },
  ];
}
