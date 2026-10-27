export type StorageErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SESSION_NOT_FOUND'
  | 'DUPLICATE_SESSION'
  | 'DUPLICATE_ID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_REVISION'
  | 'STALE_OWNERSHIP'
  | 'TERMINAL_REQUIRED'
  | 'TRANSACTION_CONFLICT'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}
