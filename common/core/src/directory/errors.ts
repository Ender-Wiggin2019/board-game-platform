export type DirectoryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ADMISSION_NOT_FOUND'
  | 'FACT_CONFLICT'
  | 'ROUTE_MISMATCH'
  | 'SCHEMA_MISMATCH'
  | 'DATABASE_ERROR'
  | 'MIGRATION_REQUIRED';

export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;
  readonly retryable: boolean;

  constructor(
    code: DirectoryErrorCode,
    message: string,
    retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
    this.name = 'DirectoryError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isDirectoryError(value: unknown): value is DirectoryError {
  return value instanceof DirectoryError;
}
