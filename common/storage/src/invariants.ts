import {
  isJsonValue,
  type SessionRoute,
  type SessionStatus,
} from '@board-game/contracts';
import { StorageError } from './errors.js';
import type {
  AutomationDecision,
  AutomationTrace,
  AutomationTraceReadOptions,
  CommandReceipt,
  DomainEvent,
  DueSessionReadOptions,
  EventReadOptions,
  HeadWriteOptions,
  OutboxKey,
  OutboxReadOptions,
  OutboxRecord,
  SessionCreateOptions,
  SessionDeadline,
  SessionHead,
  SessionOwner,
  TerminalCleanupOptions,
} from './types.js';

const ROUTE_KEYS = [
  'gameId',
  'modeId',
  'sessionId',
  'releaseId',
  'backendBindingId',
  'storageBindingId',
  'ownershipEpoch',
] as const;

const HEAD_STATUSES: readonly SessionStatus[] = [
  'suspended',
  'active',
  'paused',
  'completed',
  'cancelled',
];

const RECEIPT_STATUSES: readonly CommandReceipt['status'][] = [
  'accepted',
  'rejected',
  'unknown',
  'tombstone',
];

const RESULT_RETENTIONS: readonly CommandReceipt['resultRetention'][] = [
  'replayable',
  'ephemeral-result',
];

const RECEIPT_KEYS = [
  'sessionId',
  'commandId',
  'actorPrincipalId',
  'inputHash',
  'status',
  'resultRetention',
  'persistedRevision',
  'persistedAt',
  'error',
] as const;

const RECEIPT_ERROR_KEYS = ['code', 'messageKey', 'retryable'] as const;

const AUTOMATION_DECISION_KEYS = [
  'sessionId',
  'decisionId',
  'commandId',
  'deadlineId',
  'expectedRevision',
  'seatId',
  'turnId',
  'command',
  'createdAt',
] as const;

const AUTOMATION_FAILURE_KEYS = ['seatId', 'messageKey'] as const;
const EVENT_SOURCE_KINDS = ['human', 'ai', 'automa', 'system'] as const;

const AUTOMATION_TRACE_KEYS = [
  'kind',
  'sessionId',
  'traceId',
  'decisionId',
  'commandId',
  'deadlineId',
  'releaseId',
  'policyId',
  'policyVersion',
  'expectedRevision',
  'seatId',
  'turnId',
  'state',
  'input',
  'schemaVersion',
  'options',
  'command',
  'diagnostics',
  'outcome',
  'startedAt',
  'finishedAt',
  'createdAt',
  'eventSequenceStart',
  'eventSequenceCount',
] as const;

const AUTOMATION_TRACE_OUTCOMES: readonly AutomationTrace['outcome'][] = [
  'deciding',
  'decided',
  'executed',
  'rejected',
  'timeout',
  'failed',
];

function assertObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StorageError('INVALID_ARGUMENT', `${name} must be an object`);
}

function assertExactKeys(
  value: object,
  keys: readonly string[],
  name: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)))
    throw new StorageError(
      'INVALID_ARGUMENT',
      `${name} contains an unknown field`,
    );
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string`,
    );
  }
}

export function assertFiniteNumber(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new StorageError('INVALID_ARGUMENT', `${name} must be finite`);
}

export function assertNonNegativeInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new StorageError(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative integer`,
    );
}

export function assertSequenceCursor(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -1)
    throw new StorageError(
      'INVALID_ARGUMENT',
      `${name} must be an integer greater than or equal to -1`,
    );
}

export function assertSessionRoute(route: SessionRoute): void {
  assertObject(route, 'Session route');
  assertExactKeys(route, ROUTE_KEYS, 'Session route');
  for (const key of ROUTE_KEYS) assertNonEmpty(route[key], `route.${key}`);
}

export function assertSessionStatus(
  status: unknown,
): asserts status is SessionStatus {
  if (!HEAD_STATUSES.includes(status as SessionStatus))
    throw new StorageError('INVALID_ARGUMENT', 'Session status is invalid');
}

export function assertSessionDeadline(deadline: SessionDeadline): void {
  assertObject(deadline, 'Session deadline');
  assertExactKeys(deadline, ['deadlineId', 'dueAt'], 'Session deadline');
  assertNonEmpty(deadline.deadlineId, 'deadlineId');
  assertFiniteNumber(deadline.dueAt, 'deadline.dueAt');
  if (deadline.dueAt < 0)
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Session deadline dueAt must be non-negative',
    );
}

