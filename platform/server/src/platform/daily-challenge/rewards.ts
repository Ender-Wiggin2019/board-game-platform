import { createHash } from 'node:crypto';
import {
  assertJsonPayloadSize,
  canonicalStableStringify,
} from '@board-game/contracts';
import {
  type AwardGrant,
  type AwardRewardDelivery,
  AwardRewardRunner,
  type AwardStore,
  rewardRecordIdFor,
} from '@board-game/core';
import type {
  DailyChallengeAttemptRecord,
  DailyChallengeRewardAward,
  DailyChallengeRewardPlan,
  DailyChallengeRewardPolicy,
  DailyChallengeRewardTier,
} from './types.js';

const DAILY_REWARD_TIER = 'daily' as const;
const DAILY_REWARD_INSTRUCTION = 'daily-challenge-points' as const;
const DAILY_REWARD_PLAN_BYTES = 256 * 1024;
const MAX_REWARD_STRING_LENGTH = 512;

export interface DailyChallengeRewardPlanInput {
  readonly gameId: string;
  readonly challengeDate: string;
  readonly eligibilityCutoffAt: string;
  readonly policy: DailyChallengeRewardPolicy;
  readonly attempts: readonly DailyChallengeAttemptRecord[];
}

export interface DailyChallengeRewardSettlementResult {
  readonly planDigest: string;
  readonly grants: readonly AwardGrant[];
  readonly deliveries: readonly AwardRewardDelivery[];
}

export interface DailyChallengeRewardRunnerOptions {
  readonly awards: AwardStore;
  readonly delivery: AwardRewardRunner;
  readonly now?: () => number;
}

function invalid(field: string): never {
  throw new Error(`DAILY_REWARD_${field.toUpperCase()}_INVALID`);
}

function recordOf(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    invalid(`${field}_fields`);
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_REWARD_STRING_LENGTH
  )
    invalid(field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalid(field);
  return value;
}

function assertTier(value: unknown, field: string): DailyChallengeRewardTier {
  const tier = recordOf(value, field);
  exactKeys(tier, ['percent', 'quantity'], field);
  const percent = positiveInteger(tier.percent, `${field}.percent`);
  if (percent > 100) invalid(`${field}.percent`);
  return {
    percent,
    quantity: positiveInteger(tier.quantity, `${field}.quantity`),
  };
}

/** Validate the release-pinned daily reward policy before registration/storage. */
export function assertDailyChallengeRewardPolicy(
  value: unknown,
): asserts value is DailyChallengeRewardPolicy {
  const policy = recordOf(value, 'policy');
  exactKeys(
    policy,
    [
      'modeId',
      'definitionVersion',
      'asset',
      'tiers',
      'participationQuantity',
      'sourceKeyPrefix',
    ],
    'policy',
  );
  text(policy.modeId, 'mode_id');
  text(policy.definitionVersion, 'definition_version');
  text(policy.asset, 'asset');
  const sourceKeyPrefix = text(policy.sourceKeyPrefix, 'source_key_prefix');
  if (sourceKeyPrefix.length + 1 + 10 > MAX_REWARD_STRING_LENGTH)
    invalid('source_key_prefix');
  const tiers = policy.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) invalid('tiers');
  let previousPercent = 0;
  for (const [index, value] of tiers.entries()) {
    const tier = assertTier(value, `tiers_${index}`);
    if (tier.percent <= previousPercent) invalid('tiers_order');
    previousPercent = tier.percent;
  }
  positiveInteger(policy.participationQuantity, 'participation_quantity');
  assertJsonPayloadSize(policy as never, 16 * 1024, 'daily reward policy');
}

function digestInput(plan: Omit<DailyChallengeRewardPlan, 'digest'>): string {
  return createHash('sha256')
    .update(canonicalStableStringify(plan as never))
    .digest('hex');
}

