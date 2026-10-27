import {
  assertGameResult,
  type CompetitiveResult,
  contractError,
  type GameAssetDefinition,
  type GameCapability,
  type GameMetadata,
  type GamePolicyKind,
  type GamePolicyVersion,
  type GameRankingEntry,
  type GameRankingSummary,
  type GameResult,
  type JsonValue,
  type MatchAdmission,
  type Participant,
  type ParticipantController,
  type PlatformCompletionRecord,
  participantAccountId,
} from '@board-game/contracts';
import {
  type RatingPolicy,
  type RatingPolicyInput,
  type RatingStore,
  rateTrueSkill,
} from '@board-game/core';
import type {
  GameAchievementDefinition,
  GameAchievementStore,
} from './capabilities/achievements.js';
import type { GameCapabilityService } from './capabilities/service.js';
import type {
  GameAchievementSource,
  GameCapabilityRegistration,
  GameCompletionContext,
  GameRewardPlan,
} from './capabilities/types.js';
import { assertDailyChallengeRewardPolicy } from './daily-challenge/rewards.js';
import type { DailyChallengeRewardPolicy } from './daily-challenge/types.js';
import type {
  GameMessageTemplate,
  PlatformMessageService,
} from './PlatformMessageService.js';

const CONTROLLERS = new Set<ParticipantController>([
  'human',
  'hotseat',
  'ai',
  'automa',
  'bot',
]);
const POLICY_KINDS = new Set<GamePolicyKind>([
  'rating',
  'progression',
  'reward',
  'achievement',
]);
const COMPLETION_TEMPLATE_KEYS = [
  'templateId',
  'title',
  'body',
  'actionLabel',
  'actionPath',
] as const;

/** JSON-only rating/reward/achievement data supplied by a game release. */
export interface RemoteSettlementPolicyBundle {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly releaseId: string;
  readonly approvedModes: readonly string[];
  readonly rating: {
    readonly poolId: string;
    readonly policyVersion: string;
    readonly progressionPolicyVersion: string;
    /** Additional frozen pools sharing the same rating algorithm and stars. */
    readonly policies?: readonly {
      readonly poolId: string;
      readonly policyVersion: string;
      readonly progressionPolicyVersion: string;
    }[];
    readonly algorithm: 'trueskill-stars-v1';
    readonly parameters: {
      readonly mu: number;
      readonly sigma: number;
      readonly beta: number;
      readonly tau: number;
      readonly drawProbability: number;
      readonly minDelta: number;
    };
    readonly stars: {
      readonly rewards: Readonly<Record<'2' | '3' | '4', readonly number[]>>;
      readonly legendThreshold: number;
      readonly legendQualifyingGames: number;
    };
  };
  readonly rewards: {
    readonly definitionVersion: string;
    readonly asset: string;
    readonly quantities: readonly number[];
    /** Optional complete per-player-count reward tables for game-owned rules. */
    readonly quantitiesByPlayerCount?: Readonly<
      Record<'2' | '3' | '4', readonly number[]>
    >;
    readonly excludeControllers: readonly ParticipantController[];
  };
  readonly dailyChallengeRewards?: DailyChallengeRewardPolicy;
  readonly achievements: {
    readonly definitionVersion: string;
    readonly definitions: readonly GameAchievementDefinition[];
    readonly winnerAchievementId?: string;
    /** Legacy bundles may request generic facts; game-owned bundles can opt out. */
    readonly generatedFacts?: 'basic' | 'none';
    readonly excludeControllers: readonly ParticipantController[];
  };
  readonly messages: {
    readonly completion: {
      readonly templateId: string;
      readonly title: string;
      readonly body: string;
      readonly actionLabel: string;
      readonly actionPath: string;
    };
  };
}

/** Approval is explicit platform state, never inferred from the game bundle. */
export interface RemoteSettlementApproval {
  readonly gameId: string;
  readonly releaseId: string;
  readonly approvedModes: readonly string[];
  /** Daily mode approval is separate from ordinary completion settlement. */
  readonly approvedDailyModes?: readonly string[];
  readonly approvedPolicyVersions: readonly GamePolicyVersion[];
}

export interface RemoteSettlementServices {
  readonly achievements: GameAchievementStore;
  readonly ratings: Pick<
    RatingStore,
    'listByRanking' | 'getRating' | 'getRankedPosition'
  >;
  readonly capabilities: Pick<GameCapabilityService, 'complete'>;
  readonly messages: Pick<PlatformMessageService, 'publish'>;
}

export interface RemoteSettlementHandlerOptions {
  readonly bundle: RemoteSettlementPolicyBundle;
  readonly approval: RemoteSettlementApproval;
  readonly metadata: GameMetadata;
  readonly services: RemoteSettlementServices;
  readonly displayName?: (
    principalId: string,
  ) => string | Promise<string | undefined>;
  /** Optional public alias retained when the durable pool id is internal. */
  readonly publicPoolId?: string;
  /** Optional persisted admission reader; the completion record is the fallback. */
  readonly admission?: (
    record: PlatformCompletionRecord,
  ) => Promise<MatchAdmission | null>;
}

