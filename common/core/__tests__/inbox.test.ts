import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxConsumerRunner } from '../src/delivery/consumer.js';
import { InboxError } from '../src/inbox/errors.js';
import { MAX_INBOX_CONSUMER_ATTEMPTS } from '../src/inbox/index.js';
import { MemoryInboxStore } from '../src/inbox/memory.js';
import { PostgresInboxStore } from '../src/inbox/postgres.js';
import type {
  FactEnvelope,
  InboxStore,
  InboxUnitOfWork,
} from '../src/inbox/types.js';

function fact(
  eventId = 'event-1',
  payload: Record<string, unknown> = { score: 1 },
): FactEnvelope {
  return {
    producerId: 'game-host',
    eventId,
    sessionId: 'session-1',
    kind: 'ranked.match.completed',
    schemaVersion: 1,
    sourceRelease: 'release-1',
    payload: payload as FactEnvelope['payload'],
    aggregateSequence: 1,
    occurredAt: 10,
    receivedAt: 20,
  };
}

async function exerciseCore(store: InboxStore): Promise<void> {
  const accepted = await store.accept(fact());
  expect(accepted.envelopeKey).toBeTruthy();
  expect(await store.getEnvelope(accepted.envelopeKey)).toEqual(accepted);

  const result = await store.transactConsume(
    'leaderboard',
    accepted.envelopeKey,
    async (unitOfWork) => {
      expect(unitOfWork.envelope).toEqual(accepted);
      return (
        await unitOfWork.appendEffect({
          effectId: 'ranked-score:event-1',
          payload: { playerId: 'player-1', score: 1 },
          createdAt: 30,
        })
      ).effectId;
    },
  );
  expect(result).toMatchObject({
    status: 'processed',
    result: 'ranked-score:event-1',
  });
  expect(await store.listEffects('leaderboard')).toHaveLength(1);

  const duplicate = await store.transactConsume(
    'leaderboard',
    accepted.envelopeKey,
    async () => {
      throw new Error('completed facts must not invoke the callback');
    },
  );
  expect(duplicate.status).toBe('duplicate');
  expect(
    await store.getReceipt('leaderboard', accepted.envelopeKey),
  ).toMatchObject({
    status: 'completed',
    attempts: 1,
  });
}

