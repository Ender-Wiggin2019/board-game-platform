import { EErrorCode, type IErrorI18n } from '@board-game/contracts';
import { createErrorPayload, GameError, toErrorPayload } from '@board-game/sdk';
import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface IHttpResponse {
  status: (statusCode: number) => {
    json: (payload: unknown) => void;
  };
  getHeader?: (name: string) => unknown;
  setHeader?: (name: string, value: string | number) => void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<IHttpResponse>();
    const { status, payload, retryAfterSeconds } = this.toHttpError(exception);
    if (
      retryAfterSeconds !== undefined &&
      response.getHeader?.('Retry-After') === undefined
    ) {
      response.setHeader?.('Retry-After', retryAfterSeconds);
    }
    response.status(status).json(payload);
  }

  private toHttpError(exception: unknown): {
    status: number;
    payload: ReturnType<typeof toErrorPayload>;
    retryAfterSeconds?: number;
  } {
    if (exception instanceof GameError) {
      return {
        status: statusForCode(exception.code),
        payload: exception.toPayload(),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
        this.logger.error('Unexpected HTTP exception', exception);
        return {
          status,
          payload: createErrorPayload(
            EErrorCode.INTERNAL_SERVER_ERROR,
            'Internal server error',
            undefined,
            { i18n: { key: 'internal_server_error' } },
          ),
          retryAfterSeconds: retryAfterSecondsFromHttpException(status, body),
        };
      }

      const code = codeForHttpStatus(status);
      const i18n = i18nFromHttpException(body);
      return {
        status,
        payload: createErrorPayload(
          code,
          messageFromHttpException(exception, body),
          undefined,
          i18n === undefined ? undefined : { i18n },
        ),
        retryAfterSeconds: retryAfterSecondsFromHttpException(status, body),
      };
    }

    this.logger.error('Unexpected HTTP error', exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      payload: toErrorPayload(exception),
    };
  }
}

function codeForHttpStatus(status: number): EErrorCode {
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return EErrorCode.UNAUTHORIZED;
    case HttpStatus.FORBIDDEN:
      return EErrorCode.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return EErrorCode.GAME_NOT_FOUND;
    default:
      return EErrorCode.VALIDATION_ERROR;
  }
}

function statusForCode(code: EErrorCode): number {
  switch (code) {
    case EErrorCode.UNAUTHORIZED:
      return HttpStatus.UNAUTHORIZED;
    case EErrorCode.FORBIDDEN:
      return HttpStatus.FORBIDDEN;
    case EErrorCode.GAME_NOT_FOUND:
    case EErrorCode.PLAYER_NOT_FOUND:
      return HttpStatus.NOT_FOUND;
    case EErrorCode.REPLAY_UNAVAILABLE:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case EErrorCode.INTERNAL_SERVER_ERROR:
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      return HttpStatus.BAD_REQUEST;
  }
}

function messageFromHttpException(
  exception: HttpException,
  body: unknown = exception.getResponse(),
): string {
  if (typeof body === 'string') {
    return body;
  }

  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return message.join(' ');
    }
    if (typeof message === 'string') {
      return message;
    }
    const code = (body as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code;
    }
  }

  return exception.message;
}

/**
 * Throw sites can attach a structured translation hint by passing an object
 * body: `new BadRequestException({ message, i18n: { key, params } })`. The
 * hint rides the payload as a first-class field; `message` stays plain text.
 */
function i18nFromHttpException(body: unknown): IErrorI18n | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const i18n = (body as { i18n?: unknown }).i18n;
  if (!i18n || typeof i18n !== 'object') {
    return undefined;
  }

  const { key, params } = i18n as { key?: unknown; params?: unknown };
  if (typeof key !== 'string' || key.length === 0) {
    return undefined;
  }

  return {
    key,
    ...(params && typeof params === 'object'
      ? { params: params as IErrorI18n['params'] }
      : {}),
  };
}

function retryAfterSecondsFromHttpException(
  status: number,
  body: unknown,
): number | undefined {
  if (
    status !== HttpStatus.TOO_MANY_REQUESTS &&
    status !== HttpStatus.SERVICE_UNAVAILABLE
  ) {
    return undefined;
  }
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
