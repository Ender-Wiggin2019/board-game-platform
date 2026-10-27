import type { JsonValue, SessionRoute } from '@board-game/contracts';
import type { AdmissionStore } from '../admission/types.js';
import type {
  FactEnvelope,
  InboxEnvelope,
  InboxStore,
  InboxUnitOfWork,
} from '../inbox/index.js';

/** Structural subset of @board-game/storage.OutboxRecord. */
export interface OutboxFactRecord {
  readonly outboxId: string;
  readonly sessionId: string;
  readonly producerId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly sourceRelease: string;
  readonly payload: JsonValue;
  readonly aggregateSequence?: number;
  readonly createdAt: number;
  readonly deliveredAt?: number;
  readonly attempts: number;
  readonly nextAttemptAt?: number;
}

export interface OutboxReadOptions {
  readonly limit: number;
  readonly producerId?: string;
  readonly sessionId?: string;
  readonly now?: number;
}

export interface OutboxDeliveryKey {
  readonly sessionId: string;
  readonly outboxId: string;
}

export interface HeadRouteSource {
  readonly route: SessionRoute;
}

/** Structural subset of StorageDriver needed by outbox delivery. */
export interface OutboxSource {
  readOutboxBatch(
    options: OutboxReadOptions,
  ): Promise<readonly OutboxFactRecord[]>;
  markOutboxDelivered(
    keys: readonly OutboxDeliveryKey[],
    deliveredAt?: number,
  ): Promise<number>;
  markOutboxFailed(
    keys: readonly OutboxDeliveryKey[],
    nextAttemptAt: number,
  ): Promise<number>;
  getHead(sessionId: string): Promise<HeadRouteSource | null>;
}

/** Authenticated server-side source identity; browser input is never used here. */
export interface TrustedSourceIdentity {
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly ownershipEpoch: string;
}

export interface FactDelivery {
  readonly source: TrustedSourceIdentity;
  readonly route: SessionRoute;
  readonly fact: FactEnvelope;
}

export interface FactDeliveryAck {
  readonly envelopeKey: string;
  readonly producerId: string;
  readonly eventId: string;
  readonly digest: string;
}

export type SourceAuthorizationResult =
  | boolean
  | void
  | Promise<boolean | void>;

export interface TrustedFactIngestorOptions {
  readonly inbox: InboxStore;
  readonly admission: Pick<AdmissionStore, 'getAdmission'>;
  /** Rechecks server-side source registration and ownership. */
  readonly authorizeSource: (
    source: TrustedSourceIdentity,
    route: SessionRoute,
  ) => SourceAuthorizationResult;
  readonly allowedKinds: ReadonlySet<string> | readonly string[];
  readonly maxPayloadBytes?: number;
  readonly maxIdentifierLength?: number;
}

export interface OutboxFactDispatcherOptions {
  readonly source: OutboxSource;
  readonly receiver: TrustedFactIngestorLike;
  /** Supplied by the trusted transport/server caller, never read from a browser payload. */
  readonly sourceIdentity:
    | TrustedSourceIdentity
    | ((
        record: OutboxFactRecord,
        route: SessionRoute,
      ) => TrustedSourceIdentity | Promise<TrustedSourceIdentity>);
  readonly batchSize?: number;
  readonly producerId?: string;
  readonly sessionId?: string;
  readonly now?: () => number;
}

export interface TrustedFactIngestorLike {
  ingest(delivery: FactDelivery): Promise<FactDeliveryAck>;
}

export interface DispatchFailure {
  readonly sessionId: string;
  readonly outboxId: string;
  readonly message: string;
}

export interface DispatchReport {
  readonly scanned: number;
  readonly delivered: number;
  readonly failed: number;
  readonly failures: readonly DispatchFailure[];
}

export type ConsumerHandler = (unitOfWork: InboxUnitOfWork) => Promise<unknown>;

/**
 * Business-idempotent external work. The runner invokes this outside the
 * Inbox database transaction, then records a receipt in a separate empty
 * transaction. It is at-least-once delivery, never external exactly-once.
 */
export type ExternalConsumerHandler = (
  envelope: InboxEnvelope,
) => Promise<void>;

export interface ConsumerRunOptions {
  readonly limit: number;
  /** Optional clock override for deterministic retry/replay scheduling. */
  readonly now?: number;
}

export interface ConsumerRunFailure {
  readonly envelopeKey: string;
  readonly message: string;
}

export interface ConsumerRunReport {
  readonly consumerKey: string;
  readonly scanned: number;
  readonly processed: number;
  readonly duplicates: number;
  readonly failed: number;
  readonly failures: readonly ConsumerRunFailure[];
}

export interface RegisteredConsumer {
  readonly key: string;
  readonly handler: ConsumerHandler;
  readonly external?: false;
}

export interface RegisteredExternalConsumer {
  readonly key: string;
  readonly handler: ExternalConsumerHandler;
  readonly external: true;
}
