import {
  canonicalStableStringify,
  type JsonValue,
  type MatchAdmission,
  type Participant,
} from '@board-game/contracts';
import { RatingError } from './errors.js';
import {
  assertAdmission,
  assertCompetitiveResult,
  assertJson,
  clone,
  DEFAULT_RATING_STATE_BYTES,
  digestOf,
  rankingOf,
  validatePolicy,
  validateUpdateList,
} from './invariants.js';
import type {
  RatingParticipantSettlement,
  RatingPolicy,
  RatingSettlementRecord,
  RatingSettlementRequest,
  RatingSettlementRunner,
  RatingSettlementServiceOptions,
  RatingSettlementTransaction,
  RatingState,
  RatingStateInput,
} from './types.js';

type RatedAdmission = MatchAdmission & {
  readonly rating: NonNullable<MatchAdmission['rating']>;
};

function principalMap(
  participants: readonly Participant[],
): ReadonlyMap<string, Participant> {
  return new Map(
    participants.map((participant) => [participant.principalId, participant]),
  );
}

function requestDigest(request: RatingSettlementRequest): string {
  return digestOf({
    sessionId: request.sessionId,
    resultRevision: request.resultRevision,
    occurredAt: request.occurredAt,
    result: request.result as JsonValue,
  });
}

function validateRequest(request: RatingSettlementRequest): void {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating settlement request must be an object',
    );
  if (
    typeof request.sessionId !== 'string' ||
    request.sessionId.trim().length === 0
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'sessionId must be a non-empty string',
    );
  if (
    typeof request.resultRevision !== 'number' ||
    !Number.isSafeInteger(request.resultRevision) ||
    request.resultRevision < 1
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'resultRevision must be a positive integer',
    );
  if (request.resultRevision > 1)
    throw new RatingError(
      'CORRECTION_UNSUPPORTED',
      'rating corrections require a policy recomputation path',
      false,
    );
  if (
    typeof request.occurredAt !== 'number' ||
    !Number.isFinite(request.occurredAt) ||
    request.occurredAt < 0
  )
    throw new RatingError(
      'INVALID_ARGUMENT',
      'occurredAt must be a finite non-negative number',
    );
}

function stateForParticipant(
  state: RatingState | null,
  participant: Participant,
  policy: RatingPolicy,
  admission: Parameters<RatingPolicy['initialState']>[1],
  poolId: string,
  maxStateBytes: number,
): { readonly initial: JsonValue; readonly before: JsonValue } {
  if (state) {
    if (
      state.poolId !== poolId ||
      state.participantId !== participant.principalId ||
      state.policyVersion !== admission.rating?.policyVersion ||
      state.progressionPolicyVersion !==
        admission.rating?.progressionPolicyVersion
    )
      throw new RatingError(
        'POLICY_NOT_FOUND',
        'persisted rating state has a different policy pin',
      );
    assertJson(state.initial, 'rating initial state', maxStateBytes);
    assertJson(state.value, 'rating current state', maxStateBytes);
    return { initial: clone(state.initial), before: clone(state.value) };
  }
  let initial: JsonValue;
  try {
    initial = policy.initialState(participant, admission);
  } catch {
    throw new RatingError(
      'INVALID_POLICY_OUTPUT',
      'rating policy initial state failed',
    );
  }
  try {
    assertJson(initial, 'rating initial state', maxStateBytes);
  } catch {
    throw new RatingError(
      'INVALID_POLICY_OUTPUT',
      'rating policy returned an invalid initial state',
    );
  }
  return { initial: clone(initial), before: clone(initial) };
}

