export type DeliveryErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SOURCE_UNAUTHORIZED'
  | 'ADMISSION_NOT_FOUND'
  | 'ROUTE_MISMATCH'
  | 'FACT_REJECTED'
  | 'CONSUMER_NOT_REGISTERED'
  | 'CONSUMER_ALREADY_REGISTERED';

export class DeliveryError extends Error {
  readonly code: DeliveryErrorCode;
  readonly retryable: boolean;

  constructor(
    code: DeliveryErrorCode,
    message: string,
    retryable = code === 'SOURCE_UNAUTHORIZED' || code === 'FACT_REJECTED',
  ) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function isDeliveryError(value: unknown): value is DeliveryError {
  return value instanceof DeliveryError;
}
