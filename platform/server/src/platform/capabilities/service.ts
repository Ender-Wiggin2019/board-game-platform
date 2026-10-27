import {
  type AchievementCollection,
  assertGameResult,
  assertJsonPayloadSize,
  assertSessionRoute,
  contractError,
  type GameCatalogEntry,
  type GameProfileSummary,
  type GameRankingSummary,
  type GameWallet,
  type JsonValue,
} from '@board-game/contracts';
import {
  type AwardGrant,
  AwardRewardRunner,
  type AwardStore,
  type EntitlementStore,
  type RatingSettlementRunner,
} from '@board-game/core';
import type {
  GameCapabilityRegistration,
  GameCapabilityServiceOptions,
  GameCompletionContext,
  GameCompletionInput,
  GameCompletionOutcome,
  GameRewardPlan,
  GameRewardReceipt,
  GameRewardWriteRequest,
} from './types.js';
import {
  completionSourceRecordId,
  participantIds,
  ratingPolicies,
} from './types.js';

const MAX_FACT_BYTES = 64 * 1024;
const MAX_REWARD_INSTRUCTIONS = 1_000;
const MAX_DELIVERY_BATCH = 1_000;

function invalid(details?: JsonValue): never {
  throw contractError(
    'INVALID_REQUEST',
    'platform.game.capability.request_invalid',
    false,
    details,
  );
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    invalid({ field });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function routeMatches(
  left: GameCompletionInput['route'],
  right: GameCompletionInput['route'],
): boolean {
  return (
    left.gameId === right.gameId &&
    left.modeId === right.modeId &&
    left.sessionId === right.sessionId &&
    left.releaseId === right.releaseId &&
    left.backendBindingId === right.backendBindingId &&
    left.storageBindingId === right.storageBindingId &&
    left.ownershipEpoch === right.ownershipEpoch
  );
}

function validateCompletion(input: GameCompletionInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  assertSessionRoute(input.route);
  if (!input.admission || typeof input.admission !== 'object') invalid();
  if (
    input.admission.route.sessionId !== input.route.sessionId ||
    !routeMatches(input.admission.route, input.route)
  )
    invalid({ field: 'admission.route' });
  if (
    !Number.isSafeInteger(input.resultRevision) ||
    input.resultRevision < 1 ||
    typeof input.occurredAt !== 'number' ||
    !Number.isFinite(input.occurredAt) ||
    input.occurredAt < 0
  )
    invalid({ field: 'completion identity' });
  try {
    assertGameResult(input.result, input.admission.participants);
  } catch {
    invalid({ field: 'result' });
  }
  if (input.achievementSources !== undefined) {
    if (!Array.isArray(input.achievementSources))
      invalid({ field: 'achievementSources' });
    const principals = participantIds(input.admission.participants);
    const seen = new Set<string>();
    for (const source of input.achievementSources) {
      if (!source || typeof source !== 'object')
        invalid({ field: 'achievementSources' });
      requireString(source.principalId, 'achievementSources.principalId');
      if (!principals.has(source.principalId) || seen.has(source.principalId))
        invalid({ field: 'achievementSources.principalId' });
      seen.add(source.principalId);
      if (
        !Array.isArray(source.facts) ||
        source.facts.length > MAX_REWARD_INSTRUCTIONS
      )
        invalid({ field: 'achievementSources.facts' });
      for (const fact of source.facts)
        assertJsonPayloadSize(fact, MAX_FACT_BYTES, 'achievement fact');
    }
  }
}

function contextFor(input: GameCompletionInput): GameCompletionContext {
  return {
    gameId: input.route.gameId,
    releaseId: input.route.releaseId,
    sessionId: input.route.sessionId,
    resultRevision: input.resultRevision,
    occurredAt: input.occurredAt,
    route: clone(input.route),
    admission: clone(input.admission),
    result: clone(input.result),
    achievementSources: clone(input.achievementSources ?? []),
  };
}

function assertWallet(
  wallet: GameWallet,
  gameId: string,
  principalId: string,
): GameWallet {
  if (
    !wallet ||
    typeof wallet !== 'object' ||
    wallet.gameId !== gameId ||
    wallet.principalId !== principalId ||
    !Array.isArray(wallet.assets)
  )
    invalid({ field: 'wallet' });
  assertJsonPayloadSize(wallet, 256 * 1024, 'wallet');
  return clone(wallet);
}

function assertAchievements(
  collection: AchievementCollection,
  gameId: string,
  principalId: string,
): AchievementCollection {
  if (
    !collection ||
    typeof collection !== 'object' ||
    collection.gameId !== gameId ||
    collection.principalId !== principalId ||
    typeof collection.definitionVersion !== 'string' ||
    !Array.isArray(collection.items)
  )
    invalid({ field: 'achievements' });
  assertJsonPayloadSize(collection, 256 * 1024, 'achievements');
  return clone(collection);
}

function assertRankings(
  rankings: GameRankingSummary,
  gameId: string,
): GameRankingSummary {
  if (
    !rankings ||
    typeof rankings !== 'object' ||
    rankings.gameId !== gameId ||
    typeof rankings.poolId !== 'string' ||
    typeof rankings.policyVersion !== 'string' ||
    typeof rankings.progressionPolicyVersion !== 'string' ||
    !Array.isArray(rankings.entries)
  )
    invalid({ field: 'rankings' });
  assertJsonPayloadSize(rankings, 512 * 1024, 'rankings');
  return clone(rankings);
}

function validateRewardPlans(
  registration: GameCapabilityRegistration,
  context: GameCompletionContext,
  plans: readonly GameRewardPlan[],
): void {
  if (!Array.isArray(plans) || plans.length > MAX_REWARD_INSTRUCTIONS)
    invalid({ field: 'reward plans' });
  const participants = participantIds(context.admission.participants);
  const assets = new Set(registration.assets.map((asset) => asset.asset));
  const planKeys = new Set<string>();
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') invalid({ field: 'reward plan' });
    requireString(plan.principalId, 'reward plan principalId');
    requireString(plan.awardId, 'reward plan awardId');
    requireString(plan.tier, 'reward plan tier');
    if (!participants.has(plan.principalId))
      invalid({ field: 'reward plan principalId' });
    const planKey = `${plan.principalId}:${plan.awardId}:${plan.tier}`;
    if (planKeys.has(planKey)) invalid({ field: 'reward plan duplicate' });
    planKeys.add(planKey);
    if (
      !Array.isArray(plan.rewards) ||
      plan.rewards.length > MAX_REWARD_INSTRUCTIONS
    )
      invalid({ field: 'reward plan rewards' });
    const rewardIds = new Set<string>();
    for (const reward of plan.rewards) {
      if (!reward || typeof reward !== 'object')
        invalid({ field: 'reward instruction' });
      requireString(reward.rewardId, 'reward.rewardId');
      requireString(reward.asset, 'reward.asset');
      if (!assets.has(reward.asset)) invalid({ field: 'reward.asset' });
      if (!Number.isSafeInteger(reward.quantity) || reward.quantity < 1)
        invalid({ field: 'reward.quantity' });
      if (rewardIds.has(reward.rewardId)) invalid({ field: 'reward.rewardId' });
      rewardIds.add(reward.rewardId);
      if (reward.metadata !== undefined)
        assertJsonPayloadSize(
          reward.metadata,
          MAX_FACT_BYTES,
          'reward.metadata',
        );
    }
  }
}

