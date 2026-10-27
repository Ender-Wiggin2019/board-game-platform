import { createHash } from 'node:crypto';
import {
  assertJsonPayloadSize,
  assertParticipant,
  assertPublicPlayerProfile,
  assertSessionRoute,
  canonicalStableStringify,
  type JsonValue,
  type MatchAdmission,
  type SessionRoute,
  type SessionStatus,
} from '@board-game/contracts';
import { DirectoryError } from './errors.js';
import {
  DIRECTORY_SCHEMA_VERSION,
  type DirectoryParticipant,
  type DirectoryRetention,
  type SessionDirectoryCursor,
  type SessionDirectoryEnvelope,
  type SessionDirectoryFactKind,
  type SessionDirectoryFactPayload,
  type SessionDirectoryRecord,
} from './types.js';

export const MAX_DIRECTORY_PAGE = 100;
export const MAX_DIRECTORY_STRING_LENGTH = 512;
export const MAX_DIRECTORY_SUMMARY_BYTES = 256 * 1024;
export const MAX_DIRECTORY_RESULT_BYTES = 256 * 1024;

const FACT_KINDS: ReadonlySet<string> = new Set([
  'SessionCreated',
  'SessionActivated',
  'SessionSummaryChanged',
  'SessionCompleted',
  'SessionControlled',
]);

const CONTROL_ACTIONS: ReadonlySet<string> = new Set([
  'pause',
  'resume',
  'cancel',
]);

const STATUSES: ReadonlySet<string> = new Set([
  'suspended',
  'active',
  'completed',
  'cancelled',
  'paused',
]);

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DirectoryError('INVALID_ARGUMENT', `${name} must be an object`);
}

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_DIRECTORY_STRING_LENGTH
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${MAX_DIRECTORY_STRING_LENGTH} characters`,
      false,
    );
}

export function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${name} must be a finite non-negative timestamp`,
      false,
    );
}

export function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${name} must be a positive safe integer`,
      false,
    );
}

export function assertNonNegativeInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative safe integer`,
      false,
    );
}

