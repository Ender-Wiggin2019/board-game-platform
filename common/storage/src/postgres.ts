import { canonicalStableStringify } from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
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
  DEFAULT_STORAGE_SCHEMA,
  migrationStatements,
  tableName,
} from './migration.js';
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
  type ReceiptInput,
  type SessionCreateOptions,
  type SessionHead,
  type SessionOwner,
  type StorageCapabilities,
  type TerminalCleanupOptions,
} from './types.js';

const MAX_BATCH = 1_000;
const MAX_QUERY_PARAMETERS = 65_535;
const EVENT_COLUMN_COUNT = 10;
const OUTBOX_COLUMN_COUNT = 12;
const EVENT_INSERT_CHUNK_SIZE = Math.floor(
  MAX_QUERY_PARAMETERS / EVENT_COLUMN_COUNT,
);
const OUTBOX_INSERT_CHUNK_SIZE = Math.floor(
  MAX_QUERY_PARAMETERS / OUTBOX_COLUMN_COUNT,
);

export interface PostgresStorageOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Use a generated, validated schema name in isolated tests; production defaults to a fixed name. */
  readonly schema?: string;
  /**
   * Runs the transaction callback inside an application-owned context for the
   * checked-out client. The callback receives no client; this hook only lets
   * trusted composition code route read-only authorization queries through the
   * same transaction when the pool is saturated.
   */
  readonly runInTransactionContext?: <T>(
    client: PoolClient,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

type Row = Record<string, unknown>;

/**
 * Durable storage driver. Migrations are explicit: call `await driver.migrate()`
 * during deployment or test setup before using a new schema.
 */
export class PostgresStorageDriver implements SessionStorageDriver {
  readonly capabilities: StorageCapabilities = {
    sharedUnitOfWork: false,
    serializableTransactions: true,
    boundedResumeReads: true,
    durable: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly runInTransactionContext?: PostgresStorageOptions['runInTransactionContext'];

  constructor(options: PostgresStorageOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_STORAGE_SCHEMA;
    this.runInTransactionContext = normalized.runInTransactionContext;
    if (normalized.pool) {
      this.pool = normalized.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...normalized.poolConfig,
        connectionString:
          normalized.connectionString ??
          normalized.poolConfig?.connectionString,
      });
      this.ownsPool = true;
    }
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`board-game-storage:migrations:${this.schema}`],
      );
      for (const statement of migrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error);
    } finally {
      client.release();
    }
  }

  async createSession(
    input: SessionHead,
    options: SessionCreateOptions = {},
  ): Promise<SessionHead> {
    assertSessionCreateOptions(options);
    assertHead(input);
    assertInitialEvents(
      options.initialEvents,
      input.route.sessionId,
      input.eventSequence,
    );
    const client = await this.pool.connect();
    const heads = tableName(this.schema, 'session_heads');
    const starts = tableName(this.schema, 'session_starts');
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await this.lockSession(client, input.route.sessionId);
      const existing = await this.selectHead(
        client,
        input.route.sessionId,
        true,
      );
      if (existing) {
        if (
          !sameStart(existing, input) ||
          !sameRouteAndParticipants(existing, input)
        ) {
          throw new StorageError(
            'DUPLICATE_SESSION',
            `Session ${input.route.sessionId} already has a different start`,
          );
        }
        await client.query('COMMIT');
        return existing;
      }
      const now = Date.now();
      await client.query(
        `INSERT INTO ${starts} (session_id, start_id, start_generation, start_digest, route, participants, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
          input.route.sessionId,
          input.startId,
          input.startGeneration ?? null,
          input.startDigest,
          JSON.stringify(input.route),
          JSON.stringify(input.participants),
          now,
        ],
      );
      await client.query(
        `INSERT INTO ${heads} (session_id, start_id, start_generation, start_digest, route, status, revision, encoded_state, schema_version, participants, summary, logical_time, activated_at, deadline_id, deadline_due_at, automation_failure, event_sequence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16::jsonb, $17, $18, $18)`,
        [
          input.route.sessionId,
          input.startId,
          input.startGeneration ?? null,
          input.startDigest,
          JSON.stringify(input.route),
          input.status,
          input.revision,
          JSON.stringify(input.encodedState),
          input.schemaVersion,
          JSON.stringify(input.participants),
          JSON.stringify(input.summary),
          input.logicalTime,
          input.activatedAt ?? null,
          input.deadline?.deadlineId ?? null,
          input.deadline?.dueAt ?? null,
          JSON.stringify(input.automationFailure ?? null),
          input.eventSequence,
          now,
        ],
      );
      for (const initialEvent of options.initialEvents ?? [])
        await this.insertEvent(client, initialEvent);
      for (const message of options.initialOutbox ?? []) {
        assertOutbox(message);
        if (message.sessionId !== input.route.sessionId)
          throw new StorageError(
            'INVALID_ARGUMENT',
            'Initial outbox session does not match head',
          );
        await this.insertOutbox(client, message);
      }
      await client.query('COMMIT');
      return clone(input);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error);
    } finally {
      client.release();
    }
  }

  async getHead(sessionId: string): Promise<SessionHead | null> {
    assertNonEmpty(sessionId, 'sessionId');
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'session_heads')} WHERE session_id = $1`,
      [sessionId],
    );
    return result.rows[0] ? rowToHead(result.rows[0] as Row) : null;
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
    const params =
      actorPrincipalId === undefined
        ? [sessionId, commandId]
        : [sessionId, commandId, actorPrincipalId];
    const predicate =
      actorPrincipalId === undefined
        ? 'session_id = $1 AND command_id = $2'
        : 'session_id = $1 AND command_id = $2 AND actor_principal_id = $3';
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'command_receipts')} WHERE ${predicate}`,
      params,
    );
    return result.rows[0] ? rowToReceipt(result.rows[0] as Row) : null;
  }

  async transaction<T>(
    sessionId: string,
    owner: SessionOwner,
    callback: (tx: SessionTransaction) => Promise<T>,
  ): Promise<T> {
    assertNonEmpty(sessionId, 'sessionId');
    assertSessionOwner(owner);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await this.lockSession(client, sessionId);
      const head = await this.selectHead(client, sessionId, true);
      if (!head)
        throw new StorageError(
          'SESSION_NOT_FOUND',
          `Session ${sessionId} does not exist`,
        );
      if (head.route.ownershipEpoch !== owner.ownershipEpoch)
        throw new StorageError(
          'STALE_OWNERSHIP',
          `Session ${sessionId} is owned by another epoch`,
        );
      let localHead = clone(head);
      const tx: SessionTransaction = {
        sessionId,
        getHead: async () => clone(localHead),
        setHead: async (next, options = {}) => {
          assertHeadWriteOptions(options);
          assertHead(next);
          assertSameHeadIdentity(localHead, next, sessionId);
          this.assertHeadWrite(localHead, next, owner, options);
          const expectedRevision =
            options.expectedRevision ?? localHead.revision;
          const result = await client.query(
            `UPDATE ${tableName(this.schema, 'session_heads')}
             SET status = $1, revision = $2, encoded_state = $3::jsonb, schema_version = $4, participants = $5::jsonb,
                 summary = $6::jsonb, logical_time = $7, activated_at = $8, deadline_id = $9, deadline_due_at = $10,
                 automation_failure = $11::jsonb, event_sequence = $12, updated_at = $13
             WHERE session_id = $14 AND revision = $15 AND route->>'ownershipEpoch' = $16
             RETURNING *`,
            [
              next.status,
              next.revision,
              JSON.stringify(next.encodedState),
              next.schemaVersion,
              JSON.stringify(next.participants),
              JSON.stringify(next.summary),
              next.logicalTime,
              next.activatedAt ?? null,
              next.deadline?.deadlineId ?? null,
              next.deadline?.dueAt ?? null,
              JSON.stringify(next.automationFailure ?? null),
              next.eventSequence,
              Date.now(),
              sessionId,
              expectedRevision,
              owner.ownershipEpoch,
            ],
          );
          if (result.rowCount !== 1)
            throw new StorageError(
              'STALE_REVISION',
              `Expected revision ${expectedRevision} was not writable`,
            );
          localHead = rowToHead(result.rows[0] as Row);
          return clone(localHead);
        },
        getAutomationDecision: async (decisionId) => {
          assertNonEmpty(decisionId, 'decisionId');
          const result = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'automation_decisions')} WHERE session_id = $1 AND decision_id = $2`,
            [sessionId, decisionId],
          );
          return result.rows[0]
            ? rowToAutomationDecision(result.rows[0] as Row)
            : null;
        },
        putAutomationDecision: async (decision) => {
          assertAutomationDecision(decision);
          if (decision.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Automation decision session does not match transaction',
            );
          const existing = await this.selectAutomationDecision(
            client,
            sessionId,
            decision.decisionId,
          );
          if (existing) {
            if (!automationDecisionMatches(existing, decision))
              throw new StorageError(
                'IDEMPOTENCY_CONFLICT',
                `Automation decision ${decision.decisionId} has different payload`,
              );
            return clone(existing);
          }
          await this.insertAutomationDecision(client, decision);
          return clone(decision);
        },
        deleteAutomationDecision: async (decisionId) => {
          assertNonEmpty(decisionId, 'decisionId');
          await client.query(
            `DELETE FROM ${tableName(this.schema, 'automation_decisions')} WHERE session_id = $1 AND decision_id = $2`,
            [sessionId, decisionId],
          );
        },
        clearAutomationDecisions: async () => {
          await client.query(
            `DELETE FROM ${tableName(this.schema, 'automation_decisions')} WHERE session_id = $1`,
            [sessionId],
          );
        },
        getAutomationTrace: async (traceId) => {
          assertNonEmpty(traceId, 'traceId');
          const result = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'automation_traces')} WHERE session_id = $1 AND trace_id = $2`,
            [sessionId, traceId],
          );
          return result.rows[0]
            ? rowToAutomationTrace(result.rows[0] as Row)
            : null;
        },
        putAutomationTrace: async (trace) => {
          assertAutomationTrace(trace);
          if (trace.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Automation trace session does not match transaction',
            );
          const existing = await this.selectAutomationTrace(
            client,
            sessionId,
            trace.traceId,
          );
          if (existing && !automationTraceMatches(existing, trace))
            throw new StorageError(
              'IDEMPOTENCY_CONFLICT',
              `Automation trace ${trace.traceId} has different immutable data`,
            );
          await this.insertAutomationTrace(client, trace, Boolean(existing));
          return clone(trace);
        },
        getReceipt: async (commandId, actorPrincipalId) => {
          const params =
            actorPrincipalId === undefined
              ? [sessionId, commandId]
              : [sessionId, commandId, actorPrincipalId];
          const predicate =
            actorPrincipalId === undefined
              ? 'session_id = $1 AND command_id = $2'
              : 'session_id = $1 AND command_id = $2 AND actor_principal_id = $3';
          const result = await client.query(
            `SELECT * FROM ${tableName(this.schema, 'command_receipts')} WHERE ${predicate}`,
            params,
          );
          return result.rows[0] ? rowToReceipt(result.rows[0] as Row) : null;
        },
        putReceipt: async (receipt) => {
          assertReceipt(receipt);
          if (receipt.sessionId !== sessionId)
            throw new StorageError(
              'INVALID_ARGUMENT',
              'Receipt session does not match transaction',
            );
          const existing = await this.selectReceipt(
            client,
            sessionId,
            receipt.commandId,
          );
          if (existing) {
            if (!receiptMatches(existing, receipt))
              throw new StorageError(
                'IDEMPOTENCY_CONFLICT',
                `Command ${receipt.commandId} has a different input hash`,
              );
            return clone(existing);
          }
          await this.insertReceipt(client, receipt);
          return clone(receipt);
        },
        appendEvents: async (events) => {
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
              pendingEventIds.has(event.eventId) ||
              pendingAggregateKeys.has(aggregateKey)
            )
              throw new StorageError(
                'DUPLICATE_ID',
                `Event ${event.eventId} or aggregate sequence already exists`,
              );
            pendingEventIds.add(event.eventId);
            pendingAggregateKeys.add(aggregateKey);
          }
          if (events.length === 0) return [];

          for (
            let offset = 0;
            offset < events.length;
            offset += EVENT_INSERT_CHUNK_SIZE
          ) {
            const chunk = events.slice(
              offset,
              offset + EVENT_INSERT_CHUNK_SIZE,
            );
            const values: unknown[] = [];
            const rows = chunk.map((event, index) => {
              const parameterOffset = index * EVENT_COLUMN_COUNT;
              values.push(
                event.sessionId,
                event.eventId,
                event.producerId,
                event.aggregateSequence,
                event.schemaVersion,
                event.sourceRelease,
                JSON.stringify(event.payload),
                event.source === undefined
                  ? null
                  : JSON.stringify(event.source),
                event.logicalTime,
                event.occurredAt ?? Date.now(),
              );
              return `(${Array.from(
                { length: EVENT_COLUMN_COUNT },
                (_, field) => `$${parameterOffset + field + 1}`,
              ).join(', ')})`;
            });
            await client.query(
              `INSERT INTO ${tableName(this.schema, 'domain_events')} (session_id, event_id, producer_id, aggregate_sequence, schema_version, source_release, payload, source, logical_time, occurred_at)
               VALUES ${rows.join(', ')}`,
              values,
            );
          }

          const maxAggregateSequence = events.reduce(
            (max, event) => Math.max(max, event.aggregateSequence),
            localHead.eventSequence,
          );
          if (maxAggregateSequence > localHead.eventSequence) {
            const result = await client.query(
              `UPDATE ${tableName(this.schema, 'session_heads')} SET event_sequence = $1, updated_at = $2 WHERE session_id = $3 RETURNING event_sequence`,
              [maxAggregateSequence, Date.now(), sessionId],
            );
            localHead = clone({
              ...localHead,
              eventSequence: Number(result.rows[0].event_sequence),
            });
          }
          return events.map(clone);
        },
        appendEvent: async (event) =>
          firstBatchItem(await tx.appendEvents([event])),
        appendOutboxMany: async (messages) => {
          const pendingOutboxIds = new Set<string>();
          for (const message of messages) {
            assertOutbox(message);
            if (message.sessionId !== sessionId)
              throw new StorageError(
                'INVALID_ARGUMENT',
                'Outbox session does not match transaction',
              );
            if (pendingOutboxIds.has(message.outboxId))
              throw new StorageError(
                'DUPLICATE_ID',
                `Outbox ${message.outboxId} already exists`,
              );
            pendingOutboxIds.add(message.outboxId);
          }
          if (messages.length === 0) return [];

          for (
            let offset = 0;
            offset < messages.length;
            offset += OUTBOX_INSERT_CHUNK_SIZE
          ) {
            const chunk = messages.slice(
              offset,
              offset + OUTBOX_INSERT_CHUNK_SIZE,
            );
            const values: unknown[] = [];
            const rows = chunk.map((message, index) => {
              const parameterOffset = index * OUTBOX_COLUMN_COUNT;
              values.push(
                message.sessionId,
                message.outboxId,
                message.producerId,
                message.kind,
                message.schemaVersion,
                message.sourceRelease,
                JSON.stringify(message.payload),
                message.aggregateSequence ?? null,
                message.createdAt,
                message.deliveredAt ?? null,
                message.attempts,
                message.nextAttemptAt ?? null,
              );
              return `(${Array.from(
                { length: OUTBOX_COLUMN_COUNT },
                (_, field) => `$${parameterOffset + field + 1}`,
              ).join(', ')})`;
            });
            await client.query(
              `INSERT INTO ${tableName(this.schema, 'outbox')} (session_id, outbox_id, producer_id, kind, schema_version, source_release, payload, aggregate_sequence, created_at, delivered_at, attempts, next_attempt_at)
               VALUES ${rows.join(', ')}`,
              values,
            );
          }
          return messages.map(clone);
        },
        appendOutbox: async (message) =>
          firstBatchItem(await tx.appendOutboxMany([message])),
        clearPrivateState: async (cleanupOptions = {}) => {
          assertTerminalCleanupOptions(cleanupOptions);
          if (
            cleanupOptions.requireTerminal !== false &&
            !isTerminalStatus(localHead.status)
          )
            throw new StorageError(
              'TERMINAL_REQUIRED',
              'Only terminal sessions can clear private state',
            );
          await client.query(
            `DELETE FROM ${tableName(this.schema, 'domain_events')} WHERE session_id = $1`,
            [sessionId],
          );
          await client.query(
            `DELETE FROM ${tableName(this.schema, 'automation_decisions')} WHERE session_id = $1`,
            [sessionId],
          );
          const result = await client.query(
            `UPDATE ${tableName(this.schema, 'session_heads')} SET encoded_state = 'null'::jsonb, updated_at = $1 WHERE session_id = $2 RETURNING *`,
            [Date.now(), sessionId],
          );
          localHead = rowToHead(result.rows[0] as Row);
          return clone(localHead);
        },
      };
      const result = await (this.runInTransactionContext
        ? this.runInTransactionContext(client, () => callback(tx))
        : callback(tx));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error);
    } finally {
      client.release();
    }
  }

  private async lockSession(
    client: PoolClient,
    sessionId: string,
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [sessionId],
    );
  }

  private async selectHead(
    client: PoolClient,
    sessionId: string,
    forUpdate: boolean,
  ): Promise<SessionHead | null> {
    const result = await client.query(
      `SELECT * FROM ${tableName(this.schema, 'session_heads')} WHERE session_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [sessionId],
    );
    return result.rows[0] ? rowToHead(result.rows[0] as Row) : null;
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

  private async selectReceipt(
    client: PoolClient,
    sessionId: string,
    commandId: string,
  ): Promise<CommandReceipt | null> {
    const result = await client.query(
      `SELECT * FROM ${tableName(this.schema, 'command_receipts')} WHERE session_id = $1 AND command_id = $2`,
      [sessionId, commandId],
    );
    return result.rows[0] ? rowToReceipt(result.rows[0] as Row) : null;
  }

  private async selectAutomationDecision(
    client: PoolClient,
    sessionId: string,
    decisionId: string,
  ): Promise<AutomationDecision | null> {
    const result = await client.query(
      `SELECT * FROM ${tableName(this.schema, 'automation_decisions')} WHERE session_id = $1 AND decision_id = $2`,
      [sessionId, decisionId],
    );
    return result.rows[0]
      ? rowToAutomationDecision(result.rows[0] as Row)
      : null;
  }

  private async insertAutomationDecision(
    client: PoolClient,
    decision: AutomationDecision,
  ): Promise<void> {
    assertAutomationDecision(decision);
    await client.query(
      `INSERT INTO ${tableName(this.schema, 'automation_decisions')} (session_id, decision_id, command_id, deadline_id, expected_revision, seat_id, turn_id, command, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        decision.sessionId,
        decision.decisionId,
        decision.commandId,
        decision.deadlineId,
        decision.expectedRevision,
        decision.seatId,
        decision.turnId,
        JSON.stringify(decision.command),
        decision.createdAt,
      ],
    );
  }

  private async selectAutomationTrace(
    client: PoolClient,
    sessionId: string,
    traceId: string,
  ): Promise<AutomationTrace | null> {
    const result = await client.query(
      `SELECT * FROM ${tableName(this.schema, 'automation_traces')} WHERE session_id = $1 AND trace_id = $2`,
      [sessionId, traceId],
    );
    return result.rows[0] ? rowToAutomationTrace(result.rows[0] as Row) : null;
  }

  private async insertAutomationTrace(
    client: PoolClient,
    trace: AutomationTrace,
    update: boolean,
  ): Promise<void> {
    assertAutomationTrace(trace);
    if (update) {
      await client.query(
        `UPDATE ${tableName(this.schema, 'automation_traces')}
         SET command = $3::jsonb, diagnostics = $4::jsonb, outcome = $5,
             finished_at = $6, event_sequence_start = $7,
             event_sequence_count = $8
         WHERE session_id = $1 AND trace_id = $2`,
        [
          trace.sessionId,
          trace.traceId,
          trace.command === undefined ? null : JSON.stringify(trace.command),
          trace.diagnostics === undefined
            ? null
            : JSON.stringify(trace.diagnostics),
          trace.outcome,
          trace.finishedAt ?? null,
          trace.eventSequenceStart ?? null,
          trace.eventSequenceCount ?? null,
        ],
      );
      await this.pruneTraceSession(client, trace.sessionId, trace.createdAt);
      return;
    }
    await client.query(
      `INSERT INTO ${tableName(this.schema, 'automation_traces')}
       (session_id, trace_id, trace_kind, decision_id, command_id, deadline_id, release_id,
        policy_id, policy_version, expected_revision, seat_id, turn_id, state,
        input, schema_version, options, command, diagnostics, outcome,
        started_at, finished_at, created_at, event_sequence_start,
        event_sequence_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15, $16::jsonb, $17::jsonb, $18::jsonb,
               $19, $20, $21, $22, $23, $24)`,
      [
        trace.sessionId,
        trace.traceId,
        trace.kind,
        trace.decisionId,
        trace.commandId,
        trace.deadlineId,
        trace.releaseId,
        trace.policyId,
        trace.policyVersion ?? null,
        trace.expectedRevision,
        trace.seatId,
        trace.turnId,
        JSON.stringify(trace.state),
        JSON.stringify(trace.input),
        trace.schemaVersion,
        JSON.stringify(trace.options),
        trace.command === undefined ? null : JSON.stringify(trace.command),
        trace.diagnostics === undefined
          ? null
          : JSON.stringify(trace.diagnostics),
        trace.outcome,
        trace.startedAt,
        trace.finishedAt ?? null,
        trace.createdAt,
        trace.eventSequenceStart ?? null,
        trace.eventSequenceCount ?? null,
      ],
    );
    await this.pruneTraceSession(client, trace.sessionId, trace.createdAt);
  }

  private async pruneTraceSession(
    client: PoolClient,
    sessionId: string,
    newestCreatedAt: number,
  ): Promise<void> {
    await client.query(
      `WITH ranked AS (
         SELECT trace_id,
                ROW_NUMBER() OVER (ORDER BY created_at DESC, trace_id DESC) AS position,
                SUM(
                  pg_column_size(state) + pg_column_size(input) +
                  pg_column_size(options) + COALESCE(pg_column_size(command), 0) +
                  COALESCE(pg_column_size(diagnostics), 0)
                ) OVER (ORDER BY created_at DESC, trace_id DESC) AS total_bytes
           FROM ${tableName(this.schema, 'automation_traces')}
          WHERE session_id = $1
            AND created_at >= $2::double precision - $3::double precision
       )
       DELETE FROM ${tableName(this.schema, 'automation_traces')} traces
        USING ranked
        WHERE traces.session_id = $1
          AND traces.trace_id = ranked.trace_id
          AND (ranked.position > $4 OR ranked.total_bytes > $5)`,
      [
        sessionId,
        newestCreatedAt,
        AUTOMATION_TRACE_MAX_AGE_MS,
        AUTOMATION_TRACE_MAX_COUNT,
        AUTOMATION_TRACE_MAX_BYTES,
      ],
    );
    await client.query(
      `DELETE FROM ${tableName(this.schema, 'automation_traces')}
        WHERE session_id = $1
          AND created_at < $2::double precision - $3::double precision`,
      [sessionId, newestCreatedAt, AUTOMATION_TRACE_MAX_AGE_MS],
    );
  }

  private async insertReceipt(
    client: PoolClient,
    receipt: ReceiptInput,
  ): Promise<void> {
    assertReceipt(receipt);
    await client.query(
      `INSERT INTO ${tableName(this.schema, 'command_receipts')} (session_id, command_id, actor_principal_id, input_hash, status, result_retention, persisted_revision, persisted_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        receipt.sessionId,
        receipt.commandId,
        receipt.actorPrincipalId,
        receipt.inputHash,
        receipt.status,
        receipt.resultRetention,
        receipt.persistedRevision ?? null,
        receipt.persistedAt ?? null,
        receipt.error ? JSON.stringify(receipt.error) : null,
      ],
    );
  }

  private async insertEvent(
    client: PoolClient,
    event: DomainEvent,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${tableName(this.schema, 'domain_events')} (session_id, event_id, producer_id, aggregate_sequence, schema_version, source_release, payload, source, logical_time, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
      [
        event.sessionId,
        event.eventId,
        event.producerId,
        event.aggregateSequence,
        event.schemaVersion,
        event.sourceRelease,
        JSON.stringify(event.payload),
        event.source === undefined ? null : JSON.stringify(event.source),
        event.logicalTime,
        event.occurredAt ?? Date.now(),
      ],
    );
  }

  private async insertOutbox(
    client: PoolClient,
    message: OutboxRecord,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${tableName(this.schema, 'outbox')} (session_id, outbox_id, producer_id, kind, schema_version, source_release, payload, aggregate_sequence, created_at, delivered_at, attempts, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
      [
        message.sessionId,
        message.outboxId,
        message.producerId,
        message.kind,
        message.schemaVersion,
        message.sourceRelease,
        JSON.stringify(message.payload),
        message.aggregateSequence ?? null,
        message.createdAt,
        message.deliveredAt ?? null,
        message.attempts,
        message.nextAttemptAt ?? null,
      ],
    );
  }

  async readEvents(
    sessionId: string,
    options: EventReadOptions,
  ): Promise<readonly DomainEvent[]> {
    assertNonEmpty(sessionId, 'sessionId');
    assertEventReadOptions(options);
    assertBatchLimit(options.limit);
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'domain_events')} WHERE session_id = $1 AND aggregate_sequence > $2 ORDER BY aggregate_sequence, event_id LIMIT $3`,
      [sessionId, options.afterSequence ?? -1, options.limit],
    );
    return result.rows.map((row) => rowToEvent(row as Row));
  }

  async readDueSessions(
    options: DueSessionReadOptions,
  ): Promise<readonly DueSession[]> {
    assertDueSessionReadOptions(options);
    assertBatchLimit(options.limit);
    const now = options.now ?? Date.now();
    await this.pruneAutomationTraces(now);
    const where = [
      `status = 'active'`,
      'deadline_id IS NOT NULL',
      'deadline_due_at IS NOT NULL',
    ];
    const params: unknown[] = [now];
    where.push(`deadline_due_at <= $${params.length}`);
    const add = (value: unknown, expression: string) => {
      params.push(value);
      where.push(expression.replace('?', `$${params.length}`));
    };
    if (options.backendBindingId !== undefined)
      add(options.backendBindingId, "route->>'backendBindingId' = ?");
    if (options.storageBindingId !== undefined)
      add(options.storageBindingId, "route->>'storageBindingId' = ?");
    if (options.releaseId !== undefined)
      add(options.releaseId, "route->>'releaseId' = ?");
    if (options.deadlineKind === 'automation')
      add('automation:%', 'deadline_id LIKE ?');
    else if (options.deadlineKind === 'system')
      add('automation:%', 'deadline_id NOT LIKE ?');
    params.push(options.limit);
    const result = await this.pool.query(
      `SELECT session_id, route, revision, deadline_id, deadline_due_at
         FROM ${tableName(this.schema, 'session_heads')}
        WHERE ${where.join(' AND ')}
        ORDER BY deadline_due_at, session_id
        LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => ({
      sessionId: String(row.session_id),
      route: row.route as DueSession['route'],
      revision: Number(row.revision),
      deadline: {
        deadlineId: String(row.deadline_id),
        dueAt: Number(row.deadline_due_at),
      },
    }));
  }

  async readOutboxBatch(
    options: OutboxReadOptions,
  ): Promise<readonly OutboxRecord[]> {
    assertOutboxReadOptions(options);
    assertBatchLimit(options.limit);
    const where = ['delivered_at IS NULL'];
    const params: unknown[] = [];
    const add = (value: unknown, expression: string) => {
      params.push(value);
      where.push(expression.replace('?', `$${params.length}`));
    };
    if (options.sessionId !== undefined)
      add(options.sessionId, 'session_id = ?');
    if (options.producerId !== undefined)
      add(options.producerId, 'producer_id = ?');
    const now = options.now ?? Date.now();
    add(now, '(next_attempt_at IS NULL OR next_attempt_at <= ?)');
    params.push(options.limit);
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema, 'outbox')} WHERE ${where.join(' AND ')} ORDER BY created_at, outbox_id LIMIT $${params.length}`,
      params,
    );
    return result.rows.map((row) => rowToOutbox(row as Row));
  }

  async readAutomationTraces(
    sessionId: string,
    options: AutomationTraceReadOptions,
  ): Promise<readonly AutomationTrace[]> {
    assertNonEmpty(sessionId, 'sessionId');
    assertAutomationTraceReadOptions(options);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = options.now ?? Date.now();
      await this.pruneTraceSession(client, sessionId, now);
      const values: unknown[] = [sessionId];
      const predicates = ['session_id = $1'];
      if (options.kind !== undefined) {
        values.push(options.kind);
        predicates.push(`trace_kind = $${values.length}`);
      }
      if (options.afterCreatedAt !== undefined) {
        values.push(options.afterCreatedAt);
        predicates.push(`created_at > $${values.length}`);
      }
      values.push(options.limit);
      const result = await client.query(
        `SELECT * FROM ${tableName(this.schema, 'automation_traces')}
         WHERE ${predicates.join(' AND ')}
         ORDER BY created_at ASC, trace_id ASC
         LIMIT $${values.length}`,
        values,
      );
      await client.query('COMMIT');
      return result.rows.map((row) => rowToAutomationTrace(row as Row));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pruneAutomationTraces(now = Date.now()): Promise<number> {
    if (!Number.isFinite(now))
      throw new StorageError('INVALID_ARGUMENT', 'now must be finite');
    const result = await this.pool.query(
      `DELETE FROM ${tableName(this.schema, 'automation_traces')}
        WHERE created_at < $1::double precision - $2::double precision`,
      [now, AUTOMATION_TRACE_MAX_AGE_MS],
    );
    return result.rowCount ?? 0;
  }

  async markOutboxDelivered(
    keys: readonly OutboxKey[],
    deliveredAt = Date.now(),
  ): Promise<number> {
    assertOutboxKeys(keys);
    assertBatchLimit(keys.length || 1);
    if (!Number.isFinite(deliveredAt))
      throw new StorageError('INVALID_ARGUMENT', 'deliveredAt must be finite');
    const client = await this.pool.connect();
    let updated = 0;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      for (const key of keys) {
        const result = await client.query(
          `UPDATE ${tableName(this.schema, 'outbox')} SET delivered_at = $1, attempts = attempts + 1 WHERE session_id = $2 AND outbox_id = $3 AND delivered_at IS NULL`,
          [deliveredAt, key.sessionId, key.outboxId],
        );
        updated += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asStorageError(error);
    } finally {
      client.release();
    }
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
      const result = await this.pool.query(
        `UPDATE ${tableName(this.schema, 'outbox')} SET next_attempt_at = GREATEST(COALESCE(next_attempt_at, 0), $1), attempts = attempts + 1 WHERE session_id = $2 AND outbox_id = $3 AND delivered_at IS NULL`,
        [nextAttemptAt, key.sessionId, key.outboxId],
      );
      updated += result.rowCount ?? 0;
    }
    return updated;
  }

  async clearTerminalSession(
    sessionId: string,
    options: TerminalCleanupOptions = {},
  ): Promise<void> {
    assertNonEmpty(sessionId, 'sessionId');
    assertTerminalCleanupOptions(options);
    const head = await this.getHead(sessionId);
    if (!head)
      throw new StorageError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} does not exist`,
      );
    if (options.requireTerminal !== false && !isTerminalStatus(head.status))
      throw new StorageError(
        'TERMINAL_REQUIRED',
        'Only terminal sessions can be cleared',
      );
    await this.transaction(
      sessionId,
      { ownershipEpoch: head.route.ownershipEpoch },
      (tx) => tx.clearPrivateState(options).then(() => undefined),
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

function assertBatchLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new StorageError(
      'INVALID_ARGUMENT',
      `Batch limit must be an integer between 1 and ${MAX_BATCH}`,
    );
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

function assertSameHeadIdentity(
  current: SessionHead,
  next: SessionHead,
  sessionId: string,
): void {
  if (
    next.route.sessionId !== sessionId ||
    next.startId !== current.startId ||
    next.startDigest !== current.startDigest ||
    (next.startGeneration ?? 0) !== (current.startGeneration ?? 0) ||
    !sameRoutePins(current, next)
  ) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'A session head cannot change its route pins or start identity',
    );
  }
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