export interface RemoteSettlementHandler {
  readonly registration: GameCapabilityRegistration;
  /** Pass to PlatformGameServices.register as its ratingPolicies option. */
  readonly ratingPolicy: RatingPolicy;
  /** All frozen pool policies; ratingPolicy is the primary-pool shorthand. */
  readonly ratingPolicies: readonly RatingPolicy[];
  /** Pass to PlatformGameServices.register as its messages option. */
  readonly messages: Readonly<Record<string, GameMessageTemplate>>;
  /** Inject this callback into PlatformApplicationRuntime.settleCompletion. */
  readonly settleCompletion: (
    record: PlatformCompletionRecord,
  ) => Promise<void>;
}

interface RatingProgressionState {
  readonly mu: number;
  readonly sigma: number;
  readonly stars: number;
  readonly qualifyingGames: number;
  readonly legend: boolean;
}

function recordOf(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  )
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_FIELDS_INVALID`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  return value;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  return value;
}

function assertControllerList(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  const seen = new Set<string>();
  for (const controller of value) {
    if (
      typeof controller !== 'string' ||
      !CONTROLLERS.has(controller as ParticipantController) ||
      seen.has(controller)
    )
      throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
    seen.add(controller);
  }
}

function assertPolicyVersions(
  versions: readonly GamePolicyVersion[],
  field: string,
): void {
  if (!Array.isArray(versions) || versions.length === 0)
    throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
  const seen = new Set<string>();
  for (const version of versions) {
    const value = recordOf(version, `${field}_entry`);
    exactKeys(value, ['kind', 'version'], `${field}_entry`);
    if (
      typeof value.kind !== 'string' ||
      !POLICY_KINDS.has(value.kind as GamePolicyKind)
    )
      throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_INVALID`);
    const versionText = text(value.version, `${field}.version`);
    const key = `${value.kind}:${versionText}`;
    if (seen.has(key))
      throw new Error(`REMOTE_POLICY_${field.toUpperCase()}_DUPLICATE`);
    seen.add(key);
  }
}

