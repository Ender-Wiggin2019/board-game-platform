import { Global, Module } from '@nestjs/common';
import { MailForegroundPresenceService } from './mail-foreground-presence.service.js';
import { MailGamePolicyRegistry } from './mail-game-policies.js';
import { MailOnlinePresenceService } from './mail-online-presence.service.js';
import { MailOpsController } from './mail-ops.controller.js';
import { MailOpsService } from './mail-ops.service.js';
import { MailOutboxService } from './mail-outbox.service.js';
import { createMailProvider } from './mail-provider-factory.js';
import { MailStatusReconciler } from './mail-status-reconciler.js';
import { MailSuppressionService } from './mail-suppression.service.js';
import { MailUnsubscribeController } from './mail-unsubscribe.controller.js';
import { MailUnsubscribeTokenService } from './mail-unsubscribe.service.js';
import {
  isMailConsumerProcess,
  MAIL_PROVIDER,
  MailWorkerService,
} from './mail-worker.service.js';

// In standalone mode the HTTP graph still needs enqueueing and preference
// services, but it must not construct either consumer. The dedicated entry
// point sets the worker role before loading this module.
const MAIL_CONSUMER_PROVIDERS = isMailConsumerProcess()
  ? [
      { provide: MAIL_PROVIDER, useFactory: createMailProvider },
      MailWorkerService,
      MailStatusReconciler,
    ]
  : [];

@Global()
@Module({
  controllers: [MailOpsController, MailUnsubscribeController],
  providers: [
    MailGamePolicyRegistry,
    MailForegroundPresenceService,
    MailOnlinePresenceService,
    MailOutboxService,
    MailOpsService,
    MailSuppressionService,
    {
      provide: MailUnsubscribeTokenService,
      useFactory: () => new MailUnsubscribeTokenService(),
    },
    ...MAIL_CONSUMER_PROVIDERS,
  ],
  exports: [
    MailGamePolicyRegistry,
    MailForegroundPresenceService,
    MailOnlinePresenceService,
    MailOutboxService,
    MailOpsService,
    MailSuppressionService,
    MailUnsubscribeTokenService,
    ...MAIL_CONSUMER_PROVIDERS,
  ],
})
export class MailModule {}
