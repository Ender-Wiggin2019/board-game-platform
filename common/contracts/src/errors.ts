import type { JsonValue } from './json.js';

/** Stable categories that callers can handle without parsing human text. */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'SCHEMA_VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_READY',
  'SESSION_SUSPENDED',
  'SESSION_CLOSED',
  'STALE_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'OWNERSHIP_LOST',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface ErrorEnvelope {
  readonly code: ErrorCode;
  /** A localization key or stable diagnostic key; never a secret-bearing message. */
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: JsonValue;
}

export class PlatformError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(envelope.messageKey);
    this.name = 'PlatformError';
    this.envelope = envelope;
  }
}

export function isPlatformError(error: unknown): error is PlatformError {
  return error instanceof PlatformError;
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isPlatformError(error)) return error.envelope;

  return {
    code: 'INTERNAL',
    messageKey: 'platform.error.internal',
    retryable: false,
  };
}

export function contractError(
  code: ErrorCode,
  messageKey: string,
  retryable = false,
  details?: JsonValue,
): PlatformError {
  return new PlatformError({ code, messageKey, retryable, details });
}