/** Validate an immutable, persisted reward plan and its digest. */
export function assertDailyChallengeRewardPlan(
  value: unknown,
): asserts value is DailyChallengeRewardPlan {
  const plan = recordOf(value, 'plan');
  exactKeys(
    plan,
    [
      'gameId',
      'challengeDate',
      'eligibilityCutoffAt',
      'policy',
      'awards',
      'digest',
    ],
    'plan',
  );
  const gameId = text(plan.gameId, 'game_id');
  const challengeDate = text(plan.challengeDate, 'challenge_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(challengeDate)) invalid('challenge_date');
  const eligibilityCutoffAt = text(
    plan.eligibilityCutoffAt,
    'eligibility_cutoff',
  );
  if (!Number.isFinite(Date.parse(eligibilityCutoffAt)))
    invalid('eligibility_cutoff');
  assertDailyChallengeRewardPolicy(plan.policy);
  if (!Array.isArray(plan.awards)) invalid('awards');
  const seen = new Set<string>();
  for (const [index, value] of plan.awards.entries()) {
    const award = recordOf(value, `award_${index}`);
    exactKeys(
      award,
      ['principalId', 'awardId', 'tier', 'sourceRecordId', 'quantity'],
      `award_${index}`,
    );
    const principalId = text(award.principalId, `award_${index}_principal`);
    const awardId = text(award.awardId, `award_${index}_id`);
    const sourceRecordId = text(award.sourceRecordId, `award_${index}_source`);
    if (award.tier !== DAILY_REWARD_TIER || awardId !== sourceRecordId)
      invalid(`award_${index}`);
    positiveInteger(award.quantity, `award_${index}_quantity`);
    if (seen.has(principalId)) invalid('award_duplicate_principal');
    seen.add(principalId);
  }
  const digest = text(plan.digest, 'digest');
  if (!/^[0-9a-f]{64}$/.test(digest)) invalid('digest');
  assertJsonPayloadSize(
    plan as never,
    DAILY_REWARD_PLAN_BYTES,
    'daily reward plan',
  );
  const withoutDigest = {
    gameId,
    challengeDate,
    eligibilityCutoffAt,
    policy: plan.policy,
    awards: plan.awards,
  } satisfies Omit<DailyChallengeRewardPlan, 'digest'>;
  if (digestInput(withoutDigest) !== digest)
    throw new Error('DAILY_REWARD_PLAN_DIGEST_CONFLICT');
}

function completedAtMs(attempt: DailyChallengeAttemptRecord): number {
  const value = attempt.completedAt;
  if (!value) return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function stableAttemptOrder(
  left: DailyChallengeAttemptRecord,
  right: DailyChallengeAttemptRecord,
): number {
  return (
    left.principalId.localeCompare(right.principalId) ||
    left.attemptNumber - right.attemptNumber ||
    completedAtMs(left) - completedAtMs(right) ||
    left.attemptId.localeCompare(right.attemptId)
  );
}

function bestAttemptOrder(
  left: DailyChallengeAttemptRecord,
  right: DailyChallengeAttemptRecord,
): number {
  return (
    Number(right.score) - Number(left.score) ||
    left.attemptNumber - right.attemptNumber ||
    completedAtMs(left) - completedAtMs(right) ||
    left.principalId.localeCompare(right.principalId) ||
    left.gameId.localeCompare(right.gameId) ||
    left.attemptId.localeCompare(right.attemptId)
  );
}

interface RankedAttempt {
  readonly attempt: DailyChallengeAttemptRecord;
  readonly rank: number;
}

function rankAttempts(
  attempts: readonly DailyChallengeAttemptRecord[],
): readonly RankedAttempt[] {
  const ordered = [...attempts].sort(bestAttemptOrder);
  let previousScore: number | undefined;
  let previousRank = 0;
  return ordered.map((attempt, index) => {
    const rank = previousScore === attempt.score ? previousRank : index + 1;
    previousScore = attempt.score;
    previousRank = rank;
    return { attempt, rank };
  });
}

function quantityForRank(
  rank: number,
  population: number,
  policy: DailyChallengeRewardPolicy,
): number {
  const tier = policy.tiers.find(
    (candidate) => rank <= Math.ceil((population * candidate.percent) / 100),
  );
  return tier?.quantity ?? policy.participationQuantity;
}

function sourceKeyFor(
  policy: DailyChallengeRewardPolicy,
  challengeDate: string,
): string {
  return `${policy.sourceKeyPrefix}:${challengeDate}`;
}

/** Calculate the frozen first-look/overall max award plan. */
export function calculateDailyChallengeRewardPlan(
  input: DailyChallengeRewardPlanInput,
): DailyChallengeRewardPlan {
  assertDailyChallengeRewardPolicy(input.policy);
  text(input.gameId, 'game_id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.challengeDate))
    invalid('challenge_date');
  const cutoff = Date.parse(input.eligibilityCutoffAt);
  if (!Number.isFinite(cutoff)) invalid('eligibility_cutoff');

  const eligible = [...input.attempts]
    .filter(
      (attempt) =>
        attempt.gameId === input.gameId &&
        attempt.challengeDate === input.challengeDate &&
        attempt.modeId === input.policy.modeId &&
        attempt.status === 'completed' &&
        Number.isFinite(attempt.score) &&
        attempt.completedAt !== undefined &&
        completedAtMs(attempt) <= cutoff,
    )
    .sort(stableAttemptOrder);
  const firstLookByPrincipal = new Map<string, DailyChallengeAttemptRecord>();
  const overallByPrincipal = new Map<string, DailyChallengeAttemptRecord>();
  for (const attempt of eligible) {
    if (
      attempt.attemptNumber === 1 &&
      !firstLookByPrincipal.has(attempt.principalId)
    )
      firstLookByPrincipal.set(attempt.principalId, attempt);
    const current = overallByPrincipal.get(attempt.principalId);
    if (!current || bestAttemptOrder(attempt, current) < 0)
      overallByPrincipal.set(attempt.principalId, attempt);
  }

  const quantities = new Map<string, number>();
  for (const board of [
    [...firstLookByPrincipal.values()],
    [...overallByPrincipal.values()],
  ]) {
    const ranked = rankAttempts(board);
    for (const { attempt, rank } of ranked) {
      const quantity = quantityForRank(rank, ranked.length, input.policy);
      quantities.set(
        attempt.principalId,
        Math.max(quantity, quantities.get(attempt.principalId) ?? 0),
      );
    }
  }

  const sourceRecordId = sourceKeyFor(input.policy, input.challengeDate);
  const awards: DailyChallengeRewardAward[] = [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([principalId, quantity]) => ({
      principalId,
      awardId: sourceRecordId,
      tier: DAILY_REWARD_TIER,
      sourceRecordId,
      quantity,
    }));
  const withoutDigest = {
    gameId: input.gameId,
    challengeDate: input.challengeDate,
    eligibilityCutoffAt: input.eligibilityCutoffAt,
    policy: structuredClone(input.policy),
    awards,
  } satisfies Omit<DailyChallengeRewardPlan, 'digest'>;
  const plan: DailyChallengeRewardPlan = {
    ...withoutDigest,
    digest: digestInput(withoutDigest),
  };
  assertJsonPayloadSize(
    plan as never,
    DAILY_REWARD_PLAN_BYTES,
    'daily reward plan',
  );
  return plan;
}

/** Durable platform reward writer for one frozen daily plan. */
export class DailyChallengeRewardRunner {
  private readonly awards: AwardStore;
  private readonly delivery: AwardRewardRunner;
  private readonly now: () => number;

  public constructor(options: DailyChallengeRewardRunnerOptions) {
    if (!options || typeof options !== 'object')
      throw new Error('DAILY_REWARD_RUNNER_OPTIONS_INVALID');
    this.awards = options.awards;
    this.delivery = options.delivery;
    this.now = options.now ?? Date.now;
    if (!this.awards || !this.delivery)
      throw new Error('DAILY_REWARD_RUNNER_DEPENDENCY_MISSING');
  }

  public async settle(
    plan: DailyChallengeRewardPlan,
  ): Promise<DailyChallengeRewardSettlementResult> {
    assertDailyChallengeRewardPlan(plan);
    const grants: AwardGrant[] = [];
    for (const award of plan.awards) {
      grants.push(
        await this.awards.grantAward({
          namespace: plan.gameId,
          principalId: award.principalId,
          awardId: award.awardId,
          tier: award.tier,
          definitionVersion: plan.policy.definitionVersion,
          sourceRecordId: award.sourceRecordId,
          rewards: [
            {
              rewardId: DAILY_REWARD_INSTRUCTION,
              namespace: plan.gameId,
              asset: plan.policy.asset,
              quantity: award.quantity,
            },
          ],
        }),
      );
    }
    if (grants.length === 0)
      return { planDigest: plan.digest, grants, deliveries: [] };
    const deliveries = await this.delivery.deliverPending({
      limit: 1_000,
      namespace: plan.gameId,
      now: this.now(),
    });
    for (const grant of grants) {
      for (const instruction of grant.rewards) {
        const reward = await this.awards.getReward(
          rewardRecordIdFor(grant.awardGrantId, instruction.rewardId),
        );
        if (!reward || reward.status !== 'delivered')
          throw new Error('DAILY_REWARD_DELIVERY_PENDING');
      }
    }
    return { planDigest: plan.digest, grants, deliveries };
  }
}
