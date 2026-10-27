import type { MatchAdmission, SessionRoute } from '@board-game/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  InboxConsumerRunner,
  OutboxFactDispatcher,
  type OutboxFactRecord,
  type OutboxSource,
  TrustedFactIngestor,
  type TrustedSourceIdentity,
} from '../src/delivery/index.js';
import { MemoryInboxStore } from '../src/inbox/memory.js';
import { PostgresInboxStore } from '../src/inbox/postgres.js';
import type { FactEnvelope, InboxStore } from '../src/inbox/types.js';

const route: SessionRoute = {
  gameId: 'seti',
  modeId: 'ranked',
  sessionId: 'session-1',
  releaseId: 'release-1',
  backendBindingId: 'backend-1',
  storageBindingId: 'storage-1',
  ownershipEpoch: 'epoch-1',
};

const source: TrustedSourceIdentity = {
  gameId: route.gameId,
  releaseId: route.releaseId,
  backendBindingId: route.backendBindingId,
  ownershipEpoch: route.ownershipEpoch,
};

function admissionFor(admissionRoute = route): MatchAdmission {
  return {
    id: 'admission-1',
    route: admissionRoute,
    participants: [
      { principalId: 'player-1', seatId: 'seat-1' },
      { principalId: 'player-2', seatId: 'seat-2' },
    ],
    visibility: 'private',
    rating: null,
    validityPolicyVersion: 'policy-1',
    createdAt: 1,
  };
}

function fact(eventId = 'event-1'): FactEnvelope {
  return {
    producerId: `game:${route.gameId}:session:${route.sessionId}`,
    eventId,
    sessionId: route.sessionId,
    kind: 'ranked.match.completed',
    schemaVersion: 1,
    sourceRelease: route.releaseId,
    payload: { eventId },
    aggregateSequence: 1,
    occurredAt: 10,
    receivedAt: 20,
  };
}

function outbox(eventId = 'event-1'): OutboxFactRecord {
  return {
    outboxId: eventId,
    sessionId: route.sessionId,
    producerId: `game:${route.gameId}:session:${route.sessionId}`,
    kind: 'ranked.match.completed',
    schemaVersion: 1,
    sourceRelease: route.releaseId,
    payload: { eventId },
    aggregateSequence: 1,
    createdAt: 10,
    attempts: 0,
  };
}

class FakeOutboxSource implements OutboxSource {
  readonly records: OutboxFactRecord[];
  delivered = new Set<string>();

  constructor(records: readonly OutboxFactRecord[]) {
    this.records = records.map((record) => structuredClone(record));
  }

  async readOutboxBatch(options: {
    readonly limit: number;
    readonly producerId?: string;
    readonly sessionId?: string;
    readonly now?: number;
  }): Promise<readonly OutboxFactRecord[]> {
    return this.records
      .filter(
        (record) =>
          !record.deliveredAt &&
          !this.delivered.has(record.outboxId) &&
          (options.producerId === undefined ||
            options.producerId === record.producerId) &&
          (options.sessionId === undefined ||
            options.sessionId === record.sessionId) &&
          (options.now === undefined ||
            record.nextAttemptAt === undefined ||
            record.nextAttemptAt <= options.now),
      )
      .slice(0, options.limit)
      .map((record) => structuredClone(record));
  }

  async markOutboxDelivered(
    keys: readonly { readonly sessionId: string; readonly outboxId: string }[],
    deliveredAt = 100,
  ): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const record = this.records.find(
        (candidate) =>
          candidate.sessionId === key.sessionId &&
          candidate.outboxId === key.outboxId,
      );
      if (record && !record.deliveredAt) {
        Object.assign(record, { deliveredAt, attempts: record.attempts + 1 });
        this.delivered.add(record.outboxId);
        count += 1;
      }
    }
    return count;
  }

  async markOutboxFailed(
    keys: readonly { sessionId: string; outboxId: string }[],
    nextAttemptAt: number,
  ) {
    let count = 0;
    for (const key of keys) {
      const record = this.records.find(
        (row) =>
          row.sessionId === key.sessionId && row.outboxId === key.outboxId,
      );
      if (record && record.deliveredAt === undefined) {
        Object.assign(record, { nextAttemptAt, attempts: record.attempts + 1 });
        count += 1;
      }
    }
    return count;
  }

  async getHead(sessionId: string): Promise<{ route: SessionRoute } | null> {
    return sessionId === route.sessionId ? { route } : null;
  }
}