export function assertAutomationFailure(
  failure: NonNullable<SessionHead['automationFailure']>,
): void {
  assertObject(failure, 'Automation failure');
  assertExactKeys(failure, AUTOMATION_FAILURE_KEYS, 'Automation failure');
  assertNonEmpty(failure.seatId, 'automationFailure.seatId');
  assertNonEmpty(failure.messageKey, 'automationFailure.messageKey');
  if (failure.seatId.length > 256 || failure.messageKey.length > 256)
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Automation failure metadata is too long',
    );
}

export function assertAutomationDecision(decision: AutomationDecision): void {
  assertObject(decision, 'Automation decision');
  assertExactKeys(decision, AUTOMATION_DECISION_KEYS, 'Automation decision');
  assertNonEmpty(decision.sessionId, 'automationDecision.sessionId');
  assertNonEmpty(decision.decisionId, 'automationDecision.decisionId');
  assertNonEmpty(decision.commandId, 'automationDecision.commandId');
  assertNonEmpty(decision.deadlineId, 'automationDecision.deadlineId');
  assertNonNegativeInteger(
    decision.expectedRevision,
    'automationDecision.expectedRevision',
  );
  assertNonEmpty(decision.seatId, 'automationDecision.seatId');
  assertNonEmpty(decision.turnId, 'automationDecision.turnId');
  if (!isJsonValue(decision.command))
    throw new StorageError(
      'INVALID_ARGUMENT',
      'automationDecision.command must be JSON',
    );
  const encodedCommand = JSON.stringify(decision.command);
  if (
    encodedCommand === undefined ||
    new TextEncoder().encode(encodedCommand).byteLength > 64 * 1024
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'automationDecision.command exceeds the storage limit',
    );
  assertFiniteNumber(decision.createdAt, 'automationDecision.createdAt');
}

function assertJsonBytes(value: unknown, limit: number, name: string): void {
  if (!isJsonValue(value))
    throw new StorageError('INVALID_ARGUMENT', `${name} must be JSON`);
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > limit
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      `${name} exceeds the storage limit`,
    );
}

/** Validates a private trace and keeps its replay payload bounded. */
export function assertAutomationTrace(trace: AutomationTrace): void {
  assertObject(trace, 'Automation trace');
  assertExactKeys(trace, AUTOMATION_TRACE_KEYS, 'Automation trace');
  if (trace.kind !== 'automation' && trace.kind !== 'command')
    throw new StorageError(
      'INVALID_ARGUMENT',
      'automationTrace.kind must be automation or command',
    );
  assertNonEmpty(trace.sessionId, 'automationTrace.sessionId');
  assertNonEmpty(trace.traceId, 'automationTrace.traceId');
  assertNonEmpty(trace.decisionId, 'automationTrace.decisionId');
  assertNonEmpty(trace.commandId, 'automationTrace.commandId');
  assertNonEmpty(trace.deadlineId, 'automationTrace.deadlineId');
  assertNonEmpty(trace.releaseId, 'automationTrace.releaseId');
  assertNonEmpty(trace.policyId, 'automationTrace.policyId');
  if (trace.policyVersion !== undefined)
    assertNonEmpty(trace.policyVersion, 'automationTrace.policyVersion');
  assertNonNegativeInteger(
    trace.expectedRevision,
    'automationTrace.expectedRevision',
  );
  assertNonEmpty(trace.seatId, 'automationTrace.seatId');
  assertNonEmpty(trace.turnId, 'automationTrace.turnId');
  assertJsonBytes(trace.state, 2 * 1024 * 1024, 'automationTrace.state');
  assertJsonBytes(trace.input, 512 * 1024, 'automationTrace.input');
  if (!Number.isSafeInteger(trace.schemaVersion) || trace.schemaVersion < 1)
    throw new StorageError(
      'INVALID_ARGUMENT',
      'automationTrace.schemaVersion must be positive',
    );
  assertJsonBytes(trace.options, 16 * 1024, 'automationTrace.options');
  if (trace.command !== undefined)
    assertJsonBytes(trace.command, 64 * 1024, 'automationTrace.command');
  if (trace.diagnostics !== undefined)
    assertJsonBytes(
      trace.diagnostics,
      128 * 1024,
      'automationTrace.diagnostics',
    );
  if (!AUTOMATION_TRACE_OUTCOMES.includes(trace.outcome))
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Automation trace outcome is invalid',
    );
  assertFiniteNumber(trace.startedAt, 'automationTrace.startedAt');
  if (trace.finishedAt !== undefined)
    assertFiniteNumber(trace.finishedAt, 'automationTrace.finishedAt');
  assertFiniteNumber(trace.createdAt, 'automationTrace.createdAt');
  if (trace.eventSequenceStart !== undefined)
    assertNonNegativeInteger(
      trace.eventSequenceStart,
      'automationTrace.eventSequenceStart',
    );
  if (trace.eventSequenceCount !== undefined)
    assertNonNegativeInteger(
      trace.eventSequenceCount,
      'automationTrace.eventSequenceCount',
    );
  if (
    trace.eventSequenceStart === undefined &&
    trace.eventSequenceCount !== undefined &&
    trace.eventSequenceCount !== 0
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'automationTrace.eventSequenceCount requires a start sequence',
    );
}

