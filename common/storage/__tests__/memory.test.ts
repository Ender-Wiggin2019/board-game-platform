import { describe, expect, it } from 'vitest';
import type { SessionTransaction } from '../src/driver.js';
import { StorageError } from '../src/errors.js';
import { MemoryStorageDriver } from '../src/memory.js';
import type {
  AutomationDecision,
  DomainEvent,
  OutboxRecord,
  SessionHead,
} from '../src/types.js';

function head(
  sessionId = 'session-1',
  ownershipEpoch = 'epoch-1',
): SessionHead {
  return {
    route: {
      gameId: 'game',
      modeId: 'standard',
      sessionId,
      releaseId: 'release-1',
      backendBindingId: 'backend-1',
      storageBindingId: 'storage-1',
      ownershipEpoch,
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

function event(
  sessionId = 'session-1',
  eventId = 'event-1',
  sequence = 1,
): DomainEvent {
  return {
    eventId,
    sessionId,
    producerId: 'game-host',
    aggregateSequence: sequence,
    schemaVersion: 1,
    sourceRelease: 'release-1',
    payload: { private: true },
    logicalTime: sequence,
  };
}

function outbox(sessionId = 'session-1', outboxId = 'outbox-1'): OutboxRecord {
  return {
    outboxId,
    sessionId,
    producerId: 'game-host',
    kind: 'session.changed',
    schemaVersion: 1,
    sourceRelease: 'release-1',
    payload: { revision: 1 },
    createdAt: 1,
    attempts: 0,
  };
}

function automationDecision(decisionId = 'decision-1'): AutomationDecision {
  return {
    sessionId: 'session-1',
    decisionId,
    commandId: `command-${decisionId}`,
    deadlineId: 'deadline-1',
    expectedRevision: 0,
    seatId: 'seat-1',
    turnId: 'turn-1',
    command: { type: 'choose', value: 1 },
    createdAt: 1,
  };
}

describe('MemoryStorageDriver', () => {
  it('reads only bounded active deadlines and returns isolated route data', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession({
      ...head('due-session'),
      deadline: { deadlineId: 'deadline-1', dueAt: 10 },
    });
    await driver.createSession({
      ...head('future-session'),
      deadline: { deadlineId: 'deadline-2', dueAt: 100 },
    });
    await driver.createSession({
      ...head('paused-session'),
      status: 'paused',
      deadline: { deadlineId: 'deadline-3', dueAt: 1 },
    });
    const due = await driver.readDueSessions({ limit: 10, now: 10 });
    expect(due.map((session) => session.sessionId)).toEqual(['due-session']);
    const route = due[0]?.route;
    if (!route) throw new Error('expected due session');
    (route as { sessionId: string }).sessionId = 'mutated';
    expect((await driver.getHead('due-session'))?.route.sessionId).toBe(
      'due-session',
    );
    expect(
      await driver.readDueSessions({
        limit: 10,
        now: 10,
        backendBindingId: 'other-backend',
      }),
    ).toEqual([]);
  });

  it('partitions due deadlines for independent system and automation scans', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession({
      ...head('system-deadline'),
      deadline: { deadlineId: 'turn-1', dueAt: 10 },
    });
    await driver.createSession({
      ...head('automation-deadline'),
      deadline: { deadlineId: 'automation:one', dueAt: 10 },
    });

    expect(
      (
        await driver.readDueSessions({
          limit: 10,
          now: 10,
          deadlineKind: 'system',
        })
      ).map((item) => item.sessionId),
    ).toEqual(['system-deadline']);
    expect(
      (
        await driver.readDueSessions({
          limit: 10,
          now: 10,
          deadlineKind: 'automation',
        })
      ).map((item) => item.sessionId),
    ).toEqual(['automation-deadline']);
  });

  it('defers failed outbox rows so later facts remain deliverable', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head(), {
      initialOutbox: [outbox(), outbox('session-1', 'outbox-2')],
    });
    const key = { sessionId: 'session-1', outboxId: 'outbox-1' };
    await driver.markOutboxFailed([key], 1_000);
    expect(
      (await driver.readOutboxBatch({ limit: 1, now: 100 }))[0]?.outboxId,
    ).toBe('outbox-2');
    expect(
      (await driver.readOutboxBatch({ limit: 1, now: 1_000 }))[0],
    ).toMatchObject({ outboxId: 'outbox-1', attempts: 1 });
    await driver.markOutboxDelivered([key], 1_001);
    expect(await driver.markOutboxFailed([key], 2_000)).toBe(0);
    expect(
      (await driver.readOutboxBatch({ limit: 5, now: 3_000 })).map(
        (row) => row.outboxId,
      ),
    ).toEqual(['outbox-2']);
  });

  it('delivers an outbox row immediately when its logical timestamp is ahead of wall time', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head(), {
      initialOutbox: [{ ...outbox(), createdAt: 2 }],
    });

    await expect(
      driver.readOutboxBatch({ limit: 1, now: 1 }),
    ).resolves.toMatchObject([{ outboxId: 'outbox-1', createdAt: 2 }]);
  });

  it('commits initial events atomically, advances the event cursor, and does not duplicate an idempotent start', async () => {
    const driver = new MemoryStorageDriver();
    const initial = head('initial-events');
    const initialEvent = event('initial-events', 'initial-event-1', 1);
    const withEventSequence = { ...initial, eventSequence: 1 };
    const invalidOutbox = { ...outbox('other-session', 'invalid-outbox') };
    await expect(
      driver.createSession(withEventSequence, {
        initialEvents: [initialEvent],
        initialOutbox: [invalidOutbox],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await driver.getHead('initial-events')).toBeNull();

    await driver.createSession(withEventSequence, {
      initialEvents: [initialEvent],
    });
    expect((await driver.getHead('initial-events'))?.eventSequence).toBe(1);
    expect(await driver.readEvents('initial-events', { limit: 10 })).toEqual([
      initialEvent,
    ]);
    expect(
      await driver.createSession(withEventSequence, {
        initialEvents: [initialEvent],
      }),
    ).toEqual(withEventSequence);
    expect(
      await driver.readEvents('initial-events', { limit: 10 }),
    ).toHaveLength(1);
  });

  it('isolates reads and rolls back all transaction writes on failure', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());

    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          const current = await tx.getHead();
          await tx.setHead({
            ...current,
            revision: 1,
            encodedState: { turn: 1 },
            summary: { turn: 1 },
          });
          await tx.appendEvent(event());
          await tx.appendOutbox(outbox());
          throw new Error('rule failure');
        },
      ),
    ).rejects.toThrow('rule failure');

    const persisted = await driver.getHead('session-1');
    expect(persisted?.revision).toBe(0);
    expect(persisted?.encodedState).toEqual({ turn: 0 });
    expect(await driver.readEvents('session-1', { limit: 10 })).toEqual([]);
    expect(await driver.readOutboxBatch({ limit: 10 })).toEqual([]);

    const copy = await driver.getHead('session-1');
    if (!copy) throw new Error('expected a session head');
    (copy.encodedState as { turn: number }).turn = 99;
    expect((await driver.getHead('session-1'))?.encodedState).toEqual({
      turn: 0,
    });
  });

  it('round-trips safe automation failure metadata and clears it transactionally', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession({
      ...head('automation-failure'),
      automationFailure: {
        seatId: 'seat-ai',
        messageKey: 'server.automation.workerFailed',
      },
    });
    expect(
      (await driver.getHead('automation-failure'))?.automationFailure,
    ).toEqual({
      seatId: 'seat-ai',
      messageKey: 'server.automation.workerFailed',
    });

    await driver.transaction(
      'automation-failure',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        const current = await tx.getHead();
        await tx.setHead({
          ...current,
          revision: current.revision + 1,
          automationFailure: undefined,
        });
      },
    );
    expect(
      (await driver.getHead('automation-failure'))?.automationFailure,
    ).toBe(undefined);
  });

  it('appends event and outbox batches atomically and advances a standalone event cursor once', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    const events = [
      event('session-1', 'event-batch-1', 1),
      event('session-1', 'event-batch-2', 2),
    ];
    const messages = [
      outbox('session-1', 'outbox-batch-1'),
      outbox('session-1', 'outbox-batch-2'),
    ];

    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(await tx.appendEvents(events)).toEqual(events);
        expect(await tx.appendOutboxMany(messages)).toEqual(messages);
      },
    );

    expect((await driver.getHead('session-1'))?.eventSequence).toBe(2);
    expect(
      (await driver.readEvents('session-1', { limit: 10 })).map(
        (item) => item.eventId,
      ),
    ).toEqual(['event-batch-1', 'event-batch-2']);
    expect(
      (await driver.readOutboxBatch({ limit: 10 })).map(
        (item) => item.outboxId,
      ),
    ).toEqual(['outbox-batch-1', 'outbox-batch-2']);

    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) =>
          tx.appendEvents([
            event('session-1', 'event-batch-3', 3),
            event('session-1', 'event-batch-duplicate', 3),
          ]),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    expect((await driver.getHead('session-1'))?.eventSequence).toBe(2);
    expect(await driver.readEvents('session-1', { limit: 10 })).toHaveLength(2);
  });

  it('isolates all append return values from persisted rows and peer results', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());

    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        const singleEvent = await tx.appendEvent(
          event('session-1', 'event-single-isolation', 1),
        );
        (singleEvent.payload as { private: boolean }).private = false;

        const batchEvents = await tx.appendEvents([
          event('session-1', 'event-batch-isolation-1', 2),
          event('session-1', 'event-batch-isolation-2', 3),
        ]);
        const firstBatchEvent = batchEvents[0];
        const secondBatchEvent = batchEvents[1];
        if (!firstBatchEvent || !secondBatchEvent)
          throw new Error('expected event batch results');
        (firstBatchEvent.payload as { private: boolean }).private = false;
        expect(secondBatchEvent.payload).toEqual({ private: true });

        const singleOutbox = await tx.appendOutbox(
          outbox('session-1', 'outbox-single-isolation'),
        );
        (singleOutbox.payload as { revision: number }).revision = 99;

        const batchOutbox = await tx.appendOutboxMany([
          outbox('session-1', 'outbox-batch-isolation-1'),
          outbox('session-1', 'outbox-batch-isolation-2'),
        ]);
        const firstBatchOutbox = batchOutbox[0];
        const secondBatchOutbox = batchOutbox[1];
        if (!firstBatchOutbox || !secondBatchOutbox)
          throw new Error('expected outbox batch results');
        (firstBatchOutbox.payload as { revision: number }).revision = 99;
        expect(secondBatchOutbox.payload).toEqual({ revision: 1 });
      },
    );

    expect(
      (await driver.readEvents('session-1', { limit: 10 })).map((item) => ({
        eventId: item.eventId,
        payload: item.payload,
      })),
    ).toEqual([
      { eventId: 'event-single-isolation', payload: { private: true } },
      { eventId: 'event-batch-isolation-1', payload: { private: true } },
      { eventId: 'event-batch-isolation-2', payload: { private: true } },
    ]);
    expect(
      (await driver.readOutboxBatch({ sessionId: 'session-1', limit: 10 })).map(
        (item) => ({ outboxId: item.outboxId, payload: item.payload }),
      ),
    ).toEqual([
      { outboxId: 'outbox-batch-isolation-1', payload: { revision: 1 } },
      { outboxId: 'outbox-batch-isolation-2', payload: { revision: 1 } },
      { outboxId: 'outbox-single-isolation', payload: { revision: 1 } },
    ]);
  });

  it('accepts append batches larger than the bounded read limit', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    const events = Array.from({ length: 1_001 }, (_, index) =>
      event('session-1', `large-event-${index + 1}`, index + 1),
    );
    const messages = Array.from({ length: 1_001 }, (_, index) =>
      outbox('session-1', `large-outbox-${index + 1}`),
    );

    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(await tx.appendEvents(events)).toHaveLength(events.length);
        expect(await tx.appendOutboxMany(messages)).toHaveLength(
          messages.length,
        );
      },
    );

    expect((await driver.getHead('session-1'))?.eventSequence).toBe(1_001);
    expect(await driver.readEvents('session-1', { limit: 1 })).toHaveLength(1);
    expect(
      await driver.readOutboxBatch({ sessionId: 'session-1', limit: 1 }),
    ).toHaveLength(1);
  });

  it('serializes concurrent transactions without lost revisions', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    await Promise.all(
      Array.from({ length: 20 }, () =>
        driver.transaction(
          'session-1',
          { ownershipEpoch: 'epoch-1' },
          async (tx) => {
            const current = await tx.getHead();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await tx.setHead({
              ...current,
              revision: current.revision + 1,
              encodedState: { turn: current.revision + 1 },
              summary: { turn: current.revision + 1 },
            });
          },
        ),
      ),
    );
    expect((await driver.getHead('session-1'))?.revision).toBe(20);
  });

  it('rejects stale ownership and duplicate start identities', async () => {
    const driver = new MemoryStorageDriver();
    const initial = head();
    expect(await driver.createSession(initial)).toEqual(initial);
    expect(
      await driver.createSession({
        ...initial,
        encodedState: { ignored: true },
      }),
    ).toEqual(initial);

    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'stale' },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'STALE_OWNERSHIP' });
    await expect(
      driver.createSession({ ...initial, startDigest: 'different' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SESSION' });
    await expect(
      driver.createSession({
        ...initial,
        route: { ...initial.route, releaseId: 'other' },
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SESSION' });
  });

  it('keeps receipts actor-scoped and rejects command hash reuse', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    const receipt = {
      sessionId: 'session-1',
      commandId: 'command-1',
      actorPrincipalId: 'player-1',
      inputHash: 'hash-1',
      status: 'accepted' as const,
      resultRetention: 'ephemeral-result' as const,
      persistedRevision: 1,
      persistedAt: 1,
    };
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.putReceipt(receipt);
      },
    );
    expect(
      await driver.getReceipt('session-1', 'command-1', 'other-player'),
    ).toBeNull();
    expect(
      await driver.getReceipt('session-1', 'command-1', 'player-1'),
    ).toEqual(receipt);
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.putReceipt({ ...receipt, inputHash: 'hash-2' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('persists automation decisions idempotently and rolls back uncommitted choices', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    const decision = automationDecision();

    let returned: AutomationDecision | undefined;
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        returned = await tx.putAutomationDecision(decision);
        const stored = await tx.getAutomationDecision(decision.decisionId);
        expect(stored).toEqual(decision);
      },
    );
    expect(returned).toEqual(decision);
    if (!returned) throw new Error('expected automation decision');
    (returned.command as { type: string }).type = 'mutated';
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.putAutomationDecision(decision),
      ),
    ).resolves.toEqual(decision);

    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) =>
          tx.putAutomationDecision({
            ...decision,
            command: { type: 'different' },
          }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const rollback = automationDecision('decision-rollback');
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => {
          await tx.putAutomationDecision(rollback);
          throw new Error('policy worker failed');
        },
      ),
    ).rejects.toThrow('policy worker failed');
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.getAutomationDecision(rollback.decisionId),
      ),
    ).resolves.toBeNull();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        driver.transaction(
          'session-1',
          { ownershipEpoch: 'epoch-1' },
          async (tx) => tx.putAutomationDecision(decision),
        ),
      ),
    );
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => tx.deleteAutomationDecision(decision.decisionId),
    );
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.getAutomationDecision(decision.decisionId),
      ),
    ).resolves.toBeNull();
    const second = automationDecision('decision-2');
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.putAutomationDecision(decision);
        await tx.putAutomationDecision(second);
        await tx.clearAutomationDecisions();
      },
    );
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        expect(await tx.getAutomationDecision(decision.decisionId)).toBeNull();
        expect(await tx.getAutomationDecision(second.decisionId)).toBeNull();
      },
    );
  });

  it('rejects malformed route/status and unsafe receipt metadata', async () => {
    const driver = new MemoryStorageDriver();
    await expect(
      driver.createSession({
        ...head(),
        route: { ...head().route, gameId: '' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.createSession({
        ...head(),
        route: {
          ...head().route,
          extra: 'unknown',
        } as unknown as SessionHead['route'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.createSession({
        ...head(),
        status: 'finished' as unknown as SessionHead['status'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await driver.createSession(head());
    const receipt = {
      sessionId: 'session-1',
      commandId: 'unsafe-command',
      actorPrincipalId: 'player-1',
      inputHash: 'hash-unsafe',
      status: 'accepted' as const,
      resultRetention: 'ephemeral-result' as const,
    };
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) =>
          tx.putReceipt({
            ...receipt,
            payload: { private: true },
          } as unknown as typeof receipt),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.putReceipt({ ...receipt, persistedRevision: 1.5 }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) =>
          tx.putReceipt({ ...receipt, persistedAt: Number.POSITIVE_INFINITY }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.appendEvent({ ...event(), occurredAt: Number.NaN }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) =>
          tx.appendOutbox({
            ...outbox(),
            outboxId: 'invalid-outbox',
            deliveredAt: Number.POSITIVE_INFINITY,
          }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('closes transaction handles after commit and keeps persisted clones isolated', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    let leaked: SessionTransaction | undefined;
    let next: SessionHead | undefined;
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        leaked = tx;
        const current = await tx.getHead();
        next = {
          ...current,
          revision: 1,
          encodedState: { turn: 1 },
          summary: { turn: 1 },
        };
        await tx.setHead(next);
      },
    );
    if (!leaked || !next) throw new Error('expected transaction state');
    (next.encodedState as { turn: number }).turn = 99;
    expect((await driver.getHead('session-1'))?.encodedState).toEqual({
      turn: 1,
    });
    await expect(leaked.getHead()).rejects.toMatchObject({
      code: 'TRANSACTION_CONFLICT',
    });
    await expect(
      leaked.setHead({ ...next, revision: 2 }),
    ).rejects.toMatchObject({ code: 'TRANSACTION_CONFLICT' });
    expect((await driver.getHead('session-1'))?.revision).toBe(1);
  });

  it('clears private state and events atomically while retaining receipts and outbox', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head(), {
      initialOutbox: [
        outbox('session-1', 'outbox-pending'),
        outbox('session-1', 'outbox-delivered'),
      ],
    });
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId: 'session-1', outboxId: 'outbox-delivered' }],
        2,
      ),
    ).toBe(1);
    const receipt = {
      sessionId: 'session-1',
      commandId: 'command-1',
      actorPrincipalId: 'player-1',
      inputHash: 'hash-1',
      status: 'tombstone' as const,
      resultRetention: 'ephemeral-result' as const,
    };
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.putReceipt(receipt);
        await tx.putAutomationDecision(automationDecision());
        await tx.appendEvent(event());
        const current = await tx.getHead();
        await tx.setHead({
          ...current,
          revision: 1,
          status: 'completed',
          encodedState: { secret: true },
          summary: { done: true },
        });
        await tx.clearPrivateState();
      },
    );
    const persisted = await driver.getHead('session-1');
    expect(persisted?.encodedState).toBeNull();
    expect(await driver.readEvents('session-1', { limit: 10 })).toEqual([]);
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.getAutomationDecision('decision-1'),
      ),
    ).resolves.toBeNull();
    expect(
      await driver.getReceipt('session-1', 'command-1', 'player-1'),
    ).toEqual(receipt);
    expect(await driver.readOutboxBatch({ limit: 10 })).toEqual([
      expect.objectContaining({ outboxId: 'outbox-pending' }),
    ]);
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId: 'session-1', outboxId: 'outbox-delivered' }],
        3,
      ),
    ).toBe(0);
    expect(
      await driver.markOutboxDelivered(
        [{ sessionId: 'session-1', outboxId: 'outbox-pending' }],
        3,
      ),
    ).toBe(1);
    expect(await driver.readOutboxBatch({ limit: 10 })).toEqual([]);
  });

  it('enforces bounded event and outbox reads', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.appendEvent(event('session-1', 'event-1', 1));
        await tx.appendEvent(event('session-1', 'event-2', 2));
        await tx.appendOutbox(outbox('session-1', 'outbox-1'));
        await tx.appendOutbox(outbox('session-1', 'outbox-2'));
      },
    );
    expect(
      (
        await driver.readEvents('session-1', { afterSequence: 1, limit: 1 })
      ).map((item) => item.eventId),
    ).toEqual(['event-2']);
    expect(
      (await driver.readOutboxBatch({ limit: 1 })).map((item) => item.outboxId),
    ).toEqual(['outbox-1']);
    await expect(
      driver.readEvents('session-1', { limit: 1_001 }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects duplicate event and outbox identifiers', async () => {
    const driver = new MemoryStorageDriver();
    await driver.createSession(head());
    await driver.transaction(
      'session-1',
      { ownershipEpoch: 'epoch-1' },
      async (tx) => {
        await tx.appendEvent(event());
        await tx.appendOutbox(outbox());
      },
    );

    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.appendEvent(event()),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    await expect(
      driver.transaction(
        'session-1',
        { ownershipEpoch: 'epoch-1' },
        async (tx) => tx.appendOutbox(outbox()),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
  });
});