function assertBundle(bundle: RemoteSettlementPolicyBundle): void {
  const root = recordOf(bundle, 'bundle');
  exactKeys(
    root,
    [
      'schemaVersion',
      'gameId',
      'releaseId',
      'approvedModes',
      'rating',
      'rewards',
      ...(Object.hasOwn(root, 'dailyChallengeRewards')
        ? ['dailyChallengeRewards']
        : []),
      'achievements',
      'messages',
    ],
    'bundle',
  );
  if (bundle.schemaVersion !== 1) throw new Error('REMOTE_POLICY_SCHEMA');
  text(bundle.gameId, 'gameId');
  text(bundle.releaseId, 'releaseId');
  if (!Array.isArray(bundle.approvedModes) || bundle.approvedModes.length === 0)
    throw new Error('REMOTE_POLICY_MODES_INVALID');
  if (
    new Set(bundle.approvedModes).size !== bundle.approvedModes.length ||
    bundle.approvedModes.some((mode) => typeof mode !== 'string' || mode === '')
  )
    throw new Error('REMOTE_POLICY_MODES_INVALID');

  const rating = recordOf(bundle.rating, 'rating');
  exactKeys(
    rating,
    [
      'poolId',
      'policyVersion',
      'progressionPolicyVersion',
      'algorithm',
      'parameters',
      'stars',
      ...(Object.hasOwn(rating, 'policies') ? ['policies'] : []),
    ],
    'rating',
  );
  text(bundle.rating.poolId, 'rating.poolId');
  text(bundle.rating.policyVersion, 'rating.policyVersion');
  text(
    bundle.rating.progressionPolicyVersion,
    'rating.progressionPolicyVersion',
  );
  if (bundle.rating.algorithm !== 'trueskill-stars-v1')
    throw new Error('REMOTE_POLICY_RATING_ALGORITHM');
  const parameters = recordOf(bundle.rating.parameters, 'rating.parameters');
  exactKeys(
    parameters,
    ['mu', 'sigma', 'beta', 'tau', 'drawProbability', 'minDelta'],
    'rating.parameters',
  );
  finite(bundle.rating.parameters.mu, 'rating.parameters.mu');
  if (!(finite(bundle.rating.parameters.sigma, 'rating.parameters.sigma') > 0))
    throw new Error('REMOTE_POLICY_RATING_SIGMA');
  if (!(finite(bundle.rating.parameters.beta, 'rating.parameters.beta') > 0))
    throw new Error('REMOTE_POLICY_RATING_BETA');
  if (!(finite(bundle.rating.parameters.tau, 'rating.parameters.tau') >= 0))
    throw new Error('REMOTE_POLICY_RATING_TAU');
  const drawProbability = finite(
    bundle.rating.parameters.drawProbability,
    'rating.parameters.drawProbability',
  );
  if (drawProbability < 0 || drawProbability >= 1)
    throw new Error('REMOTE_POLICY_RATING_DRAW');
  if (
    !(
      finite(bundle.rating.parameters.minDelta, 'rating.parameters.minDelta') >
      0
    )
  )
    throw new Error('REMOTE_POLICY_RATING_MIN_DELTA');
  const stars = recordOf(bundle.rating.stars, 'rating.stars');
  exactKeys(
    stars,
    ['rewards', 'legendThreshold', 'legendQualifyingGames'],
    'rating.stars',
  );
  const rewardsByPlayerCount = recordOf(
    bundle.rating.stars.rewards,
    'rating.stars.rewards',
  );
  exactKeys(rewardsByPlayerCount, ['2', '3', '4'], 'rating.stars.rewards');
  for (const count of ['2', '3', '4'] as const) {
    const rewards = bundle.rating.stars.rewards[count];
    if (
      !Array.isArray(rewards) ||
      rewards.length !== Number(count) ||
      rewards.some(
        (reward) => !Number.isSafeInteger(reward) || !Number.isFinite(reward),
      )
    )
      throw new Error('REMOTE_POLICY_STAR_REWARDS');
  }
  positiveInteger(
    bundle.rating.stars.legendThreshold,
    'rating.legendThreshold',
  );
  positiveInteger(
    bundle.rating.stars.legendQualifyingGames,
    'rating.legendQualifyingGames',
  );
  if (bundle.rating.policies !== undefined) {
    if (bundle.rating.policies.length === 0)
      throw new Error('REMOTE_POLICY_RATING_POLICIES_INVALID');
    const poolIds = new Set([bundle.rating.poolId]);
    for (const policy of bundle.rating.policies) {
      const value = recordOf(policy, 'rating.policy');
      exactKeys(
        value,
        ['poolId', 'policyVersion', 'progressionPolicyVersion'],
        'rating.policy',
      );
      text(policy.poolId, 'rating.policy.poolId');
      text(policy.policyVersion, 'rating.policy.policyVersion');
      text(
        policy.progressionPolicyVersion,
        'rating.policy.progressionPolicyVersion',
      );
      if (poolIds.has(policy.poolId))
        throw new Error('REMOTE_POLICY_RATING_POOL_DUPLICATE');
      poolIds.add(policy.poolId);
    }
  }

  const rewards = recordOf(bundle.rewards, 'rewards');
  exactKeys(
    rewards,
    [
      'definitionVersion',
      'asset',
      'quantities',
      'excludeControllers',
      ...(Object.hasOwn(rewards, 'quantitiesByPlayerCount')
        ? ['quantitiesByPlayerCount']
        : []),
    ],
    'rewards',
  );
  text(bundle.rewards.definitionVersion, 'rewards.definitionVersion');
  text(bundle.rewards.asset, 'rewards.asset');
  if (
    !Array.isArray(bundle.rewards.quantities) ||
    bundle.rewards.quantities.length === 0 ||
    bundle.rewards.quantities.some(
      (quantity) => !Number.isSafeInteger(quantity) || quantity < 1,
    )
  )
    throw new Error('REMOTE_POLICY_REWARD_QUANTITIES');
  if (bundle.rewards.quantitiesByPlayerCount !== undefined) {
    const tables = recordOf(
      bundle.rewards.quantitiesByPlayerCount,
      'rewards.quantitiesByPlayerCount',
    );
    exactKeys(tables, ['2', '3', '4'], 'rewards.quantitiesByPlayerCount');
    for (const count of ['2', '3', '4'] as const) {
      const quantities = bundle.rewards.quantitiesByPlayerCount[count];
      if (
        !Array.isArray(quantities) ||
        quantities.length !== Number(count) ||
        quantities.some(
          (quantity) => !Number.isSafeInteger(quantity) || quantity < 1,
        )
      )
        throw new Error('REMOTE_POLICY_REWARD_QUANTITIES');
    }
  }
  assertControllerList(
    bundle.rewards.excludeControllers,
    'rewards.excludeControllers',
  );

  if (bundle.dailyChallengeRewards !== undefined) {
    assertDailyChallengeRewardPolicy(bundle.dailyChallengeRewards);
    if (bundle.approvedModes.includes(bundle.dailyChallengeRewards.modeId))
      throw new Error('REMOTE_POLICY_DAILY_MODE_IN_ORDINARY_APPROVAL');
  }

  const achievements = recordOf(bundle.achievements, 'achievements');
  exactKeys(
    achievements,
    [
      'definitionVersion',
      'definitions',
      'excludeControllers',
      ...(Object.hasOwn(achievements, 'winnerAchievementId')
        ? ['winnerAchievementId']
        : []),
      ...(Object.hasOwn(achievements, 'generatedFacts')
        ? ['generatedFacts']
        : []),
    ],
    'achievements',
  );
  text(bundle.achievements.definitionVersion, 'achievements.definitionVersion');
  if (bundle.achievements.winnerAchievementId !== undefined)
    text(bundle.achievements.winnerAchievementId, 'achievements.winner');
  if (
    bundle.achievements.generatedFacts !== undefined &&
    bundle.achievements.generatedFacts !== 'basic' &&
    bundle.achievements.generatedFacts !== 'none'
  )
    throw new Error('REMOTE_POLICY_ACHIEVEMENTS_GENERATED_FACTS');
  if (
    !Array.isArray(bundle.achievements.definitions) ||
    bundle.achievements.definitions.length === 0
  )
    throw new Error('REMOTE_POLICY_ACHIEVEMENTS');
  const achievementIds = new Set<string>();
  for (const definition of bundle.achievements.definitions) {
    const value = recordOf(definition, 'achievement.definition');
    exactKeys(
      value,
      [
        'achievementId',
        'title',
        'description',
        'tier',
        'target',
        ...(Object.hasOwn(value, 'criterion') ? ['criterion'] : []),
        ...(Object.hasOwn(value, 'seriesId') ? ['seriesId'] : []),
        ...(Object.hasOwn(value, 'level') ? ['level'] : []),
      ],
      'achievement.definition',
    );
    const achievementId = text(
      definition.achievementId,
      'achievement.achievementId',
    );
    if (achievementIds.has(achievementId))
      throw new Error('REMOTE_POLICY_ACHIEVEMENT_DUPLICATE');
    achievementIds.add(achievementId);
    text(definition.title, 'achievement.title');
    text(definition.description, 'achievement.description');
    text(definition.tier, 'achievement.tier');
    positiveInteger(definition.target, 'achievement.target');
    if (definition.criterion !== undefined) {
      const criterion = recordOf(
        definition.criterion,
        'achievement.definition.criterion',
      );
      exactKeys(
        criterion,
        [
          'metric',
          'aggregation',
          'comparator',
          ...(Object.hasOwn(criterion, 'subjectId') ? ['subjectId'] : []),
        ],
        'achievement.definition.criterion',
      );
      text(criterion.metric, 'achievement.definition.criterion.metric');
      if (criterion.aggregation !== 'sum' && criterion.aggregation !== 'max')
        throw new Error('REMOTE_POLICY_ACHIEVEMENT_CRITERION');
      if (criterion.comparator !== 'gte' && criterion.comparator !== 'gt')
        throw new Error('REMOTE_POLICY_ACHIEVEMENT_CRITERION');
      if (criterion.subjectId !== undefined)
        text(criterion.subjectId, 'achievement.definition.criterion.subjectId');
    }
    if (definition.seriesId !== undefined)
      text(definition.seriesId, 'achievement.seriesId');
    if (definition.level !== undefined)
      positiveInteger(definition.level, 'achievement.level');
  }
  if (
    bundle.achievements.winnerAchievementId !== undefined &&
    !achievementIds.has(bundle.achievements.winnerAchievementId)
  )
    throw new Error('REMOTE_POLICY_WINNER_ACHIEVEMENT');
  assertControllerList(
    bundle.achievements.excludeControllers,
    'achievements.excludeControllers',
  );

  const messages = recordOf(bundle.messages, 'messages');
  exactKeys(messages, ['completion'], 'messages');
  const completion = recordOf(
    bundle.messages.completion,
    'messages.completion',
  );
  exactKeys(completion, COMPLETION_TEMPLATE_KEYS, 'messages.completion');
  for (const key of COMPLETION_TEMPLATE_KEYS)
    text(completion[key], `messages.completion.${key}`);
}

