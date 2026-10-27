import { createHash } from 'node:crypto';
import {
  assertSessionRoute,
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { EntitlementError } from './errors.js';
import type {
  EntitlementBalance,
  EntitlementBalanceKey,
  EntitlementGrantRequest,
  EntitlementPendingOptions,
  EntitlementReservationInput,
  EntitlementReservationIntent,
  EntitlementReservationReference,
  EntitlementReservationRequest,
} from './types.js';

export const MAX_ENTITLEMENT_BATCH = 1_000;
export const MAX_ENTITLEMENT_STRING_LENGTH = 512;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new EntitlementError('INVALID_ARGUMENT', `${name} must be an object`);
}

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_ENTITLEMENT_STRING_LENGTH
  )
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${MAX_ENTITLEMENT_STRING_LENGTH} characters`,
    );
}

export function assertQuantity(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      `${name} must be a positive safe integer`,
    );
}

export function assertStoredQuantity(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new EntitlementError(
      'DATABASE_ERROR',
      `${name} must be a non-negative safe integer`,
      false,
    );
}

export function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      `${name} must be a finite non-negative timestamp`,
    );
}

export function assertStoredTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new EntitlementError(
      'DATABASE_ERROR',
      `${name} must be a finite non-negative timestamp`,
      false,
    );
}

export function assertRevision(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new EntitlementError(
      'DATABASE_ERROR',
      `${name} must be a non-negative safe integer`,
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
    throw new EntitlementError('INVALID_ARGUMENT', `${name} must be JSON safe`);
  }
}

const ROUTE_KEYS = [
  'gameId',
  'modeId',
  'sessionId',
  'releaseId',
  'backendBindingId',
  'storageBindingId',
  'ownershipEpoch',
] as const;

function assertExactKeys(
  value: object,
  keys: readonly string[],
  name: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      `${name} contains an unsupported field`,
      false,
    );
}

export function validateReservationIntent(
  intent: EntitlementReservationIntent,
  sessionId?: string,
): void {
  assertObject(intent, 'reservation intent');
  assertExactKeys(
    intent,
    ['route', 'commandDigest', 'requirementsDigest'],
    'reservation intent',
  );
  assertObject(intent.route, 'reservation intent route');
  assertExactKeys(intent.route, ROUTE_KEYS, 'reservation intent route');
  try {
    assertSessionRoute(intent.route);
  } catch {
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      'reservation intent route is invalid',
      false,
    );
  }
  if (sessionId !== undefined && intent.route.sessionId !== sessionId)
    throw new EntitlementError(
      'IDEMPOTENCY_CONFLICT',
      'reservation intent route does not match sessionId',
      false,
    );
  assertString(intent.commandDigest, 'intent.commandDigest');
  assertString(intent.requirementsDigest, 'intent.requirementsDigest');
}

export function assertLimit(limit: unknown): asserts limit is number {
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ENTITLEMENT_BATCH
  )
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_ENTITLEMENT_BATCH}`,
    );
}

export function validateGrantRequest(request: EntitlementGrantRequest): void {
  assertObject(request, 'grant request');
  assertString(request.namespace, 'namespace');
  assertString(request.sourceRecordId, 'sourceRecordId');
  assertString(request.principalId, 'principalId');
  assertString(request.asset, 'asset');
  assertQuantity(request.quantity, 'quantity');
  if (request.metadata !== undefined) assertJson(request.metadata, 'metadata');
  if (request.createdAt !== undefined)
    assertTimestamp(request.createdAt, 'createdAt');
}

export function validateBalanceKey(key: EntitlementBalanceKey): void {
  assertObject(key, 'balance key');
  assertString(key.namespace, 'namespace');
  assertString(key.principalId, 'principalId');
  assertString(key.asset, 'asset');
}

export function validateReservationRequest(
  request: EntitlementReservationRequest,
): void {
  validateBalanceKey(request);
  assertString(request.sessionId, 'sessionId');
  assertString(request.commandId, 'commandId');
  assertQuantity(request.quantity, 'quantity');
  validateReservationIntent(request.intent, request.sessionId);
  if (request.reservationId !== undefined)
    assertString(request.reservationId, 'reservationId');
  if (request.createdAt !== undefined)
    assertTimestamp(request.createdAt, 'createdAt');
}

export function validatePendingOptions(
  options: EntitlementPendingOptions,
): void {
  assertObject(options, 'pending options');
  assertLimit(options.limit);
  if (options.namespace !== undefined)
    assertString(options.namespace, 'namespace');
  if (options.principalId !== undefined)
    assertString(options.principalId, 'principalId');
  if (options.asset !== undefined) assertString(options.asset, 'asset');
  if (options.gameId !== undefined) assertString(options.gameId, 'gameId');
  if (options.backendBindingId !== undefined)
    assertString(options.backendBindingId, 'backendBindingId');
  if (options.storageBindingId !== undefined)
    assertString(options.storageBindingId, 'storageBindingId');
}

