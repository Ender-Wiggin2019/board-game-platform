import type { JsonValue } from '@board-game/contracts';
import type { EntitlementGrant } from '../entitlements/types.js';

export interface AwardKey {
  readonly namespace: string;
  readonly principalId: string;
  readonly awardId: string;
  readonly tier: string;
}

export interface AwardRewardInstruction {
  /** Stable key within this award definition. */
  readonly rewardId: string;
  /** Entitlement namespace receiving the resulting asset grant. */
  readonly namespace: string;
  readonly asset: string;
  readonly quantity: number;
  readonly metadata?: JsonValue;
}

export interface AwardGrantRequest extends AwardKey {
  readonly definitionVersion: string;
  readonly sourceRecordId: string;
  readonly rewards: readonly AwardRewardInstruction[];
  readonly createdAt?: number;
}

/** Trusted migration-only input; live eligibility must use grantAward. */
export interface AwardImportRequest extends AwardGrantRequest {
  readonly importedRewardAlreadyDelivered?: readonly string[];
}

export interface AwardGrant extends AwardGrantRequest {
  readonly awardGrantId: string;
  readonly definitionDigest: string;
  readonly createdAt: number;
}

export type AwardRewardStatus = 'pending' | 'delivered';

export interface AwardRewardRecord extends AwardRewardInstruction {
  /** Globally stable row id derived from awardGrantId and instruction rewardId. */
  readonly rewardId: string;
  readonly instructionId: string;
  readonly awardGrantId: string;
  readonly awardNamespace: string;
  readonly principalId: string;
  readonly status: AwardRewardStatus;
  /** Number of delivery attempts, persisted for bounded replay backoff. */
  readonly attempts: number;
  /** Earliest time a reward reconciler should retry this row. */
  readonly nextAttemptAt?: number;
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export interface AwardPendingOptions {
  readonly limit: number;
  readonly namespace?: string;
  readonly principalId?: string;
  /** Optional clock override for deterministic replay tests and operators. */
  readonly now?: number;
}

export interface AwardStoreCapabilities {
  readonly durable: boolean;
  readonly serializableTransactions: boolean;
  readonly boundedReads: boolean;
}

export interface AwardStore {
  readonly capabilities: AwardStoreCapabilities;
  /** Inserts an immutable award and its pending reward rows atomically. */
  grantAward(request: AwardGrantRequest): Promise<AwardGrant>;
  /** Trusted migration path; only this API may mark imported rewards delivered. */
  importAward(request: AwardImportRequest): Promise<AwardGrant>;
  getAward(key: AwardKey): Promise<AwardGrant | null>;
  getReward(rewardId: string): Promise<AwardRewardRecord | null>;
  /** Bounded pending rows for the reward reconciler. */
  listPendingRewards(
    options: AwardPendingOptions,
  ): Promise<readonly AwardRewardRecord[]>;
  /** Marking a delivered reward is idempotent. */
  markRewardDelivered(
    rewardId: string,
    deliveredAt?: number,
  ): Promise<AwardRewardRecord>;
  /** Records safe retry metadata without retaining an external error payload. */
  markRewardFailed(rewardId: string): Promise<AwardRewardRecord>;
  close(): Promise<void>;
}

export interface AwardRewardRunnerOptions {
  readonly awards: AwardStore;
  readonly entitlements: Pick<
    import('../entitlements/types.js').EntitlementStore,
    'grant'
  >;
}

export interface AwardRewardDelivery {
  readonly reward: AwardRewardRecord;
  readonly grant: EntitlementGrant;
}
