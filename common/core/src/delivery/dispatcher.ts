import type { SessionRoute } from '@board-game/contracts';
import { DeliveryError } from './errors.js';
import {
  assertLimit,
  assertRoute,
  copy,
  DEFAULT_MAX_IDENTIFIER_LENGTH,
} from './invariants.js';
import type {
  DispatchFailure,
  DispatchReport,
  FactDelivery,
  OutboxFactDispatcherOptions,
  OutboxFactRecord,
  TrustedSourceIdentity,
} from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outboxFact(record: OutboxFactRecord): FactDelivery['fact'] {
  return {
    producerId: record.producerId,
    eventId: record.outboxId,
    sessionId: record.sessionId,
    kind: record.kind,
    schemaVersion: record.schemaVersion,
    sourceRelease: record.sourceRelease,
    payload: copy(record.payload),
    ...(record.aggregateSequence !== undefined
      ? { aggregateSequence: record.aggregateSequence }
      : {}),
    occurredAt: record.createdAt,
  };
}

export class OutboxFactDispatcher {
  private readonly batchSize: number;
  private readonly now: () => number;

  constructor(private readonly options: OutboxFactDispatcherOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.now = options.now ?? Date.now;
    assertLimit(this.batchSize);
  }

  async dispatchOnce(): Promise<DispatchReport> {
    const now = this.now();
    const records = await this.options.source.readOutboxBatch({
      limit: this.batchSize,
      ...(this.options.producerId
        ? { producerId: this.options.producerId }
        : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      now,
    });
    let delivered = 0;
    const failures: DispatchFailure[] = [];
    for (const record of records) {
      if (record.deliveredAt !== undefined) continue;
      try {
        const head = await this.options.source.getHead(record.sessionId);
        if (!head)
          throw new DeliveryError(
            'ROUTE_MISMATCH',
            `No session head exists for ${record.sessionId}`,
          );
        const route = copy(head.route);
        assertRoute(route, DEFAULT_MAX_IDENTIFIER_LENGTH);
        if (route.sessionId !== record.sessionId)
          throw new DeliveryError(
            'ROUTE_MISMATCH',
            'Session head route does not match the outbox session',
          );
        const source = await this.sourceIdentity(record, route);
        const ack = await this.options.receiver.ingest({
          source,
          route,
          fact: outboxFact(record),
        });
        if (
          ack.eventId !== record.outboxId ||
          ack.producerId !== record.producerId
        )
          throw new DeliveryError(
            'FACT_REJECTED',
            'Fact receiver returned an acknowledgement for a different event',
          );
        const updated = await this.options.source.markOutboxDelivered(
          [{ sessionId: record.sessionId, outboxId: record.outboxId }],
          now,
        );
        if (updated < 1)
          throw new DeliveryError(
            'FACT_REJECTED',
            'Outbox acknowledgement could not mark the source record delivered',
          );
        delivered += updated;
      } catch (error) {
        // A poison/temporarily unavailable source must not occupy every bounded batch.
        const delay = Math.min(
          300_000,
          1_000 * 2 ** Math.min(record.attempts, 9),
        );
        await this.options.source.markOutboxFailed(
          [{ sessionId: record.sessionId, outboxId: record.outboxId }],
          now + delay,
        );
        failures.push({
          sessionId: record.sessionId,
          outboxId: record.outboxId,
          message: errorMessage(error),
        });
      }
    }
    return {
      scanned: records.length,
      delivered,
      failed: failures.length,
      failures,
    };
  }

  private async sourceIdentity(
    record: OutboxFactRecord,
    route: SessionRoute,
  ): Promise<TrustedSourceIdentity> {
    const sourceIdentity = this.options.sourceIdentity;
    if (typeof sourceIdentity === 'function')
      return sourceIdentity(record, route);
    return copy(sourceIdentity);
  }
}
