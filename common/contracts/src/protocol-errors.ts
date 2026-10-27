/** Stable error codes shared by HTTP, socket, and game adapters. */
export enum EErrorCode {
  CONNECTION_ERROR = 'CONNECTION_ERROR',
  SERVER_BUSY = 'SERVER_BUSY',
  PROTOCOL_UPGRADE_REQUIRED = 'PROTOCOL_UPGRADE_REQUIRED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  GAME_NOT_FOUND = 'GAME_NOT_FOUND',
  PLAYER_NOT_FOUND = 'PLAYER_NOT_FOUND',
  INVALID_PHASE = 'INVALID_PHASE',
  NOT_YOUR_TURN = 'NOT_YOUR_TURN',
  INVALID_ACTION = 'INVALID_ACTION',
  INVALID_FREE_ACTION = 'INVALID_FREE_ACTION',
  INVALID_INPUT_RESPONSE = 'INVALID_INPUT_RESPONSE',
  STALE_INPUT_RESPONSE = 'STALE_INPUT_RESPONSE',
  REPLAY_UNAVAILABLE = 'REPLAY_UNAVAILABLE',
  INSUFFICIENT_RESOURCES = 'INSUFFICIENT_RESOURCES',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
}

export enum EErrorSeverity {
  SILENT = 'silent',
  WARNING = 'warning',
  ERROR = 'error',
  BLOCKING = 'blocking',
}

export enum EErrorCategory {
  AUTH = 'auth',
  BUSINESS = 'business',
  SYSTEM = 'system',
  TRANSPORT = 'transport',
  VALIDATION = 'validation',
}

export enum EErrorDisplay {
  NONE = 'none',
  TOAST = 'toast',
  BLOCKING = 'blocking',
}

export enum EErrorResponsibility {
  PLAYER_ACTION = 'player_action',
  AUTHORIZATION = 'authorization',
  CONNECTION = 'connection',
  SYSTEM = 'system',
}

export interface IErrorClassification {
  category: EErrorCategory;
  display: EErrorDisplay;
  responsibility: EErrorResponsibility;
  retryable: boolean;
  severity: EErrorSeverity;
}

/** Structured translation hint attached to an error at its throw site. */
export interface IErrorI18n {
  key: string;
  params?: Record<string, string | number>;
}

export interface IErrorPayload {
  code: EErrorCode;
  /** Plain human-readable fallback text; never machine-encoded. */
  message: string;
  i18n?: IErrorI18n;
  details?: Record<string, unknown>;
  category?: EErrorCategory;
  display?: EErrorDisplay;
  responsibility?: EErrorResponsibility;
  retryable?: boolean;
  severity?: EErrorSeverity;
  /** Correlates a mutation rejection with the originating client request. */
  requestId?: string;
  gameId?: string;
}

export type TNormalizedErrorPayload = IErrorPayload &
  Required<IErrorClassification>;

export function classifyErrorCode(code: EErrorCode): IErrorClassification {
  switch (code) {
    case EErrorCode.CONNECTION_ERROR:
      return {
        category: EErrorCategory.TRANSPORT,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.CONNECTION,
        retryable: true,
        severity: EErrorSeverity.BLOCKING,
      };

    case EErrorCode.SERVER_BUSY:
      return {
        category: EErrorCategory.SYSTEM,
        display: EErrorDisplay.TOAST,
        responsibility: EErrorResponsibility.CONNECTION,
        retryable: true,
        severity: EErrorSeverity.WARNING,
      };

    case EErrorCode.PROTOCOL_UPGRADE_REQUIRED:
      return {
        category: EErrorCategory.TRANSPORT,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.CONNECTION,
        retryable: false,
        severity: EErrorSeverity.BLOCKING,
      };

    case EErrorCode.STALE_INPUT_RESPONSE:
      return {
        category: EErrorCategory.TRANSPORT,
        display: EErrorDisplay.NONE,
        responsibility: EErrorResponsibility.CONNECTION,
        retryable: false,
        severity: EErrorSeverity.SILENT,
      };

    case EErrorCode.INVALID_PHASE:
    case EErrorCode.NOT_YOUR_TURN:
    case EErrorCode.INVALID_ACTION:
    case EErrorCode.INVALID_FREE_ACTION:
    case EErrorCode.INVALID_INPUT_RESPONSE:
    case EErrorCode.INSUFFICIENT_RESOURCES:
      return {
        category: EErrorCategory.BUSINESS,
        display: EErrorDisplay.TOAST,
        responsibility: EErrorResponsibility.PLAYER_ACTION,
        retryable: true,
        severity: EErrorSeverity.WARNING,
      };

    case EErrorCode.VALIDATION_ERROR:
      return {
        category: EErrorCategory.VALIDATION,
        display: EErrorDisplay.TOAST,
        responsibility: EErrorResponsibility.PLAYER_ACTION,
        retryable: true,
        severity: EErrorSeverity.WARNING,
      };

    case EErrorCode.UNAUTHORIZED:
    case EErrorCode.FORBIDDEN:
      return {
        category: EErrorCategory.AUTH,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.AUTHORIZATION,
        retryable: false,
        severity: EErrorSeverity.BLOCKING,
      };

    case EErrorCode.GAME_NOT_FOUND:
    case EErrorCode.PLAYER_NOT_FOUND:
      return {
        category: EErrorCategory.BUSINESS,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.PLAYER_ACTION,
        retryable: false,
        severity: EErrorSeverity.BLOCKING,
      };

    case EErrorCode.INTERNAL_SERVER_ERROR:
      return {
        category: EErrorCategory.SYSTEM,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.SYSTEM,
        retryable: true,
        severity: EErrorSeverity.BLOCKING,
      };

    case EErrorCode.REPLAY_UNAVAILABLE:
      return {
        category: EErrorCategory.SYSTEM,
        display: EErrorDisplay.BLOCKING,
        responsibility: EErrorResponsibility.SYSTEM,
        retryable: false,
        severity: EErrorSeverity.BLOCKING,
      };
  }
}

export function normalizeErrorPayload(
  payload: IErrorPayload,
): TNormalizedErrorPayload {
  const defaults = classifyErrorCode(payload.code);
  return {
    ...payload,
    category: payload.category ?? defaults.category,
    display: payload.display ?? defaults.display,
    responsibility: payload.responsibility ?? defaults.responsibility,
    retryable: payload.retryable ?? defaults.retryable,
    severity: payload.severity ?? defaults.severity,
  };
}
