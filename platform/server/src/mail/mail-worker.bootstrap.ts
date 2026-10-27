import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DrizzleModule } from '@/persistence/drizzle.module.js';
import { MailModule } from './mail.module.js';
import {
  isDedicatedMailWorkerProcess,
  MailWorkerService,
} from './mail-worker.service.js';

/** Minimal application context for the process that owns mail delivery. */
@Module({
  imports: [DrizzleModule, MailModule],
})
export class MailWorkerBootstrapModule {}

export async function bootstrapMailWorker(): Promise<void> {
  if (!isDedicatedMailWorkerProcess()) {
    throw new Error(
      'Mail worker requires SETI_MAIL_PROCESS_MODE=standalone and the worker process role',
    );
  }

  const app = await NestFactory.createApplicationContext(
    MailWorkerBootstrapModule,
  );
  app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
  Logger.log(
    'SETI mail worker started; PostgreSQL outbox delivery and status reconciliation are enabled',
    MailWorkerService.name,
  );
}