/** Validates a release-persisted JSON bundle before it is used for admission. */
export function assertRemoteSettlementPolicyBundle(
  value: unknown,
): asserts value is RemoteSettlementPolicyBundle {
  assertBundle(value as RemoteSettlementPolicyBundle);
}

function assertApproval(
  bundle: RemoteSettlementPolicyBundle,
  approval: RemoteSettlementApproval,
): void {
  if (!approval || typeof approval !== 'object')
    throw new Error('REMOTE_POLICY_APPROVAL_REQUIRED');
  if (
    approval.gameId !== bundle.gameId ||
    approval.releaseId !== bundle.releaseId
  )
    throw new Error('REMOTE_POLICY_APPROVAL_RELEASE_MISMATCH');
  if (
    !Array.isArray(approval.approvedModes) ||
    approval.approvedModes.length === 0
  )
    throw new Error('REMOTE_POLICY_APPROVAL_MODES');
  if (approval.approvedDailyModes !== undefined) {
    if (
      !Array.isArray(approval.approvedDailyModes) ||
      new Set(approval.approvedDailyModes).size !==
        approval.approvedDailyModes.length ||
      approval.approvedDailyModes.some(
        (mode) => typeof mode !== 'string' || mode.trim().length === 0,
      )
    )
      throw new Error('REMOTE_POLICY_APPROVAL_DAILY_MODES');
  }
  if (
    bundle.approvedModes.some((mode) => !approval.approvedModes.includes(mode))
  )
    throw new Error('REMOTE_POLICY_APPROVAL_MODE_MISSING');
  if (
    bundle.dailyChallengeRewards !== undefined &&
    !approval.approvedDailyModes?.includes(bundle.dailyChallengeRewards.modeId)
  )
    throw new Error('REMOTE_POLICY_APPROVAL_DAILY_MODE_MISSING');
  assertPolicyVersions(
    approval.approvedPolicyVersions,
    'approval.approvedPolicyVersions',
  );
  const expected = [
    ...ratingSpecs(bundle).flatMap(
      (spec) =>
        [
          ['rating', spec.policyVersion],
          ['progression', spec.progressionPolicyVersion],
        ] as const,
    ),
    ['reward', bundle.rewards.definitionVersion],
    ...(bundle.dailyChallengeRewards === undefined
      ? []
      : [['reward', bundle.dailyChallengeRewards.definitionVersion] as const]),
    ['achievement', bundle.achievements.definitionVersion],
  ];
  const expectedKeys = new Set<string>();
  for (const [kind, version] of expected) {
    const expectedKey = `${kind}:${version}`;
    if (expectedKeys.has(expectedKey)) continue;
    expectedKeys.add(expectedKey);
    if (
      !approval.approvedPolicyVersions.some(
        (candidate) => candidate.kind === kind && candidate.version === version,
      )
    )
      throw new Error('REMOTE_POLICY_APPROVAL_VERSION_MISSING');
  }
}

interface RemoteRatingPolicySpec {
  readonly poolId: string;
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
}

