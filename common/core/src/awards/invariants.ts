import { createHash } from 'node:crypto';
import {
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { AwardError } from './errors.js';
import type {
  AwardGrantRequest,
  AwardImportRequest,
  AwardKey,
  AwardPendingOptions,
  AwardRewardInstruction,
} from './types.js';

export const MAX_AWARD_BATCH = 1_000;
export const MAX_AWARD_STRING_LENGTH = 512;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AwardError('INVALID_ARGUMENT', `${name} must be an object`);
}

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_AWARD_STRING_LENGTH
  )
    throw new AwardError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${MAX_AWARD_STRING_LENGTH} characters`,
    );
}

export function assertQuantity(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new AwardError(
      'INVALID_ARGUMENT',
      `${name} must be a positive safe integer`,
    );
}

export function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new AwardError(
      'INVALID_ARGUMENT',
      `${name} must be a finite non-negative timestamp`,
    );
}

export function assertStoredTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new AwardError(
      'DATABASE_ERROR',
      `${name} must be a finite non-negative timestamp`,
      false,
    );
}

export function assertJson(
  value: unknown,
  name: string,
): asserts value is JsonValue {
  try {
    canonicalStableStringify(value);
  } catch {
    throw new AwardError('INVALID_ARGUMENT', `${name} must be JSON safe`);
  }
}

export function assertLimit(limit: unknown): asserts limit is number {
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_AWARD_BATCH
  )
    throw new AwardError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_AWARD_BATCH}`,
    );
}

export function validateAwardKey(key: AwardKey): void {
  assertObject(key, 'award key');
  assertString(key.namespace, 'namespace');
  assertString(key.principalId, 'principalId');
  assertString(key.awardId, 'awardId');
  assertString(key.tier, 'tier');
}

function validateRewardInstruction(
  reward: AwardRewardInstruction,
  index: number,
): void {
  assertObject(reward, `rewards[${index}]`);
  assertString(reward.rewardId, `rewards[${index}].rewardId`);
  assertString(reward.namespace, `rewards[${index}].namespace`);
  assertString(reward.asset, `rewards[${index}].asset`);
  assertQuantity(reward.quantity, `rewards[${index}].quantity`);
  if (reward.metadata !== undefined)
    assertJson(reward.metadata, `rewards[${index}].metadata`);
}

export function validateAwardRequest(
  request: AwardGrantRequest,
  allowImportField = false,
): void {
  validateAwardKey(request);
  assertString(request.definitionVersion, 'definitionVersion');
  assertString(request.sourceRecordId, 'sourceRecordId');
  if (
    !Array.isArray(request.rewards) ||
    request.rewards.length > MAX_AWARD_BATCH
  )
    throw new AwardError(
      'INVALID_ARGUMENT',
      `rewards must contain at most ${MAX_AWARD_BATCH} instructions`,
    );
  const rewardIds = new Set<string>();
  for (const [index, reward] of request.rewards.entries()) {
    validateRewardInstruction(reward, index);
    if (rewardIds.has(reward.rewardId))
      throw new AwardError(
        'INVALID_ARGUMENT',
        `rewards contains duplicate rewardId ${reward.rewardId}`,
      );
    rewardIds.add(reward.rewardId);
  }
  if (request.createdAt !== undefined)
    assertTimestamp(request.createdAt, 'createdAt');
  if (
    !allowImportField &&
    Object.hasOwn(request, 'importedRewardAlreadyDelivered')
  )
    throw new AwardError(
      'INVALID_ARGUMENT',
      'importedRewardAlreadyDelivered is only valid for importAward',
    );
}

export function validateImportRequest(request: AwardImportRequest): void {
  validateAwardRequest(request, true);
  if (request.importedRewardAlreadyDelivered !== undefined) {
    if (!Array.isArray(request.importedRewardAlreadyDelivered))
      throw new AwardError(
        'INVALID_ARGUMENT',
        'importedRewardAlreadyDelivered must be an array',
      );
    const rewardIds = new Set(request.rewards.map((reward) => reward.rewardId));
    const imported = new Set<string>();
    for (const rewardId of request.importedRewardAlreadyDelivered) {
      assertString(rewardId, 'importedRewardAlreadyDelivered rewardId');
      if (!rewardIds.has(rewardId) || imported.has(rewardId))
        throw new AwardError(
          'INVALID_ARGUMENT',
          `imported reward ${rewardId} is not a unique definition reward`,
        );
      imported.add(rewardId);
    }
  }
}

export function validatePendingOptions(options: AwardPendingOptions): void {
  assertObject(options, 'pending options');
  assertLimit(options.limit);
  if (options.namespace !== undefined)
    assertString(options.namespace, 'namespace');
  if (options.principalId !== undefined)
    assertString(options.principalId, 'principalId');
  if (options.now !== undefined) assertTimestamp(options.now, 'now');
}

export function validateRewardId(rewardId: string): void {
  assertString(rewardId, 'rewardId');
}

export function digestOf(value: JsonValue): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

export function awardKey(key: AwardKey): string {
  return JSON.stringify([
    key.namespace,
    key.principalId,
    key.awardId,
    key.tier,
  ]);
}

export function awardGrantIdFor(key: AwardKey): string {
  return `award_${digestOf({
    namespace: key.namespace,
    principalId: key.principalId,
    awardId: key.awardId,
    tier: key.tier,
  })}`;
}

export function definitionDigest(request: AwardGrantRequest): string {
  return digestOf({
    definitionVersion: request.definitionVersion,
    rewards: request.rewards as unknown as JsonValue,
  });
}

export function rewardRecordIdFor(
  awardGrantId: string,
  instructionId: string,
): string {
  return `award_reward_${digestOf({ awardGrantId, instructionId })}`;
}
