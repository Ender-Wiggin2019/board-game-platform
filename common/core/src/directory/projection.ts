import type { MatchAdmission, SessionStatus } from '@board-game/contracts';
import { DirectoryError } from './errors.js';
import {
  admissionParticipants,
  allowedStatusTransition,
  assertPayloadParticipantsMatch,
  clone,
  factDigest,
  parseFactPayload,
} from './invariants.js';
import type {
  DirectoryParticipant,
  SessionDirectoryEnvelope,
  SessionDirectoryFactKind,
  SessionDirectoryFactPayload,
  SessionDirectoryRecord,
} from './types.js';

export interface StoredDirectoryFact {
  readonly sessionId: string;
  readonly aggregateSequence: number;
  readonly kind: SessionDirectoryFactKind;
  readonly eventId: string;
  readonly digest: string;
  readonly recordedAt: number;
}

export interface ProjectionInput {
  readonly envelope: SessionDirectoryEnvelope & {
    readonly sessionId: string;
    readonly aggregateSequence: number;
    readonly kind: SessionDirectoryFactKind;
  };
  readonly admission: MatchAdmission;
  readonly retention: {
    readonly retainSummary: boolean;
    readonly retainResult: boolean;
  };
  readonly now: number;
  readonly current: SessionDirectoryRecord | null;
  readonly currentFacts: readonly StoredDirectoryFact[];
}

export interface ProjectionResult {
  readonly record: SessionDirectoryRecord;
  readonly fact: StoredDirectoryFact;
  readonly applied: boolean;
}

function factTimestamp(input: ProjectionInput): number {
  return input.envelope.occurredAt ?? input.envelope.receivedAt ?? input.now;
}

function projectParticipants(
  admission: MatchAdmission,
  current: SessionDirectoryRecord | null,
  payload: SessionDirectoryFactPayload,
  preserveCurrent: boolean,
): readonly DirectoryParticipant[] {
  const frozen = current?.participants ?? admissionParticipants(admission);
  assertPayloadParticipantsMatch(payload.participants, frozen);
  if (payload.participants === undefined || preserveCurrent)
    return clone(frozen);
  const supplied = new Map(
    payload.participants.map((participant) => [
      participant.principalId,
      participant,
    ]),
  );
  return frozen.map((participant) => {
    const update = supplied.get(participant.principalId);
    if (update?.publicProfile === undefined) return clone(participant);
    const currentProfile = participant.publicProfile ?? {};
    const nextProfile = {
      ...clone(currentProfile),
      ...(update.publicProfile.displayName !== undefined
        ? { displayName: update.publicProfile.displayName }
        : {}),
      ...(update.publicProfile.appearance !== undefined
        ? { appearance: clone(update.publicProfile.appearance) }
        : {}),
    };
    return {
      ...clone(participant),
      ...(Object.keys(nextProfile).length > 0
        ? { publicProfile: nextProfile }
        : {}),
    };
  });
}

function applyStatus(
  previous: SessionStatus | undefined,
  next: SessionStatus,
): SessionStatus {
  if (previous === undefined) return next;
  if (!allowedStatusTransition(previous, next))
    throw new DirectoryError(
      'FACT_CONFLICT',
      `directory status cannot transition from ${previous} to ${next}`,
      false,
    );
  return next;
}

function desiredStatus(
  kind: SessionDirectoryFactKind,
  payload: SessionDirectoryFactPayload,
  current: SessionDirectoryRecord | null,
): SessionStatus {
  if (kind === 'SessionActivated') return 'active';
  if (kind === 'SessionCompleted') return 'completed';
  if (kind === 'SessionControlled') {
    if (payload.action === 'pause') return 'paused';
    if (payload.action === 'resume') return 'active';
    if (payload.action === 'cancel') return 'cancelled';
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'SessionControlled requires an action',
      false,
    );
  }
  if (kind === 'SessionSummaryChanged')
    return payload.status ?? current?.status ?? 'active';
  return payload.status ?? current?.status ?? 'suspended';
}

