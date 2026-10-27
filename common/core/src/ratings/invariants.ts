import { createHash } from 'node:crypto';
import {
  assertGameResult,
  assertJsonPayloadSize,
  assertParticipant,
  assertSessionRoute,
  type CompetitiveResult,
  canonicalStableStringify,
  type JsonValue,
  type MatchAdmission,
  type Participant,
} from '@board-game/contracts';
import { RatingError } from './errors.js';
import type {
  RatingParticipantSettlement,
  RatingPolicy,
  RatingSettlementDraft,
  RatingSettlementRecord,
  RatingState,
  RatingUpdate,
} from './types.js';

export const DEFAULT_RATING_STATE_BYTES = 64 * 1024;
export const MAX_RATING_BATCH = 1_000;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new RatingError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string`,
    );
}

export function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new RatingError(
      'INVALID_ARGUMENT',
      `${name} must be a finite non-negative number`,
    );
}

export function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new RatingError(
      'INVALID_ARGUMENT',
      `${name} must be a positive integer`,
    );
}

export function assertJson(
  value: unknown,
  name: string,
  maxBytes: number,
): asserts value is JsonValue {
  try {
    assertJsonPayloadSize(value, maxBytes, name);
  } catch {
    throw new RatingError('INVALID_ARGUMENT', `${name} must be bounded JSON`);
  }
}

export function digestOf(value: JsonValue): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

export function equalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalStableStringify(left) === canonicalStableStringify(right);
  } catch {
    return false;
  }
}

export function assertAdmission(
  admission: MatchAdmission,
  sessionId: string,
): asserts admission is MatchAdmission & {
  readonly rating: NonNullable<MatchAdmission['rating']>;
} {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission))
    throw new RatingError('INVALID_ARGUMENT', 'admission must be an object');
  assertSessionRoute(admission.route);
  if (admission.route.sessionId !== sessionId)
    throw new RatingError(
      'INVALID_ARGUMENT',
      'session route does not match session',
    );
  if (
    !Array.isArray(admission.participants) ||
    admission.participants.length === 0
  )
    throw new RatingError('INVALID_ARGUMENT', 'admission roster is invalid');
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const participant of admission.participants) {
    try {
      assertParticipant(participant);
    } catch {
      throw new RatingError(
        'INVALID_ARGUMENT',
        'admission participant is invalid',
      );
    }
    if (
      principals.has(participant.principalId) ||
      seats.has(participant.seatId)
    )
      throw new RatingError(
        'INVALID_ARGUMENT',
        'admission roster contains duplicates',
      );
    principals.add(participant.principalId);
    seats.add(participant.seatId);
  }
  const rating = admission.rating;
  if (rating === null)
    throw new RatingError('RATING_NOT_ENABLED', 'rating is not enabled');
  for (const key of [
    'poolId',
    'policyVersion',
    'progressionPolicyVersion',
  ] as const)
    assertString(rating[key], `admission.rating.${key}`);
  if (rating.seasonId !== null)
    assertString(rating.seasonId, 'admission.rating.seasonId');
}

export function assertCompetitiveResult(
  result: unknown,
  participants: readonly Participant[],
): asserts result is CompetitiveResult {
  try {
    assertGameResult(result, participants);
  } catch {
    throw new RatingError(
      'INVALID_ARGUMENT',
      'competitive result does not match admission roster',
    );
  }
  if (result.kind !== 'competitive')
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating requires a competitive result',
    );
}

export function rankingOf(result: CompetitiveResult): readonly string[] {
  return result.rankGroups.flatMap((group) =>
    group.teams.flatMap((team) => [...team.participantIds]),
  );
}

function assertStoredCompetitiveResult(
  value: unknown,
  participantIds: readonly string[],
): asserts value is CompetitiveResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RatingError('DATABASE_ERROR', 'stored rating result is invalid');
  const result = value as Record<string, unknown>;
  if (
    result.kind !== 'competitive' ||
    !Array.isArray(result.rankGroups) ||
    result.rankGroups.length === 0 ||
    Object.keys(result).some((key) => !['kind', 'rankGroups'].includes(key))
  )
    throw new RatingError('DATABASE_ERROR', 'stored rating result is invalid');
  const ids: string[] = [];
  for (const group of result.rankGroups) {
    const groupValue =
      group && typeof group === 'object' && !Array.isArray(group)
        ? (group as Record<string, unknown>)
        : null;
    if (
      !groupValue ||
      !Array.isArray(groupValue.teams) ||
      groupValue.teams.length === 0 ||
      Object.keys(groupValue).some((key) => key !== 'teams')
    )
      throw new RatingError(
        'DATABASE_ERROR',
        'stored rating result is invalid',
      );
    for (const team of groupValue.teams) {
      if (!team || typeof team !== 'object' || Array.isArray(team))
        throw new RatingError(
          'DATABASE_ERROR',
          'stored rating result is invalid',
        );
      const teamValue = team as Record<string, unknown>;
      if (
        !Array.isArray(teamValue.participantIds) ||
        teamValue.participantIds.length === 0 ||
        Object.keys(teamValue).some(
          (key) => !['participantIds', 'score'].includes(key),
        )
      )
        throw new RatingError(
          'DATABASE_ERROR',
          'stored rating result is invalid',
        );
      if (
        teamValue.score !== undefined &&
        (typeof teamValue.score !== 'number' ||
          !Number.isFinite(teamValue.score))
      )
        throw new RatingError(
          'DATABASE_ERROR',
          'stored rating result is invalid',
        );
      for (const participantId of teamValue.participantIds) {
        if (typeof participantId !== 'string' || participantId.length === 0)
          throw new RatingError(
            'DATABASE_ERROR',
            'stored rating result is invalid',
          );
        ids.push(participantId);
      }
    }
  }
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== participantIds.length ||
    participantIds.some((participantId) => !ids.includes(participantId))
  )
    throw new RatingError(
      'DATABASE_ERROR',
      'stored rating result roster is invalid',
    );
}

export function validatePolicy(
  policy: RatingPolicy,
  policyVersion: string,
  progressionPolicyVersion: string,
): void {
  if (
    policy.policyVersion !== policyVersion ||
    policy.progressionPolicyVersion !== progressionPolicyVersion ||
    typeof policy.initialState !== 'function' ||
    typeof policy.calculate !== 'function'
  )
    throw new RatingError(
      'POLICY_NOT_FOUND',
      'rating policy pin is not registered',
    );
}

export function validateUpdateList(
  updates: unknown,
  participants: readonly Participant[],
  expectedBefore: Readonly<Record<string, JsonValue>>,
  maxStateBytes: number,
): asserts updates is readonly RatingUpdate[] {
  if (!Array.isArray(updates) || updates.length !== participants.length)
    throw new RatingError(
      'INVALID_POLICY_OUTPUT',
      'rating policy must update every participant exactly once',
    );
  const ids = new Set<string>();
  const allowed = new Set(
    participants.map((participant) => participant.principalId),
  );
  for (const update of updates) {
    if (!update || typeof update !== 'object' || Array.isArray(update))
      throw new RatingError(
        'INVALID_POLICY_OUTPUT',
        'rating policy returned an invalid update',
      );
    assertString(update.participantId, 'rating update participantId');
    if (!allowed.has(update.participantId) || ids.has(update.participantId))
      throw new RatingError(
        'INVALID_POLICY_OUTPUT',
        'rating policy returned duplicate or unknown participant',
      );
    ids.add(update.participantId);
    try {
      assertJson(update.after, 'rating update after', maxStateBytes);
    } catch {
      throw new RatingError(
        'INVALID_POLICY_OUTPUT',
        'rating policy returned an invalid after state',
      );
    }
    if (update.before !== undefined) {
      try {
        assertJson(update.before, 'rating update before', maxStateBytes);
      } catch {
        throw new RatingError(
          'INVALID_POLICY_OUTPUT',
          'rating policy returned an invalid before state',
        );
      }
      if (!equalJson(update.before, expectedBefore[update.participantId]))
        throw new RatingError(
          'INVALID_POLICY_OUTPUT',
          'rating policy before state is stale',
        );
    }
    if (
      update.rankingScore !== undefined &&
      (typeof update.rankingScore !== 'number' ||
        !Number.isFinite(update.rankingScore))
    )
      throw new RatingError(
        'INVALID_POLICY_OUTPUT',
        'rating policy returned an invalid ranking score',
      );
  }
}

export function validateSettlementRecord(record: RatingSettlementRecord): void {
  assertString(record.poolId, 'settlement.poolId');
  assertString(record.sessionId, 'settlement.sessionId');
  assertPositiveInteger(record.resultRevision, 'settlement.resultRevision');
  assertString(record.digest, 'settlement.digest');
  assertTimestamp(record.occurredAt, 'settlement.occurredAt');
  assertPositiveInteger(record.sequence, 'settlement.sequence');
  assertString(record.policyVersion, 'settlement.policyVersion');
  assertString(
    record.progressionPolicyVersion,
    'settlement.progressionPolicyVersion',
  );
  if (record.seasonId !== null)
    assertString(record.seasonId, 'settlement.seasonId');
  assertSessionRoute(record.route);
  if (record.route.sessionId !== record.sessionId)
    throw new RatingError(
      'DATABASE_ERROR',
      'settlement route does not match session',
    );
  if (!Array.isArray(record.participants) || record.participants.length === 0)
    throw new RatingError(
      'DATABASE_ERROR',
      'settlement participants are invalid',
    );
  for (const participant of record.participants)
    validateParticipantSettlement(participant, DEFAULT_RATING_STATE_BYTES);
  const participantIds = record.participants.map(
    (participant) => participant.participantId,
  );
  if (new Set(participantIds).size !== participantIds.length)
    throw new RatingError(
      'DATABASE_ERROR',
      'settlement participants are duplicated',
    );
  assertStoredCompetitiveResult(record.result, participantIds);
  assertJsonPayloadSize(record, 512 * 1024);
}

export function validateSettlementDraft(draft: RatingSettlementDraft): void {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft))
    throw new RatingError(
      'INVALID_ARGUMENT',
      'settlement draft must be an object',
    );
  assertString(draft.poolId, 'settlement.poolId');
  assertString(draft.sessionId, 'settlement.sessionId');
  assertPositiveInteger(draft.resultRevision, 'settlement.resultRevision');
  if (draft.resultRevision > 1)
    throw new RatingError(
      'CORRECTION_UNSUPPORTED',
      'rating corrections require a policy recomputation path',
      false,
    );
  assertString(draft.digest, 'settlement.digest');
  assertTimestamp(draft.occurredAt, 'settlement.occurredAt');
  assertString(draft.policyVersion, 'settlement.policyVersion');
  assertString(
    draft.progressionPolicyVersion,
    'settlement.progressionPolicyVersion',
  );
  if (draft.seasonId !== null)
    assertString(draft.seasonId, 'settlement.seasonId');
  assertSessionRoute(draft.route);
  if (draft.route.sessionId !== draft.sessionId)
    throw new RatingError(
      'INVALID_ARGUMENT',
      'settlement route does not match session',
    );
  if (!Array.isArray(draft.participants) || draft.participants.length === 0)
    throw new RatingError(
      'INVALID_ARGUMENT',
      'settlement participants are invalid',
    );
  for (const participant of draft.participants)
    validateParticipantSettlement(participant, DEFAULT_RATING_STATE_BYTES);
  const participantIds = draft.participants.map(
    (participant) => participant.participantId,
  );
  if (new Set(participantIds).size !== participantIds.length)
    throw new RatingError(
      'INVALID_ARGUMENT',
      'settlement participants are duplicated',
    );
  assertStoredCompetitiveResult(draft.result, participantIds);
  assertJsonPayloadSize(draft.result, 256 * 1024);
  assertJsonPayloadSize(draft.participants, 256 * 1024);
}

export function validateState(state: RatingState, maxStateBytes: number): void {
  assertString(state.poolId, 'rating.poolId');
  assertString(state.participantId, 'rating.participantId');
  assertString(state.policyVersion, 'rating.policyVersion');
  assertString(
    state.progressionPolicyVersion,
    'rating.progressionPolicyVersion',
  );
  assertPositiveInteger(state.updatedSequence, 'rating.updatedSequence');
  assertJson(state.initial, 'rating.initial', maxStateBytes);
  assertJson(state.value, 'rating.value', maxStateBytes);
  if (
    state.rankingScore !== undefined &&
    (typeof state.rankingScore !== 'number' ||
      !Number.isFinite(state.rankingScore))
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating.rankingScore must be finite',
    );
}

export function validateParticipantSettlement(
  settlement: RatingParticipantSettlement,
  maxStateBytes: number,
): void {
  assertString(settlement.participantId, 'settlement participantId');
  assertJson(settlement.initial, 'settlement initial', maxStateBytes);
  assertJson(settlement.before, 'settlement before', maxStateBytes);
  assertJson(settlement.after, 'settlement after', maxStateBytes);
}
