import { canonicalStableStringify } from '@board-game/contracts';
import type { SessionStorageDriver, SessionTransaction } from './driver.js';
import { StorageError } from './errors.js';
import {
  assertAutomationDecision,
  assertAutomationTrace,
  assertAutomationTraceReadOptions,
  assertDueSessionReadOptions,
  assertEvent,
  assertEventReadOptions,
  assertHead,
  assertHeadWriteOptions,
  assertInitialEvents,
  assertNonEmpty,
  assertOutbox,
  assertOutboxKeys,
  assertOutboxReadOptions,
  assertReceipt,
  assertSessionCreateOptions,
  assertSessionOwner,
  assertTerminalCleanupOptions,
  clone,
  isTerminalStatus,
  sameStart,
} from './invariants.js';
import {
  AUTOMATION_TRACE_MAX_AGE_MS,
  AUTOMATION_TRACE_MAX_BYTES,
  AUTOMATION_TRACE_MAX_COUNT,
  type AutomationDecision,
  type AutomationTrace,
  type AutomationTraceReadOptions,
  type CommandReceipt,
  type DomainEvent,
  type DueSession,
  type DueSessionReadOptions,
  type EventReadOptions,
  type HeadWriteOptions,
  type OutboxKey,
  type OutboxReadOptions,
  type OutboxRecord,
  type SessionCreateOptions,
  type SessionHead,
  type SessionOwner,
  type StorageCapabilities,
  type TerminalCleanupOptions,
} from './types.js';

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

interface SessionData {
  head: SessionHead;
  automationDecisions: Map<string, AutomationDecision>;
  automationTraces: Map<string, AutomationTrace>;
  receipts: Map<string, CommandReceipt>;
  events: Map<string, DomainEvent>;
  outbox: Map<string, OutboxRecord>;
}

interface LocalSessionData {
  head: SessionHead;
  automationDecisions: Map<string, AutomationDecision>;
  automationTraces: Map<string, AutomationTrace>;
  receipts: Map<string, CommandReceipt>;
  events: Map<string, DomainEvent>;
  outbox: Map<string, OutboxRecord>;
}

const MAX_BATCH = 1_000;

function assertBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      `Batch limit must be an integer between 1 and ${MAX_BATCH}`,
    );
  }
}

function eventAggregateKey(event: DomainEvent): string {
  return JSON.stringify([event.producerId, event.aggregateSequence]);
}

function firstBatchItem<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined)
    throw new StorageError(
      'TRANSACTION_CONFLICT',
      'A single append did not return a record',
    );
  return item;
}

function receiptMatches(
  existing: CommandReceipt,
  incoming: CommandReceipt,
): boolean {
  return (
    existing.sessionId === incoming.sessionId &&
    existing.commandId === incoming.commandId &&
    existing.inputHash === incoming.inputHash &&
    existing.actorPrincipalId === incoming.actorPrincipalId
  );
}

/**
 * Deterministic in-process driver. Each transaction works on a deep clone and
 * commits the clone only after the callback succeeds, so failed rule execution
 * cannot leak mutations into the next command.
 */
export class MemoryStorageDriver implements SessionStorageDriver {
  readonly capabilities: StorageCapabilities = {
    sharedUnitOfWork: false,
    serializableTransactions: true,
    boundedResumeReads: true,
    durable: false,
  };

  private readonly sessions = new Map<string, SessionData>();
  private readonly sessionLocks = new Map<string, Mutex>();

  private lock(sessionId: string): Mutex {
    let mutex = this.sessionLocks.get(sessionId);
    if (!mutex) {
      mutex = new Mutex();
      this.sessionLocks.set(sessionId, mutex);
    }
    return mutex;
  }