function ingestorFor(
  inbox: InboxStore,
  admissionRoute = route,
  authorizeSource: (
    sourceIdentity: TrustedSourceIdentity,
    frozenRoute: SessionRoute,
  ) => boolean | void | Promise<boolean | void> = () => true,
): TrustedFactIngestor {
  return new TrustedFactIngestor({
    inbox,
    admission: {
      getAdmission: async () => admissionFor(admissionRoute),
    },
    authorizeSource,
    allowedKinds: ['ranked.match.completed'],
  });
}

async function exerciseReplay(store: InboxStore): Promise<void> {
  const inbox = store;
  const first = await inbox.accept({ ...fact('replay-1'), receivedAt: 10 });
  const second = await inbox.accept(fact('replay-2'));
  await expect(
    inbox.transactConsume(
      'consumer-a',
      first.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'consumer-a:replay-1',
          payload: { eventId: first.eventId },
        });
        throw new Error('consumer unavailable');
      },
    ),
  ).rejects.toThrow('consumer unavailable');

  const failedReceipt = await inbox.getReceipt('consumer-a', first.envelopeKey);
  expect(failedReceipt).toMatchObject({ status: 'failed', attempts: 1 });
  const retryAt = failedReceipt?.nextAttemptAt;
  expect(retryAt).toBeTypeOf('number');
  if (retryAt === undefined) throw new Error('retryAt was not persisted');
  expect(
    (
      await inbox.listPending('consumer-a', {
        limit: 1,
        now: retryAt,
      })
    ).map((envelope) => envelope.eventId),
  ).toEqual(['replay-1']);

  const runner = new InboxConsumerRunner(inbox);
  runner.register('consumer-a', async (unitOfWork) => {
    await unitOfWork.appendEffect({
      effectId: `consumer-a:${unitOfWork.envelope.eventId}`,
      payload: { delivered: true },
    });
  });
  const report = await runner.runOnce('consumer-a', {
    limit: 10,
    now: retryAt,
  });
  expect(report).toMatchObject({
    scanned: 2,
    processed: 2,
    failed: 0,
  });

  const secondRunner = new InboxConsumerRunner(inbox);
  secondRunner.register('consumer-b', async (unitOfWork) => {
    await unitOfWork.appendEffect({
      effectId: `consumer-b:${unitOfWork.envelope.eventId}`,
      payload: { independent: true },
    });
  });
  const independent = await secondRunner.runOnce('consumer-b', { limit: 10 });
  expect(independent).toMatchObject({
    scanned: 2,
    processed: 2,
    failed: 0,
  });
  expect(await inbox.listEffects('consumer-a')).toHaveLength(2);
  expect(await inbox.listEffects('consumer-b')).toHaveLength(2);

  // Keep the second fact referenced so this helper proves both pending rows
  // were replayed after the runner was reconstructed.
  expect(await inbox.getEnvelope(second.envelopeKey)).not.toBeNull();
}