function sameRouteAndParticipants(a: SessionHead, b: SessionHead): boolean {
  return (
    sameRoutePins(a, b) &&
    canonicalStableStringify(a.participants) ===
      canonicalStableStringify(b.participants)
  );
}

function rowToHead(row: Row): SessionHead {
  return {
    route: row.route as SessionHead['route'],
    startId: String(row.start_id),
    ...(row.start_generation === null || row.start_generation === undefined
      ? {}
      : { startGeneration: Number(row.start_generation) }),
    startDigest: String(row.start_digest),
    status: String(row.status) as SessionHead['status'],
    revision: Number(row.revision),
    encodedState: row.encoded_state as SessionHead['encodedState'],
    schemaVersion: Number(row.schema_version),
    participants: row.participants as SessionHead['participants'],
    summary: row.summary as SessionHead['summary'],
    logicalTime: Number(row.logical_time),
    ...(row.automation_failure === null || row.automation_failure === undefined
      ? {}
      : {
          automationFailure:
            row.automation_failure as SessionHead['automationFailure'],
        }),
    activatedAt:
      row.activated_at === null || row.activated_at === undefined
        ? undefined
        : Number(row.activated_at),
    deadline:
      row.deadline_id === null ||
      row.deadline_id === undefined ||
      row.deadline_due_at === null ||
      row.deadline_due_at === undefined
        ? undefined
        : {
            deadlineId: String(row.deadline_id),
            dueAt: Number(row.deadline_due_at),
          },
    eventSequence: Number(row.event_sequence),
  };
}