export function assertAutomationTraceReadOptions(
  options: AutomationTraceReadOptions,
): void {
  assertObject(options, 'Automation trace read options');
  assertExactKeys(
    options,
    ['limit', 'afterCreatedAt', 'kind', 'now'],
    'Automation trace read options',
  );
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 200
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Automation trace limit must be between 1 and 200',
    );
  if (options.afterCreatedAt !== undefined)
    assertFiniteNumber(
      options.afterCreatedAt,
      'automationTrace.afterCreatedAt',
    );
  if (
    options.kind !== undefined &&
    options.kind !== 'automation' &&
    options.kind !== 'command'
  )
    throw new StorageError('INVALID_ARGUMENT', 'automationTrace.kind invalid');
  if (options.now !== undefined)
    assertFiniteNumber(options.now, 'automationTrace.now');
}

export function assertSessionOwner(owner: SessionOwner): void {
  assertObject(owner, 'Session owner');
  assertExactKeys(owner, ['ownershipEpoch', 'ownerId'], 'Session owner');
  assertNonEmpty(owner.ownershipEpoch, 'ownershipEpoch');
  if (owner.ownerId !== undefined) assertNonEmpty(owner.ownerId, 'ownerId');
}

export function assertHeadWriteOptions(options: HeadWriteOptions): void {
  assertObject(options, 'Head write options');
  assertExactKeys(
    options,
    ['expectedRevision', 'ownershipEpoch'],
    'Head write options',
  );
  if (options.expectedRevision !== undefined)
    assertNonNegativeInteger(options.expectedRevision, 'expectedRevision');
  if (options.ownershipEpoch !== undefined)
    assertNonEmpty(options.ownershipEpoch, 'ownershipEpoch');
}

export function assertSessionCreateOptions(
  options: SessionCreateOptions,
): void {
  assertObject(options, 'Session create options');
  assertExactKeys(
    options,
    ['initialOutbox', 'initialEvents'],
    'Session create options',
  );
  if (
    options.initialOutbox !== undefined &&
    !Array.isArray(options.initialOutbox)
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'initialOutbox must be an array',
    );
  if (
    options.initialEvents !== undefined &&
    !Array.isArray(options.initialEvents)
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'initialEvents must be an array',
    );
}

export function assertInitialEvents(
  events: readonly DomainEvent[] | undefined,
  sessionId: string,
  eventSequence: number,
): void {
  assertNonEmpty(sessionId, 'sessionId');
  assertNonNegativeInteger(eventSequence, 'Session head eventSequence');
  const initialEvents = events ?? [];
  if (initialEvents.length !== eventSequence)
    throw new StorageError(
      'INVALID_ARGUMENT',
      'initialEvents count must equal the session head eventSequence',
    );
  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  for (const event of initialEvents) {
    assertEvent(event);
    if (event.sessionId !== sessionId)
      throw new StorageError(
        'INVALID_ARGUMENT',
        'Initial event session does not match head',
      );
    if (event.aggregateSequence < 1 || event.aggregateSequence > eventSequence)
      throw new StorageError(
        'INVALID_ARGUMENT',
        'Initial event sequence must be between 1 and eventSequence',
      );
    if (eventIds.has(event.eventId) || sequences.has(event.aggregateSequence))
      throw new StorageError(
        'DUPLICATE_ID',
        'Initial events must have unique event ids and sequences',
      );
    eventIds.add(event.eventId);
    sequences.add(event.aggregateSequence);
  }
  for (let sequence = 1; sequence <= eventSequence; sequence += 1) {
    if (!sequences.has(sequence))
      throw new StorageError(
        'INVALID_ARGUMENT',
        'Initial event sequences must be contiguous from one',
      );
  }
}