export function validateReservationInput(
  input: EntitlementReservationInput,
): EntitlementReservationReference {
  if (typeof input === 'string') {
    assertString(input, 'reservationId');
    return { reservationId: input };
  }
  assertObject(input, 'reservation reference');
  assertString(input.reservationId, 'reservationId');
  if (input.namespace !== undefined) assertString(input.namespace, 'namespace');
  if (input.sessionId !== undefined) assertString(input.sessionId, 'sessionId');
  if (input.commandId !== undefined) assertString(input.commandId, 'commandId');
  if (input.principalId !== undefined)
    assertString(input.principalId, 'principalId');
  if (input.asset !== undefined) assertString(input.asset, 'asset');
  if (input.quantity !== undefined) assertQuantity(input.quantity, 'quantity');
  if (input.intentDigest !== undefined)
    assertString(input.intentDigest, 'intentDigest');
  return input;
}

export function grantKey(
  value: Pick<
    EntitlementGrantRequest,
    'namespace' | 'sourceRecordId' | 'principalId' | 'asset'
  >,
): string {
  return JSON.stringify([
    value.namespace,
    value.sourceRecordId,
    value.principalId,
    value.asset,
  ]);
}

export function balanceKey(value: EntitlementBalanceKey): string {
  return JSON.stringify([value.namespace, value.principalId, value.asset]);
}

export function commandKey(value: EntitlementReservationRequest): string {
  return JSON.stringify([value.namespace, value.sessionId, value.commandId]);
}

export function digestOf(value: JsonValue): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

export function grantDigest(request: EntitlementGrantRequest): string {
  return digestOf({
    namespace: request.namespace,
    sourceRecordId: request.sourceRecordId,
    principalId: request.principalId,
    asset: request.asset,
    quantity: request.quantity,
    metadata: request.metadata ?? null,
  });
}

export function grantIdFor(request: EntitlementGrantRequest): string {
  return `grant_${digestOf({
    namespace: request.namespace,
    sourceRecordId: request.sourceRecordId,
    principalId: request.principalId,
    asset: request.asset,
  })}`;
}

export function reservationIdFor(
  request: Pick<
    EntitlementReservationRequest,
    'namespace' | 'sessionId' | 'commandId'
  >,
): string {
  return `reservation_${digestOf({
    namespace: request.namespace,
    sessionId: request.sessionId,
    commandId: request.commandId,
  })}`;
}

export function reservationDigest(
  request: EntitlementReservationRequest,
): string {
  const intentDigest = reservationIntentDigest(request.intent);
  return digestOf({
    namespace: request.namespace,
    sessionId: request.sessionId,
    commandId: request.commandId,
    principalId: request.principalId,
    asset: request.asset,
    quantity: request.quantity,
    intentDigest,
  });
}

export function reservationIntentDigest(
  intent: EntitlementReservationIntent,
): string {
  validateReservationIntent(intent);
  return digestOf({
    route: intent.route as unknown as JsonValue,
    commandDigest: intent.commandDigest,
    requirementsDigest: intent.requirementsDigest,
  });
}

export function buildBalance(
  key: EntitlementBalanceKey,
  granted: number,
  consumed: number,
  reserved: number,
  revision: number,
): EntitlementBalance {
  assertStoredQuantity(granted, 'granted');
  assertStoredQuantity(consumed, 'consumed');
  assertStoredQuantity(reserved, 'reserved');
  assertRevision(revision, 'revision');
  if (consumed + reserved > granted)
    throw new EntitlementError(
      'DATABASE_ERROR',
      'entitlement balance is overcommitted',
      false,
    );
  const available = granted - consumed - reserved;
  assertStoredQuantity(available, 'available');
  return {
    ...key,
    granted,
    consumed,
    reserved,
    available,
    revision,
  };
}

export function assertReferenceMatches(
  reference: EntitlementReservationReference,
  reservation: {
    readonly namespace: string;
    readonly sessionId: string;
    readonly commandId: string;
    readonly principalId: string;
    readonly asset: string;
    readonly quantity: number;
    readonly intentDigest: string;
  },
): void {
  const checks: readonly [
    keyof EntitlementReservationReference,
    unknown,
    unknown,
  ][] = [
    ['namespace', reference.namespace, reservation.namespace],
    ['sessionId', reference.sessionId, reservation.sessionId],
    ['commandId', reference.commandId, reservation.commandId],
    ['principalId', reference.principalId, reservation.principalId],
    ['asset', reference.asset, reservation.asset],
    ['quantity', reference.quantity, reservation.quantity],
    ['intentDigest', reference.intentDigest, reservation.intentDigest],
  ];
  for (const [name, supplied, actual] of checks) {
    if (supplied !== undefined && supplied !== actual)
      throw new EntitlementError(
        'IDEMPOTENCY_CONFLICT',
        `reservation ${String(name)} does not match the stored request`,
        false,
      );
  }
}