function ratingSpecs(
  bundle: RemoteSettlementPolicyBundle,
): readonly RemoteRatingPolicySpec[] {
  return [
    {
      poolId: bundle.rating.poolId,
      policyVersion: bundle.rating.policyVersion,
      progressionPolicyVersion: bundle.rating.progressionPolicyVersion,
    },
    ...(bundle.rating.policies ?? []),
  ];
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function initialState(
  bundle: RemoteSettlementPolicyBundle,
): RatingProgressionState {
  return {
    mu: bundle.rating.parameters.mu,
    sigma: bundle.rating.parameters.sigma,
    stars: 0,
    qualifyingGames: 0,
    legend: false,
  };
}

function stateOf(
  value: JsonValue | undefined,
  bundle: RemoteSettlementPolicyBundle,
): RatingProgressionState {
  if (value === undefined) return initialState(bundle);
  const candidate = recordOf(value, 'rating.state');
  exactKeys(
    candidate,
    ['mu', 'sigma', 'stars', 'qualifyingGames', 'legend'],
    'rating.state',
  );
  const mu = finite(candidate.mu, 'rating.state.mu');
  const sigma = finite(candidate.sigma, 'rating.state.sigma');
  const stars = safeInteger(candidate.stars, 'rating.state.stars');
  const qualifyingGames = safeInteger(
    candidate.qualifyingGames,
    'rating.state.qualifyingGames',
  );
  if (
    sigma <= 0 ||
    stars < 0 ||
    qualifyingGames < 0 ||
    typeof candidate.legend !== 'boolean'
  )
    throw new Error('REMOTE_POLICY_RATING_STATE');
  return {
    mu,
    sigma,
    stars,
    qualifyingGames,
    legend: candidate.legend,
  };
}

function rankMap(result: CompetitiveResult): Map<string, number> {
  const ranks = new Map<string, number>();
  result.rankGroups.forEach((group, index) => {
    for (const team of group.teams)
      for (const participantId of team.participantIds)
        ranks.set(participantId, index);
  });
  return ranks;
}

function placementMap(
  result: CompetitiveResult,
): Map<string, { readonly start: number; readonly end: number }> {
  const placements = new Map<
    string,
    { readonly start: number; readonly end: number }
  >();
  let position = 1;
  for (const group of result.rankGroups) {
    const count = group.teams.reduce(
      (total, team) => total + team.participantIds.length,
      0,
    );
    const placement = { start: position, end: position + count - 1 };
    for (const team of group.teams)
      for (const participantId of team.participantIds)
        placements.set(participantId, placement);
    position += count;
  }
  return placements;
}

function skillAfter(
  participants: readonly Participant[],
  previous: Readonly<Record<string, JsonValue>>,
  ranks: ReadonlyMap<string, number>,
  bundle: RemoteSettlementPolicyBundle,
): Map<string, { readonly mu: number; readonly sigma: number }> {
  const ordered = [...participants]
    .map((participant) => {
      const state = stateOf(previous[participant.principalId], bundle);
      const engineRank = ranks.get(participant.principalId);
      if (engineRank === undefined) throw new Error('REMOTE_POLICY_ROSTER');
      return {
        userId: participant.principalId,
        mu: state.mu,
        sigma: state.sigma,
        engineRank,
      };
    })
    .sort((left, right) => left.userId.localeCompare(right.userId));
  const rankLevels = [
    ...new Set(ordered.map((player) => player.engineRank)),
  ].sort((left, right) => left - right);
  const rankOrdinals = new Map(rankLevels.map((rank, index) => [rank, index]));
  const rated = rateTrueSkill(
    ordered.map((player) => [{ mu: player.mu, sigma: player.sigma }]),
    ordered.map((player) => rankOrdinals.get(player.engineRank) ?? 0),
    bundle.rating.parameters,
  );
  const byUser = new Map<
    string,
    { readonly mu: number; readonly sigma: number }
  >();
  ordered.forEach((player, index) => {
    const row = rated[index]?.[0];
    if (
      !row ||
      !Number.isFinite(row.mu) ||
      !Number.isFinite(row.sigma) ||
      row.sigma <= 0
    )
      throw new Error('REMOTE_POLICY_RATING_OUTPUT');
    byUser.set(player.userId, { mu: row.mu, sigma: row.sigma });
  });
  const ties = new Map<string, string[]>();
  for (const player of ordered) {
    const key = `${player.engineRank}\u0000${player.mu}\u0000${player.sigma}`;
    ties.set(key, [...(ties.get(key) ?? []), player.userId]);
  }
  for (const ids of ties.values()) {
    if (ids.length < 2) continue;
    const states = ids.flatMap((id) => {
      const state = byUser.get(id);
      return state ? [state] : [];
    });
    if (states.length !== ids.length)
      throw new Error('REMOTE_POLICY_RATING_OUTPUT');
    const mu =
      states.reduce((total, state) => total + state.mu, 0) / states.length;
    const sigma =
      states.reduce((total, state) => total + state.sigma, 0) / states.length;
    for (const id of ids) byUser.set(id, { mu, sigma });
  }
  return byUser;
}

function starReward(
  bundle: RemoteSettlementPolicyBundle,
  playerCount: 2 | 3 | 4,
  positionStart: number,
  positionEnd: number,
): number {
  if (positionStart === 1 && positionEnd === playerCount) return 0;
  const values = bundle.rating.stars.rewards[
    String(playerCount) as '2' | '3' | '4'
  ].slice(positionStart - 1, positionEnd);
  return Math.trunc(
    values.reduce((total, value) => total + value, 0) / values.length,
  );
}

function rankingScore(state: RatingProgressionState): number {
  return (
    (state.legend ? 1_000_000_000_000 : 0) + state.stars * 1_000_000 + state.mu
  );
}

/** Exact generic TrueSkill-plus-stars interpreter used by approved bundles. */
function createRemoteRatingPolicyForSpec(
  bundle: RemoteSettlementPolicyBundle,
  spec: RemoteRatingPolicySpec,
): RatingPolicy {
  return {
    policyVersion: spec.policyVersion,
    progressionPolicyVersion: spec.progressionPolicyVersion,
    initialState: () => asJson(initialState(bundle)),
    calculate: (input: RatingPolicyInput) => {
      if (input.result.kind !== 'competitive')
        throw new Error('REMOTE_POLICY_COMPETITIVE_RESULT_REQUIRED');
      const playerCount = input.participants.length;
      if (playerCount < 2 || playerCount > 4)
        throw new Error('REMOTE_POLICY_PLAYER_COUNT');
      const ranks = rankMap(input.result);
      const placements = placementMap(input.result);
      const skills = skillAfter(
        input.participants,
        input.previous,
        ranks,
        bundle,
      );
      const allTied = input.result.rankGroups.length === 1;
      return input.participants.map((participant) => {
        const participantId = participant.principalId;
        const before = stateOf(input.previous[participantId], bundle);
        const placement = placements.get(participantId);
        const skill = skills.get(participantId);
        if (!placement || !skill) throw new Error('REMOTE_POLICY_ROSTER');
        const base =
          allTied || before.legend
            ? 0
            : starReward(
                bundle,
                playerCount as 2 | 3 | 4,
                placement.start,
                placement.end,
              );
        const floor = before.stars < 10 ? before.stars : 0;
        const stars = before.legend
          ? before.stars
          : Math.max(floor, before.stars + base);
        const qualifyingGames = before.qualifyingGames + (allTied ? 0 : 1);
        const legend =
          before.legend ||
          (stars >= bundle.rating.stars.legendThreshold &&
            qualifyingGames >= bundle.rating.stars.legendQualifyingGames);
        const after: RatingProgressionState = {
          mu: skill.mu,
          sigma: skill.sigma,
          stars,
          qualifyingGames,
          legend,
        };
        return {
          participantId,
          before: asJson(before),
          after: asJson(after),
          rankingScore: rankingScore(after),
        };
      });
    },
  };
}

export function createRemoteRatingPolicy(
  bundle: RemoteSettlementPolicyBundle,
): RatingPolicy {
  assertBundle(bundle);
  const spec = ratingSpecs(bundle)[0];
  if (!spec) throw new Error('REMOTE_POLICY_RATING_INVALID');
  return createRemoteRatingPolicyForSpec(bundle, spec);
}

/** Build one deterministic interpreter for every approved rating pool. */
export function createRemoteRatingPolicies(
  bundle: RemoteSettlementPolicyBundle,
): readonly RatingPolicy[] {
  assertBundle(bundle);
  return ratingSpecs(bundle).map((spec) =>
    createRemoteRatingPolicyForSpec(bundle, spec),
  );
}

function hasExcludedController(
  participants: readonly Participant[],
  excluded: readonly ParticipantController[],
): boolean {
  return participants.some((participant) =>
    excluded.includes(participant.controller ?? 'human'),
  );
}

function winners(result: GameResult): ReadonlySet<string> {
  return result.kind === 'competitive'
    ? new Set(
        result.rankGroups[0]?.teams.flatMap((team) => team.participantIds) ??
          [],
      )
    : new Set<string>();
}

function achievementFacts(
  context: Pick<GameCompletionContext, 'admission' | 'result'>,
  bundle: RemoteSettlementPolicyBundle,
): readonly GameAchievementSource[] {
  if (bundle.achievements.generatedFacts === 'none') return [];
  const winnerIds = winners(context.result);
  return context.admission.participants.map((participant) => ({
    principalId: participant.principalId,
    facts: [
      asJson({ achievementId: 'first-game', amount: 1 }),
      asJson({ achievementId: 'veteran', amount: 1 }),
      ...(bundle.achievements.winnerAchievementId !== undefined &&
      winnerIds.has(participant.principalId)
        ? [
            asJson({
              achievementId: bundle.achievements.winnerAchievementId,
              amount: 1,
            }),
          ]
        : []),
    ],
  }));
}

/**
 * Accept only facts described by the release-pinned achievement catalog. This
 * retains the legacy direct-id form while preventing an unknown metric from
 * silently becoming a platform achievement.
 */
function assertApprovedAchievementSources(
  sources: readonly GameAchievementSource[],
  definitions: readonly GameAchievementDefinition[],
): void {
  const ids = new Set(
    definitions.map((definition) => definition.achievementId),
  );
  for (const source of sources) {
    for (const raw of source.facts) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.achievement_fact_invalid',
        );
      const fact = raw as Record<string, unknown>;
      if (typeof fact.achievementId === 'string') {
        if (
          Object.keys(fact).some(
            (key) => !['achievementId', 'amount'].includes(key),
          ) ||
          !ids.has(fact.achievementId) ||
          !Number.isSafeInteger(fact.amount) ||
          (fact.amount as number) < 1
        )
          throw contractError(
            'INVALID_REQUEST',
            'platform.remote.achievement_fact_unapproved',
          );
        continue;
      }
      if (
        Object.keys(fact).some(
          (key) => !['metric', 'value', 'subjectId'].includes(key),
        ) ||
        typeof fact.metric !== 'string' ||
        !Number.isSafeInteger(fact.value) ||
        (fact.value as number) < 0 ||
        (fact.subjectId !== undefined && typeof fact.subjectId !== 'string')
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.achievement_fact_invalid',
        );
      const approved = definitions.some((definition) => {
        const criterion = definition.criterion;
        return (
          criterion !== undefined &&
          criterion.metric === fact.metric &&
          criterion.subjectId === fact.subjectId
        );
      });
      if (!approved)
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.achievement_fact_unapproved',
        );
    }
  }
}

