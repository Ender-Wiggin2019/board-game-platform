import {
  assertJsonPayloadSize,
  assertSessionRoute,
  canonicalStableStringify,
  jsonByteLength,
  type SessionRoute,
} from '@board-game/contracts';
import { DeliveryError } from './errors.js';
import type { FactDelivery, TrustedSourceIdentity } from './types.js';

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
export const DEFAULT_MAX_IDENTIFIER_LENGTH = 256;
export const MAX_BATCH = 1_000;

export function copy<T>(value: T): T {
  return structuredClone(value);
}

export function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DeliveryError('INVALID_ARGUMENT', `${name} must be an object`);
}

export function assertString(
  value: unknown,
  name: string,
  maxLength = DEFAULT_MAX_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    throw new DeliveryError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${maxLength} characters`,
    );
}

export function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new DeliveryError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_BATCH}`,
    );
}

export function assertRoute(route: SessionRoute, maxLength: number): void {
  try {
    assertSessionRoute(route);
  } catch {
    throw new DeliveryError('ROUTE_MISMATCH', 'Fact route is invalid');
  }
  for (const [key, value] of Object.entries(route))
    assertString(value, `route.${key}`, maxLength);
}

export function assertSource(
  source: TrustedSourceIdentity,
  route: SessionRoute,
  maxLength: number,
): void {
  assertObject(source, 'source');
  assertString(source.gameId, 'source.gameId', maxLength);
  assertString(source.releaseId, 'source.releaseId', maxLength);
  assertString(source.backendBindingId, 'source.backendBindingId', maxLength);
  assertString(source.ownershipEpoch, 'source.ownershipEpoch', maxLength);
  if (
    source.gameId !== route.gameId ||
    source.releaseId !== route.releaseId ||
    source.backendBindingId !== route.backendBindingId ||
    source.ownershipEpoch !== route.ownershipEpoch
  )
    throw new DeliveryError(
      'SOURCE_UNAUTHORIZED',
      'Authenticated source does not match the frozen session route',
    );
}

export function assertDeliveryShape(
  delivery: FactDelivery,
  maxPayloadBytes: number,
  maxIdentifierLength: number,
  allowedKinds: ReadonlySet<string>,
): void {
  assertObject(delivery, 'delivery');
  assertRoute(delivery.route, maxIdentifierLength);
  assertSource(delivery.source, delivery.route, maxIdentifierLength);
  assertObject(delivery.fact, 'fact');
  assertString(
    delivery.fact.producerId,
    'fact.producerId',
    maxIdentifierLength,
  );
  assertString(delivery.fact.eventId, 'fact.eventId', maxIdentifierLength);
  assertString(delivery.fact.kind, 'fact.kind', maxIdentifierLength);
  if (!allowedKinds.has(delivery.fact.kind))
    throw new DeliveryError(
      'FACT_REJECTED',
      `Fact kind ${delivery.fact.kind} is not allowed for this ingress`,
    );
  if (delivery.fact.sessionId !== undefined)
    assertString(
      delivery.fact.sessionId,
      'fact.sessionId',
      maxIdentifierLength,
    );
  assertString(
    delivery.fact.sourceRelease,
    'fact.sourceRelease',
    maxIdentifierLength,
  );
  if (delivery.fact.sessionId !== delivery.route.sessionId)
    throw new DeliveryError(
      'ROUTE_MISMATCH',
      'Fact sessionId does not match the frozen session route',
    );
  if (delivery.fact.sourceRelease !== delivery.route.releaseId)
    throw new DeliveryError(
      'ROUTE_MISMATCH',
      'Fact sourceRelease does not match the frozen session route',
    );
  const expectedProducer = `game:${delivery.route.gameId}:session:${delivery.route.sessionId}`;
  if (delivery.fact.producerId !== expectedProducer)
    throw new DeliveryError(
      'ROUTE_MISMATCH',
      'Fact producerId does not match the frozen session route',
    );
  try {
    assertJsonPayloadSize(delivery.fact.payload, maxPayloadBytes);
    jsonByteLength(delivery.fact.payload);
  } catch {
    throw new DeliveryError(
      'FACT_REJECTED',
      'Fact payload exceeds the configured JSON limit or is not JSON safe',
    );
  }
}

export function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}
