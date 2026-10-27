import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module.js';
import { InviteCodeModule } from '@/invite-codes/invite-code.module.js';
import { AccountSecurityAdminController } from './account-security-admin.controller.js';
import { PlatformAdministrationController } from './platform-administration.controller.js';
import { PlatformPerformanceController } from './platform-performance.controller.js';
import { RuntimeTelemetry } from './RuntimeTelemetry.js';

/** Platform administration is available independently of any game module. */
@Module({
  imports: [AuthModule, InviteCodeModule],
  controllers: [
    PlatformAdministrationController,
    AccountSecurityAdminController,
    PlatformPerformanceController,
  ],
  providers: [
    { provide: RuntimeTelemetry, useFactory: () => new RuntimeTelemetry() },
  ],
})
export class PlatformAdministrationModule {}
