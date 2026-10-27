import type { EntitlementStore } from '../entitlements/types.js';
import { AwardError } from './errors.js';
import type {
  AwardPendingOptions,
  AwardRewardDelivery,
  AwardRewardRecord,
  AwardRewardRunnerOptions,
  AwardStore,
} from './types.js';

function rewardSourceRecordId(reward: AwardRewardRecord): string {
  return `award:${reward.awardGrantId}:reward:${reward.rewardId}`;
}

/**
 * Delivers durable award rewards through the entitlement ledger. The reward
 * remains pending until markRewardDelivered commits, so a lost acknowledgement
 * safely retries the same idempotent entitlement grant.
 */
export class AwardRewardRunner {
  private readonly awards: AwardStore;
  private readonly entitlements: Pick<EntitlementStore, 'grant'>;

  constructor(options: AwardRewardRunnerOptions) {
    if (!options || typeof options !== 'object')
      throw new AwardError(
        'INVALID_ARGUMENT',
        'runner options must be an object',
      );
    this.awards = options.awards;
    this.entitlements = options.entitlements;
    if (!this.awards || !this.entitlements)
      throw new AwardError(
        'INVALID_ARGUMENT',
        'runner requires award and entitlement stores',
      );
  }

  async deliverPending(
    options: AwardPendingOptions,
  ): Promise<readonly AwardRewardDelivery[]> {
    const pending = await this.awards.listPendingRewards(options);
    const delivered: AwardRewardDelivery[] = [];
    const failures: unknown[] = [];
    for (const reward of pending) {
      try {
        const grant = await this.entitlements.grant({
          namespace: reward.namespace,
          sourceRecordId: rewardSourceRecordId(reward),
          principalId: reward.principalId,
          asset: reward.asset,
          quantity: reward.quantity,
          ...(reward.metadata !== undefined
            ? { metadata: reward.metadata }
            : {}),
          createdAt: reward.createdAt,
        });
        const committed = await this.awards.markRewardDelivered(
          reward.rewardId,
        );
        delivered.push({ reward: committed, grant });
      } catch (error) {
        failures.push(error);
        try {
          await this.awards.markRewardFailed(reward.rewardId);
        } catch (metadataError) {
          failures.push(metadataError);
        }
      }
    }
    if (failures.length > 0) throw failures[0];
    return delivered;
  }
}

export function awardRewardSourceRecordId(reward: AwardRewardRecord): string {
  return rewardSourceRecordId(reward);
}
