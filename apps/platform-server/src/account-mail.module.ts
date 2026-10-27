import {
  type IAccountMailOutbox,
  MAIL_OUTBOX_SERVICE,
} from '@board-platform/server/auth/email-proof.js';
import { MailModule } from '@board-platform/server/mail/mail.module.js';
import { MailOutboxService } from '@board-platform/server/mail/mail-outbox.service.js';
import type { TMailTemplateKey } from '@board-platform/server/mail/mail-provider.js';
import type { TMailKind } from '@board-platform/server/persistence/schema/mailOutbox.js';
import { Global, Module } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Binds neutral account challenges to the platform-owned mail outbox. */
@Global()
@Module({
  imports: [MailModule],
  providers: [
    {
      provide: MAIL_OUTBOX_SERVICE,
      inject: [MailOutboxService],
      useFactory: (mail: MailOutboxService): IAccountMailOutbox => ({
        enqueueTemplate: (transaction, input) =>
          mail.enqueueTemplate(
            {
              recipient: input.recipient,
              templateKey: input.templateKey as TMailTemplateKey,
              variables: input.variables,
              kind: input.kind as TMailKind,
              userId: input.userId,
              emailVersion: input.emailVersion,
              challengeId: input.challengeId,
              dedupeKey:
                input.dedupeKey ??
                (input.challengeId
                  ? `auth-challenge:${input.challengeId}`
                  : `auth-mail:${input.kind}`),
              priority: input.priority,
              notBefore: input.notBefore,
              expiresAt: input.expiresAt,
              sensitivePayload: input.sensitivePayload,
            },
            transaction as NodePgDatabase,
          ),
        cancelByDedupeKey: (transaction, dedupeKey, reason) =>
          mail.cancelByDedupeKey(
            dedupeKey,
            reason,
            transaction as NodePgDatabase,
          ),
      }),
    },
  ],
  exports: [MAIL_OUTBOX_SERVICE],
})
export class AccountMailCompositionModule {}