function rewardPlans(
  context: GameCompletionContext,
  bundle: RemoteSettlementPolicyBundle,
): readonly GameRewardPlan[] {
  if (context.result.kind !== 'competitive') return [];
  const plans: GameRewardPlan[] = [];
  const quantities =
    bundle.rewards.quantitiesByPlayerCount?.[
      String(context.admission.participants.length) as '2' | '3' | '4'
    ] ?? bundle.rewards.quantities;
  let position = 1;
  for (const group of context.result.rankGroups) {
    const quantity = quantities[Math.min(position - 1, quantities.length - 1)];
    for (const team of group.teams)
      for (const principalId of team.participantIds)
        plans.push({
          principalId,
          awardId: `match:${context.sessionId}`,
          tier: `place-${position}`,
          rewards: [
            {
              rewardId: `finish-${position}-credits`,
              asset: bundle.rewards.asset,
              quantity,
              metadata: asJson({ placement: position }),
            },
          ],
        });
    position += group.teams.reduce(
      (total, team) => total + team.participantIds.length,
      0,
    );
  }
  return plans;
}

function fallbackAdmission(record: PlatformCompletionRecord): MatchAdmission {
  return {
    id: record.admissionId,
    route: record.route,
    participants: record.participants,
    visibility: 'private',
    rating: record.rating,
    validityPolicyVersion: record.validityPolicyVersion,
    createdAt: record.receivedAt,
  };
}