function makeRecord(
  input: ProjectionInput,
  payload: SessionDirectoryFactPayload,
  options: {
    readonly preserveSummary?: boolean;
    readonly preserveParticipants?: boolean;
  } = {},
): SessionDirectoryRecord {
  const current = input.current;
  const timestamp = factTimestamp(input);
  if (
    input.envelope.kind === 'SessionCreated' &&
    payload.status !== undefined &&
    payload.status !== 'suspended' &&
    payload.status !== 'active' &&
    payload.status !== 'paused'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'SessionCreated status must be suspended, active, or paused',
      false,
    );
  if (
    input.envelope.kind === 'SessionActivated' &&
    payload.status !== undefined &&
    payload.status !== 'active'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'SessionActivated status must be active',
      false,
    );
  if (
    input.envelope.kind === 'SessionCompleted' &&
    payload.status !== undefined &&
    payload.status !== 'completed'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'SessionCompleted status must be completed',
      false,
    );
  if (input.envelope.kind === 'SessionControlled') {
    if (payload.action === undefined)
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'SessionControlled requires an action',
        false,
      );
    const expectedStatus =
      payload.action === 'pause'
        ? 'paused'
        : payload.action === 'resume'
          ? 'active'
          : 'cancelled';
    if (payload.status !== undefined && payload.status !== expectedStatus)
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'SessionControlled status does not match action',
        false,
      );
  }
  if (
    payload.resultRevision !== undefined &&
    input.envelope.kind !== 'SessionCompleted'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'resultRevision is only valid for SessionCompleted',
      false,
    );
  if (
    payload.endedAt !== undefined &&
    input.envelope.kind !== 'SessionCompleted'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'endedAt is only valid for SessionCompleted',
      false,
    );
  if (
    payload.replayRef !== undefined &&
    input.envelope.kind !== 'SessionCompleted'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'replayRef is only valid for SessionCompleted',
      false,
    );
  if (
    payload.action !== undefined &&
    input.envelope.kind !== 'SessionControlled'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'action is only valid for SessionControlled',
      false,
    );
  if (
    payload.principalId !== undefined &&
    input.envelope.kind !== 'SessionControlled'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'principalId is only valid for SessionControlled',
      false,
    );
  const participants = projectParticipants(
    input.admission,
    current,
    payload,
    options.preserveParticipants === true,
  );
  const status = applyStatus(
    current?.status,
    desiredStatus(input.envelope.kind, payload, current),
  );
  if (
    input.envelope.kind === 'SessionSummaryChanged' &&
    payload.summary === undefined
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'SessionSummaryChanged requires a summary',
      false,
    );
  if (
    payload.result !== undefined &&
    input.envelope.kind !== 'SessionCompleted'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'only SessionCompleted may carry a result',
      false,
    );

  const result = input.retention.retainResult
    ? (payload.result ?? current?.result)
    : undefined;
  const summary = input.retention.retainSummary
    ? options.preserveSummary
      ? current?.summary
      : (payload.summary ?? current?.summary)
    : undefined;
  const record: SessionDirectoryRecord = {
    sessionId: input.envelope.sessionId,
    admissionId: input.admission.id,
    route: clone(input.admission.route),
    visibility: input.admission.visibility,
    participants,
    status,
    latestAggregateSequence: Math.max(
      current?.latestAggregateSequence ?? 0,
      input.envelope.aggregateSequence,
    ),
    ...(summary !== undefined ? { summary: clone(summary) } : {}),
    ...(result !== undefined ? { result: clone(result) } : {}),
    createdAt: current?.createdAt ?? input.admission.createdAt,
    updatedAt: Math.max(current?.updatedAt ?? 0, timestamp),
  };
  return record;
}

export function applyProjection(input: ProjectionInput): ProjectionResult {
  const payload = parseFactPayload(input.envelope.payload, input.envelope.kind);
  const digest = factDigest(input.envelope, payload);
  const fact: StoredDirectoryFact = {
    sessionId: input.envelope.sessionId,
    aggregateSequence: input.envelope.aggregateSequence,
    kind: input.envelope.kind,
    eventId: input.envelope.eventId,
    digest,
    recordedAt: factTimestamp(input),
  };
  const sameEvent = input.currentFacts.find(
    (candidate) => candidate.eventId === fact.eventId,
  );
  if (sameEvent) {
    if (!input.current)
      throw new DirectoryError(
        'DATABASE_ERROR',
        'directory fact ledger exists without a session projection',
        false,
      );
    if (sameEvent.digest !== fact.digest)
      throw new DirectoryError(
        'FACT_CONFLICT',
        'directory event id was reused with a different fact',
        false,
      );
    return {
      record: clone(input.current as SessionDirectoryRecord),
      fact: clone(sameEvent),
      applied: false,
    };
  }
  const sameSequenceAndKind = input.currentFacts.find(
    (candidate) =>
      candidate.aggregateSequence === fact.aggregateSequence &&
      candidate.kind === fact.kind,
  );
  if (sameSequenceAndKind) {
    if (!input.current)
      throw new DirectoryError(
        'DATABASE_ERROR',
        'directory fact ledger exists without a session projection',
        false,
      );
    if (sameSequenceAndKind.digest !== fact.digest)
      throw new DirectoryError(
        'FACT_CONFLICT',
        'directory sequence and kind were reused with a different fact',
        false,
      );
    return {
      record: clone(input.current as SessionDirectoryRecord),
      fact: clone(sameSequenceAndKind),
      applied: false,
    };
  }
  if (
    input.envelope.kind === 'SessionCompleted' &&
    input.current?.status === 'completed'
  ) {
    const completionFact = input.currentFacts.find(
      (candidate) => candidate.kind === 'SessionCompleted',
    );
    if (completionFact?.digest === fact.digest)
      return {
        record: clone(input.current),
        fact: clone(completionFact),
        applied: false,
      };
    throw new DirectoryError(
      'FACT_CONFLICT',
      'a session completion fact is already recorded',
      false,
    );
  }
  const stale =
    input.current !== null &&
    input.envelope.aggregateSequence < input.current.latestAggregateSequence;
  if (stale && input.envelope.kind !== 'SessionCompleted')
    return {
      record: clone(input.current),
      fact,
      applied: false,
    };
  const record = makeRecord(input, payload, {
    preserveSummary: stale && input.envelope.kind === 'SessionCompleted',
    preserveParticipants: stale && input.envelope.kind === 'SessionCompleted',
  });
  return { record, fact, applied: true };
}
