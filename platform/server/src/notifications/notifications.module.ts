import { Module } from '@nestjs/common';
import { MailModule } from '@/mail/mail.module.js';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

@Module({
  imports: [MailModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class NotificationsModule {}
