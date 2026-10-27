export type AwardErrorCode =
  | 'INVALID_ARGUMENT'
  | 'AWARD_NOT_FOUND'
  | 'REWARD_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MIGRATION_REQUIRED'
  | 'DATABASE_ERROR';

export class AwardError extends Error {
  readonly code: AwardErrorCode;
  readonly retryable: boolean;

  constructor(
    code: AwardErrorCode,
    message: string,
    retryable = code === 'DATABASE_ERROR',
  ) {
    super(message);
    this.name = 'AwardError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isAwardError(value: unknown): value is AwardError {
  return value instanceof AwardError;
}
