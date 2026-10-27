import { ECapability } from '@board-platform/contracts/auth/permissions';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { MailOpsService } from './mail-ops.service.js';

@Controller('admin/mail')
@UseGuards(RolesGuard)
@Capabilities(ECapability.ANALYTICS_READ)
export class MailOpsController {
  public constructor(
    @Inject(MailOpsService) private readonly ops: MailOpsService,
  ) {}

  @Get('status')
  public async status(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return this.ops.getStatus(50);
    }
    return this.ops.getStatus(parsed);
  }

  @Get('suppressions')
  public async suppressions(@Query('limit') limit?: string) {
    const parsed = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return this.ops.listSuppressions(100);
    }
    return this.ops.listSuppressions(parsed);
  }
}