function messageTemplate(
  completion: RemoteSettlementPolicyBundle['messages']['completion'],
): GameMessageTemplate {
  return (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw contractError('INVALID_REQUEST', 'platform.messages.payload');
    const sessionId = (payload as Record<string, unknown>).sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0)
      throw contractError('INVALID_REQUEST', 'platform.messages.payload');
    return {
      title: { kind: 'literal', text: completion.title },
      body: { kind: 'literal', text: completion.body },
      action: {
        label: completion.actionLabel,
        href: completion.actionPath.replace(
          '{sessionId}',
          encodeURIComponent(sessionId),
        ),
      },
    };
  };
}

async function readRankings(
  options: RemoteSettlementHandlerOptions,
  principalId?: string,
): Promise<GameRankingSummary> {
  const page = await options.services.ratings.listByRanking(
    options.bundle.rating.poolId,
    100,
  );
  const entries: GameRankingEntry[] = [];
  for (const [index, state] of page.items.entries()) {
    const displayName = await options.displayName?.(state.participantId);
    entries.push({
      principalId: state.participantId,
      ...(displayName ? { displayName } : {}),
      rank: index + 1,
      rating: asJson(state.value),
    });
  }
  let viewer = principalId
    ? entries.find((entry) => entry.principalId === principalId)
    : undefined;
  if (principalId && !viewer) {
    const [state, rank] = await Promise.all([
      options.services.ratings.getRating(
        options.bundle.rating.poolId,
        principalId,
      ),
      options.services.ratings.getRankedPosition(
        options.bundle.rating.poolId,
        principalId,
      ),
    ]);
    if (state && rank !== null) {
      const displayName = await options.displayName?.(principalId);
      viewer = {
        principalId,
        ...(displayName ? { displayName } : {}),
        rank,
        rating: asJson(state.value),
      };
    }
  }
  return {
    gameId: options.bundle.gameId,
    poolId: options.publicPoolId ?? options.bundle.rating.poolId,
    policyVersion: options.bundle.rating.policyVersion,
    progressionPolicyVersion: options.bundle.rating.progressionPolicyVersion,
    entries,
    ...(viewer ? { viewer } : {}),
  };
}