function rewardReceipt(
  plan: GameRewardPlan,
  sourceRecordId: string,
  grant: AwardGrant,
  deliveredRewardIds: readonly string[],
): GameRewardReceipt {
  return {
    principalId: plan.principalId,
    awardId: plan.awardId,
    tier: plan.tier,
    sourceRecordId,
    grantId: grant.awardGrantId,
    deliveredRewardIds: [...deliveredRewardIds],
  };
}

/** Shared public game capability reads and completion side-effect runner. */
export class GameCapabilityService {
  private readonly registry: GameCapabilityServiceOptions['registry'];
  private readonly awards: AwardStore | undefined;
  private readonly entitlements:
    | Pick<EntitlementStore, 'grant' | 'getBalance'>
    | undefined;
  private readonly ratings: RatingSettlementRunner | undefined;
  private readonly rewardRunner: AwardRewardRunner | undefined;

  public constructor(options: GameCapabilityServiceOptions) {
    if (!options || typeof options !== 'object' || !options.registry)
      throw new TypeError('GAME_CAPABILITY_SERVICE_OPTIONS_REQUIRED');
    this.registry = options.registry;
    this.awards = options.awards;
    this.entitlements = options.entitlements;
    this.ratings = options.ratings;
    if (this.awards && this.entitlements)
      this.rewardRunner = new AwardRewardRunner({
        awards: this.awards,
        entitlements: this.entitlements,
      });
  }