  async createSession(
    input: SessionHead,
    options: SessionCreateOptions = {},
  ): Promise<SessionHead> {
    assertSessionCreateOptions(options);
    assertHead(input);
    const sessionId = input.route.sessionId;
    assertInitialEvents(options.initialEvents, sessionId, input.eventSequence);
    return this.lock(sessionId).run(async () => {
      const existing = this.sessions.get(sessionId);
      if (existing) {
        if (
          sameStart(existing.head, input) &&
          sameRouteAndParticipants(existing.head, input)
        )
          return clone(existing.head);
        throw new StorageError(
          'DUPLICATE_SESSION',
          `Session ${sessionId} already has a different start`,
        );
      }
      const session: SessionData = {
        head: clone(input),
        automationDecisions: new Map(),
        automationTraces: new Map(),
        receipts: new Map(),
        events: new Map(),
        outbox: new Map(),
      };
      for (const initialEvent of options.initialEvents ?? []) {
        if (session.events.has(initialEvent.eventId))
          throw new StorageError(
            'DUPLICATE_ID',
            `Initial event ${initialEvent.eventId} is duplicated`,
          );
        session.events.set(initialEvent.eventId, clone(initialEvent));
      }
      for (const message of options.initialOutbox ?? []) {
        assertOutbox(message);
        if (message.sessionId !== sessionId)
          throw new StorageError(
            'INVALID_ARGUMENT',
            'Initial outbox session does not match head',
          );
        if (session.outbox.has(message.outboxId)) {
          throw new StorageError(
            'DUPLICATE_ID',
            `Initial outbox ${message.outboxId} is duplicated`,
          );
        }
        session.outbox.set(message.outboxId, clone(message));
      }
      this.sessions.set(sessionId, session);
      return clone(input);
    });
  }

  async getHead(sessionId: string): Promise<SessionHead | null> {
    assertNonEmpty(sessionId, 'sessionId');
    const session = this.sessions.get(sessionId);
    return session ? clone(session.head) : null;
  }

  async getReceipt(
    sessionId: string,
    commandId: string,
    actorPrincipalId?: string,
  ): Promise<CommandReceipt | null> {
    assertNonEmpty(sessionId, 'sessionId');
    assertNonEmpty(commandId, 'commandId');
    if (actorPrincipalId !== undefined)
      assertNonEmpty(actorPrincipalId, 'actorPrincipalId');
    const receipt = this.sessions.get(sessionId)?.receipts.get(commandId);
    if (
      !receipt ||
      (actorPrincipalId !== undefined &&
        receipt.actorPrincipalId !== actorPrincipalId)
    )
      return null;
    return clone(receipt);
  }

