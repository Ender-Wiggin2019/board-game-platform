import {
  EErrorCode,
  type IErrorClassification,
  type IErrorI18n,
  normalizeErrorPayload,
  type TNormalizedErrorPayload,
} from '@board-game/contracts';

type TGameErrorOptions = Partial<IErrorClassification> & {
  i18n?: IErrorI18n;
};

export class GameError extends Error {
  public readonly code: EErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly i18n?: IErrorI18n;
  public readonly category: IErrorClassification['category'];
  public readonly display: IErrorClassification['display'];
  public readonly responsibility: IErrorClassification['responsibility'];
  public readonly retryable: IErrorClassification['retryable'];
  public readonly severity: IErrorClassification['severity'];

  public constructor(
    code: EErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: TGameErrorOptions,
  ) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.details = details;
    this.i18n = options?.i18n;
    const normalized = normalizeErrorPayload({
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...options,
    });
    this.category = normalized.category;
    this.display = normalized.display;
    this.responsibility = normalized.responsibility;
    this.retryable = normalized.retryable;
    this.severity = normalized.severity;
  }

  public toPayload(): TNormalizedErrorPayload {
    return normalizeErrorPayload({
      code: this.code,
      message: this.message,
      ...(this.i18n === undefined ? {} : { i18n: this.i18n }),
      ...(this.details === undefined ? {} : { details: this.details }),
      category: this.category,
      display: this.display,
      responsibility: this.responsibility,
      retryable: this.retryable,
      severity: this.severity,
    });
  }
}

export function createErrorPayload(
  code: EErrorCode,
  message: string,
  details?: Record<string, unknown>,
  options?: TGameErrorOptions,
): TNormalizedErrorPayload {
  return normalizeErrorPayload({
    code,
    message,
    ...(details === undefined ? {} : { details }),
    ...options,
  });
}

export function toErrorPayload(error: unknown): TNormalizedErrorPayload {
  if (error instanceof GameError) return error.toPayload();

  return createErrorPayload(
    EErrorCode.INTERNAL_SERVER_ERROR,
    'Internal server error',
    undefined,
    { i18n: { key: 'internal_server_error' } },
  );
}
