import { Module } from '@nestjs/common';
import { AccountExtensionsModule } from '@/auth/account-extensions.module.js';
import { InviteCodeService } from './invite-code.service.js';

@Module({
  imports: [AccountExtensionsModule],
  providers: [InviteCodeService],
  exports: [InviteCodeService],
})
export class InviteCodeModule {}