describe('trusted outbox delivery', () => {
  it('durably accepts before acknowledging and retries when the ack is lost', async () => {
    const inbox = new MemoryInboxStore();
    const ingestor = ingestorFor(inbox);
    const sourceStore = new FakeOutboxSource([outbox()]);
    let receiverCalls = 0;
    let now = 100;
    const receiver = {
      ingest: async (delivery: Parameters<typeof ingestor.ingest>[0]) => {
        receiverCalls += 1;
        const acknowledgment = await ingestor.ingest(delivery);
        if (receiverCalls === 1) throw new Error('ack lost in transit');
        return acknowledgment;
      },
    };
    const dispatcher = new OutboxFactDispatcher({
      source: sourceStore,
      receiver,
      sourceIdentity: source,
      now: () => now,
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      scanned: 1,
      delivered: 0,
      failed: 1,
    });
    expect(sourceStore.delivered).toEqual(new Set());
    expect(await inbox.listPending('consumer-a', { limit: 10 })).toHaveLength(
      1,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      scanned: 0,
    });
    now += 1_000;
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      scanned: 1,
      delivered: 1,
      failed: 0,
    });
    expect(sourceStore.delivered).toEqual(new Set(['event-1']));
    expect(await inbox.listPending('consumer-a', { limit: 10 })).toHaveLength(
      1,
    );
    expect(receiverCalls).toBe(2);
  });

  it('rejects a source whose game or ownership epoch does not match the route', async () => {
    const inbox = new MemoryInboxStore();
    const ingestor = ingestorFor(inbox);
    for (const invalidSource of [
      { ...source, gameId: 'other-game' },
      { ...source, ownershipEpoch: 'stale-epoch' },
    ]) {
      await expect(
        ingestor.ingest({
          source: invalidSource,
          route,
          fact: fact('rejected'),
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_UNAUTHORIZED' });
    }
    expect(await inbox.listPending('consumer-a', { limit: 10 })).toEqual([]);
  });

  it('rejects a route that is not the persisted match admission', async () => {
    const inbox = new MemoryInboxStore();
    const ingestor = ingestorFor(inbox, {
      ...route,
      releaseId: 'other-release',
    });
    await expect(
      ingestor.ingest({ source, route, fact: fact('wrong-admission') }),
    ).rejects.toMatchObject({ code: 'ROUTE_MISMATCH' });
    expect(await inbox.listPending('consumer-a', { limit: 10 })).toEqual([]);
  });

  it('authorizes the source before reading the persisted admission', async () => {
    const inbox = new MemoryInboxStore();
    let admissionReads = 0;
    const ingestor = new TrustedFactIngestor({
      inbox,
      admission: {
        getAdmission: async () => {
          admissionReads += 1;
          return admissionFor();
        },
      },
      authorizeSource: async () => false,
      allowedKinds: ['ranked.match.completed'],
    });

    await expect(
      ingestor.ingest({ source, route, fact: fact('unauthorized') }),
    ).rejects.toMatchObject({ code: 'SOURCE_UNAUTHORIZED' });
    expect(admissionReads).toBe(0);
    expect(await inbox.listPending('consumer-a', { limit: 10 })).toEqual([]);
  });
});

describe('recoverable inbox consumers', () => {
  it('replays failed and never-attempted facts with independent consumer progress', async () => {
    await exerciseReplay(new MemoryInboxStore());
  });

  it('does not run stale dead letters and reports a dead-letter race as failed', async () => {
    const store = new MemoryInboxStore({ now: () => 100 });
    const accepted = await store.accept(fact('dead-letter-runner'));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(
        store.transactConsume(
          'dead-letter-consumer',
          accepted.envelopeKey,
          async () => {
            throw new Error('poison');
          },
        ),
      ).rejects.toThrow('poison');
    }
    const deadReceipt = await store.getReceipt(
      'dead-letter-consumer',
      accepted.envelopeKey,
    );
    if (!deadReceipt) throw new Error('expected dead-letter receipt');

    vi.spyOn(store, 'listPending').mockResolvedValue([accepted]);
    const receiptSpy = vi
      .spyOn(store, 'getReceipt')
      .mockResolvedValue(deadReceipt);
    const externalHandler = vi.fn(async () => undefined);
    const externalRunner = new InboxConsumerRunner(store);
    externalRunner.registerExternal('dead-letter-consumer', externalHandler);
    await expect(
      externalRunner.runOnce('dead-letter-consumer', { limit: 1, now: 100 }),
    ).resolves.toMatchObject({
      scanned: 1,
      processed: 0,
      duplicates: 0,
      failed: 1,
    });
    expect(externalHandler).not.toHaveBeenCalled();

    receiptSpy.mockResolvedValue(null);
    const internalHandler = vi.fn(async () => undefined);
    const internalRunner = new InboxConsumerRunner(store);
    internalRunner.register('dead-letter-consumer', internalHandler);
    await expect(
      internalRunner.runOnce('dead-letter-consumer', { limit: 1, now: 100 }),
    ).resolves.toMatchObject({
      scanned: 1,
      processed: 0,
      duplicates: 0,
      failed: 1,
    });
    expect(internalHandler).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('runs external work outside the inbox transaction and deduplicates concurrent business effects', async () => {
    let now = 100;
    const inbox = new MemoryInboxStore({ now: () => now });
    await inbox.accept(fact('external-concurrent'));
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const businessEffects = new Set<string>();
    let handlerCalls = 0;
    const runner = new InboxConsumerRunner(inbox);
    runner.registerExternal('external-consumer', async (envelope) => {
      handlerCalls += 1;
      started += 1;
      if (started === 2) release();
      await gate;
      businessEffects.add(envelope.eventId);
    });

    const first = runner.runOnce('external-consumer', { limit: 1, now });
    const second = runner.runOnce('external-consumer', { limit: 1, now });
    const reports = await Promise.all([first, second]);
    expect(handlerCalls).toBe(2);
    expect(businessEffects).toEqual(new Set(['external-concurrent']));
    expect(reports.map((report) => report.processed).sort()).toEqual([0, 1]);
    expect(reports.map((report) => report.duplicates).sort()).toEqual([0, 1]);
    expect(reports.every((report) => report.failed === 0)).toBe(true);
    now = 1_000;
  });

  it('replays an external operation after an unknown receipt acknowledgement', async () => {
    const store = new MemoryInboxStore();
    await store.accept(fact('external-ack-loss'));
    let dropReceipt = true;
    const inbox: InboxStore = {
      capabilities: store.capabilities,
      accept: store.accept.bind(store),
      getEnvelope: store.getEnvelope.bind(store),
      getReceipt: store.getReceipt.bind(store),
      transactConsume: async (consumerKey, envelopeKey, callback) => {
        if (dropReceipt) {
          dropReceipt = false;
          throw new Error('ack lost');
        }
        return store.transactConsume(consumerKey, envelopeKey, callback);
      },
      consumeOnce: store.consumeOnce.bind(store),
      listEffects: store.listEffects.bind(store),
      listPending: store.listPending.bind(store),
      retryDeadLetters: store.retryDeadLetters.bind(store),
      close: store.close.bind(store),
    };
    const effects = new Set<string>();
    const runner = new InboxConsumerRunner(inbox);
    runner.registerExternal('external-ack', async (envelope) => {
      effects.add(envelope.eventId);
    });
    await expect(
      runner.runOnce('external-ack', { limit: 1 }),
    ).resolves.toMatchObject({ scanned: 1, processed: 0, failed: 1 });
    await expect(
      runner.runOnce('external-ack', { limit: 1 }),
    ).resolves.toMatchObject({ scanned: 1, processed: 1, failed: 0 });
    expect(effects).toEqual(new Set(['external-ack-loss']));
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const schema = `bgp_core_delivery_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
const describePostgres = databaseUrl ? describe : describe.skip;
let postgres: PostgresInboxStore | undefined;
let postgresNow = Date.now();

describePostgres('Postgres delivery durability', () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
    postgres = new PostgresInboxStore({
      connectionString: databaseUrl,
      schema,
      now: () => postgresNow,
    });
    await postgres.migrate();
  });

  afterAll(async () => {
    await postgres?.close();
    if (!databaseUrl) return;
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  it('replays a failed receipt after a store restart', async () => {
    if (!databaseUrl || !postgres)
      throw new Error('Postgres store unavailable');
    const accepted = await postgres.accept(fact('pg-replay'));
    await expect(
      postgres.transactConsume(
        'pg-consumer',
        accepted.envelopeKey,
        async () => {
          throw new Error('pg consumer unavailable');
        },
      ),
    ).rejects.toThrow('pg consumer unavailable');
    const failedReceipt = await postgres.getReceipt(
      'pg-consumer',
      accepted.envelopeKey,
    );
    const retryAt = failedReceipt?.nextAttemptAt;
    expect(retryAt).toBeTypeOf('number');
    if (retryAt === undefined) throw new Error('retryAt was not persisted');
    await postgres.close();
    postgres = new PostgresInboxStore({
      connectionString: databaseUrl,
      schema,
      now: () => postgresNow,
    });
    const pending = await postgres.listPending('pg-consumer', {
      limit: 10,
      now: retryAt,
    });
    expect(pending.map((envelope) => envelope.eventId)).toEqual(['pg-replay']);
    const runner = new InboxConsumerRunner(postgres);
    runner.register('pg-consumer', async (unitOfWork) => {
      await unitOfWork.appendEffect({
        effectId: 'pg-consumer:pg-replay',
        payload: { replayed: true },
      });
    });
    await expect(
      runner.runOnce('pg-consumer', { limit: 10, now: retryAt }),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
  });

  it('runs a same-pool external port with a max-one PostgreSQL pool', async () => {
    if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
    const externalSchema = `bgp_ext_${process.pid}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const inbox = new PostgresInboxStore({ pool, schema: externalSchema });
    try {
      await inbox.migrate();
      await inbox.accept(fact('external-pg'));
      const failed = await inbox.accept(fact('external-pg-failure'));
      let businessCalls = 0;
      const runner = new InboxConsumerRunner(inbox);
      runner.registerExternal('external-pg', async (envelope) => {
        await pool.query('SELECT 1');
        if (envelope.eventId === failed.eventId)
          throw new Error('same-pool external failure');
        businessCalls += 1;
      });
      await expect(
        runner.runOnce('external-pg', { limit: 1 }),
      ).resolves.toMatchObject({ processed: 1, failed: 0 });
      expect(businessCalls).toBe(1);
      expect(
        await inbox.getReceipt(
          'external-pg',
          (await inbox.accept(fact('external-pg'))).envelopeKey,
        ),
      ).toMatchObject({ status: 'completed' });
      await expect(
        runner.runOnce('external-pg', { limit: 1 }),
      ).resolves.toMatchObject({ processed: 0, failed: 1 });
      expect(
        await inbox.getReceipt('external-pg', failed.envelopeKey),
      ).toMatchObject({ status: 'failed', attempts: 1 });
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${externalSchema}" CASCADE`);
      await pool.end();
    }
  });
});
