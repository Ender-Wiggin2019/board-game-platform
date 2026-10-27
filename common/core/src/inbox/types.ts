import type { JsonValue } from '@board-game/contracts';

/** A consumer is dead-lettered after this many failed attempts. */
export const MAX_INBOX_CONSUMER_ATTEMPTS = 10;

/** The immutable portion of an accepted fact. Arrival time is storage metadata. */
export interface FactEnvelope {
  readonly producerId: string;
  readonly eventId: string;
  readonly sessionId?: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly sourceRelease: string;
  readonly payload: JsonValue;
  readonly aggregateSequence?: number;
  readonly occurredAt?: number;
  readonly receivedAt?: number;
  /** Optional producer digest retained with the fact and checked on retries. */
  readonly digest?: string;
}

export interface InboxEnvelope
  extends Omit<FactEnvelope, 'receivedAt' | 'digest'> {
  readonly envelopeKey: string;
  readonly digest: string;
  readonly receivedAt: number;
}

export interface InboxEffectInput {
  readonly effectId: string;
  readonly payload: JsonValue;
  readonly createdAt?: number;
}

export interface InboxEffectRecord {
  readonly consumerKey: string;
  readonly envelopeKey: string;
  readonly producerId: string;
  readonly eventId: string;
  readonly effectId: string;
  readonly digest: string;
  readonly payload: JsonValue;
  readonly createdAt: number;
}

export type ConsumerReceiptStatus = 'failed' | 'dead-letter' | 'completed';

export interface ConsumerReceipt {
  readonly consumerKey: string;
  readonly envelopeKey: string;
  readonly producerId: string;
  readonly eventId: string;
  readonly status: ConsumerReceiptStatus;
  readonly attempts: number;
  readonly lastAttemptAt: number;
  /** Earliest time a replay runner should retry this failed receipt. */
  readonly nextAttemptAt?: number;
  readonly completedAt?: number;
}

export interface InboxUnitOfWork {
  readonly envelope: InboxEnvelope;
  /**
   * Appends a durable effect to this consumer's ledger. Reusing an effect id
   * with a different payload or envelope is an idempotency conflict.
   */
  appendEffect(effect: InboxEffectInput): Promise<InboxEffectRecord>;
}

export type ConsumeOutcome<Result> =
  | {
      readonly status: 'processed';
      readonly receipt: ConsumerReceipt;
      readonly result: Result;
    }
  | {
      readonly status: 'duplicate';
      readonly receipt: ConsumerReceipt;
    }
  | {
      readonly status: 'dead-letter';
      readonly receipt: ConsumerReceipt;
    };

export interface ListEffectsOptions {
  readonly envelopeKey?: string;
  readonly limit?: number;
}

export interface ListPendingOptions {
  readonly limit: number;
  /** Optional clock override for deterministic replay tests and operators. */
  readonly now?: number;
}

export interface RetryDeadLettersOptions {
  readonly limit: number;
  /** Timestamp assigned to requeued receipts; defaults to the store clock. */
  readonly now?: number;
}

export interface InboxCapabilities {
  readonly durable: boolean;
  readonly serializableTransactions: boolean;
  readonly boundedReads: boolean;
}

export interface InboxStore {
  readonly capabilities: InboxCapabilities;
  /** Idempotently accepts a fact and returns its stable envelope key. */
  accept(envelope: FactEnvelope): Promise<InboxEnvelope>;
  getEnvelope(envelopeKey: string): Promise<InboxEnvelope | null>;
  getReceipt(
    consumerKey: string,
    envelopeKey: string,
  ): Promise<ConsumerReceipt | null>;
  /**
   * Runs a consumer callback in the same transaction as its receipt and
   * durable effect ledger. External side effects in the callback are outside
   * this atomicity boundary. A PostgreSQL callback holds its transaction
   * connection until it resolves; same-pool external ports must therefore use
   * a transaction-bound client or a separate pool to avoid pool exhaustion.
   */
  transactConsume<Result>(
    consumerKey: string,
    envelopeKey: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>>;
  /** Alias for callers that model a delivery as a single consume attempt. */
  consumeOnce<Result>(
    consumerKey: string,
    envelopeKey: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>>;
  listEffects(
    consumerKey: string,
    options?: ListEffectsOptions,
  ): Promise<readonly InboxEffectRecord[]>;
  /** Bounded replay scan; failed facts are returned only once due. */
  listPending(
    consumerKey: string,
    options: ListPendingOptions,
  ): Promise<readonly InboxEnvelope[]>;
  /** Explicitly requeues at most `limit` dead letters for this consumer. */
  retryDeadLetters(
    consumerKey: string,
    options: RetryDeadLettersOptions,
  ): Promise<number>;
  close(): Promise<void>;
}
