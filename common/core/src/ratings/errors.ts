export type RatingErrorCode =
  | 'INVALID_ARGUMENT'
  | 'ADMISSION_NOT_FOUND'
  | 'RATING_NOT_ENABLED'
  | 'POLICY_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CORRECTION_UNSUPPORTED'
  | 'INVALID_POLICY_OUTPUT'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class RatingError extends Error {
  readonly code: RatingErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RatingErrorCode,
    message: string,
    retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
    this.name = 'RatingError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isRatingError(value: unknown): value is RatingError {
  return value instanceof RatingError;
}
