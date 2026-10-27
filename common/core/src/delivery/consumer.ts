import type { InboxEnvelope, InboxStore } from '../inbox/index.js';
import { DeliveryError } from './errors.js';
import { assertLimit, assertObject, assertString } from './invariants.js';
import type {
  ConsumerHandler,
  ConsumerRunFailure,
  ConsumerRunOptions,
  ConsumerRunReport,
  ExternalConsumerHandler,
  RegisteredConsumer,
} from './types.js';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InboxConsumerRunner {
  private readonly consumers = new Map<
    string,
    | { readonly external: false; readonly handler: ConsumerHandler }
    | { readonly external: true; readonly handler: ExternalConsumerHandler }
  >();

  constructor(private readonly inbox: InboxStore) {
    if (!inbox)
      throw new DeliveryError('INVALID_ARGUMENT', 'inbox is required');
  }

  register(consumer: RegisteredConsumer): void;
  register(key: string, handler: ConsumerHandler): void;
  register(
    consumerOrKey: RegisteredConsumer | string,
    maybeHandler?: ConsumerHandler,
  ): void {
    const consumer: RegisteredConsumer =
      typeof consumerOrKey === 'string'
        ? { key: consumerOrKey, handler: maybeHandler as ConsumerHandler }
        : consumerOrKey;
    if (typeof consumerOrKey !== 'string') assertObject(consumer, 'consumer');
    assertString(consumer.key, 'consumer.key');
    if (typeof consumer.handler !== 'function')
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'consumer.handler is required',
      );
    if (this.consumers.has(consumer.key))
      throw new DeliveryError(
        'CONSUMER_ALREADY_REGISTERED',
        `Consumer ${consumer.key} is already registered`,
      );
    this.consumers.set(consumer.key, {
      external: false,
      handler: consumer.handler,
    });
  }

  /**
   * Registers business-idempotent work that must not run while an Inbox
   * database transaction holds a connection. This is at-least-once delivery;
   * the handler owns deduplication for unknown acknowledgements and races.
   */
  registerExternal(key: string, handler: ExternalConsumerHandler): void {
    assertString(key, 'consumer.key');
    if (typeof handler !== 'function')
      throw new DeliveryError(
        'INVALID_ARGUMENT',
        'consumer.handler is required',
      );
    if (this.consumers.has(key))
      throw new DeliveryError(
        'CONSUMER_ALREADY_REGISTERED',
        `Consumer ${key} is already registered`,
      );
    this.consumers.set(key, { external: true, handler });
  }

  unregister(consumerKey: string): boolean {
    assertString(consumerKey, 'consumerKey');
    return this.consumers.delete(consumerKey);
  }

  async runOnce(
    consumerKey: string,
    options: ConsumerRunOptions,
  ): Promise<ConsumerRunReport> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    assertLimit(options.limit);
    const registration = this.consumers.get(consumerKey);
    if (!registration)
      throw new DeliveryError(
        'CONSUMER_NOT_REGISTERED',
        `Consumer ${consumerKey} is not registered`,
      );
    const pending = await this.inbox.listPending(consumerKey, {
      limit: options.limit,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    let processed = 0;
    let duplicates = 0;
    const failures: ConsumerRunFailure[] = [];
    for (const envelope of pending) {
      const receipt = await this.inbox.getReceipt(
        consumerKey,
        envelope.envelopeKey,
      );
      if (receipt?.status === 'completed') {
        duplicates += 1;
        continue;
      }
      if (receipt?.status === 'dead-letter') {
        failures.push({
          envelopeKey: envelope.envelopeKey,
          message: 'Inbox receipt is dead-lettered; explicit retry is required',
        });
        continue;
      }
      try {
        const outcome = registration.external
          ? await this.runExternal(consumerKey, envelope, registration.handler)
          : await this.inbox.transactConsume(
              consumerKey,
              envelope.envelopeKey,
              registration.handler,
            );
        if (outcome.status === 'processed') {
          processed += 1;
        } else if (outcome.status === 'duplicate') {
          duplicates += 1;
        } else {
          failures.push({
            envelopeKey: envelope.envelopeKey,
            message:
              'Inbox receipt became dead-lettered; explicit retry is required',
          });
        }
      } catch (error) {
        failures.push({
          envelopeKey: envelope.envelopeKey,
          message: message(error),
        });
      }
    }
    return {
      consumerKey,
      scanned: pending.length,
      processed,
      duplicates,
      failed: failures.length,
      failures,
    };
  }

  private async runExternal(
    consumerKey: string,
    envelope: InboxEnvelope,
    handler: ExternalConsumerHandler,
  ): Promise<Awaited<ReturnType<InboxStore['transactConsume']>>> {
    let externalSucceeded = false;
    try {
      await handler(structuredClone(envelope));
      externalSucceeded = true;
      return await this.inbox.transactConsume(
        consumerKey,
        envelope.envelopeKey,
        async () => undefined,
      );
    } catch (error) {
      if (!externalSucceeded) {
        try {
          const failureOutcome = await this.inbox.transactConsume(
            consumerKey,
            envelope.envelopeKey,
            async () => {
              throw error;
            },
          );
          if (failureOutcome.status === 'duplicate') return failureOutcome;
        } catch {
          // Preserve the external failure in the run report. The store has
          // recorded retry metadata when its failure transaction succeeded.
        }
      }
      throw error;
    }
  }
}
