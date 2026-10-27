import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStorageDriver } from '../src/postgres.js';
import type {
  AutomationDecision,
  AutomationTrace,
  DomainEvent,
  OutboxRecord,
  SessionHead,
} from '../src/types.js';
import {
  AUTOMATION_TRACE_MAX_AGE_MS,
  AUTOMATION_TRACE_MAX_BYTES,
  AUTOMATION_TRACE_MAX_COUNT,
} from '../src/types.js';

const databaseUrl = process.env.BGP_TEST_DATABASE_URL;
const schema = `bgp_storage_test_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
const describePostgres = databaseUrl ? describe : describe.skip;
let driver: PostgresStorageDriver;

function testDatabaseUrl(): string {
  if (!databaseUrl) throw new Error('BGP_TEST_DATABASE_URL is required');
  return databaseUrl;
}

function head(sessionId = 'session-pg'): SessionHead {
  return {
    route: {
      gameId: 'game',
      modeId: 'standard',
      sessionId,
      releaseId: 'release-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch: 'epoch-1',
    },
    startId: 'start-1',
    startDigest: 'digest-1',
    status: 'active',
    revision: 0,
    encodedState: { turn: 0 },
    schemaVersion: 1,
    participants: [{ principalId: 'player-1', seatId: 'seat-1' }],
    summary: { turn: 0 },
    logicalTime: 0,
    eventSequence: 0,
  };
}

const event: DomainEvent = {
  eventId: 'event-pg-1',
  sessionId: 'session-pg',
  producerId: 'game-host',
  aggregateSequence: 1,
  schemaVersion: 1,
  sourceRelease: 'release-1',
  payload: { private: true },
  logicalTime: 1,
};

const outbox: OutboxRecord = {
  outboxId: 'outbox-pg-1',
  sessionId: 'session-pg',
  producerId: 'game-host',
  kind: 'session.changed',
  schemaVersion: 1,
  sourceRelease: 'release-1',
  payload: { revision: 1 },
  createdAt: 1,
  attempts: 0,
};

const automationDecision: AutomationDecision = {
  sessionId: 'session-pg',
  decisionId: 'decision-pg-1',
  commandId: 'automation:decision-pg-1',
  deadlineId: 'deadline-pg-1',
  expectedRevision: 0,
  seatId: 'seat-1',
  turnId: 'turn-1',
  command: { type: 'choose', value: 1 },
  createdAt: 1,
};

function automationTrace(sessionId: string): AutomationTrace {
  return {
    kind: 'command',
    sessionId,
    traceId: `command:${sessionId}`,
    decisionId: `command:${sessionId}`,
    commandId: `command:${sessionId}`,
    deadlineId: `command:${sessionId}`,
    releaseId: 'release-1',
    policyId: 'player-command',
    expectedRevision: 0,
    seatId: 'seat-1',
    turnId: 'revision:0',
    state: { private: 'state' },
    input: { actor: { principalId: 'player-1', kind: 'player' } },
    schemaVersion: 1,
    options: null,
    command: { type: 'choose', value: 1 },
    outcome: 'executed',
    startedAt: 1,
    finishedAt: 2,
    createdAt: 1,
    eventSequenceStart: 1,
    eventSequenceCount: 1,
  };
}

function traceVariant(
  sessionId: string,
  index: number,
  state: AutomationTrace['state'] = { private: 'state' },
): AutomationTrace {
  const base = automationTrace(sessionId);
  const suffix = String(index);
  return {
    ...base,
    traceId: `${base.traceId}:${suffix}`,
    decisionId: `${base.decisionId}:${suffix}`,
    commandId: `${base.commandId}:${suffix}`,
    deadlineId: `${base.deadlineId}:${suffix}`,
    state,
    startedAt: index,
    finishedAt: index + 1,
    createdAt: index,
  };
}

const eventInsertChunkSize = Math.floor(65_535 / 9);
const outboxInsertChunkSize = Math.floor(65_535 / 12);

function largeEventBatch(sessionId: string): DomainEvent[] {
  return Array.from({ length: eventInsertChunkSize + 1 }, (_, index) => ({
    ...event,
    sessionId,
    eventId: `event-${sessionId}-${index + 1}`,
    aggregateSequence: index + 1,
    logicalTime: index + 1,
    occurredAt: index + 1,
  }));
}

function largeOutboxBatch(sessionId: string): OutboxRecord[] {
  return Array.from({ length: outboxInsertChunkSize + 1 }, (_, index) => ({
    ...outbox,
    sessionId,
    outboxId: `outbox-${sessionId}-${index + 1}`,
    aggregateSequence: index + 1,
    createdAt: index + 1,
  }));
}

describePostgres('PostgresStorageDriver', () => {
  beforeAll(async () => {
    driver = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema,
    });
    await driver.migrate();
  });

  afterAll(async () => {
    await driver.close();
    const cleanup = new Pool({ connectionString: testDatabaseUrl() });
    try {
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  });

  it('serializes same-schema migrations and keeps v1 heads readable', async () => {
    const migrationSchema = `${schema}_concurrent`;
    const first = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema: migrationSchema,
    });
    const second = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema: migrationSchema,
    });
    const sessionId = 'migration-v1-session';
    try {
      await Promise.all([first.migrate(), second.migrate()]);
      await first.createSession(head(sessionId));
      await Promise.all([first.migrate(), second.migrate()]);
      expect(await second.getHead(sessionId)).toMatchObject({
        schemaVersion: 1,
        route: { releaseId: 'release-1' },
      });
    } finally {
      await first.close();
      await second.close();
      const cleanup = new Pool({ connectionString: testDatabaseUrl() });
      try {
        await cleanup.query(`DROP SCHEMA "${migrationSchema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    }
  });

  it('persists delivery backoff across driver reconstruction', async () => {
    await driver.createSession(head('retry-session'), {
      initialOutbox: [{ ...outbox, sessionId: 'retry-session' }],
    });
    await driver.markOutboxFailed(
      [{ sessionId: 'retry-session', outboxId: outbox.outboxId }],
      1_000,
    );
    const restarted = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema,
    });
    try {
      expect(
        await restarted.readOutboxBatch({
          sessionId: 'retry-session',
          limit: 1,
          now: 999,
        }),
      ).toEqual([]);
      expect(
        (
          await restarted.readOutboxBatch({
            sessionId: 'retry-session',
            limit: 1,
            now: 1_000,
          })
        )[0],
      ).toMatchObject({ attempts: 1, nextAttemptAt: 1_000 });
      await restarted.markOutboxDelivered(
        [{ sessionId: 'retry-session', outboxId: outbox.outboxId }],
        1_001,
      );
    } finally {
      await restarted.close();
    }
  });

  it('does not defer committed rows based on future createdAt', async () => {
    const sessionId = 'session-pg-logical-time';
    const immediate = {
      ...outbox,
      sessionId,
      outboxId: 'outbox-pg-logical-immediate',
      createdAt: 2,
    };
    const deferred = {
      ...outbox,
      sessionId,
      outboxId: 'outbox-pg-logical-deferred',
      createdAt: 1,
      nextAttemptAt: 2,
    };
    await driver.createSession(head(sessionId), {
      initialOutbox: [immediate, deferred],
    });

    expect(
      await driver.readOutboxBatch({ sessionId, limit: 10, now: 1 }),
    ).toEqual([expect.objectContaining(immediate)]);
    expect(
      (await driver.readOutboxBatch({ sessionId, limit: 10, now: 2 })).map(
        (row) => row.outboxId,
      ),
    ).toEqual([deferred.outboxId, immediate.outboxId]);
    expect(
      await driver.markOutboxDelivered(
        [immediate, deferred].map(({ sessionId, outboxId }) => ({
          sessionId,
          outboxId,
        })),
        3,
      ),
    ).toBe(2);
  });

  it('persists bounded active deadlines across driver reconstruction', async () => {
    const sessionId = 'due-session-pg';
    await driver.createSession({
      ...head(sessionId),
      deadline: { deadlineId: 'deadline-pg-1', dueAt: 10 },
    });
    expect(await driver.readDueSessions({ limit: 10, now: 10 })).toMatchObject([
      {
        sessionId,
        revision: 0,
        deadline: { deadlineId: 'deadline-pg-1', dueAt: 10 },
      },
    ]);
    await driver.close();
    driver = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema,
    });
    expect(await driver.readDueSessions({ limit: 10, now: 10 })).toMatchObject([
      {
        sessionId,
        deadline: { deadlineId: 'deadline-pg-1', dueAt: 10 },
      },
    ]);
  });

  it('persists safe automation failure metadata across driver reconstruction', async () => {
    const sessionId = 'automation-failure-pg';
    await driver.createSession({
      ...head(sessionId),
      automationFailure: {
        seatId: 'seat-ai',
        messageKey: 'server.automation.workerFailed',
      },
    });
    expect((await driver.getHead(sessionId))?.automationFailure).toEqual({
      seatId: 'seat-ai',
      messageKey: 'server.automation.workerFailed',
    });
    await driver.close();
    driver = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema,
    });
    expect((await driver.getHead(sessionId))?.automationFailure).toEqual({
      seatId: 'seat-ai',
      messageKey: 'server.automation.workerFailed',
    });
  });

  it('survives a driver restart with durable head, receipts, events, and outbox', async () => {
    await driver.createSession(head(), { initialOutbox: [outbox] });
    await driver.transaction(
      'session-pg',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        const current = await tx.getHead();
        await tx.setHead({
          ...current,
          revision: 1,
          encodedState: { turn: 1 },
          summary: { turn: 1 },
        });
        await tx.putReceipt({
          sessionId: 'session-pg',
          commandId: 'command-pg-1',
          actorPrincipalId: 'player-1',
          inputHash: 'hash-1',
          status: 'accepted',
          resultRetention: 'ephemeral-result',
          persistedRevision: 1,
          persistedAt: 1,
        });
        await tx.putAutomationDecision(automationDecision);
        await tx.appendEvent(event);
      },
    );
    await driver.close();
    driver = new PostgresStorageDriver({
      connectionString: testDatabaseUrl(),
      schema,
    });
    expect((await driver.getHead('session-pg'))?.revision).toBe(1);
    expect(
      await driver.getReceipt('session-pg', 'command-pg-1', 'player-1'),
    ).toMatchObject({ inputHash: 'hash-1' });
    await driver.transaction(
      'session-pg',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(
          await tx.getAutomationDecision(automationDecision.decisionId),
        ).toEqual(automationDecision);
      },
    );
    expect(await driver.readEvents('session-pg', { limit: 10 })).toHaveLength(
      1,
    );
    expect(await driver.readOutboxBatch({ limit: 10 })).toHaveLength(1);
  });

  it('persists standalone event and outbox batches with one durable event cursor advance', async () => {
    const sessionId = 'session-pg-batch';
    const events = [
      {
        ...event,
        sessionId,
        eventId: 'event-pg-batch-1',
        aggregateSequence: 1,
      },
      {
        ...event,
        sessionId,
        eventId: 'event-pg-batch-2',
        aggregateSequence: 2,
      },
    ];
    const messages = [
      { ...outbox, sessionId, outboxId: 'outbox-pg-batch-1' },
      { ...outbox, sessionId, outboxId: 'outbox-pg-batch-2' },
    ];
    await driver.createSession(head(sessionId));
    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(await tx.appendEvents(events)).toEqual(events);
        expect(await tx.appendOutboxMany(messages)).toEqual(messages);
      },
    );
    expect((await driver.getHead(sessionId))?.eventSequence).toBe(2);
    expect(
      (await driver.readEvents(sessionId, { limit: 10 })).map(
        (item) => item.eventId,
      ),
    ).toEqual(['event-pg-batch-1', 'event-pg-batch-2']);
    expect(
      (await driver.readOutboxBatch({ sessionId, limit: 10 })).map(
        (item) => item.outboxId,
      ),
    ).toEqual(['outbox-pg-batch-1', 'outbox-pg-batch-2']);

    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.appendEvents([
          {
            ...event,
            sessionId,
            eventId: 'event-pg-batch-3',
            aggregateSequence: 3,
          },
          {
            ...event,
            sessionId,
            eventId: 'event-pg-batch-duplicate',
            aggregateSequence: 3,
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    expect((await driver.getHead(sessionId))?.eventSequence).toBe(2);
    expect(await driver.readEvents(sessionId, { limit: 10 })).toHaveLength(2);
  });

  it('persists append batches across PostgreSQL parameter chunks', async () => {
    const sessionId = 'session-pg-chunk-success';
    const events = largeEventBatch(sessionId);
    const messages = largeOutboxBatch(sessionId);
    await driver.createSession(head(sessionId));

    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(await tx.appendEvents(events)).toHaveLength(events.length);
        expect(await tx.appendOutboxMany(messages)).toHaveLength(
          messages.length,
        );
      },
    );

    expect((await driver.getHead(sessionId))?.eventSequence).toBe(
      events.length,
    );
    expect(
      await driver.readEvents(sessionId, {
        afterSequence: events.length - 1,
        limit: 2,
      }),
    ).toEqual([events.at(-1)]);
    expect(await driver.readOutboxBatch({ sessionId, limit: 1 })).toHaveLength(
      1,
    );
  });

  it('prevalidates oversized batches before any PostgreSQL chunk is written', async () => {
    const sessionId = 'session-pg-chunk-invalid';
    const events = largeEventBatch(sessionId);
    events[events.length - 1] = {
      ...events[events.length - 1],
      aggregateSequence: events[0].aggregateSequence,
    };
    await driver.createSession(head(sessionId));

    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, (tx) =>
        tx.appendEvents(events),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    expect((await driver.getHead(sessionId))?.eventSequence).toBe(0);
    expect(await driver.readEvents(sessionId, { limit: 1 })).toEqual([]);
  });

  it('rolls back all PostgreSQL chunks after a later transaction failure', async () => {
    const sessionId = 'session-pg-chunk-rollback';
    const events = largeEventBatch(sessionId);
    const messages = largeOutboxBatch(sessionId);
    await driver.createSession(head(sessionId));

    await expect(
      driver.transaction(
        sessionId,
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          await tx.appendEvents(events);
          await tx.appendOutboxMany(messages);
          throw new Error('chunk rollback');
        },
      ),
    ).rejects.toThrow('chunk rollback');
    expect((await driver.getHead(sessionId))?.eventSequence).toBe(0);
    expect(await driver.readEvents(sessionId, { limit: 1 })).toEqual([]);
    expect(await driver.readOutboxBatch({ sessionId, limit: 1 })).toEqual([]);
  });

  it('atomically persists initial events and does not duplicate an idempotent start', async () => {
    const sessionId = 'session-pg-initial-events';
    const initialHead = { ...head(sessionId), eventSequence: 1 };
    const initialEvent = {
      ...event,
      sessionId,
      eventId: 'event-pg-initial-1',
      aggregateSequence: 1,
      occurredAt: 1,
    };
    await expect(
      driver.createSession(initialHead, {
        initialEvents: [initialEvent],
        initialOutbox: [{ ...outbox, outboxId: 'wrong-session-outbox' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await driver.getHead(sessionId)).toBeNull();

    await driver.createSession(initialHead, { initialEvents: [initialEvent] });
    expect((await driver.getHead(sessionId))?.eventSequence).toBe(1);
    expect(await driver.readEvents(sessionId, { limit: 10 })).toEqual([
      initialEvent,
    ]);
    expect(
      await driver.createSession(initialHead, {
        initialEvents: [initialEvent],
      }),
    ).toEqual(initialHead);
    expect(await driver.readEvents(sessionId, { limit: 10 })).toHaveLength(1);
  });

  it('rolls back a failed serializable transaction', async () => {
    await expect(
      driver.transaction(
        'session-pg',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          const current = await tx.getHead();
          await tx.setHead({
            ...current,
            revision: 2,
            encodedState: { leaked: true },
            summary: { leaked: true },
          });
          await tx.appendEvent({
            ...event,
            eventId: 'event-pg-rollback',
            aggregateSequence: 2,
          });
          throw new Error('rollback');
        },
      ),
    ).rejects.toThrow('rollback');
    expect((await driver.getHead('session-pg'))?.revision).toBe(1);
    expect(await driver.readEvents('session-pg', { limit: 10 })).toHaveLength(
      1,
    );
  });

  it('keeps private command traces isolated, rollback-safe, and TTL-prunable', async () => {
    const sessionId = 'session-pg-private-trace';
    await driver.createSession(head(sessionId));
    const trace = automationTrace(sessionId);
    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.putAutomationTrace(trace);
        await tx.appendEvent({
          ...event,
          sessionId,
          eventId: 'event-pg-private-trace',
          source: { kind: 'human', traceId: trace.traceId },
        });
      },
    );
    expect(await driver.readEvents(sessionId, { limit: 10 })).toEqual([
      expect.objectContaining({
        source: { kind: 'human', traceId: trace.traceId },
      }),
    ]);
    await expect(
      driver.readAutomationTraces(sessionId, { limit: 10, now: 1 }),
    ).resolves.toEqual([trace]);
    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        const current = await tx.getHead();
        await tx.setHead({
          ...current,
          status: 'completed',
          revision: current.revision + 1,
        });
        await tx.clearPrivateState();
      },
    );
    await expect(
      driver.readAutomationTraces(sessionId, { limit: 10, now: 1 }),
    ).resolves.toEqual([trace]);
    await expect(
      driver.transaction(
        sessionId,
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          await tx.putAutomationTrace({
            ...trace,
            traceId: `${trace.traceId}:rollback`,
            commandId: `${trace.commandId}:rollback`,
          });
          throw new Error('trace rollback');
        },
      ),
    ).rejects.toThrow('trace rollback');
    expect(
      await driver.readAutomationTraces(sessionId, { limit: 10, now: 1 }),
    ).toHaveLength(1);
    await expect(
      driver.readAutomationTraces(sessionId, {
        limit: 10,
        now: 1 + AUTOMATION_TRACE_MAX_AGE_MS + 1,
      }),
    ).resolves.toEqual([]);
  });

  it('enforces trace count/byte caps and prunes idle sessions', async () => {
    const countSession = 'session-pg-trace-count-cap';
    await driver.createSession(head(countSession));
    await driver.transaction(
      countSession,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        for (let index = 1; index <= AUTOMATION_TRACE_MAX_COUNT + 1; index += 1)
          await tx.putAutomationTrace(traceVariant(countSession, index));
      },
    );
    const countTraces = await driver.readAutomationTraces(countSession, {
      limit: 200,
      now: AUTOMATION_TRACE_MAX_COUNT + 2,
    });
    expect(countTraces).toHaveLength(AUTOMATION_TRACE_MAX_COUNT);
    expect(countTraces[0]?.traceId).toBe(`command:${countSession}:2`);

    const byteSession = 'session-pg-trace-byte-cap';
    await driver.createSession(head(byteSession));
    const largeState = {
      private: randomBytes(1_100_000).toString('base64'),
    };
    await driver.transaction(
      byteSession,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        for (let index = 1; index <= 17; index += 1)
          await tx.putAutomationTrace(
            traceVariant(byteSession, index, largeState),
          );
      },
    );
    const byteTraces = await driver.readAutomationTraces(byteSession, {
      limit: 200,
      now: 18,
    });
    const bytes = byteTraces.reduce(
      (total, value) =>
        total + Buffer.byteLength(JSON.stringify(value), 'utf8'),
      0,
    );
    expect(byteTraces.length).toBeLessThan(17);
    expect(bytes).toBeLessThanOrEqual(AUTOMATION_TRACE_MAX_BYTES);

    const idleSession = 'session-pg-trace-idle-prune';
    await driver.createSession(head(idleSession));
    await driver.transaction(idleSession, { ownershipEpoch: 'epoch-1' }, (tx) =>
      tx.putAutomationTrace(traceVariant(idleSession, 1)),
    );
    const expiredAt = 1 + AUTOMATION_TRACE_MAX_AGE_MS + 1;
    await driver.readDueSessions({ limit: 10, now: expiredAt });
    await expect(
      driver.readAutomationTraces(idleSession, {
        limit: 10,
        now: expiredAt,
      }),
    ).resolves.toEqual([]);

    const rollbackSession = 'session-pg-trace-association-rollback';
    await driver.createSession(head(rollbackSession));
    await expect(
      driver.transaction(
        rollbackSession,
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          const trace = traceVariant(rollbackSession, 1);
          await tx.putAutomationTrace(trace);
          await tx.appendEvent({
            ...event,
            sessionId: rollbackSession,
            eventId: `${rollbackSession}:event:1`,
            source: { kind: 'human', traceId: trace.traceId },
          });
          throw new Error('trace and event rollback');
        },
      ),
    ).rejects.toThrow('trace and event rollback');
    await expect(
      driver.readAutomationTraces(rollbackSession, { limit: 10, now: 1 }),
    ).resolves.toEqual([]);
    await expect(
      driver.readEvents(rollbackSession, { limit: 10 }),
    ).resolves.toEqual([]);
    const beforeDeniedHead = await driver.getHead(rollbackSession);
    await expect(
      driver.transaction(
        rollbackSession,
        { ownershipEpoch: 'wrong-epoch' },
        async (tx) => {
          await tx.putAutomationTrace(traceVariant(rollbackSession, 2));
        },
      ),
    ).rejects.toMatchObject({ code: 'STALE_OWNERSHIP' });
    expect(await driver.getHead(rollbackSession)).toEqual(beforeDeniedHead);
    await expect(
      driver.readAutomationTraces(rollbackSession, { limit: 10, now: 2 }),
    ).resolves.toEqual([]);
  });

  it('rejects malformed route/status, receipt fields, timestamps, and revisions', async () => {
    await expect(
      driver.createSession({
        ...head('session-pg-invalid'),
        route: { ...head('session-pg-invalid').route, gameId: '' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.createSession({
        ...head('session-pg-invalid-extra'),
        route: {
          ...head('session-pg-invalid-extra').route,
          extra: 'unknown',
        } as unknown as SessionHead['route'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.createSession({
        ...head('session-pg-invalid-status'),
        status: 'finished' as unknown as SessionHead['status'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const sessionId = 'session-pg-invalid';
    await driver.createSession(head(sessionId));
    const receipt = {
      sessionId,
      commandId: 'unsafe-command',
      actorPrincipalId: 'player-1',
      inputHash: 'hash-unsafe',
      status: 'accepted' as const,
      resultRetention: 'ephemeral-result' as const,
    };
    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.putReceipt({
          ...receipt,
          payload: { private: true },
        } as unknown as typeof receipt),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.putReceipt({ ...receipt, persistedRevision: 1.5 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.putReceipt({ ...receipt, persistedAt: Number.POSITIVE_INFINITY }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.appendEvent({
          ...event,
          sessionId,
          occurredAt: Number.NaN,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(sessionId, { ownershipEpoch: 'epoch-1' }, async (tx) =>
        tx.appendOutbox({
          ...outbox,
          sessionId,
          outboxId: 'invalid-outbox',
          deliveredAt: Number.POSITIVE_INFINITY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('retains pending outbox rows while terminal private state is cleared', async () => {
    const sessionId = 'session-pg-terminal';
    const delivered = { ...outbox, sessionId, outboxId: 'outbox-pg-delivered' };
    const pending = { ...outbox, sessionId, outboxId: 'outbox-pg-pending' };
    await driver.createSession(head(sessionId), {
      initialOutbox: [delivered, pending],
    });
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId, outboxId: delivered.outboxId }],
        2,
      ),
    ).toBe(1);
    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.putAutomationDecision({
          ...automationDecision,
          sessionId,
          decisionId: `${sessionId}-decision`,
          commandId: `${sessionId}-command`,
          deadlineId: `${sessionId}-deadline`,
        });
        const current = await tx.getHead();
        await tx.setHead({
          ...current,
          status: 'completed',
          revision: 1,
          encodedState: { secret: true },
        });
        await tx.clearPrivateState();
      },
    );
    await driver.transaction(
      sessionId,
      { ownershipEpoch: 'epoch-1' },
      async (tx) =>
        expect(
          await tx.getAutomationDecision(`${sessionId}-decision`),
        ).toBeNull(),
    );
    expect(await driver.readOutboxBatch({ sessionId, limit: 10 })).toEqual([
      expect.objectContaining({ outboxId: pending.outboxId }),
    ]);
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId, outboxId: delivered.outboxId }],
        3,
      ),
    ).toBe(0);
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId, outboxId: pending.outboxId }],
        3,
      ),
    ).toBe(1);
    expect(await driver.readOutboxBatch({ sessionId, limit: 10 })).toEqual([]);
  });
});