export function assertJson(
  value: unknown,
  name: string,
  maxBytes = MAX_DIRECTORY_SUMMARY_BYTES,
): asserts value is JsonValue {
  try {
    assertJsonPayloadSize(value, maxBytes, name);
  } catch {
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${name} must be bounded JSON`,
      false,
    );
  }
}

export function equalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalStableStringify(left) === canonicalStableStringify(right);
  } catch {
    return false;
  }
}

export function assertSessionId(
  sessionId: unknown,
): asserts sessionId is string {
  assertString(sessionId, 'sessionId');
}

export function assertStatus(
  value: unknown,
  name: string,
): asserts value is SessionStatus {
  if (typeof value !== 'string' || !STATUSES.has(value))
    throw new DirectoryError('INVALID_ARGUMENT', `${name} is invalid`, false);
}

export function assertFactKind(
  value: unknown,
): asserts value is SessionDirectoryFactKind {
  if (typeof value !== 'string' || !FACT_KINDS.has(value))
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'unsupported directory fact kind',
      false,
    );
}

function assertPayloadKeys(payload: Record<string, unknown>): void {
  const allowed = new Set([
    'summary',
    'result',
    'participants',
    'status',
    'action',
    'resultRevision',
    'endedAt',
    'replayRef',
    'progress',
    'principalId',
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key))
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        `directory fact payload contains unsupported field ${key}`,
        false,
      );
  }
}

function validateDirectoryParticipant(
  value: unknown,
  index: number,
  source = 'payload',
): asserts value is DirectoryParticipant {
  const field = `${source}.participants[${index}]`;
  assertObject(value, field);
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    'principalId',
    'seatId',
    'teamId',
    'controller',
    'controlledBy',
    'controllerId',
    'controllerOptions',
    'publicProfile',
  ]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key))
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        `${field} contains unsupported field ${key}`,
        false,
      );
  }
  assertString(item.principalId, `${field}.principalId`);
  assertString(item.seatId, `${field}.seatId`);
  if (item.teamId !== undefined) assertString(item.teamId, `${field}.teamId`);
  try {
    assertParticipant(item);
  } catch {
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `${field} has an invalid participant schema`,
      false,
    );
  }
  if (item.publicProfile !== undefined) {
    try {
      assertPublicPlayerProfile(item.publicProfile);
    } catch {
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        `${field}.publicProfile is invalid`,
        false,
      );
    }
    assertJson(item.publicProfile, `${field}.publicProfile`, 32 * 1024);
  }
}

export function parseFactPayload(
  value: unknown,
  kind?: SessionDirectoryFactKind,
): SessionDirectoryFactPayload {
  // Host create/activate facts historically emitted the summary directly;
  // newer producers wrap it in { summary, ... }. Normalize both forms.
  let payload: Record<string, unknown>;
  if (
    (kind === 'SessionCreated' || kind === 'SessionActivated') &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const candidate = value as Record<string, unknown>;
    const wrapperKeys = new Set([
      'summary',
      'result',
      'participants',
      'status',
      'action',
      'resultRevision',
      'endedAt',
      'replayRef',
      'progress',
      'principalId',
    ]);
    payload =
      Object.keys(candidate).length === 0 ||
      Object.keys(candidate).some((key) => wrapperKeys.has(key))
        ? candidate
        : { summary: value as JsonValue };
  } else if (
    (kind === 'SessionCreated' || kind === 'SessionActivated') &&
    (typeof value !== 'object' || value === null || Array.isArray(value))
  ) {
    payload = { summary: value as JsonValue };
  } else {
    assertObject(value, 'directory fact payload');
    payload = value as Record<string, unknown>;
  }
  assertPayloadKeys(payload);
  if (payload.summary !== undefined)
    assertJson(payload.summary, 'payload.summary');
  if (payload.result !== undefined)
    assertJson(payload.result, 'payload.result', MAX_DIRECTORY_RESULT_BYTES);
  if (payload.status !== undefined)
    assertStatus(payload.status, 'payload.status');
  if (
    payload.action !== undefined &&
    (typeof payload.action !== 'string' || !CONTROL_ACTIONS.has(payload.action))
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'payload.action is invalid',
      false,
    );
  if (payload.resultRevision !== undefined)
    assertPositiveInteger(payload.resultRevision, 'payload.resultRevision');
  if (payload.endedAt !== undefined)
    assertTimestamp(payload.endedAt, 'payload.endedAt');
  if (payload.replayRef !== undefined)
    assertJson(payload.replayRef, 'payload.replayRef', 16 * 1024);
  if (payload.progress !== undefined)
    assertJson(payload.progress, 'payload.progress');
  if (payload.principalId !== undefined)
    assertString(payload.principalId, 'payload.principalId');
  if (payload.participants !== undefined) {
    if (
      !Array.isArray(payload.participants) ||
      payload.participants.length > 100
    )
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'payload.participants must contain at most 100 entries',
        false,
      );
    const principals = new Set<string>();
    const seats = new Set<string>();
    for (const [index, participant] of payload.participants.entries()) {
      validateDirectoryParticipant(participant, index);
      if (
        principals.has(participant.principalId) ||
        seats.has(participant.seatId)
      )
        throw new DirectoryError(
          'INVALID_ARGUMENT',
          'payload.participants contains duplicates',
          false,
        );
      principals.add(participant.principalId);
      seats.add(participant.seatId);
    }
  }
  return clone(payload as SessionDirectoryFactPayload);
}

export function validateEnvelope(
  envelope: SessionDirectoryEnvelope,
): asserts envelope is SessionDirectoryEnvelope & {
  readonly sessionId: string;
  readonly aggregateSequence: number;
  readonly kind: SessionDirectoryFactKind;
} {
  assertObject(envelope, 'directory envelope');
  assertString(envelope.producerId, 'producerId');
  assertString(envelope.eventId, 'eventId');
  assertSessionId(envelope.sessionId);
  assertFactKind(envelope.kind);
  if (envelope.schemaVersion !== DIRECTORY_SCHEMA_VERSION)
    throw new DirectoryError(
      'SCHEMA_MISMATCH',
      `directory facts require schemaVersion ${DIRECTORY_SCHEMA_VERSION}`,
      false,
    );
  assertString(envelope.sourceRelease, 'sourceRelease');
  if (envelope.aggregateSequence === undefined)
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'directory facts require aggregateSequence',
      false,
    );
  assertNonNegativeInteger(envelope.aggregateSequence, 'aggregateSequence');
  if (envelope.occurredAt !== undefined)
    assertTimestamp(envelope.occurredAt, 'occurredAt');
  assertTimestamp(envelope.receivedAt, 'receivedAt');
  assertString(envelope.digest, 'digest');
  parseFactPayload(envelope.payload, envelope.kind);
}

export function validateAdmission(
  admission: MatchAdmission,
  sessionId: string,
): void {
  assertObject(admission, 'admission');
  try {
    assertSessionRoute(admission.route);
  } catch {
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'admission route is invalid',
      false,
    );
  }
  if (admission.route.sessionId !== sessionId)
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'admission route does not match fact session',
      false,
    );
  assertString(admission.id, 'admission.id');
  if (admission.visibility !== 'public' && admission.visibility !== 'private')
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'admission visibility is invalid',
      false,
    );
  if (
    !Array.isArray(admission.participants) ||
    admission.participants.length === 0
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'admission roster is invalid',
      false,
    );
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const participant of admission.participants) {
    try {
      assertParticipant(participant);
    } catch {
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'admission participant is invalid',
        false,
      );
    }
    if (
      principals.has(participant.principalId) ||
      seats.has(participant.seatId)
    )
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'admission roster contains duplicates',
        false,
      );
    principals.add(participant.principalId);
    seats.add(participant.seatId);
  }
  assertTimestamp(admission.createdAt, 'admission.createdAt');
}

export function assertRecordMatchesAdmission(
  record: SessionDirectoryRecord,
  admission: MatchAdmission,
): void {
  if (
    !equalJson(record.route, admission.route) ||
    record.admissionId !== admission.id ||
    record.visibility !== admission.visibility
  )
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'existing directory session is pinned to a different admission',
      false,
    );
  const frozen = admissionParticipants(admission);
  if (
    record.participants.length !== frozen.length ||
    record.participants.some((participant, index) => {
      const expected = frozen[index];
      return (
        !expected ||
        participant.principalId !== expected.principalId ||
        participant.seatId !== expected.seatId ||
        participant.teamId !== expected.teamId ||
        (participant.controller ?? 'human') !==
          (expected.controller ?? 'human') ||
        participant.controlledBy !== expected.controlledBy ||
        participant.controllerId !== expected.controllerId ||
        !equalJson(
          participant.controllerOptions ?? null,
          expected.controllerOptions ?? null,
        )
      );
    })
  )
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'existing directory roster is pinned to a different admission',
      false,
    );
}

export function assertSourceMatches(
  envelope: SessionDirectoryEnvelope & {
    readonly sessionId: string;
  },
  route: SessionRoute,
): void {
  const expectedProducer = `game:${route.gameId}:session:${route.sessionId}`;
  if (
    envelope.sessionId !== route.sessionId ||
    envelope.sourceRelease !== route.releaseId ||
    envelope.producerId !== expectedProducer
  )
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'directory fact source does not match the frozen session route',
      false,
    );
}

export function factDigest(
  envelope: SessionDirectoryEnvelope & {
    readonly sessionId: string;
    readonly aggregateSequence: number;
    readonly kind: SessionDirectoryFactKind;
  },
  payload: SessionDirectoryFactPayload,
): string {
  return createHash('sha256')
    .update(
      canonicalStableStringify({
        producerId: envelope.producerId,
        eventId: envelope.eventId,
        sessionId: envelope.sessionId,
        kind: envelope.kind,
        schemaVersion: envelope.schemaVersion,
        sourceRelease: envelope.sourceRelease,
        aggregateSequence: envelope.aggregateSequence,
        payload,
      }),
    )
    .digest('hex');
}

export function normalizeRetention(value: DirectoryRetention): {
  readonly retainSummary: boolean;
  readonly retainResult: boolean;
} {
  if (typeof value === 'string') {
    if (value === 'summary-and-replay')
      return { retainSummary: true, retainResult: true };
    if (value === 'progress-only')
      return { retainSummary: true, retainResult: false };
    if (value === 'ephemeral-result')
      return { retainSummary: false, retainResult: false };
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'unsupported history policy',
      false,
    );
  }
  assertObject(value, 'retention policy');
  if (
    typeof value.retainSummary !== 'boolean' ||
    typeof value.retainResult !== 'boolean'
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'retention policy flags are invalid',
      false,
    );
  return {
    retainSummary: value.retainSummary,
    retainResult: value.retainResult,
  };
}

export function admissionParticipants(
  admission: MatchAdmission,
): readonly DirectoryParticipant[] {
  return admission.participants.map((participant) => ({
    principalId: participant.principalId,
    seatId: participant.seatId,
    ...(participant.teamId !== undefined ? { teamId: participant.teamId } : {}),
    ...(participant.controller !== undefined
      ? { controller: participant.controller }
      : {}),
    ...(participant.controlledBy !== undefined
      ? { controlledBy: participant.controlledBy }
      : {}),
    ...(participant.controllerId !== undefined
      ? { controllerId: participant.controllerId }
      : {}),
    ...(participant.controllerOptions !== undefined
      ? { controllerOptions: clone(participant.controllerOptions) }
      : {}),
    ...(participant.publicProfile !== undefined
      ? { publicProfile: clone(participant.publicProfile) }
      : {}),
  }));
}

export function assertPayloadParticipantsMatch(
  supplied: readonly DirectoryParticipant[] | undefined,
  frozen: readonly DirectoryParticipant[],
): void {
  if (supplied === undefined) return;
  if (supplied.length !== frozen.length)
    throw new DirectoryError(
      'ROUTE_MISMATCH',
      'fact roster does not match admission',
      false,
    );
  for (const participant of frozen) {
    const found = supplied.find(
      (candidate) => candidate.principalId === participant.principalId,
    );
    if (
      !found ||
      found.seatId !== participant.seatId ||
      found.teamId !== participant.teamId ||
      (found.controller ?? 'human') !== (participant.controller ?? 'human') ||
      found.controlledBy !== participant.controlledBy ||
      found.controllerId !== participant.controllerId ||
      canonicalStableStringify(found.controllerOptions ?? null) !==
        canonicalStableStringify(participant.controllerOptions ?? null)
    )
      throw new DirectoryError(
        'ROUTE_MISMATCH',
        'fact roster does not match admission',
        false,
      );
  }
}

export function allowedStatusTransition(
  previous: SessionStatus | undefined,
  next: SessionStatus,
): boolean {
  if (!previous)
    return next === 'suspended' || next === 'active' || next === 'paused';
  const allowed: Record<SessionStatus, readonly SessionStatus[]> = {
    suspended: ['suspended', 'active', 'paused', 'completed', 'cancelled'],
    active: ['active', 'paused', 'completed', 'cancelled'],
    paused: ['paused', 'active', 'completed', 'cancelled'],
    completed: ['completed'],
    cancelled: ['cancelled'],
  };
  return allowed[previous].includes(next);
}

export function encodeCursor(cursor: SessionDirectoryCursor): string {
  assertTimestamp(cursor.updatedAt, 'cursor.updatedAt');
  assertSessionId(cursor.sessionId);
  return Buffer.from(
    JSON.stringify([cursor.updatedAt, cursor.sessionId]),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(value: string): SessionDirectoryCursor {
  assertString(value, 'cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new DirectoryError('INVALID_ARGUMENT', 'cursor is invalid', false);
  }
  if (!Array.isArray(parsed) || parsed.length !== 2)
    throw new DirectoryError('INVALID_ARGUMENT', 'cursor is invalid', false);
  assertTimestamp(parsed[0], 'cursor.updatedAt');
  assertSessionId(parsed[1]);
  return { updatedAt: parsed[0], sessionId: parsed[1] };
}

export function validateListOptions(options: {
  readonly limit?: number;
  readonly cursor?: string;
  readonly gameId?: string;
  readonly status?: SessionStatus;
}): void {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_DIRECTORY_PAGE)
  )
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_DIRECTORY_PAGE}`,
      false,
    );
  if (options.cursor !== undefined) decodeCursor(options.cursor);
  if (options.gameId !== undefined) assertString(options.gameId, 'gameId');
  if (options.status !== undefined) assertStatus(options.status, 'status');
}