export function assertTerminalCleanupOptions(
  options: TerminalCleanupOptions,
): void {
  assertObject(options, 'Terminal cleanup options');
  assertExactKeys(options, ['requireTerminal'], 'Terminal cleanup options');
  if (
    options.requireTerminal !== undefined &&
    typeof options.requireTerminal !== 'boolean'
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'requireTerminal must be a boolean',
    );
}

export function assertHead(head: SessionHead): void {
  assertObject(head, 'Session head');
  assertSessionRoute(head.route);
  assertNonEmpty(head.startId, 'startId');
  if (head.startGeneration !== undefined)
    assertNonNegativeInteger(head.startGeneration, 'startGeneration');
  assertNonEmpty(head.startDigest, 'startDigest');
  assertSessionStatus(head.status);
  assertNonNegativeInteger(head.revision, 'Session head revision');
  if (!Number.isSafeInteger(head.schemaVersion) || head.schemaVersion < 1) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Session head schemaVersion must be a positive integer',
    );
  }
  assertNonNegativeInteger(head.eventSequence, 'Session head eventSequence');
  assertFiniteNumber(head.logicalTime, 'Session head logicalTime');
  if (head.activatedAt !== undefined)
    assertFiniteNumber(head.activatedAt, 'Session head activatedAt');
  if (head.deadline !== undefined) assertSessionDeadline(head.deadline);
  if (head.automationFailure !== undefined)
    assertAutomationFailure(head.automationFailure);
  if (!Array.isArray(head.participants)) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Session head participants must be an array',
    );
  }
  for (const [index, participant] of head.participants.entries()) {
    assertObject(participant, `Session head participants[${index}]`);
    assertNonEmpty(
      participant.principalId,
      `Session head participants[${index}].principalId`,
    );
    assertNonEmpty(
      participant.seatId,
      `Session head participants[${index}].seatId`,
    );
    if (participant.teamId !== undefined)
      assertNonEmpty(
        participant.teamId,
        `Session head participants[${index}].teamId`,
      );
  }
}

export function assertReceipt(receipt: CommandReceipt): void {
  assertObject(receipt, 'Receipt');
  assertExactKeys(receipt, RECEIPT_KEYS, 'Receipt');
  assertNonEmpty(receipt.sessionId, 'receipt.sessionId');
  assertNonEmpty(receipt.commandId, 'receipt.commandId');
  assertNonEmpty(receipt.actorPrincipalId, 'receipt.actorPrincipalId');
  assertNonEmpty(receipt.inputHash, 'receipt.inputHash');
  if (!RECEIPT_STATUSES.includes(receipt.status))
    throw new StorageError('INVALID_ARGUMENT', 'Receipt status is invalid');
  if (!RESULT_RETENTIONS.includes(receipt.resultRetention))
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Receipt resultRetention is invalid',
    );
  if (receipt.persistedRevision !== undefined)
    assertNonNegativeInteger(
      receipt.persistedRevision,
      'receipt.persistedRevision',
    );
  if (receipt.persistedAt !== undefined)
    assertFiniteNumber(receipt.persistedAt, 'receipt.persistedAt');
  if (receipt.error !== undefined) {
    assertObject(receipt.error, 'Receipt error');
    assertExactKeys(receipt.error, RECEIPT_ERROR_KEYS, 'Receipt error');
    assertNonEmpty(receipt.error.code, 'receipt.error.code');
    assertNonEmpty(receipt.error.messageKey, 'receipt.error.messageKey');
    if (typeof receipt.error.retryable !== 'boolean')
      throw new StorageError(
        'INVALID_ARGUMENT',
        'receipt.error.retryable must be a boolean',
      );
  }
}

export function assertEvent(event: DomainEvent): void {
  assertObject(event, 'Event');
  assertNonEmpty(event.sessionId, 'event.sessionId');
  assertNonEmpty(event.eventId, 'event.eventId');
  assertNonEmpty(event.producerId, 'event.producerId');
  assertNonEmpty(event.sourceRelease, 'event.sourceRelease');
  assertNonNegativeInteger(event.aggregateSequence, 'Event aggregateSequence');
  if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Event schemaVersion must be a positive integer',
    );
  }
  assertFiniteNumber(event.logicalTime, 'Event logicalTime');
  if (event.occurredAt !== undefined)
    assertFiniteNumber(event.occurredAt, 'Event occurredAt');
  if (event.source !== undefined) {
    assertObject(event.source, 'event.source');
    assertExactKeys(
      event.source,
      ['kind', 'seatId', 'traceId'],
      'event.source',
    );
    if (
      typeof event.source.kind !== 'string' ||
      !EVENT_SOURCE_KINDS.includes(
        event.source.kind as (typeof EVENT_SOURCE_KINDS)[number],
      )
    )
      throw new StorageError(
        'INVALID_ARGUMENT',
        'event.source.kind is invalid',
      );
    if (event.source.seatId !== undefined)
      assertNonEmpty(event.source.seatId, 'event.source.seatId');
    if (event.source.traceId !== undefined)
      assertNonEmpty(event.source.traceId, 'event.source.traceId');
  }
}