  public list(): readonly GameCatalogEntry[] {
    const registry = this.registry as unknown as {
      list: () => readonly GameCatalogEntry[];
    };
    return registry.list().map((entry) => clone(entry));
  }

  public get(gameId: string, releaseId: string): GameCatalogEntry | null {
    const registry = this.registry as unknown as {
      get: (gameId: string, releaseId: string) => GameCatalogEntry | null;
    };
    return clone(registry.get(gameId, releaseId));
  }

  public async getAchievements(
    gameId: string,
    releaseId: string,
    principalId: string,
  ): Promise<AchievementCollection> {
    requireString(principalId, 'principalId');
    const registration = this.registry.resolve(gameId, releaseId);
    if (!registration.achievements?.read)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.achievements_unavailable',
      );
    return assertAchievements(
      await registration.achievements.read(principalId),
      gameId,
      principalId,
    );
  }

  public async getWallet(
    gameId: string,
    releaseId: string,
    principalId: string,
  ): Promise<GameWallet> {
    requireString(principalId, 'principalId');
    const registration = this.registry.resolve(gameId, releaseId);
    const custom =
      registration.wallet?.read ?? registration.rewards?.readWallet;
    if (custom)
      return assertWallet(await custom(principalId), gameId, principalId);
    if (!this.entitlements)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.wallet_unavailable',
      );
    const entitlements = this.entitlements;
    const assets = await Promise.all(
      registration.assets.map(async (definition) => {
        const balance = await entitlements.getBalance({
          namespace: gameId,
          principalId,
          asset: definition.asset,
        });
        return { ...definition, ...balance };
      }),
    );
    return {
      gameId,
      principalId,
      assets,
    };
  }

  public async getRankings(
    gameId: string,
    releaseId: string,
    principalId?: string,
  ): Promise<GameRankingSummary> {
    const registration = this.registry.resolve(gameId, releaseId);
    const reader =
      registration.rankings?.read ?? registration.rating?.readRankings;
    if (!reader)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.rankings_unavailable',
      );
    return assertRankings(await reader(principalId), gameId);
  }

  public async getProfile(
    gameId: string,
    releaseId: string,
    principalId: string,
  ): Promise<GameProfileSummary> {
    requireString(principalId, 'principalId');
    const registration = this.registry.resolve(gameId, releaseId);
    const base = registration.profile
      ? await registration.profile.read(principalId)
      : {};
    if (!base || typeof base !== 'object') invalid({ field: 'profile' });
    const result: GameProfileSummary = {
      gameId,
      principalId,
      ...(base.displayName !== undefined
        ? { displayName: base.displayName }
        : {}),
      ...(base.stats !== undefined ? { stats: clone(base.stats) } : {}),
      ...(base.rank !== undefined ? { rank: clone(base.rank) } : {}),
      ...(registration.achievements?.read
        ? {
            achievements: await this.getAchievements(
              gameId,
              releaseId,
              principalId,
            ),
          }
        : {}),
      ...(registration.capabilities.includes('wallet')
        ? { wallet: await this.getWallet(gameId, releaseId, principalId) }
        : {}),
      ...(registration.capabilities.includes('rankings')
        ? { rankings: await this.getRankings(gameId, releaseId, principalId) }
        : {}),
    };
    assertJsonPayloadSize(result, 512 * 1024, 'profile');
    return result;
  }

  public async getStatistics(
    gameId: string,
    releaseId: string,
    principalId?: string,
  ): Promise<JsonValue> {
    const registration = this.registry.resolve(gameId, releaseId);
    if (!registration.statistics)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.statistics_unavailable',
      );
    const result = await registration.statistics.read(principalId);
    assertJsonPayloadSize(result, 512 * 1024, 'statistics');
    return clone(result);
  }

  public async complete(
    input: GameCompletionInput,
  ): Promise<GameCompletionOutcome> {
    validateCompletion(input);
    const registration = this.registry.resolve(
      input.route.gameId,
      input.route.releaseId,
    );
    const context = contextFor(input);
    let achievementProcessed = false;
    if (registration.achievements?.consume) {
      await registration.achievements.consume({
        ...context,
        definitionVersion: registration.achievements.definitionVersion,
        sourceRecordId: completionSourceRecordId(
          context.gameId,
          context.sessionId,
          context.resultRevision,
          registration.achievements.definitionVersion,
        ),
      });
      achievementProcessed = true;
    }

    const rewards = await this.writeRewards(registration, context);
    const rating = await this.settleRating(registration, context);
    return {
      gameId: context.gameId,
      releaseId: context.releaseId,
      sessionId: context.sessionId,
      resultRevision: context.resultRevision,
      achievementProcessed,
      rewards,
      rating,
    };
  }

  private async writeRewards(
    registration: GameCapabilityRegistration,
    context: GameCompletionContext,
  ): Promise<readonly GameRewardReceipt[]> {
    if (!registration.rewards) return [];
    const definitionVersion = registration.rewards.definitionVersion;
    const sourceRecordId = completionSourceRecordId(
      context.gameId,
      context.sessionId,
      context.resultRevision,
      definitionVersion,
    );
    const plans = await registration.rewards.createAwards(context);
    validateRewardPlans(registration, context, plans);
    const request: GameRewardWriteRequest = {
      ...context,
      definitionVersion,
      sourceRecordId,
      plans: clone(plans),
    };
    if (registration.rewards.write) {
      const receipts = await registration.rewards.write(request);
      assertJsonPayloadSize(receipts, 512 * 1024, 'reward receipts');
      return clone(receipts);
    }
    if (!this.awards || !this.rewardRunner)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.rewards_unavailable',
      );

    const grants: Array<{ plan: GameRewardPlan; grant: AwardGrant }> = [];
    for (const plan of plans) {
      const grant = await this.awards.grantAward({
        namespace: context.gameId,
        principalId: plan.principalId,
        awardId: `${sourceRecordId}:${plan.awardId}`,
        tier: plan.tier,
        definitionVersion,
        sourceRecordId,
        rewards: plan.rewards.map((reward) => ({
          rewardId: reward.rewardId,
          namespace: context.gameId,
          asset: reward.asset,
          quantity: reward.quantity,
          ...(reward.metadata !== undefined
            ? { metadata: clone(reward.metadata) }
            : {}),
        })),
        createdAt: context.occurredAt,
      });
      grants.push({ plan, grant });
    }

    const deliveredByGrant = new Map<string, readonly string[]>();
    for (const principalId of new Set(
      grants.map(({ plan }) => plan.principalId),
    )) {
      const deliveries = await this.rewardRunner.deliverPending({
        limit: MAX_DELIVERY_BATCH,
        namespace: context.gameId,
        principalId,
      });
      for (const delivery of deliveries) {
        const current =
          deliveredByGrant.get(delivery.reward.awardGrantId) ?? [];
        deliveredByGrant.set(delivery.reward.awardGrantId, [
          ...current,
          delivery.reward.rewardId,
        ]);
      }
    }
    return grants.map(({ plan, grant }) =>
      rewardReceipt(
        plan,
        sourceRecordId,
        grant,
        deliveredByGrant.get(grant.awardGrantId) ?? [],
      ),
    );
  }

  private async settleRating(
    registration: GameCapabilityRegistration,
    context: GameCompletionContext,
  ): Promise<JsonValue | null> {
    if (!context.admission.rating) {
      if (registration.rating) return null;
      return null;
    }
    if (!registration.rating)
      throw contractError(
        'CONFLICT',
        'platform.game.capability.rating_unregistered',
      );
    const policy = ratingPolicies(registration.rating).find(
      (candidate) =>
        candidate.poolId === '*' ||
        candidate.poolId === context.admission.rating?.poolId,
    );
    if (
      !policy ||
      context.admission.rating.policyVersion !== policy.policyVersion ||
      context.admission.rating.progressionPolicyVersion !==
        policy.progressionPolicyVersion
    )
      throw contractError(
        'CONFLICT',
        'platform.game.capability.rating_policy_mismatch',
      );
    if (
      registration.rating.settlement === 'external' &&
      !registration.rating.settle
    )
      return null;
    const request = {
      ...context,
      policyVersion: policy.policyVersion,
      progressionPolicyVersion: policy.progressionPolicyVersion,
    };
    let result: JsonValue | null;
    if (registration.rating.settle)
      result = await registration.rating.settle(request);
    else {
      if (!this.ratings)
        throw contractError(
          'NOT_READY',
          'platform.game.capability.rating_unavailable',
        );
      const settled = await this.ratings.settle({
        sessionId: context.sessionId,
        resultRevision: context.resultRevision,
        result: context.result,
        occurredAt: context.occurredAt,
      });
      result = clone(settled) as unknown as JsonValue;
    }
    if (result !== null)
      assertJsonPayloadSize(result, 512 * 1024, 'rating settlement');
    return clone(result);
  }
}