function rowToReceipt(row: Row): CommandReceipt {
  return {
    sessionId: String(row.session_id),
    commandId: String(row.command_id),
    actorPrincipalId: String(row.actor_principal_id),
    inputHash: String(row.input_hash),
    status: String(row.status) as CommandReceipt['status'],
    resultRetention: String(
      row.result_retention,
    ) as CommandReceipt['resultRetention'],
    persistedRevision:
      row.persisted_revision === null || row.persisted_revision === undefined
        ? undefined
        : Number(row.persisted_revision),
    persistedAt:
      row.persisted_at === null || row.persisted_at === undefined
        ? undefined
        : Number(row.persisted_at),
    error:
      row.error === null || row.error === undefined
        ? undefined
        : (row.error as CommandReceipt['error']),
  };
}

function rowToAutomationDecision(row: Row): AutomationDecision {
  return {
    sessionId: String(row.session_id),
    decisionId: String(row.decision_id),
    commandId: String(row.command_id),
    deadlineId: String(row.deadline_id),
    expectedRevision: Number(row.expected_revision),
    seatId: String(row.seat_id),
    turnId: String(row.turn_id),
    command: row.command as AutomationDecision['command'],
    createdAt: Number(row.created_at),
  };
}

function rowToAutomationTrace(row: Row): AutomationTrace {
  return {
    kind: row.trace_kind === 'command' ? 'command' : 'automation',
    sessionId: String(row.session_id),
    traceId: String(row.trace_id),
    decisionId: String(row.decision_id),
    commandId: String(row.command_id),
    deadlineId: String(row.deadline_id),
    releaseId: String(row.release_id),
    policyId: String(row.policy_id),
    ...(row.policy_version === null || row.policy_version === undefined
      ? {}
      : { policyVersion: String(row.policy_version) }),
    expectedRevision: Number(row.expected_revision),
    seatId: String(row.seat_id),
    turnId: String(row.turn_id),
    state: row.state as AutomationTrace['state'],
    input: row.input as AutomationTrace['input'],
    schemaVersion: Number(row.schema_version),
    options: row.options as AutomationTrace['options'],
    ...(row.command === null || row.command === undefined
      ? {}
      : { command: row.command as AutomationTrace['command'] }),
    ...(row.diagnostics === null || row.diagnostics === undefined
      ? {}
      : {
          diagnostics: row.diagnostics as AutomationTrace['diagnostics'],
        }),
    outcome: String(row.outcome) as AutomationTrace['outcome'],
    startedAt: Number(row.started_at),
    ...(row.finished_at === null || row.finished_at === undefined
      ? {}
      : { finishedAt: Number(row.finished_at) }),
    createdAt: Number(row.created_at),
    ...(row.event_sequence_start === null ||
    row.event_sequence_start === undefined
      ? {}
      : { eventSequenceStart: Number(row.event_sequence_start) }),
    ...(row.event_sequence_count === null ||
    row.event_sequence_count === undefined
      ? {}
      : { eventSequenceCount: Number(row.event_sequence_count) }),
  };
}

