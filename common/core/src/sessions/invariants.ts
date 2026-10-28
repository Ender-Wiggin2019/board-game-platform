import {
  assertJsonPayloadSize,
  assertSessionRoute,
  canonicalStableStringify,
  contractError,
  DEFAULT_JSON_LIMITS,
  isCommandPrecondition,
  isJsonValue,
  type JsonValue,
  MAX_EVENT_READ_LIMIT,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  CommandInput,
  EventsInput,
  PlatformIdentityReference,
  QueryInput,
  ResolvedIdentity,
  ResumeInput,
  StatusInput,
} from './types.js';

const MAX_IDENTIFIER_LENGTH = 256;

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function invalid(messageKey: string): never {
  throw contractError('INVALID_REQUEST', messageKey);
}

export function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH
  )
    invalid(`platform.gateway.${field}.invalid`);
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`platform.gateway.${field}.invalid`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)))
    invalid(`platform.gateway.${field}.fields`);
}

export function assertIdentityReference(
  value: unknown,
): asserts value is PlatformIdentityReference {
  const reference = requireObject(value, 'identity');
  requireExactKeys(
    reference,
    ['principalId', 'authSessionId', 'seatId'],
    'identity',
  );
  requireIdentifier(reference.principalId, 'identity.principalId');
  requireIdentifier(reference.authSessionId, 'identity.authSessionId');
  if (reference.seatId !== undefined)
    requireIdentifier(reference.seatId, 'identity.seatId');
}

export function assertResolvedIdentity(
  value: unknown,
): asserts value is ResolvedIdentity {
  const identity = requireObject(value, 'resolvedIdentity');
  requireIdentifier(identity.principalId, 'resolvedIdentity.principalId');
  requireIdentifier(identity.authEpoch, 'resolvedIdentity.authEpoch');
  if (identity.authSessionId !== undefined)
    requireIdentifier(identity.authSessionId, 'resolvedIdentity.authSessionId');
  if (typeof identity.active !== 'boolean')
    invalid('platform.gateway.resolvedIdentity.active');
}

export function assertRoute(value: unknown): asserts value is SessionRoute {
  try {
    assertSessionRoute(value);
  } catch {
    throw contractError(
      'OWNERSHIP_LOST',
      'platform.gateway.route.invalid',
      false,
    );
  }
}

export function assertCommandInput<Command extends JsonValue>(
  value: unknown,
): asserts value is CommandInput<Command> {
  const input = requireObject(value, 'command');
  requireExactKeys(input, ['commandId', 'precondition', 'command'], 'command');
  requireIdentifier(input.commandId, 'command.commandId');
  if (!isCommandPrecondition(input.precondition))
    invalid('platform.gateway.command.precondition');
  if (!isJsonValue(input.command)) invalid('platform.gateway.command.payload');
  assertJsonPayloadSize(
    input.command,
    DEFAULT_JSON_LIMITS.commandBytes,
    'command',
  );
}

export function assertQueryInput<Query extends JsonValue>(
  value: unknown,
): asserts value is QueryInput<Query> {
  const input = requireObject(value, 'query');
  requireExactKeys(input, ['revision', 'query'], 'query');
  if (
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0
  )
    invalid('platform.gateway.query.revision');
  if (!isJsonValue(input.query)) invalid('platform.gateway.query.payload');
  assertJsonPayloadSize(input.query, DEFAULT_JSON_LIMITS.queryBytes, 'query');
}

export function assertEventsInput(
  value: unknown,
): asserts value is EventsInput {
  const input = requireObject(value, 'events');
  requireExactKeys(input, ['afterSequence', 'limit', 'viewEpoch'], 'events');
  if (
    typeof input.afterSequence !== 'number' ||
    !Number.isSafeInteger(input.afterSequence) ||
    input.afterSequence < 0
  )
    invalid('platform.gateway.events.sequence');
  if (
    typeof input.limit !== 'number' ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_EVENT_READ_LIMIT
  )
    invalid('platform.gateway.events.limit');
  if (input.viewEpoch !== undefined)
    requireIdentifier(input.viewEpoch, 'events.viewEpoch');
}

export function assertResumeInput(
  value: unknown,
): asserts value is ResumeInput {
  const input = requireObject(value, 'resume');
  requireExactKeys(input, ['viewerEpoch', 'streamCursor'], 'resume');
  if (input.viewerEpoch !== undefined)
    requireIdentifier(input.viewerEpoch, 'resume.viewerEpoch');
  if (input.streamCursor !== undefined)
    requireIdentifier(input.streamCursor, 'resume.streamCursor');
}

export function assertStatusInput(
  value: unknown,
): asserts value is StatusInput {
  const input = requireObject(value, 'status');
  requireExactKeys(input, ['startId', 'commandId'], 'status');
  if (input.startId !== undefined)
    requireIdentifier(input.startId, 'status.startId');
  if (input.commandId !== undefined)
    requireIdentifier(input.commandId, 'status.commandId');
}

export function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}

export function assertPartialRoute(
  value: unknown,
  expected: SessionRoute,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw contractError('OWNERSHIP_LOST', 'platform.gateway.response.route');
  const candidate = value as Record<string, unknown>;
  if (Object.hasOwn(candidate, 'route')) {
    assertExactRoute(candidate.route, expected);
  }
  if (
    candidate.gameId !== expected.gameId ||
    candidate.sessionId !== expected.sessionId ||
    candidate.releaseId !== expected.releaseId
  )
    throw contractError('OWNERSHIP_LOST', 'platform.gateway.response.route');
}

export function assertExactRoute(value: unknown, expected: SessionRoute): void {
  assertRoute(value);
  if (!sameRoute(value, expected))
    throw contractError('OWNERSHIP_LOST', 'platform.gateway.response.route');
}