export function assertOutbox(message: OutboxRecord): void {
  assertObject(message, 'Outbox');
  assertNonEmpty(message.sessionId, 'outbox.sessionId');
  assertNonEmpty(message.outboxId, 'outbox.outboxId');
  assertNonEmpty(message.producerId, 'outbox.producerId');
  assertNonEmpty(message.kind, 'outbox.kind');
  assertNonEmpty(message.sourceRelease, 'outbox.sourceRelease');
  if (
    !Number.isSafeInteger(message.schemaVersion) ||
    message.schemaVersion < 1
  ) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Outbox schemaVersion must be a positive integer',
    );
  }
  assertFiniteNumber(message.createdAt, 'Outbox createdAt');
  if (message.deliveredAt !== undefined)
    assertFiniteNumber(message.deliveredAt, 'Outbox deliveredAt');
  assertNonNegativeInteger(message.attempts, 'Outbox attempts');
  if (message.nextAttemptAt !== undefined)
    assertFiniteNumber(message.nextAttemptAt, 'Outbox nextAttemptAt');
  if (message.aggregateSequence !== undefined)
    assertNonNegativeInteger(
      message.aggregateSequence,
      'Outbox aggregateSequence',
    );
}

export function assertEventReadOptions(options: EventReadOptions): void {
  assertObject(options, 'Event read options');
  assertExactKeys(options, ['afterSequence', 'limit'], 'Event read options');
  if (options.afterSequence !== undefined)
    assertSequenceCursor(options.afterSequence, 'afterSequence');
}

export function assertDueSessionReadOptions(
  options: DueSessionReadOptions,
): void {
  assertObject(options, 'Due session read options');
  assertExactKeys(
    options,
    [
      'limit',
      'now',
      'backendBindingId',
      'storageBindingId',
      'releaseId',
      'deadlineKind',
    ],
    'Due session read options',
  );
  if (options.now !== undefined) assertFiniteNumber(options.now, 'now');
  for (const [name, value] of [
    ['backendBindingId', options.backendBindingId],
    ['storageBindingId', options.storageBindingId],
    ['releaseId', options.releaseId],
  ] as const)
    if (value !== undefined) assertNonEmpty(value, name);
  if (
    options.deadlineKind !== undefined &&
    options.deadlineKind !== 'system' &&
    options.deadlineKind !== 'automation'
  )
    throw new StorageError(
      'INVALID_ARGUMENT',
      'deadlineKind must be system or automation',
    );
}

export function assertOutboxReadOptions(options: OutboxReadOptions): void {
  assertObject(options, 'Outbox read options');
  assertExactKeys(
    options,
    ['limit', 'producerId', 'sessionId', 'now'],
    'Outbox read options',
  );
  if (options.producerId !== undefined)
    assertNonEmpty(options.producerId, 'producerId');
  if (options.sessionId !== undefined)
    assertNonEmpty(options.sessionId, 'sessionId');
  if (options.now !== undefined) assertFiniteNumber(options.now, 'now');
}

export function assertOutboxKey(key: OutboxKey): void {
  assertObject(key, 'Outbox key');
  assertExactKeys(key, ['sessionId', 'outboxId'], 'Outbox key');
  assertNonEmpty(key.sessionId, 'outbox key.sessionId');
  assertNonEmpty(key.outboxId, 'outbox key.outboxId');
}

export function assertOutboxKeys(keys: readonly OutboxKey[]): void {
  if (!Array.isArray(keys))
    throw new StorageError('INVALID_ARGUMENT', 'Outbox keys must be an array');
  for (const key of keys) assertOutboxKey(key);
}

export function isTerminalStatus(status: SessionHead['status']): boolean {
  return status === 'completed' || status === 'cancelled';
}

export function sameStart(a: SessionHead, b: SessionHead): boolean {
  return (
    a.startId === b.startId &&
    a.startDigest === b.startDigest &&
    (a.startGeneration ?? 0) === (b.startGeneration ?? 0)
  );
}
