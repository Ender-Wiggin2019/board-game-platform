import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { MailOutboxRepository } from './mail-outbox.repository.js';
import { type MailProvider, MailProviderError } from './mail-provider.js';
import { createMailProvider } from './mail-provider-factory.js';
import { MailSuppressionService } from './mail-suppression.service.js';
import {
  isDedicatedMailWorkerProcess,
  isMailConsumerProcess,
  MAIL_PROVIDER,
} from './mail-worker.service.js';

const RECONCILE_INTERVAL_MS = 60_000;

/** Polls the selected provider so accepted is not mistaken for delivered. */
@Injectable()
export class MailStatusReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailStatusReconciler.name);
  private readonly outbox: MailOutboxRepository;
  private readonly suppression: MailSuppressionService;
  private readonly provider: MailProvider;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeCycle: Promise<number> | undefined;
  private stopping = false;

  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Optional() @Inject(MAIL_PROVIDER) provider?: MailProvider,
  ) {
    this.provider = provider ?? createMailProvider();
    this.outbox = new MailOutboxRepository(db);
    this.suppression = new MailSuppressionService(db);
  }

  public onModuleInit(): void {
    if (
      !isMailConsumerProcess() ||
      process.env.SETI_MAIL_STATUS_RECONCILER_ENABLED !== 'true' ||
      this.timer
    ) {
      return;
    }
    this.stopping = false;
    this.timer = setInterval(() => {
      if (this.activeCycle || this.stopping) return;
      const cycle = this.reconcileOnce();
      this.activeCycle = cycle;
      void cycle
        .catch((error) => {
          this.logger.error(
            `mail status reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          if (this.activeCycle === cycle) this.activeCycle = undefined;
        });
    }, RECONCILE_INTERVAL_MS);
    if (!isDedicatedMailWorkerProcess()) this.timer.unref?.();
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const activeCycle = this.activeCycle;
    if (activeCycle) {
      await activeCycle.catch((error: unknown) => {
        this.logger.warn(
          `mail status reconciliation shutdown drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  public async reconcileOnce(limit = 100): Promise<number> {
    if (
      !isMailConsumerProcess() ||
      this.stopping ||
      process.env.SETI_MAIL_STATUS_RECONCILER_ENABLED !== 'true' ||
      !this.provider.isConfigured()
    ) {
      return 0;
    }
    const jobs = await this.outbox.listForReconciliation(limit);
    let checked = 0;
    for (const job of jobs) {
      try {
        const status = await this.provider.getSendEmailStatus({
          messageId: job.providerMessageId,
          recipient: job.recipient,
          requestDate: job.providerSentAt ?? undefined,
        });
        if (!status) {
          await this.outbox.markDeliveryStatus(
            job.id,
            job.providerMessageId,
            'unknown',
            'provider status not found yet',
          );
          checked += 1;
          continue;
        }
        await this.outbox.markDeliveryStatus(
          job.id,
          job.providerMessageId,
          status.deliveryStatus,
          status.detail,
        );
        if (
          status.deliveryStatus === 'bounced' ||
          status.deliveryStatus === 'complained'
        ) {
          await this.suppression.suppressFromProvider(
            job.recipient,
            status.deliveryStatus,
            this.provider.provider,
          );
        }
        checked += 1;
      } catch (error) {
        if (
          error instanceof MailProviderError &&
          error.disposition === 'unknown'
        ) {
          await this.outbox.markDeliveryStatus(
            job.id,
            job.providerMessageId,
            'unknown',
            error.code,
          );
          checked += 1;
          continue;
        }
        this.logger.warn(
          `could not reconcile mail ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return checked;
  }
}
