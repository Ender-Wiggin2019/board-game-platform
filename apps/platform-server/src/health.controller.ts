import { Public } from '@board-platform/server/auth/public.decorator.js';
import {
  Controller,
  Get,
  HttpStatus,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StandaloneFactIngressLifecycle,
  StandaloneReadiness,
} from './standalone-runtime.js';

interface ResponseStatus {
  status(code: number): unknown;
}

@Controller()
@Public()
export class HealthController {
  constructor(
    private readonly readiness: StandaloneReadiness,
    private readonly factIngress: StandaloneFactIngressLifecycle,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok' as const };
  }

  @Get('health/live')
  live() {
    return { status: 'ok' as const };
  }

  @Get('health/ready')
  ready(@Res({ passthrough: true }) response: ResponseStatus) {
    const snapshot = this.readiness.current;
    const factIngress = this.factIngress.status;
    if (!snapshot.completed) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      throw new ServiceUnavailableException(
        'platform is restoring registry state',
      );
    }
    if (factIngress.lastError) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return {
        status: 'unavailable' as const,
        restoredBindings: snapshot.restoredBindings,
        factIngress,
      };
    }
    return {
      status: 'ok' as const,
      restoredBindings: snapshot.restoredBindings,
      factIngress,
    };
  }
}
