import { ECapability } from '@board-platform/contracts/auth/permissions';
import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { RuntimeTelemetry } from './RuntimeTelemetry.js';

@Controller('platform/admin/performance')
@UseGuards(RolesGuard)
@Capabilities(ECapability.ANALYTICS_READ)
export class PlatformPerformanceController {
  public constructor(
    @Inject(RuntimeTelemetry) private readonly telemetry: RuntimeTelemetry,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  public read() {
    return this.telemetry.snapshot();
  }
}