describe('MemoryInboxStore', () => {
  it('deduplicates facts by producer/event and keeps clone isolation', async () => {
    const store = new MemoryInboxStore({ now: () => 100 });
    const payload = { score: 1 };
    const first = await store.accept(fact('event-dedupe', payload));
    payload.score = 99;
    expect((await store.getEnvelope(first.envelopeKey))?.payload).toEqual({
      score: 1,
    });
    const duplicate = await store.accept(fact('event-dedupe', { score: 1 }));
    expect(duplicate).toEqual(first);
    await expect(
      store.accept(fact('event-dedupe', { score: 2 })),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const suppliedDigest = await store.accept({
      ...fact('event-supplied-digest'),
      digest: 'producer-digest-1',
    });
    expect(suppliedDigest.digest).toBe('producer-digest-1');
    await expect(
      store.accept({
        ...fact('event-supplied-digest', { score: 2 }),
        digest: 'producer-digest-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rolls back effects on callback failure and persists retry attempts', async () => {
    const store = new MemoryInboxStore({ now: () => 100 });
    const accepted = await store.accept(fact('event-retry'));
    await expect(
      store.transactConsume(
        'consumer',
        accepted.envelopeKey,
        async (unitOfWork) => {
          await unitOfWork.appendEffect({
            effectId: 'effect-1',
            payload: { value: 1 },
          });
          throw new Error('consumer failed');
        },
      ),
    ).rejects.toThrow('consumer failed');
    expect(await store.listEffects('consumer')).toEqual([]);
    expect(
      await store.getReceipt('consumer', accepted.envelopeKey),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
    });

    await store.transactConsume(
      'consumer',
      accepted.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'effect-1',
          payload: { value: 1 },
        });
        return true;
      },
    );
    expect(
      await store.getReceipt('consumer', accepted.envelopeKey),
    ).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
    expect(await store.listEffects('consumer')).toHaveLength(1);
  });

  it('isolates consumer progress and serializes concurrent redelivery', async () => {
    const store = new MemoryInboxStore();
    const accepted = await store.accept(fact('event-concurrent'));
    let callbackCalls = 0;
    const consume = (consumerKey: string) =>
      store.transactConsume(
        consumerKey,
        accepted.envelopeKey,
        async (unitOfWork) => {
          callbackCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 0));
          await unitOfWork.appendEffect({
            effectId: `${consumerKey}:effect`,
            payload: { ok: true },
          });
          return consumerKey;
        },
      );
    const [first, second] = await Promise.all([
      consume('consumer-a'),
      consume('consumer-a'),
    ]);
    expect(callbackCalls).toBe(1);
    expect([first.status, second.status].sort()).toEqual([
      'duplicate',
      'processed',
    ]);
    await store.transactConsume(
      'consumer-b',
      accepted.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'consumer-b:effect',
          payload: { ok: true },
        });
        return undefined;
      },
    );
    expect(
      await store.getReceipt('consumer-b', accepted.envelopeKey),
    ).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
  });

  it('rejects malformed envelopes, effects, and leaked unit-of-work handles', async () => {
    const store = new MemoryInboxStore();
    await expect(
      store.accept({ ...fact('bad-schema'), schemaVersion: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      store.accept({ ...fact('bad-time'), occurredAt: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const accepted = await store.accept(fact('leak'));
    let leaked: InboxUnitOfWork | undefined;
    await store.transactConsume(
      'consumer',
      accepted.envelopeKey,
      async (unitOfWork) => {
        leaked = unitOfWork;
        return undefined;
      },
    );
    await expect(
      leaked?.appendEffect({ effectId: 'late', payload: {} }),
    ).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
  });

  it('backs off a poison head while allowing later facts and other consumers to progress', async () => {
    let now = 1_000;
    const store = new MemoryInboxStore({ now: () => now });
    const poison = await store.accept(fact('event-poison'));
    const healthy = await store.accept(fact('event-healthy'));

    const poisonRunner = new InboxConsumerRunner(store);
    poisonRunner.register('consumer-a', async (unitOfWork) => {
      if (unitOfWork.envelope.eventId === poison.eventId)
        throw new Error('poison');
      await unitOfWork.appendEffect({
        effectId: `consumer-a:${unitOfWork.envelope.eventId}`,
        payload: { ok: true },
      });
    });
    await expect(
      poisonRunner.runOnce('consumer-a', { limit: 2, now }),
    ).resolves.toMatchObject({ scanned: 2, processed: 1, failed: 1 });
    expect(await store.listPending('consumer-a', { limit: 2, now })).toEqual(
      [],
    );
    expect(
      await store.getReceipt('consumer-a', healthy.envelopeKey),
    ).toMatchObject({ status: 'completed' });

    const otherRunner = new InboxConsumerRunner(store);
    otherRunner.register('consumer-b', async (unitOfWork) => {
      await unitOfWork.appendEffect({
        effectId: `consumer-b:${unitOfWork.envelope.eventId}`,
        payload: { independent: true },
      });
    });
    await expect(
      otherRunner.runOnce('consumer-b', { limit: 2, now }),
    ).resolves.toMatchObject({ scanned: 2, processed: 2, failed: 0 });

    now = 2_000;
    await expect(
      poisonRunner.runOnce('consumer-a', { limit: 2, now }),
    ).resolves.toMatchObject({ scanned: 1, processed: 0, failed: 1 });
    expect(
      await store.getReceipt('consumer-a', poison.envelopeKey),
    ).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('dead-letters after the fixed threshold and only retries by explicit bounded requeue', async () => {
    const store = new MemoryInboxStore({ now: () => 1_000 });
    const first = await store.accept(fact('event-dead-letter-first'));
    const second = await store.accept(fact('event-dead-letter-second'));
    let callbackCalls = 0;
    const fail = async (): Promise<void> => {
      callbackCalls += 1;
      throw new Error('poison');
    };

    for (const envelope of [first, second]) {
      for (
        let attempt = 0;
        attempt < MAX_INBOX_CONSUMER_ATTEMPTS;
        attempt += 1
      ) {
        await expect(
          store.transactConsume(
            'dead-letter-consumer',
            envelope.envelopeKey,
            fail,
          ),
        ).rejects.toThrow('poison');
      }
    }

    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS * 2);
    expect(
      await store.getReceipt('dead-letter-consumer', first.envelopeKey),
    ).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_INBOX_CONSUMER_ATTEMPTS,
    });
    expect(
      await store.listPending('dead-letter-consumer', {
        limit: 10,
        now: 1_000,
      }),
    ).toEqual([]);

    const direct = await store.consumeOnce(
      'dead-letter-consumer',
      first.envelopeKey,
      async () => {
        callbackCalls += 1;
        return 'must-not-run';
      },
    );
    expect(direct.status).toBe('dead-letter');
    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS * 2);

    expect(
      await store.retryDeadLetters('dead-letter-consumer', {
        limit: 1,
        now: 2_000,
      }),
    ).toBe(1);
    const pending = await store.listPending('dead-letter-consumer', {
      limit: 10,
      now: 2_000,
    });
    expect(pending).toHaveLength(1);
    const pendingEnvelope = pending[0];
    if (!pendingEnvelope) throw new Error('expected a requeued envelope');
    expect(
      await store.getReceipt(
        'dead-letter-consumer',
        pendingEnvelope.envelopeKey,
      ),
    ).toMatchObject({
      status: 'failed',
      attempts: MAX_INBOX_CONSUMER_ATTEMPTS,
      nextAttemptAt: 2_000,
    });

    await expect(
      store.transactConsume(
        'dead-letter-consumer',
        pendingEnvelope.envelopeKey,
        async () => {
          callbackCalls += 1;
          throw new Error('poison again');
        },
      ),
    ).rejects.toThrow('poison again');
    expect(
      await store.getReceipt(
        'dead-letter-consumer',
        pendingEnvelope.envelopeKey,
      ),
    ).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_INBOX_CONSUMER_ATTEMPTS + 1,
    });
    expect(
      await store.retryDeadLetters('dead-letter-consumer', {
        limit: 1,
        now: 3_000,
      }),
    ).toBe(1);

    const processed = await store.transactConsume(
      'dead-letter-consumer',
      pendingEnvelope.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'dead-letter-effect',
          payload: { recovered: true },
        });
        return 'recovered';
      },
    );
    expect(processed).toMatchObject({
      status: 'processed',
      result: 'recovered',
    });
    const duplicate = await store.transactConsume(
      'dead-letter-consumer',
      pendingEnvelope.envelopeKey,
      async () => {
        callbackCalls += 1;
        return 'must-not-run';
      },
    );
    expect(duplicate.status).toBe('duplicate');
    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS * 2 + 1);
    expect(
      await store.retryDeadLetters('dead-letter-consumer', { limit: 10 }),
    ).toBe(1);
  });
});

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const schema = `bgp_core_inbox_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
const describePostgres = databaseUrl ? describe : describe.skip;
let postgres: PostgresInboxStore;
let postgresNow = Date.now();

describePostgres('PostgresInboxStore', () => {
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
    await postgres.close();
    if (!databaseUrl) return;
    const cleanup = new Pool({ connectionString: databaseUrl });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  it('survives restart with durable facts, receipts, and effects', async () => {
    await exerciseCore(postgres);
    await postgres.close();
    if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
    postgres = new PostgresInboxStore({
      connectionString: databaseUrl,
      schema,
      now: () => postgresNow,
    });
    expect(
      (
        await postgres.getEnvelope(
          (
            await postgres.accept(fact('event-restart'))
          ).envelopeKey,
        )
      )?.eventId,
    ).toBe('event-restart');
    expect(
      await postgres.getReceipt(
        'leaderboard',
        (
          await postgres.getEnvelope(
            (
              await postgres.accept(fact())
            ).envelopeKey,
          )
        )?.envelopeKey ?? '',
      ),
    ).toMatchObject({ status: 'completed' });
  });

  it('rolls back durable effects and retries after a failed callback', async () => {
    const accepted = await postgres.accept(fact('event-pg-retry'));
    await expect(
      postgres.transactConsume(
        'pg-consumer',
        accepted.envelopeKey,
        async (unitOfWork) => {
          await unitOfWork.appendEffect({
            effectId: 'effect-pg',
            payload: { value: 1 },
          });
          throw new Error('postgres consumer failed');
        },
      ),
    ).rejects.toThrow('postgres consumer failed');
    expect(await postgres.listEffects('pg-consumer')).toEqual([]);
    expect(
      await postgres.getReceipt('pg-consumer', accepted.envelopeKey),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    await postgres.transactConsume(
      'pg-consumer',
      accepted.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'effect-pg',
          payload: { value: 1 },
        });
        return true;
      },
    );
    expect(await postgres.listEffects('pg-consumer')).toHaveLength(1);
  });

  it('serializes concurrent processing for one consumer and allows another consumer', async () => {
    const accepted = await postgres.accept(fact('event-pg-concurrent'));
    let calls = 0;
    const consume = () =>
      postgres.transactConsume(
        'pg-concurrent',
        accepted.envelopeKey,
        async (unitOfWork) => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await unitOfWork.appendEffect({
            effectId: 'effect-pg-concurrent',
            payload: { ok: true },
          });
          return true;
        },
      );
    const [first, second] = await Promise.all([consume(), consume()]);
    expect(calls).toBe(1);
    expect([first.status, second.status].sort()).toEqual([
      'duplicate',
      'processed',
    ]);
    await postgres.transactConsume(
      'pg-other-consumer',
      accepted.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'effect-pg-other',
          payload: { ok: true },
        });
        return true;
      },
    );
    expect(
      await postgres.getReceipt('pg-other-consumer', accepted.envelopeKey),
    ).toMatchObject({ status: 'completed' });
  });

  it('backs off a poison head while allowing later facts and other consumers to progress', async () => {
    if (!databaseUrl || !postgres)
      throw new Error('Postgres store unavailable');
    postgresNow = 10_000;
    const drainExisting = async (consumerKey: string) => {
      const existing = await postgres.listPending(consumerKey, {
        limit: 1_000,
        now: postgresNow,
      });
      for (const envelope of existing) {
        await postgres.transactConsume(
          consumerKey,
          envelope.envelopeKey,
          async (unitOfWork) => {
            await unitOfWork.appendEffect({
              effectId: `bootstrap:${consumerKey}:${envelope.eventId}`,
              payload: { bootstrap: true },
            });
          },
        );
      }
    };
    await drainExisting('pg-poison-a');
    await drainExisting('pg-poison-b');
    const poison = await postgres.accept(fact('00-pg-event-poison'));
    const healthy = await postgres.accept(fact('01-pg-event-healthy'));
    const poisonRunner = new InboxConsumerRunner(postgres);
    const seen: string[] = [];
    poisonRunner.register('pg-poison-a', async (unitOfWork) => {
      seen.push(unitOfWork.envelope.eventId);
      if (unitOfWork.envelope.eventId === poison.eventId)
        throw new Error('pg poison');
      await unitOfWork.appendEffect({
        effectId: `pg-poison-a:${unitOfWork.envelope.eventId}`,
        payload: { ok: true },
      });
    });
    const firstReport = await poisonRunner.runOnce('pg-poison-a', {
      limit: 2,
      now: postgresNow,
    });
    expect(firstReport).toMatchObject({
      scanned: 2,
      processed: 1,
      failed: 1,
    });
    expect(seen).toEqual(expect.arrayContaining([poison.eventId]));
    expect(
      await postgres.listPending('pg-poison-a', {
        limit: 2,
        now: postgresNow,
      }),
    ).toEqual([]);
    expect(
      await postgres.getReceipt('pg-poison-a', healthy.envelopeKey),
    ).toMatchObject({ status: 'completed' });

    const otherRunner = new InboxConsumerRunner(postgres);
    otherRunner.register('pg-poison-b', async (unitOfWork) => {
      await unitOfWork.appendEffect({
        effectId: `pg-poison-b:${unitOfWork.envelope.eventId}`,
        payload: { independent: true },
      });
    });
    await expect(
      otherRunner.runOnce('pg-poison-b', { limit: 2, now: postgresNow }),
    ).resolves.toMatchObject({ scanned: 2, processed: 2, failed: 0 });

    postgresNow = 11_000;
    await expect(
      poisonRunner.runOnce('pg-poison-a', { limit: 2, now: postgresNow }),
    ).resolves.toMatchObject({ scanned: 1, processed: 0, failed: 1 });
    expect(
      await postgres.getReceipt('pg-poison-a', poison.envelopeKey),
    ).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('dead-letters and explicitly requeues durable receipts without rerunning completed effects', async () => {
    if (!databaseUrl || !postgres)
      throw new Error('Postgres store unavailable');
    postgresNow = 20_000;
    const consumerKey = 'pg-dead-letter-consumer';
    const accepted = await postgres.accept(fact('pg-event-dead-letter'));
    let callbackCalls = 0;
    for (let attempt = 0; attempt < MAX_INBOX_CONSUMER_ATTEMPTS; attempt += 1) {
      await expect(
        postgres.transactConsume(
          consumerKey,
          accepted.envelopeKey,
          async () => {
            callbackCalls += 1;
            throw new Error('pg poison');
          },
        ),
      ).rejects.toThrow('pg poison');
    }
    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS);
    expect(
      await postgres.getReceipt(consumerKey, accepted.envelopeKey),
    ).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_INBOX_CONSUMER_ATTEMPTS,
    });
    const pendingBeforeRetry = await postgres.listPending(consumerKey, {
      limit: 1_000,
      now: postgresNow,
    });
    expect(
      pendingBeforeRetry.some(
        (envelope) => envelope.envelopeKey === accepted.envelopeKey,
      ),
    ).toBe(false);

    const direct = await postgres.consumeOnce(
      consumerKey,
      accepted.envelopeKey,
      async () => {
        callbackCalls += 1;
        return 'must-not-run';
      },
    );
    expect(direct.status).toBe('dead-letter');
    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS);

    expect(
      await postgres.retryDeadLetters(consumerKey, {
        limit: 1,
        now: postgresNow,
      }),
    ).toBe(1);
    const pendingAfterRetry = await postgres.listPending(consumerKey, {
      limit: 1_000,
      now: postgresNow,
    });
    expect(
      pendingAfterRetry.some(
        (envelope) => envelope.envelopeKey === accepted.envelopeKey,
      ),
    ).toBe(true);

    await expect(
      postgres.transactConsume(consumerKey, accepted.envelopeKey, async () => {
        callbackCalls += 1;
        throw new Error('pg poison again');
      }),
    ).rejects.toThrow('pg poison again');
    expect(
      await postgres.getReceipt(consumerKey, accepted.envelopeKey),
    ).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_INBOX_CONSUMER_ATTEMPTS + 1,
    });
    expect(
      await postgres.retryDeadLetters(consumerKey, {
        limit: 1,
        now: postgresNow + 1,
      }),
    ).toBe(1);

    const processed = await postgres.transactConsume(
      consumerKey,
      accepted.envelopeKey,
      async (unitOfWork) => {
        await unitOfWork.appendEffect({
          effectId: 'pg-dead-letter-effect',
          payload: { recovered: true },
        });
        return 'recovered';
      },
    );
    expect(processed).toMatchObject({
      status: 'processed',
      result: 'recovered',
    });
    const duplicate = await postgres.transactConsume(
      consumerKey,
      accepted.envelopeKey,
      async () => {
        callbackCalls += 1;
        return 'must-not-run';
      },
    );
    expect(duplicate.status).toBe('duplicate');
    expect(callbackCalls).toBe(MAX_INBOX_CONSUMER_ATTEMPTS + 1);
    expect(await postgres.retryDeadLetters(consumerKey, { limit: 10 })).toBe(0);
  });

  it('upgrades legacy failed threshold rows to dead-letter during migration', async () => {
    if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
    const legacySchema = `${schema}_legacy`;
    const pool = new Pool({ connectionString: databaseUrl });
    const quotedSchema = `"${legacySchema}"`;
    const factKey = Buffer.from(
      JSON.stringify(['legacy-producer', 'legacy-event']),
      'utf8',
    ).toString('base64url');
    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      await pool.query(`
        CREATE TABLE ${quotedSchema}."facts" (
          producer_id text NOT NULL,
          event_id text NOT NULL,
          session_id text,
          kind text NOT NULL,
          schema_version integer NOT NULL CHECK (schema_version >= 1),
          source_release text NOT NULL,
          aggregate_sequence bigint,
          payload jsonb NOT NULL,
          occurred_at double precision,
          received_at double precision NOT NULL,
          digest text NOT NULL,
          PRIMARY KEY (producer_id, event_id)
        )`);
      await pool.query(`
        CREATE TABLE ${quotedSchema}."consumer_receipts" (
          consumer_key text NOT NULL,
          producer_id text NOT NULL,
          event_id text NOT NULL,
          status text NOT NULL CHECK (status IN ('failed', 'completed')),
          attempts integer NOT NULL CHECK (attempts >= 1),
          last_attempt_at double precision NOT NULL,
          next_attempt_at double precision,
          completed_at double precision,
          PRIMARY KEY (consumer_key, producer_id, event_id),
          FOREIGN KEY (producer_id, event_id)
            REFERENCES ${quotedSchema}."facts" (producer_id, event_id)
        )`);
      await pool.query(
        `INSERT INTO ${quotedSchema}."facts"
          (producer_id, event_id, session_id, kind, schema_version,
           source_release, payload, received_at, digest)
         VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7, $8)`,
        [
          'legacy-producer',
          'legacy-event',
          'legacy-session',
          'legacy.kind',
          'legacy-release',
          JSON.stringify({ legacy: true }),
          10,
          'legacy-digest',
        ],
      );
      await pool.query(
        `INSERT INTO ${quotedSchema}."consumer_receipts"
          (consumer_key, producer_id, event_id, status, attempts,
           last_attempt_at, next_attempt_at)
         VALUES ($1, $2, $3, 'failed', 10, 20, 30)`,
        ['legacy-consumer', 'legacy-producer', 'legacy-event'],
      );

      const legacy = new PostgresInboxStore({
        pool,
        schema: legacySchema,
        now: () => 100,
      });
      await legacy.migrate();
      expect(await legacy.getReceipt('legacy-consumer', factKey)).toMatchObject(
        {
          status: 'dead-letter',
          attempts: MAX_INBOX_CONSUMER_ATTEMPTS,
        },
      );
      expect(
        await legacy.listPending('legacy-consumer', { limit: 10, now: 100 }),
      ).toEqual([]);
      const direct = await legacy.consumeOnce(
        'legacy-consumer',
        factKey,
        async () => {
          throw new Error('legacy dead letter must not run');
        },
      );
      expect(direct.status).toBe('dead-letter');
      expect(
        await legacy.retryDeadLetters('legacy-consumer', {
          limit: 1,
          now: 200,
        }),
      ).toBe(1);
      await legacy.migrate();
      expect(await legacy.getReceipt('legacy-consumer', factKey)).toMatchObject(
        {
          status: 'failed',
          attempts: MAX_INBOX_CONSUMER_ATTEMPTS,
          nextAttemptAt: 200,
        },
      );
      const recovered = await legacy.consumeOnce(
        'legacy-consumer',
        factKey,
        async () => 'recovered',
      );
      expect(recovered).toMatchObject({
        status: 'processed',
        result: 'recovered',
      });
    } finally {
      await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });

  it('validates schema names before opening a pool', () => {
    expect(
      () =>
        new PostgresInboxStore({
          connectionString: databaseUrl,
          schema: 'Unsafe-Name',
        }),
    ).toThrow(InboxError);
  });
});