async function calculateStates(
  tx: RatingSettlementTransaction,
  request: RatingSettlementRequest,
  admission: RatedAdmission,
  policy: RatingPolicy,
  maxStateBytes: number,
): Promise<{
  readonly participantSettlements: readonly RatingParticipantSettlement[];
  readonly states: readonly RatingStateInput[];
}> {
  const participants = admission.participants;
  const byPrincipal = principalMap(participants);
  const statesByPrincipal = new Map<
    string,
    { initial: JsonValue; before: JsonValue }
  >();
  const previous: Record<string, JsonValue> = Object.create(null) as Record<
    string,
    JsonValue
  >;
  for (const participant of participants) {
    const state = await tx.getState(participant.principalId);
    const current = stateForParticipant(
      state,
      participant,
      policy,
      admission,
      admission.rating.poolId,
      maxStateBytes,
    );
    statesByPrincipal.set(participant.principalId, current);
    previous[participant.principalId] = clone(current.before);
  }
  const result = request.result as Parameters<
    typeof policy.calculate
  >[0]['result'];
  const input = {
    previous: clone(previous),
    ranking: rankingOf(result),
    result: clone(result),
    participants: clone(participants),
    admission: clone(admission),
  } as Parameters<typeof policy.calculate>[0];
  let updates: unknown;
  try {
    updates = policy.calculate(input);
  } catch {
    throw new RatingError(
      'INVALID_POLICY_OUTPUT',
      'rating policy calculation failed',
    );
  }
  validateUpdateList(updates, participants, previous, maxStateBytes);
  const participantSettlements: RatingParticipantSettlement[] = [];
  const nextStates: RatingStateInput[] = [];
  for (const update of updates) {
    const current = statesByPrincipal.get(update.participantId);
    const participant = byPrincipal.get(update.participantId);
    if (!current || !participant)
      throw new RatingError(
        'INVALID_POLICY_OUTPUT',
        'rating policy returned an unknown participant',
      );
    participantSettlements.push({
      participantId: update.participantId,
      initial: clone(current.initial),
      before: clone(current.before),
      after: clone(update.after),
    });
    nextStates.push({
      poolId: admission.rating.poolId,
      participantId: update.participantId,
      policyVersion: admission.rating.policyVersion,
      progressionPolicyVersion: admission.rating.progressionPolicyVersion,
      initial: clone(current.initial),
      value: clone(update.after),
      ...(update.rankingScore !== undefined
        ? { rankingScore: update.rankingScore }
        : {}),
    });
  }
  return { participantSettlements, states: nextStates };
}

export class RatingSettlementService implements RatingSettlementRunner {
  private readonly store: RatingSettlementServiceOptions['store'];
  private readonly admissions: RatingSettlementServiceOptions['admissions'];
  private readonly policies: RatingSettlementServiceOptions['policies'];
  private readonly maxStateBytes: number;

  constructor(options: RatingSettlementServiceOptions) {
    this.store = options.store;
    this.admissions = options.admissions;
    this.policies = options.policies;
    this.maxStateBytes = options.maxStateBytes ?? DEFAULT_RATING_STATE_BYTES;
    if (!Number.isSafeInteger(this.maxStateBytes) || this.maxStateBytes < 1)
      throw new RatingError(
        'INVALID_ARGUMENT',
        'maxStateBytes must be a positive integer',
      );
  }

  async settle(
    request: RatingSettlementRequest,
  ): Promise<RatingSettlementRecord> {
    validateRequest(request);
    const admission = await this.admissions.getAdmission(request.sessionId);
    if (!admission)
      throw new RatingError(
        'ADMISSION_NOT_FOUND',
        `No admission exists for ${request.sessionId}`,
      );
    assertAdmission(admission, request.sessionId);
    assertCompetitiveResult(request.result, admission.participants);
    const rating = admission.rating;
    const policy = this.policies.get(
      rating.policyVersion,
      rating.progressionPolicyVersion,
    );
    if (!policy)
      throw new RatingError(
        'POLICY_NOT_FOUND',
        'rating policy pin is not registered',
      );
    validatePolicy(
      policy,
      rating.policyVersion,
      rating.progressionPolicyVersion,
    );
    const digest = requestDigest(request);
    return this.store.transaction(rating.poolId, async (tx) => {
      const existing = await tx.getSettlement(
        request.sessionId,
        request.resultRevision,
      );
      if (existing) {
        if (
          existing.digest !== digest ||
          existing.poolId !== rating.poolId ||
          existing.policyVersion !== rating.policyVersion ||
          existing.progressionPolicyVersion !==
            rating.progressionPolicyVersion ||
          existing.seasonId !== rating.seasonId ||
          !canonicalRouteEqual(existing.route, admission.route)
        )
          throw new RatingError(
            'IDEMPOTENCY_CONFLICT',
            `Settlement ${request.sessionId}/${request.resultRevision} has a different digest`,
            false,
          );
        return clone(existing);
      }
      const calculated = await calculateStates(
        tx,
        request,
        admission,
        policy,
        this.maxStateBytes,
      );
      const draft = {
        poolId: rating.poolId,
        sessionId: request.sessionId,
        resultRevision: request.resultRevision,
        digest,
        occurredAt: request.occurredAt,
        policyVersion: rating.policyVersion,
        progressionPolicyVersion: rating.progressionPolicyVersion,
        seasonId: rating.seasonId,
        route: clone(admission.route),
        result: clone(request.result) as Parameters<
          typeof policy.calculate
        >[0]['result'],
        participants: clone(calculated.participantSettlements),
      };
      return tx.commitSettlement(draft, calculated.states);
    });
  }
}

function canonicalRouteEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalStableStringify(left) === canonicalStableStringify(right);
  } catch {
    return false;
  }
}
