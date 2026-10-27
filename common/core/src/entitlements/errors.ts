export type EntitlementErrorCode =
  | 'INVALID_ARGUMENT'
  | 'GRANT_NOT_FOUND'
  | 'RESERVATION_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSUFFICIENT_BALANCE'
  | 'RESERVATION_TERMINAL'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class EntitlementError extends Error {
  readonly code: EntitlementErrorCode;
  readonly retryable: boolean;

  constructor(
    code: EntitlementErrorCode,
    message: string,
    retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isEntitlementError(value: unknown): value is EntitlementError {
  return value instanceof EntitlementError;
}