  async transaction<T>(
    sessionId: string,
    owner: SessionOwner,
    callback: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T> {
    assertNonEmpty(sessionId, 'sessionId');
    assertSessionOwner(owner);
    return this.lock(sessionId).run(async () => {
      const committed = this.sessions.get(sessionId);
      if (!committed)
        throw new StorageError(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} does not exist`,
        );
      if (committed.head.route.ownershipEpoch !== owner.ownershipEpoch) {
        throw new StorageError(
          'STALE_OWNERSHIP',
          `Session ${sessionId} is owned by another epoch`,
        );
      }

      const local: LocalSessionData = {
        head: clone(committed.head),
        automationDecisions: new Map(
          [...committed.automationDecisions].map(([key, value]) => [
            key,
            clone(value),
          ]),
        ),
        automationTraces: new Map(
          [...committed.automationTraces].map(([key, value]) => [
            key,
            clone(value),
          ]),
        ),
        receipts: new Map(
          [...committed.receipts].map(([key, value]) => [key, clone(value)]),
        ),
        events: new Map(
          [...committed.events].map(([key, value]) => [key, clone(value)]),
        ),
        outbox: new Map(
          [...committed.outbox].map(([key, value]) => [key, clone(value)]),
        ),
      };

      let open = true;
      const assertOpen = (): void => {
        if (!open)
          throw new StorageError(
            'TRANSACTION_CONFLICT',
            'The storage transaction is closed',
          );
      };

      const appendEvents = async (
        events: readonly DomainEvent[],
      ): Promise<readonly DomainEvent[]> => {
        assertOpen();
        const existingEventIds = new Set(local.events.keys());
        const existingAggregateKeys = new Set(
          [...local.events.values()].map(eventAggregateKey),
        );
        const pendingEventIds = new Set<string>();
        const pendingAggregateKeys = new Set<string>();
        for (const event of events) {
          assertEvent(event);
          if (event.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Event session does not match transaction',
            );
          const aggregateKey = eventAggregateKey(event);
          if (
            existingEventIds.has(event.eventId) ||
            pendingEventIds.has(event.eventId) ||
            existingAggregateKeys.has(aggregateKey) ||
            pendingAggregateKeys.has(aggregateKey)
          ) {
            throw new StorageError(
              'DUPLICATE_ID',
              `Event ${event.eventId} or aggregate sequence already exists`,
            );
          }
          pendingEventIds.add(event.eventId);
          pendingAggregateKeys.add(aggregateKey);
        }

        const saved = events.map(clone);
        for (const event of saved)
          local.events.set(event.eventId, clone(event));
        const maxAggregateSequence = saved.reduce(
          (max, event) => Math.max(max, event.aggregateSequence),
          local.head.eventSequence,
        );
        if (maxAggregateSequence > local.head.eventSequence) {
          local.head = clone({
            ...local.head,
            eventSequence: maxAggregateSequence,
          });
        }
        return saved;
      };

      const appendOutboxMany = async (
        messages: readonly OutboxRecord[],
      ): Promise<readonly OutboxRecord[]> => {
        assertOpen();
        const existingOutboxIds = new Set(local.outbox.keys());
        const pendingOutboxIds = new Set<string>();
        for (const message of messages) {
          assertOutbox(message);
          if (message.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Outbox session does not match transaction',
            );
          if (
            existingOutboxIds.has(message.outboxId) ||
            pendingOutboxIds.has(message.outboxId)
          )
            throw new StorageError(
              'DUPLICATE_ID',
              `Outbox ${message.outboxId} already exists`,
            );
          pendingOutboxIds.add(message.outboxId);
        }

        const saved = messages.map(clone);
        for (const message of saved)
          local.outbox.set(message.outboxId, clone(message));
        return saved;
      };

      const tx: SessionTransaction = {
        sessionId,
        getHead: async () => {
          assertOpen();
          return clone(local.head);
        },
        setHead: async (next, options = {}) => {
          assertOpen();
          assertHeadWriteOptions(options);
          assertHead(next);
          if (
            next.route.sessionId !== sessionId ||
            next.startId !== local.head.startId ||
            next.startDigest !== local.head.startDigest ||
            (next.startGeneration ?? 0) !== (local.head.startGeneration ?? 0)
          ) {
            throw new StorageError(
              'INVALID_ARGUMENT',
              'A session head cannot change its session or start identity',
            );
          }
          if (!sameRoutePins(local.head, next)) {
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Session route pins are immutable during a transaction',
            );
          }
          this.assertHeadWrite(local.head, next, owner, options);
          local.head = clone(next);
          return clone(local.head);
        },
        getAutomationDecision: async (decisionId) => {
          assertOpen();
          assertNonEmpty(decisionId, 'decisionId');
          const decision = local.automationDecisions.get(decisionId);
          return decision ? clone(decision) : null;
        },
        putAutomationDecision: async (decision) => {
          assertOpen();
          assertAutomationDecision(decision);
          if (decision.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Automation decision session does not match transaction',
            );
          const existing = local.automationDecisions.get(decision.decisionId);
          if (existing) {
            if (!automationDecisionMatches(existing, decision))
              throw new StorageError(
                'IDEMPOTENCY_CONFLICT',
                `Automation decision ${decision.decisionId} has different payload`,
              );
            return clone(existing);
          }
          local.automationDecisions.set(decision.decisionId, clone(decision));
          return clone(decision);
        },
        deleteAutomationDecision: async (decisionId) => {
          assertOpen();
          assertNonEmpty(decisionId, 'decisionId');
          local.automationDecisions.delete(decisionId);
        },
        clearAutomationDecisions: async () => {
          assertOpen();
          local.automationDecisions.clear();
        },
        getAutomationTrace: async (traceId) => {
          assertOpen();
          assertNonEmpty(traceId, 'traceId');
          const trace = local.automationTraces.get(traceId);
          return trace ? clone(trace) : null;
        },
        putAutomationTrace: async (trace) => {
          assertOpen();
          assertAutomationTrace(trace);
          if (trace.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Automation trace session does not match transaction',
            );
          const existing = local.automationTraces.get(trace.traceId);
          if (existing) {
            if (!automationTraceMatches(existing, trace))
              throw new StorageError(
                'IDEMPOTENCY_CONFLICT',
                `Automation trace ${trace.traceId} has different immutable data`,
              );
          }
          local.automationTraces.set(trace.traceId, clone(trace));
          pruneAutomationTraces(local.automationTraces, trace.createdAt);
          return clone(trace);
        },
        getReceipt: async (commandId, actorPrincipalId) => {
          assertOpen();
          const receipt = local.receipts.get(commandId);
          if (
            !receipt ||
            (actorPrincipalId !== undefined &&
              receipt.actorPrincipalId !== actorPrincipalId)
          )
            return null;
          return clone(receipt);
        },
        putReceipt: async (receipt) => {
          assertOpen();
          assertReceipt(receipt);
          if (receipt.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Receipt session does not match transaction',
            );
          const existing = local.receipts.get(receipt.commandId);
          if (existing) {
            if (!receiptMatches(existing, receipt))
              throw new StorageError(
                'IDEMPOTENCY_CONFLICT',
                `Command ${receipt.commandId} has a different input hash`,
              );
            return clone(existing);
          }
          local.receipts.set(receipt.commandId, clone(receipt));
          return clone(receipt);
        },
        appendEvents,
        appendEvent: async (event) =>
          firstBatchItem(await appendEvents([event])),
        appendOutboxMany,
        appendOutbox: async (message) =>
          firstBatchItem(await appendOutboxMany([message])),
        clearPrivateState: async (cleanupOptions = {}) => {
          assertOpen();
          assertTerminalCleanupOptions(cleanupOptions);
          if (
            cleanupOptions.requireTerminal !== false &&
            !isTerminalStatus(local.head.status)
          )
            throw new StorageError(
              'TERMINAL_REQUIRED',
              'Only terminal sessions can clear private state',
            );
          local.head = clone({ ...local.head, encodedState: null });
          local.events.clear();
          local.automationDecisions.clear();
          return clone(local.head);
        },
      };

      try {
        const result = await callback(tx);
        open = false;
        this.sessions.set(sessionId, {
          head: clone(local.head),
          automationDecisions: new Map(
            [...local.automationDecisions].map(([key, value]) => [
              key,
              clone(value),
            ]),
          ),
          automationTraces: new Map(
            [...local.automationTraces].map(([key, value]) => [
              key,
              clone(value),
            ]),
          ),
          receipts: new Map(
            [...local.receipts].map(([key, value]) => [key, clone(value)]),
          ),
          events: new Map(
            [...local.events].map(([key, value]) => [key, clone(value)]),
          ),
          outbox: new Map(
            [...local.outbox].map(([key, value]) => [key, clone(value)]),
          ),
        });
        return result;
      } catch (error) {
        open = false;
        throw error;
      }
    });
  }

  private assertHeadWrite(
    current: SessionHead,
    next: SessionHead,
    owner: SessionOwner,
    options: HeadWriteOptions,
  ): void {
    const expectedRevision = options.expectedRevision ?? current.revision;
    if (
      expectedRevision !== current.revision ||
      next.revision !== current.revision + 1
    ) {
      throw new StorageError(
        'STALE_REVISION',
        `Expected revision ${expectedRevision}, current revision is ${current.revision}`,
      );
    }
    if (next.eventSequence < current.eventSequence)
      throw new StorageError(
        'STALE_REVISION',
        'Event sequence cannot move backwards',
      );
    const expectedEpoch = options.ownershipEpoch ?? owner.ownershipEpoch;
    if (
      expectedEpoch !== owner.ownershipEpoch ||
      current.route.ownershipEpoch !== owner.ownershipEpoch ||
      next.route.ownershipEpoch !== owner.ownershipEpoch
    ) {
      throw new StorageError(
        'STALE_OWNERSHIP',
        'Session ownership epoch is stale',
      );
    }
  }

  async readEvents(
    sessionId: string,
    options: EventReadOptions,
  ): Promise<readonly DomainEvent[]> {
    assertNonEmpty(sessionId, 'sessionId');
    assertEventReadOptions(options);
    assertBatchLimit(options.limit);
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const after = options.afterSequence ?? -1;
    return [...session.events.values()]
      .filter((event) => event.aggregateSequence > after)
      .sort(
        (a, b) =>
          a.aggregateSequence - b.aggregateSequence ||
          a.eventId.localeCompare(b.eventId),
      )
      .slice(0, options.limit)
      .map(clone);
  }

  async readDueSessions(
    options: DueSessionReadOptions,
  ): Promise<readonly DueSession[]> {
    assertDueSessionReadOptions(options);
    assertBatchLimit(options.limit);
    const now = options.now ?? Date.now();
    await this.pruneAutomationTraces(now);
    return [...this.sessions.values()]
      .filter((session) => session.head.status === 'active')
      .filter((session) => {
        const { route, deadline } = session.head;
        return (
          deadline !== undefined &&
          deadline.dueAt <= now &&
          (options.backendBindingId === undefined ||
            route.backendBindingId === options.backendBindingId) &&
          (options.storageBindingId === undefined ||
            route.storageBindingId === options.storageBindingId) &&
          (options.releaseId === undefined ||
            route.releaseId === options.releaseId) &&
          (options.deadlineKind === undefined ||
            (options.deadlineKind === 'automation'
              ? deadline.deadlineId.startsWith('automation:')
              : !deadline.deadlineId.startsWith('automation:')))
        );
      })
      .sort(
        (a, b) =>
          (a.head.deadline?.dueAt ?? 0) - (b.head.deadline?.dueAt ?? 0) ||
          a.head.route.sessionId.localeCompare(b.head.route.sessionId),
      )
      .slice(0, options.limit)
      .map((session) => ({
        sessionId: session.head.route.sessionId,
        route: clone(session.head.route),
        revision: session.head.revision,
        deadline: clone(
          session.head.deadline as NonNullable<SessionHead['deadline']>,
        ),
      }));
  }

  async readOutboxBatch(
    options: OutboxReadOptions,
  ): Promise<readonly OutboxRecord[]> {
    assertOutboxReadOptions(options);
    assertBatchLimit(options.limit);
    const now = options.now ?? Date.now();
    const rows: OutboxRecord[] = [];
    for (const session of this.sessions.values()) {
      for (const record of session.outbox.values()) {
        if (record.deliveredAt !== undefined) continue;
        if (
          options.sessionId !== undefined &&
          record.sessionId !== options.sessionId
        )
          continue;
        if (
          options.producerId !== undefined &&
          record.producerId !== options.producerId
        )
          continue;
        if (record.nextAttemptAt !== undefined && record.nextAttemptAt > now)
          continue;
        rows.push(record);
      }
    }
    return rows
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.outboxId.localeCompare(b.outboxId),
      )
      .slice(0, options.limit)
      .map(clone);
  }

  async readAutomationTraces(
    sessionId: string,
    options: AutomationTraceReadOptions,
  ): Promise<readonly AutomationTrace[]> {
    assertNonEmpty(sessionId, 'sessionId');
    assertAutomationTraceReadOptions(options);
    return this.lock(sessionId).run(async () => {
      const session = this.sessions.get(sessionId);
      if (!session)
        throw new StorageError(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} does not exist`,
        );
      pruneAutomationTraces(
        session.automationTraces,
        options.now ?? Date.now(),
      );
      return [...session.automationTraces.values()]
        .filter(
          (trace) =>
            (options.kind === undefined || trace.kind === options.kind) &&
            (options.afterCreatedAt === undefined ||
              trace.createdAt > options.afterCreatedAt),
        )
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.traceId.localeCompare(right.traceId),
        )
        .slice(0, options.limit)
        .map(clone);
    });
  }

  async pruneAutomationTraces(now = Date.now()): Promise<number> {
    if (!Number.isFinite(now))
      throw new StorageError('INVALID_ARGUMENT', 'now must be finite');
    let removed = 0;
    for (const [sessionId] of this.sessions) {
      removed += await this.lock(sessionId).run(async () => {
        const session = this.sessions.get(sessionId);
        if (!session) return 0;
        const before = session.automationTraces.size;
        for (const [traceId, trace] of session.automationTraces)
          if (now - trace.createdAt > AUTOMATION_TRACE_MAX_AGE_MS)
            session.automationTraces.delete(traceId);
        return before - session.automationTraces.size;
      });
    }
    return removed;
  }

  async markOutboxDelivered(
    keys: readonly OutboxKey[],
    deliveredAt = Date.now(),
  ): Promise<number> {
    assertOutboxKeys(keys);
    assertBatchLimit(keys.length || 1);
    if (!Number.isFinite(deliveredAt))
      throw new StorageError('INVALID_ARGUMENT', 'deliveredAt must be finite');
    let updated = 0;
    for (const key of keys) {
      await this.lock(key.sessionId).run(async () => {
        const session = this.sessions.get(key.sessionId);
        const existing = session?.outbox.get(key.outboxId);
        if (!session || !existing || existing.deliveredAt !== undefined) return;
        session.outbox.set(
          key.outboxId,
          clone({ ...existing, deliveredAt, attempts: existing.attempts + 1 }),
        );
        updated += 1;
      });
    }
    return updated;
  }

  async markOutboxFailed(
    keys: readonly OutboxKey[],
    nextAttemptAt: number,
  ): Promise<number> {
    assertOutboxKeys(keys);
    assertBatchLimit(keys.length || 1);
    if (!Number.isFinite(nextAttemptAt) || nextAttemptAt < 0)
      throw new StorageError(
        'INVALID_ARGUMENT',
        'nextAttemptAt must be nonnegative and finite',
      );
    let updated = 0;
    for (const key of keys) {
      await this.lock(key.sessionId).run(async () => {
        const session = this.sessions.get(key.sessionId);
        const existing = session?.outbox.get(key.outboxId);
        if (!session || !existing || existing.deliveredAt !== undefined) return;
        session.outbox.set(
          key.outboxId,
          clone({
            ...existing,
            nextAttemptAt: Math.max(existing.nextAttemptAt ?? 0, nextAttemptAt),
            attempts: existing.attempts + 1,
          }),
        );
        updated += 1;
      });
    }
    return updated;
  }

  async clearTerminalSession(
    sessionId: string,
    options: TerminalCleanupOptions = {},
  ): Promise<void> {
    assertNonEmpty(sessionId, 'sessionId');
    assertTerminalCleanupOptions(options);
    return this.lock(sessionId).run(async () => {
      const session = this.sessions.get(sessionId);
      if (!session)
        throw new StorageError(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} does not exist`,
        );
      if (
        options.requireTerminal !== false &&
        !isTerminalStatus(session.head.status)
      ) {
        throw new StorageError(
          'TERMINAL_REQUIRED',
          'Only terminal sessions can be cleared',
        );
      }
      session.events.clear();
      session.automationDecisions.clear();
      session.head = clone({ ...session.head, encodedState: null });
      // Pending and delivered outbox rows remain available to the delivery worker.
    });
  }

  async close(): Promise<void> {
    // The memory driver owns no external resources.
  }
}

export function createMemoryStorageDriver(): MemoryStorageDriver {
  return new MemoryStorageDriver();
}

function sameRoutePins(a: SessionHead, b: SessionHead): boolean {
  return (
    a.route.gameId === b.route.gameId &&
    a.route.modeId === b.route.modeId &&
    a.route.sessionId === b.route.sessionId &&
    a.route.releaseId === b.route.releaseId &&
    a.route.backendBindingId === b.route.backendBindingId &&
    a.route.storageBindingId === b.route.storageBindingId &&
    a.route.ownershipEpoch === b.route.ownershipEpoch
  );
}

function automationDecisionMatches(
  existing: AutomationDecision,
  incoming: AutomationDecision,
): boolean {
  return (
    existing.sessionId === incoming.sessionId &&
    existing.decisionId === incoming.decisionId &&
    existing.commandId === incoming.commandId &&
    existing.deadlineId === incoming.deadlineId &&
    existing.expectedRevision === incoming.expectedRevision &&
    existing.seatId === incoming.seatId &&
    existing.turnId === incoming.turnId &&
    existing.createdAt === incoming.createdAt &&
    JSON.stringify(existing.command) === JSON.stringify(incoming.command)
  );
}

function automationTraceMatches(
  existing: AutomationTrace,
  incoming: AutomationTrace,
): boolean {
  return (
    existing.kind === incoming.kind &&
    existing.sessionId === incoming.sessionId &&
    existing.traceId === incoming.traceId &&
    existing.decisionId === incoming.decisionId &&
    existing.commandId === incoming.commandId &&
    existing.deadlineId === incoming.deadlineId &&
    existing.releaseId === incoming.releaseId &&
    existing.policyId === incoming.policyId &&
    existing.policyVersion === incoming.policyVersion &&
    existing.expectedRevision === incoming.expectedRevision &&
    existing.seatId === incoming.seatId &&
    existing.turnId === incoming.turnId &&
    JSON.stringify(existing.state) === JSON.stringify(incoming.state) &&
    JSON.stringify(existing.input) === JSON.stringify(incoming.input) &&
    existing.schemaVersion === incoming.schemaVersion &&
    JSON.stringify(existing.options) === JSON.stringify(incoming.options) &&
    existing.startedAt === incoming.startedAt &&
    existing.createdAt === incoming.createdAt &&
    existing.eventSequenceStart === incoming.eventSequenceStart &&
    existing.eventSequenceCount === incoming.eventSequenceCount
  );
}

function pruneAutomationTraces(
  traces: Map<string, AutomationTrace>,
  newestCreatedAt: number,
): void {
  const ordered = [...traces.values()].sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.traceId.localeCompare(left.traceId),
  );
  let bytes = 0;
  const keep = new Set<string>();
  for (const trace of ordered) {
    const age = newestCreatedAt - trace.createdAt;
    const size = Buffer.byteLength(JSON.stringify(trace), 'utf8');
    if (
      keep.size < AUTOMATION_TRACE_MAX_COUNT &&
      age <= AUTOMATION_TRACE_MAX_AGE_MS &&
      bytes + size <= AUTOMATION_TRACE_MAX_BYTES
    ) {
      keep.add(trace.traceId);
      bytes += size;
    }
  }
  for (const traceId of traces.keys())
    if (!keep.has(traceId)) traces.delete(traceId);
}

function sameRouteAndParticipants(a: SessionHead, b: SessionHead): boolean {
  if (!sameRoutePins(a, b)) return false;
  return (
    canonicalStableStringify(a.participants) ===
    canonicalStableStringify(b.participants)
  );
}