function rowToEvent(row: Row): DomainEvent {
  return {
    eventId: String(row.event_id),
    sessionId: String(row.session_id),
    producerId: String(row.producer_id),
    aggregateSequence: Number(row.aggregate_sequence),
    schemaVersion: Number(row.schema_version),
    sourceRelease: String(row.source_release),
    payload: row.payload as DomainEvent['payload'],
    ...(row.source === null || row.source === undefined
      ? {}
      : { source: row.source as DomainEvent['source'] }),
    logicalTime: Number(row.logical_time),
    occurredAt: Number(row.occurred_at),
  };
}

function rowToOutbox(row: Row): OutboxRecord {
  return {
    outboxId: String(row.outbox_id),
    sessionId: String(row.session_id),
    producerId: String(row.producer_id),
    kind: String(row.kind),
    schemaVersion: Number(row.schema_version),
    sourceRelease: String(row.source_release),
    payload: row.payload as OutboxRecord['payload'],
    aggregateSequence:
      row.aggregate_sequence === null || row.aggregate_sequence === undefined
        ? undefined
        : Number(row.aggregate_sequence),
    createdAt: Number(row.created_at),
    deliveredAt:
      row.delivered_at === null || row.delivered_at === undefined
        ? undefined
        : Number(row.delivered_at),
    attempts: Number(row.attempts),
    ...(row.next_attempt_at != null
      ? { nextAttemptAt: Number(row.next_attempt_at) }
      : {}),
  };
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

function asStorageError(error: unknown): Error {
  if (error instanceof StorageError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (code === '23505')
    return new StorageError(
      'DUPLICATE_ID',
      'A durable storage identifier already exists',
    );
  if (code === '40001' || code === '40P01')
    return new StorageError(
      'TRANSACTION_CONFLICT',
      'A serializable storage transaction conflicted',
      true,
    );
  if (code === '42P01')
    return new StorageError(
      'MIGRATION_REQUIRED',
      'Storage tables are not migrated',
    );
  if (error instanceof Error) return error;
  return new StorageError(
    'DATABASE_ERROR',
    'Durable storage operation failed',
    true,
  );
}

export function createPostgresStorageDriver(
  options: PostgresStorageOptions | string,
): PostgresStorageDriver {
  return new PostgresStorageDriver(options);
}