/** Build the platform-neutral registration and one completion settlement hook. */
export function createRemoteSettlementHandler(
  options: RemoteSettlementHandlerOptions,
): RemoteSettlementHandler {
  assertBundle(options.bundle);
  assertApproval(options.bundle, options.approval);
  if (options.metadata.gameId !== options.bundle.gameId)
    throw new Error('REMOTE_POLICY_METADATA_GAME_MISMATCH');
  const ratingPolicies = createRemoteRatingPolicies(options.bundle);
  const policy = ratingPolicies[0];
  if (!policy) throw new Error('REMOTE_POLICY_RATING_INVALID');
  const definitions = options.bundle.achievements.definitions.map(
    (definition) => ({
      ...definition,
    }),
  );
  const capabilities: readonly GameCapability[] = [
    'wallet',
    'rewards',
    'rating',
    'rankings',
    'profile',
    'achievements',
  ];
  const policyVersions: readonly GamePolicyVersion[] = [
    ...ratingSpecs(options.bundle).flatMap((spec) => [
      { kind: 'rating' as const, version: spec.policyVersion },
      {
        kind: 'progression' as const,
        version: spec.progressionPolicyVersion,
      },
    ]),
    {
      kind: 'reward' as const,
      version: options.bundle.rewards.definitionVersion,
    },
    ...(options.bundle.dailyChallengeRewards
      ? [
          {
            kind: 'reward' as const,
            version: options.bundle.dailyChallengeRewards.definitionVersion,
          },
        ]
      : []),
    {
      kind: 'achievement' as const,
      version: options.bundle.achievements.definitionVersion,
    },
  ].filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.kind === entry.kind && candidate.version === entry.version,
      ) === index,
  );
  const registration: GameCapabilityRegistration = {
    metadata: structuredClone(options.metadata),
    releaseId: options.bundle.releaseId,
    capabilities,
    policyVersions,
    assets: [
      ...new Set([
        options.bundle.rewards.asset,
        ...(options.bundle.dailyChallengeRewards
          ? [options.bundle.dailyChallengeRewards.asset]
          : []),
      ]),
    ].map(
      (asset) =>
        ({
          asset,
          kind: 'currency',
          label: asset,
        }) satisfies GameAssetDefinition,
    ),
    achievements: {
      definitionVersion: options.bundle.achievements.definitionVersion,
      read: (principalId) =>
        options.services.achievements.read({
          gameId: options.bundle.gameId,
          principalId,
          definitionVersion: options.bundle.achievements.definitionVersion,
          definitions,
        }),
      consume: async (request) => {
        if (
          hasExcludedController(
            request.admission.participants,
            options.bundle.achievements.excludeControllers,
          )
        )
          return;
        assertApprovedAchievementSources(
          request.achievementSources,
          definitions,
        );
        const generated = achievementFacts(request, options.bundle);
        const factsByPrincipal = new Map<string, JsonValue[]>();
        for (const source of request.achievementSources)
          factsByPrincipal.set(source.principalId, [...source.facts]);
        for (const source of generated)
          factsByPrincipal.set(source.principalId, [
            ...(factsByPrincipal.get(source.principalId) ?? []),
            ...source.facts,
          ]);
        await options.services.achievements.consume({
          gameId: options.bundle.gameId,
          definitionVersion: options.bundle.achievements.definitionVersion,
          sourceRecordId: request.sourceRecordId,
          occurredAt: request.occurredAt,
          sources: [...factsByPrincipal].map(([principalId, facts]) => ({
            principalId,
            facts,
          })),
          definitions,
        });
      },
    },
    rewards: {
      definitionVersion: options.bundle.rewards.definitionVersion,
      createAwards: (context) =>
        hasExcludedController(
          context.admission.participants,
          options.bundle.rewards.excludeControllers,
        )
          ? []
          : rewardPlans(context, options.bundle),
    },
    rating: {
      pools: ratingSpecs(options.bundle),
      readRankings: (principalId) => readRankings(options, principalId),
      settlement: 'core',
    },
    rankings: {
      read: (principalId) => readRankings(options, principalId),
    },
    profile: {
      read: async (principalId) => ({
        ...(options.displayName
          ? { displayName: await options.displayName(principalId) }
          : {}),
      }),
    },
  };
  const completion = options.bundle.messages.completion;
  const messages = {
    [completion.templateId]: messageTemplate(completion),
  } satisfies Readonly<Record<string, GameMessageTemplate>>;
  return {
    registration,
    ratingPolicy: policy,
    ratingPolicies,
    messages,
    settleCompletion: async (record) => {
      if (record.status !== 'completed') return;
      if (
        record.route.gameId !== options.bundle.gameId ||
        record.route.releaseId !== options.bundle.releaseId
      )
        throw contractError(
          'CONFLICT',
          'platform.remote.policy_route_mismatch',
        );
      const admission =
        (await options.admission?.(record)) ?? fallbackAdmission(record);
      if (!options.bundle.approvedModes.includes(record.route.modeId)) {
        // Non-rated modes can be playable without entering the platform-owned
        // reward/rating/achievement settlement policy.  They must settle as a
        // durable no-op; a rated mode missing approval is a registration bug
        // and remains a retryable conflict until admission is rejected.
        if (admission.rating === null) return;
        throw contractError(
          'CONFLICT',
          'platform.remote.policy_route_mismatch',
        );
      }
      if (record.resultRevision !== 1 || !record.result)
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.result_invalid',
        );
      try {
        assertGameResult(record.result, record.participants);
      } catch {
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.result_invalid',
        );
      }
      const hasSyntheticParticipant =
        hasExcludedController(
          record.participants,
          options.bundle.rewards.excludeControllers,
        ) ||
        hasExcludedController(
          record.participants,
          options.bundle.achievements.excludeControllers,
        );
      if (!hasSyntheticParticipant)
        await options.services.capabilities.complete({
          route: record.route,
          admission,
          result: record.result,
          resultRevision: record.resultRevision,
          occurredAt: record.endedAt,
          achievementSources: record.achievementSources ?? [],
        });
      const accountIds = new Set(
        record.participants
          .map(participantAccountId)
          .filter(
            (principalId): principalId is string => principalId !== undefined,
          ),
      );
      for (const principalId of accountIds)
        await options.services.messages.publish({
          gameId: options.bundle.gameId,
          templateId: completion.templateId,
          principalId,
          sourceId: `${record.sessionId}:${record.resultRevision}`,
          payload: {
            gameId: options.bundle.gameId,
            releaseId: options.bundle.releaseId,
            sessionId: record.sessionId,
          },
        });
    },
  };
}