export function validateRecord(record: SessionDirectoryRecord): void {
  assertSessionId(record.sessionId);
  assertString(record.admissionId, 'admissionId');
  try {
    assertSessionRoute(record.route);
  } catch {
    throw new DirectoryError(
      'DATABASE_ERROR',
      'stored directory route is invalid',
      false,
    );
  }
  if (record.route.sessionId !== record.sessionId)
    throw new DirectoryError(
      'DATABASE_ERROR',
      'stored route session mismatch',
      false,
    );
  if (record.visibility !== 'public' && record.visibility !== 'private')
    throw new DirectoryError(
      'DATABASE_ERROR',
      'stored visibility is invalid',
      false,
    );
  if (!Array.isArray(record.participants) || record.participants.length === 0)
    throw new DirectoryError(
      'DATABASE_ERROR',
      'stored participants are invalid',
      false,
    );
  const participantIds = new Set<string>();
  const participantSeats = new Set<string>();
  for (const [index, participant] of record.participants.entries()) {
    try {
      validateDirectoryParticipant(participant, index, 'stored');
    } catch {
      throw new DirectoryError(
        'DATABASE_ERROR',
        'stored participant schema is invalid',
        false,
      );
    }
    assertString(
      participant.principalId,
      `stored participants[${index}].principalId`,
    );
    assertString(participant.seatId, `stored participants[${index}].seatId`);
    if (participant.teamId !== undefined)
      assertString(participant.teamId, `stored participants[${index}].teamId`);
    if (
      participantIds.has(participant.principalId) ||
      participantSeats.has(participant.seatId)
    )
      throw new DirectoryError(
        'DATABASE_ERROR',
        'stored participants contain duplicates',
        false,
      );
    participantIds.add(participant.principalId);
    participantSeats.add(participant.seatId);
  }
  assertStatus(record.status, 'stored status');
  assertNonNegativeInteger(
    record.latestAggregateSequence,
    'latestAggregateSequence',
  );
  if (record.summary !== undefined)
    assertJson(record.summary, 'stored summary');
  if (record.result !== undefined)
    assertJson(record.result, 'stored result', MAX_DIRECTORY_RESULT_BYTES);
  assertTimestamp(record.createdAt, 'createdAt');
  assertTimestamp(record.updatedAt, 'updatedAt');
}
