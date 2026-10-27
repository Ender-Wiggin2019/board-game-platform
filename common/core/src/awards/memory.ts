import { AwardError } from './errors.js';
import {
  assertTimestamp,
  awardGrantIdFor,
  awardKey,
  clone,
  definitionDigest,
  rewardRecordIdFor,
  validateAwardKey,
  validateAwardRequest,
  validateImportRequest,
  validatePendingOptions,
  validateRewardId,
} from './invariants.js';
import type {
  AwardGrant,
  AwardGrantRequest,
  AwardImportRequest,
  AwardKey,
  AwardPendingOptions,
  AwardRewardRecord,
  AwardStore,
  AwardStoreCapabilities,
} from './types.js';

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;

function retryAt(attempts: number, now: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return (
    now + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent)
  );
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<Result>(callback: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

interface MemoryState {
  awards: Map<string, AwardGrant>;
  rewards: Map<string, AwardRewardRecord>;
}

export interface MemoryAwardStoreOptions {
  readonly now?: () => number;
}

function copyState(state: MemoryState): MemoryState {
  return {
    awards: new Map(
      [...state.awards].map(([key, value]) => [key, clone(value)]),
    ),
    rewards: new Map(
      [...state.rewards].map(([key, value]) => [key, clone(value)]),
    ),
  };
}

function buildAward(request: AwardGrantRequest, createdAt: number): AwardGrant {
  return {
    namespace: request.namespace,
    principalId: request.principalId,
    awardId: request.awardId,
    tier: request.tier,
    definitionVersion: request.definitionVersion,
    sourceRecordId: request.sourceRecordId,
    rewards: clone(request.rewards),
    awardGrantId: awardGrantIdFor(request),
    definitionDigest: definitionDigest(request),
    createdAt,
  };
}

function buildReward(
  award: AwardGrant,
  instruction: AwardGrantRequest['rewards'][number],
  createdAt: number,
  delivered: boolean,
): AwardRewardRecord {
  const rewardId = rewardRecordIdFor(award.awardGrantId, instruction.rewardId);
  return {
    rewardId,
    instructionId: instruction.rewardId,
    awardGrantId: award.awardGrantId,
    awardNamespace: award.namespace,
    principalId: award.principalId,
    namespace: instruction.namespace,
    asset: instruction.asset,
    quantity: instruction.quantity,
    ...(instruction.metadata !== undefined
      ? { metadata: clone(instruction.metadata) }
      : {}),
    status: delivered ? 'delivered' : 'pending',
    attempts: 0,
    createdAt,
    ...(delivered ? { deliveredAt: createdAt } : {}),
  };
}

/** Clone-isolated award ledger with atomic award/reward staging. */
export class MemoryAwardStore implements AwardStore {
  readonly capabilities: AwardStoreCapabilities = {
    durable: false,
    serializableTransactions: true,
    boundedReads: true,
  };

  private state: MemoryState = { awards: new Map(), rewards: new Map() };
  private readonly lock = new Mutex();
  private readonly now: () => number;

  constructor(options: MemoryAwardStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async grantAward(request: AwardGrantRequest): Promise<AwardGrant> {
    validateAwardRequest(request);
    return this.writeAward(request, new Set());
  }

  async importAward(request: AwardImportRequest): Promise<AwardGrant> {
    validateImportRequest(request);
    return this.writeAward(
      request,
      new Set(request.importedRewardAlreadyDelivered ?? []),
    );
  }

  private async writeAward(
    request: AwardGrantRequest,
    deliveredRewardIds: ReadonlySet<string>,
  ): Promise<AwardGrant> {
    return this.lock.run(async () => {
      const key = awardKey(request);
      const digest = definitionDigest(request);
      const existing = this.state.awards.get(key);
      if (existing) {
        if (existing.definitionDigest !== digest)
          throw new AwardError(
            'IDEMPOTENCY_CONFLICT',
            `Award ${key} has a different definition`,
            false,
          );
        return clone(existing);
      }
      const createdAt = request.createdAt ?? this.now();
      assertTimestamp(createdAt, 'createdAt');
      const draft = copyState(this.state);
      const award = buildAward(request, createdAt);
      draft.awards.set(key, clone(award));
      for (const instruction of award.rewards) {
        const reward = buildReward(
          award,
          instruction,
          createdAt,
          deliveredRewardIds.has(instruction.rewardId),
        );
        draft.rewards.set(reward.rewardId, clone(reward));
      }
      this.state = draft;
      return clone(award);
    });
  }

  async getAward(key: AwardKey): Promise<AwardGrant | null> {
    validateAwardKey(key);
    const found = this.state.awards.get(awardKey(key));
    return found ? clone(found) : null;
  }

  async getReward(rewardId: string): Promise<AwardRewardRecord | null> {
    validateRewardId(rewardId);
    const found = this.state.rewards.get(rewardId);
    return found ? clone(found) : null;
  }

  async listPendingRewards(
    options: AwardPendingOptions,
  ): Promise<readonly AwardRewardRecord[]> {
    validatePendingOptions(options);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    return [...this.state.rewards.values()]
      .filter(
        (reward) =>
          reward.status === 'pending' &&
          (reward.nextAttemptAt === undefined || reward.nextAttemptAt <= now) &&
          (options.namespace === undefined ||
            reward.awardNamespace === options.namespace) &&
          (options.principalId === undefined ||
            reward.principalId === options.principalId),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.rewardId.localeCompare(right.rewardId),
      )
      .slice(0, options.limit)
      .map(clone);
  }

  async markRewardDelivered(
    rewardId: string,
    deliveredAt = this.now(),
  ): Promise<AwardRewardRecord> {
    validateRewardId(rewardId);
    assertTimestamp(deliveredAt, 'deliveredAt');
    return this.lock.run(async () => {
      const existing = this.state.rewards.get(rewardId);
      if (!existing)
        throw new AwardError(
          'REWARD_NOT_FOUND',
          `Reward ${rewardId} does not exist`,
          false,
        );
      if (existing.status === 'delivered') return clone(existing);
      const draft = copyState(this.state);
      const { nextAttemptAt: _nextAttemptAt, ...deliveredBase } = existing;
      const delivered: AwardRewardRecord = {
        ...deliveredBase,
        status: 'delivered',
        attempts: existing.attempts + 1,
        deliveredAt,
      };
      draft.rewards.set(rewardId, clone(delivered));
      this.state = draft;
      return clone(delivered);
    });
  }

  async markRewardFailed(rewardId: string): Promise<AwardRewardRecord> {
    validateRewardId(rewardId);
    return this.lock.run(async () => {
      const existing = this.state.rewards.get(rewardId);
      if (!existing)
        throw new AwardError(
          'REWARD_NOT_FOUND',
          `Reward ${rewardId} does not exist`,
          false,
        );
      if (existing.status === 'delivered') return clone(existing);
      const attemptedAt = this.now();
      assertTimestamp(attemptedAt, 'attemptedAt');
      const attempts = existing.attempts + 1;
      const draft = copyState(this.state);
      const failed: AwardRewardRecord = {
        ...existing,
        attempts,
        nextAttemptAt: retryAt(attempts, attemptedAt),
      };
      draft.rewards.set(rewardId, clone(failed));
      this.state = draft;
      return clone(failed);
    });
  }

  async close(): Promise<void> {
    // The memory driver owns no external resources.
  }
}
