export type InboxErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ENVELOPE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class InboxError extends Error {
  readonly code: InboxErrorCode;
  readonly retryable: boolean;

  constructor(
    code: InboxErrorCode,
    message: string,
    retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isInboxError(value: unknown): value is InboxError {
  return value instanceof InboxError;
}
