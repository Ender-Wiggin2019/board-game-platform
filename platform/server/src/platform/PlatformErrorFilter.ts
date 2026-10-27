import {
  type ErrorCode,
  isPlatformError,
  PlatformError,
} from '@board-game/contracts';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  SCHEMA_VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_READY: 503,
  SESSION_SUSPENDED: 409,
  SESSION_CLOSED: 409,
  STALE_REVISION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OWNERSHIP_LOST: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

@Catch(PlatformError)
export class PlatformErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    if (!isPlatformError(error)) throw error;
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
      setHeader(name: string, value: string): void;
    }>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(HTTP_STATUS[error.envelope.code]).json(error.envelope);
  }
}
