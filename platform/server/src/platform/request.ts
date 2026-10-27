import { assertJsonPayloadSize, contractError } from '@board-game/contracts';
import type { IPrincipal } from '../auth/jwt-auth.guard.js';

export type PlatformRequest = {
  user: IPrincipal;
  query?: { readonly seatId?: unknown };
};

export function reference(request: PlatformRequest) {
  if (!request.user?.sub || !request.user.sid)
    throw contractError('UNAUTHENTICATED', 'platform.identity.required');
  return { principalId: request.user.sub, authSessionId: request.user.sid };
}

/** Selection is not authority; the session gateway binds it to the account. */
export function sessionReference(request: PlatformRequest) {
  const identity = reference(request);
  const seatId = request.query?.seatId;
  return seatId === undefined
    ? identity
    : { ...identity, seatId: text(seatId) };
}

export function input(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  assertJsonPayloadSize(value, 64 * 1024);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw contractError('INVALID_REQUEST', 'platform.request.invalid');
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256)
    throw contractError('INVALID_REQUEST', 'platform.request.identifier');
  return value;
}

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw contractError('INVALID_REQUEST', 'platform.request.revision');
  return value as number;
}

export function pageLimit(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value))
    throw contractError('INVALID_REQUEST', 'platform.request.limit');
  const limit = Number(value);
  if (limit > 100)
    throw contractError('INVALID_REQUEST', 'platform.request.limit');
  return limit;
}
