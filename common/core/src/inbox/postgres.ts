import { createHash } from 'node:crypto';
import {
  canonicalStableStringify,
  type JsonValue,
} from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { InboxError } from './errors.js';
import {
  assertSchemaName,
  DEFAULT_INBOX_SCHEMA,
  migrationStatements,
  tableName,
} from './migration.js';
import type {
  ConsumeOutcome,
  ConsumerReceipt,
  FactEnvelope,
  InboxCapabilities,
  InboxEffectInput,
  InboxEffectRecord,
  InboxEnvelope,
  InboxStore,
  InboxUnitOfWork,
  ListEffectsOptions,
  ListPendingOptions,
  RetryDeadLettersOptions,
} from './types.js';
import { MAX_INBOX_CONSUMER_ATTEMPTS } from './types.js';

const MAX_BATCH = 1_000;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 60_000;
type Row = Record<string, unknown>;

function retryAt(attempts: number, now: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  return (
    now + Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent)
  );
}

export interface PostgresInboxOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Must be a validated identifier; SQL never changes search_path. */
  readonly schema?: string;
  readonly now?: () => number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertObject(value: unknown, name: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InboxError('INVALID_ARGUMENT', `${name} must be an object`);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string`,
    );
}

function assertTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a finite timestamp`,
    );
}

function assertNonNegativeInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative integer`,
    );
}

function assertPositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `${name} must be a positive integer`,
    );
}

function assertJson(value: unknown, name: string): asserts value is JsonValue {
  try {
    canonicalStableStringify(value);
  } catch {
    throw new InboxError('INVALID_ARGUMENT', `${name} must be JSON safe`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH)
    throw new InboxError(
      'INVALID_ARGUMENT',
      `limit must be an integer between 1 and ${MAX_BATCH}`,
    );
}

function pairKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function envelopeKey(producerId: string, eventId: string): string {
  return Buffer.from(JSON.stringify([producerId, eventId]), 'utf8').toString(
    'base64url',
  );
}

function parseEnvelopeKey(value: string): readonly [string, string] {
  assertString(value, 'envelopeKey');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new InboxError('INVALID_ARGUMENT', 'envelopeKey is invalid');
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    typeof decoded[1] !== 'string' ||
    decoded[0].length === 0 ||
    decoded[1].length === 0
  )
    throw new InboxError('INVALID_ARGUMENT', 'envelopeKey is invalid');
  return [decoded[0], decoded[1]];
}

function digestOf(value: JsonValue): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

function envelopeDigest(envelope: FactEnvelope): string {
  return digestOf({
    producerId: envelope.producerId,
    eventId: envelope.eventId,
    sessionId: envelope.sessionId ?? null,
    kind: envelope.kind,
    schemaVersion: envelope.schemaVersion,
    sourceRelease: envelope.sourceRelease,
    aggregateSequence: envelope.aggregateSequence ?? null,
    occurredAt: envelope.occurredAt ?? null,
    payload: envelope.payload,
  });
}

function effectDigest(payload: JsonValue): string {
  return digestOf(payload);
}

function validateEnvelope(input: FactEnvelope): {
  readonly canonicalDigest: string;
  readonly storedDigest: string;
} {
  assertObject(input, 'envelope');
  assertString(input.producerId, 'producerId');
  assertString(input.eventId, 'eventId');
  if (input.sessionId !== undefined) assertString(input.sessionId, 'sessionId');
  assertString(input.kind, 'kind');
  assertPositiveInteger(input.schemaVersion, 'schemaVersion');
  assertString(input.sourceRelease, 'sourceRelease');
  assertJson(input.payload, 'payload');
  if (input.aggregateSequence !== undefined)
    assertNonNegativeInteger(input.aggregateSequence, 'aggregateSequence');
  if (input.occurredAt !== undefined)
    assertTimestamp(input.occurredAt, 'occurredAt');
  if (input.receivedAt !== undefined)
    assertTimestamp(input.receivedAt, 'receivedAt');
  const canonicalDigest = envelopeDigest(input);
  if (input.digest !== undefined) {
    assertString(input.digest, 'digest');
  }
  return {
    canonicalDigest,
    storedDigest: input.digest ?? canonicalDigest,
  };
}

function validateEffect(effect: InboxEffectInput): void {
  assertObject(effect, 'effect');
  assertString(effect.effectId, 'effectId');
  assertJson(effect.payload, 'effect payload');
  if (effect.createdAt !== undefined)
    assertTimestamp(effect.createdAt, 'effect.createdAt');
}

function asInboxError(error: unknown): InboxError {
  if (error instanceof InboxError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000')
    return new InboxError(
      'MIGRATION_REQUIRED',
      'Inbox schema has not been migrated',
      false,
    );
  if (code === '40001' || code === '40P01')
    return new InboxError(
      'DATABASE_ERROR',
      'Inbox transaction was aborted',
      true,
    );
  return new InboxError(
    'DATABASE_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new InboxError('DATABASE_ERROR', `Inbox row has invalid ${key}`);
  return value;
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw new InboxError('DATABASE_ERROR', `Inbox row has invalid ${key}`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value))
    throw new InboxError('DATABASE_ERROR', `Inbox row has invalid ${key}`);
  return value;
}

function optionalNumber(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new InboxError('DATABASE_ERROR', `Inbox row has invalid ${key}`);
  return number;
}

function rowJson(row: Row, key: string): JsonValue {
  const value = row[key];
  assertJson(value, `Inbox row ${key}`);
  return clone(value);
}

function rowToEnvelope(row: Row): InboxEnvelope {
  const producerId = requiredString(row, 'producer_id');
  const eventId = requiredString(row, 'event_id');
  const schemaVersion = rowNumber(row, 'schema_version');
  assertPositiveInteger(schemaVersion, 'schema_version');
  const aggregateSequence = optionalNumber(row, 'aggregate_sequence');
  if (aggregateSequence !== undefined)
    assertNonNegativeInteger(aggregateSequence, 'aggregate_sequence');
  const occurredAt = optionalNumber(row, 'occurred_at');
  if (occurredAt !== undefined) assertTimestamp(occurredAt, 'occurred_at');
  const receivedAt = rowNumber(row, 'received_at');
  assertTimestamp(receivedAt, 'received_at');
  const sessionId = optionalString(row, 'session_id');
  return {
    producerId,
    eventId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    kind: requiredString(row, 'kind'),
    schemaVersion,
    sourceRelease: requiredString(row, 'source_release'),
    payload: rowJson(row, 'payload'),
    ...(aggregateSequence !== undefined ? { aggregateSequence } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    envelopeKey: envelopeKey(producerId, eventId),
    digest: requiredString(row, 'digest'),
    receivedAt,
  };
}

function rowToReceipt(row: Row): ConsumerReceipt {
  const consumerKey = requiredString(row, 'consumer_key');
  const producerId = requiredString(row, 'producer_id');
  const eventId = requiredString(row, 'event_id');
  const attempts = rowNumber(row, 'attempts');
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new InboxError(
      'DATABASE_ERROR',
      'Inbox receipt attempts are invalid',
    );
  const status = requiredString(row, 'status');
  if (status !== 'failed' && status !== 'dead-letter' && status !== 'completed')
    throw new InboxError('DATABASE_ERROR', 'Inbox receipt status is invalid');
  const lastAttemptAt = rowNumber(row, 'last_attempt_at');
  assertTimestamp(lastAttemptAt, 'last_attempt_at');
  const nextAttemptAt = optionalNumber(row, 'next_attempt_at');
  if (nextAttemptAt !== undefined)
    assertTimestamp(nextAttemptAt, 'next_attempt_at');
  const completedAt = optionalNumber(row, 'completed_at');
  if (completedAt !== undefined) assertTimestamp(completedAt, 'completed_at');
  return {
    consumerKey,
    envelopeKey: envelopeKey(producerId, eventId),
    producerId,
    eventId,
    status,
    attempts,
    lastAttemptAt,
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function rowToEffect(row: Row): InboxEffectRecord {
  const consumerKey = requiredString(row, 'consumer_key');
  const producerId = requiredString(row, 'producer_id');
  const eventId = requiredString(row, 'event_id');
  const createdAt = rowNumber(row, 'created_at');
  assertTimestamp(createdAt, 'created_at');
  return {
    consumerKey,
    envelopeKey: envelopeKey(producerId, eventId),
    producerId,
    eventId,
    effectId: requiredString(row, 'effect_id'),
    digest: requiredString(row, 'digest'),
    payload: rowJson(row, 'payload'),
    createdAt,
  };
}

/** Durable inbox backed by explicit schema migrations and per-key transactions. */
export class PostgresInboxStore implements InboxStore {
  readonly capabilities: InboxCapabilities = {
    durable: true,
    serializableTransactions: false,
    boundedReads: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly now: () => number;

  constructor(options: PostgresInboxOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_INBOX_SCHEMA;
    assertSchemaName(this.schema);
    this.now = normalized.now ?? Date.now;
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
        [`board-game-inbox:migrations:${this.schema}`],
      );
      for (const statement of migrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asInboxError(error);
    } finally {
      client.release();
    }
  }

  async accept(input: FactEnvelope): Promise<InboxEnvelope> {
    const { canonicalDigest, storedDigest } = validateEnvelope(input);
    const client = await this.pool.connect();
    try {
      // The advisory lock serializes this fact/consumer key. READ COMMITTED
      // lets a waiter observe the receipt committed by the transaction it
      // waited behind; a SERIALIZABLE snapshot taken before the wait would
      // otherwise force a needless retry after the callback ran.
      await client.query('BEGIN');
      await this.lockFact(client, input.producerId, input.eventId);
      const facts = tableName(this.schema, 'facts');
      const existingResult = await client.query(
        `SELECT * FROM ${facts} WHERE producer_id = $1 AND event_id = $2`,
        [input.producerId, input.eventId],
      );
      if (existingResult.rows[0]) {
        const existing = rowToEnvelope(existingResult.rows[0] as Row);
        if (
          envelopeDigest(existing) !== canonicalDigest ||
          (input.digest !== undefined && existing.digest !== input.digest)
        )
          throw new InboxError(
            'IDEMPOTENCY_CONFLICT',
            `Fact ${input.producerId}/${input.eventId} has a different digest`,
          );
        await client.query('COMMIT');
        return clone(existing);
      }
      const receivedAt = input.receivedAt ?? this.now();
      assertTimestamp(receivedAt, 'receivedAt');
      await client.query(
        `INSERT INTO ${facts} (producer_id, event_id, session_id, kind, schema_version, source_release, aggregate_sequence, payload, occurred_at, received_at, digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
        [
          input.producerId,
          input.eventId,
          input.sessionId ?? null,
          input.kind,
          input.schemaVersion,
          input.sourceRelease,
          input.aggregateSequence ?? null,
          JSON.stringify(input.payload),
          input.occurredAt ?? null,
          receivedAt,
          storedDigest,
        ],
      );
      await client.query('COMMIT');
      return {
        producerId: input.producerId,
        eventId: input.eventId,
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        kind: input.kind,
        schemaVersion: input.schemaVersion,
        sourceRelease: input.sourceRelease,
        payload: clone(input.payload),
        ...(input.aggregateSequence !== undefined
          ? { aggregateSequence: input.aggregateSequence }
          : {}),
        ...(input.occurredAt !== undefined
          ? { occurredAt: input.occurredAt }
          : {}),
        envelopeKey: envelopeKey(input.producerId, input.eventId),
        digest: storedDigest,
        receivedAt,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asInboxError(error);
    } finally {
      client.release();
    }
  }

  async getEnvelope(key: string): Promise<InboxEnvelope | null> {
    const [producerId, eventId] = parseEnvelopeKey(key);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'facts')} WHERE producer_id = $1 AND event_id = $2`,
        [producerId, eventId],
      );
      return result.rows[0]
        ? clone(rowToEnvelope(result.rows[0] as Row))
        : null;
    } catch (error) {
      throw asInboxError(error);
    }
  }

  async getReceipt(
    consumerKey: string,
    key: string,
  ): Promise<ConsumerReceipt | null> {
    assertString(consumerKey, 'consumerKey');
    const [producerId, eventId] = parseEnvelopeKey(key);
    try {
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'consumer_receipts')} WHERE consumer_key = $1 AND producer_id = $2 AND event_id = $3`,
        [consumerKey, producerId, eventId],
      );
      return result.rows[0] ? clone(rowToReceipt(result.rows[0] as Row)) : null;
    } catch (error) {
      throw asInboxError(error);
    }
  }

  async transactConsume<Result>(
    consumerKey: string,
    key: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>> {
    assertString(consumerKey, 'consumerKey');
    if (typeof callback !== 'function')
      throw new InboxError('INVALID_ARGUMENT', 'callback must be a function');
    const [producerId, eventId] = parseEnvelopeKey(key);
    const canonicalKey = envelopeKey(producerId, eventId);
    const client = await this.pool.connect();
    let transactionOpen = false;
    let callbackFailed = false;
    let callbackError: unknown;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await this.lockConsume(client, consumerKey, canonicalKey);
      const envelopeResult = await client.query(
        `SELECT * FROM ${tableName(this.schema, 'facts')} WHERE producer_id = $1 AND event_id = $2 FOR SHARE`,
        [producerId, eventId],
      );
      if (!envelopeResult.rows[0])
        throw new InboxError(
          'ENVELOPE_NOT_FOUND',
          `Envelope ${key} does not exist`,
        );
      const envelope = rowToEnvelope(envelopeResult.rows[0] as Row);
      const receipts = tableName(this.schema, 'consumer_receipts');
      const receiptResult = await client.query(
        `SELECT * FROM ${receipts} WHERE consumer_key = $1 AND producer_id = $2 AND event_id = $3 FOR UPDATE`,
        [consumerKey, producerId, eventId],
      );
      const existing = receiptResult.rows[0]
        ? rowToReceipt(receiptResult.rows[0] as Row)
        : undefined;
      if (existing?.status === 'completed') {
        await client.query('COMMIT');
        transactionOpen = false;
        return { status: 'duplicate', receipt: clone(existing) };
      }
      if (existing?.status === 'dead-letter') {
        await client.query('COMMIT');
        transactionOpen = false;
        return { status: 'dead-letter', receipt: clone(existing) };
      }
      const attempts = (existing?.attempts ?? 0) + 1;
      const attemptedAt = this.now();
      assertTimestamp(attemptedAt, 'now');
      let open = true;
      const assertOpen = (): void => {
        if (!open)
          throw new InboxError(
            'DATABASE_ERROR',
            'The inbox unit of work is closed',
            false,
          );
      };
      const unitOfWork: InboxUnitOfWork = {
        envelope: clone(envelope),
        appendEffect: async (input) => {
          assertOpen();
          validateEffect(input);
          const digest = effectDigest(input.payload);
          const effects = tableName(this.schema, 'consumer_effects');
          const createdAt = input.createdAt ?? this.now();
          assertTimestamp(createdAt, 'effect.createdAt');
          const inserted = await client.query(
            `INSERT INTO ${effects} (consumer_key, effect_id, producer_id, event_id, digest, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (consumer_key, effect_id) DO NOTHING
             RETURNING *`,
            [
              consumerKey,
              input.effectId,
              producerId,
              eventId,
              digest,
              JSON.stringify(input.payload),
              createdAt,
            ],
          );
          if (inserted.rows[0])
            return clone(rowToEffect(inserted.rows[0] as Row));
          const existingResult = await client.query(
            `SELECT * FROM ${effects} WHERE consumer_key = $1 AND effect_id = $2 FOR UPDATE`,
            [consumerKey, input.effectId],
          );
          if (!existingResult.rows[0])
            throw new InboxError('DATABASE_ERROR', 'Inbox effect disappeared');
          const existingEffect = rowToEffect(existingResult.rows[0] as Row);
          if (
            existingEffect.producerId !== producerId ||
            existingEffect.eventId !== eventId ||
            existingEffect.digest !== digest
          )
            throw new InboxError(
              'IDEMPOTENCY_CONFLICT',
              `Effect ${consumerKey}/${input.effectId} conflicts with a prior effect`,
            );
          return clone(existingEffect);
        },
      };

      let result!: Result;
      try {
        result = await callback(unitOfWork);
        open = false;
      } catch (error) {
        open = false;
        callbackFailed = true;
        callbackError = error;
        await client.query('ROLLBACK');
        transactionOpen = false;
        try {
          await this.recordFailure(client, consumerKey, producerId, eventId);
        } catch (failureError) {
          callbackFailed = false;
          throw failureError;
        }
        throw error;
      }

      const completedAt = this.now();
      assertTimestamp(completedAt, 'completedAt');
      await client.query(
        `INSERT INTO ${receipts} (consumer_key, producer_id, event_id, status, attempts, last_attempt_at, next_attempt_at, completed_at)
         VALUES ($1, $2, $3, 'completed', $4, $5, NULL, $6)
         ON CONFLICT (consumer_key, producer_id, event_id)
         DO UPDATE SET status = 'completed', attempts = EXCLUDED.attempts, last_attempt_at = EXCLUDED.last_attempt_at, next_attempt_at = NULL, completed_at = EXCLUDED.completed_at`,
        [consumerKey, producerId, eventId, attempts, attemptedAt, completedAt],
      );
      const receipt = rowToReceipt(
        (
          await client.query(
            `SELECT * FROM ${receipts} WHERE consumer_key = $1 AND producer_id = $2 AND event_id = $3`,
            [consumerKey, producerId, eventId],
          )
        ).rows[0] as Row,
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { status: 'processed', receipt: clone(receipt), result };
    } catch (error) {
      if (transactionOpen)
        await client.query('ROLLBACK').catch(() => undefined);
      if (callbackFailed) throw callbackError;
      const mapped = asInboxError(error);
      if (mapped.retryable) {
        await this.recordFailure(
          client,
          consumerKey,
          producerId,
          eventId,
        ).catch(() => undefined);
      }
      throw mapped;
    } finally {
      client.release();
    }
  }

  async consumeOnce<Result>(
    consumerKey: string,
    key: string,
    callback: (unitOfWork: InboxUnitOfWork) => Promise<Result>,
  ): Promise<ConsumeOutcome<Result>> {
    return this.transactConsume(consumerKey, key, callback);
  }

  async listEffects(
    consumerKey: string,
    options: ListEffectsOptions = {},
  ): Promise<readonly InboxEffectRecord[]> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    const limit = options.limit ?? MAX_BATCH;
    assertLimit(limit);
    let envelopeFilter: readonly [string, string] | undefined;
    if (options.envelopeKey !== undefined)
      envelopeFilter = parseEnvelopeKey(options.envelopeKey);
    try {
      const params: unknown[] = [consumerKey];
      let predicate = 'consumer_key = $1';
      if (envelopeFilter) {
        params.push(envelopeFilter[0], envelopeFilter[1]);
        predicate += ' AND producer_id = $2 AND event_id = $3';
      }
      params.push(limit);
      const result = await this.pool.query(
        `SELECT * FROM ${tableName(this.schema, 'consumer_effects')} WHERE ${predicate} ORDER BY created_at, effect_id LIMIT $${params.length}`,
        params,
      );
      return result.rows.map((row) => clone(rowToEffect(row as Row)));
    } catch (error) {
      throw asInboxError(error);
    }
  }

  async listPending(
    consumerKey: string,
    options: ListPendingOptions,
  ): Promise<readonly InboxEnvelope[]> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    assertLimit(options.limit);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    try {
      const result = await this.pool.query(
        `SELECT f.*
           FROM ${tableName(this.schema, 'facts')} f
           LEFT JOIN ${tableName(this.schema, 'consumer_receipts')} r
             ON r.consumer_key = $1
            AND r.producer_id = f.producer_id
            AND r.event_id = f.event_id
          WHERE r.status IS NULL
             OR (r.status = 'failed'
                 AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= $2))
          ORDER BY f.received_at, f.producer_id, f.event_id
          LIMIT $3`,
        [consumerKey, now, options.limit],
      );
      return result.rows.map((row) => clone(rowToEnvelope(row as Row)));
    } catch (error) {
      throw asInboxError(error);
    }
  }

  async retryDeadLetters(
    consumerKey: string,
    options: RetryDeadLettersOptions,
  ): Promise<number> {
    assertString(consumerKey, 'consumerKey');
    assertObject(options, 'options');
    assertLimit(options.limit);
    const now = options.now ?? this.now();
    assertTimestamp(now, 'now');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const receipts = tableName(this.schema, 'consumer_receipts');
      const selected = await client.query(
        `SELECT producer_id, event_id
           FROM ${receipts}
          WHERE consumer_key = $1 AND status = 'dead-letter'
          ORDER BY last_attempt_at, producer_id, event_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [consumerKey, options.limit],
      );
      let retried = 0;
      for (const row of selected.rows as Row[]) {
        const producerId = requiredString(row, 'producer_id');
        const eventId = requiredString(row, 'event_id');
        const result = await client.query(
          `UPDATE ${receipts}
              SET status = 'failed', next_attempt_at = $4, completed_at = NULL
            WHERE consumer_key = $1
              AND producer_id = $2
              AND event_id = $3
              AND status = 'dead-letter'`,
          [consumerKey, producerId, eventId, now],
        );
        retried += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return retried;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asInboxError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async lockFact(
    client: PoolClient,
    producerId: string,
    eventId: string,
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [pairKey(producerId, eventId)],
    );
  }

  private async lockConsume(
    client: PoolClient,
    consumerKey: string,
    key: string,
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [pairKey(consumerKey, key)],
    );
  }

  private async recordFailure(
    client: PoolClient,
    consumerKey: string,
    producerId: string,
    eventId: string,
  ): Promise<void> {
    try {
      await client.query('BEGIN');
      await this.lockConsume(
        client,
        consumerKey,
        envelopeKey(producerId, eventId),
      );
      const receipts = tableName(this.schema, 'consumer_receipts');
      const existingResult = await client.query(
        `SELECT * FROM ${receipts} WHERE consumer_key = $1 AND producer_id = $2 AND event_id = $3 FOR UPDATE`,
        [consumerKey, producerId, eventId],
      );
      const existing = existingResult.rows[0]
        ? rowToReceipt(existingResult.rows[0] as Row)
        : undefined;
      if (existing?.status === 'completed') {
        await client.query('COMMIT');
        return;
      }
      const attempts = (existing?.attempts ?? 0) + 1;
      const deadLettered = attempts >= MAX_INBOX_CONSUMER_ATTEMPTS;
      const attemptedAt = this.now();
      assertTimestamp(attemptedAt, 'now');
      await client.query(
        `INSERT INTO ${receipts} (consumer_key, producer_id, event_id, status, attempts, last_attempt_at, next_attempt_at, completed_at)
         VALUES ($1, $2, $3, $6, $4, $5, $7, NULL)
         ON CONFLICT (consumer_key, producer_id, event_id)
         DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts, last_attempt_at = EXCLUDED.last_attempt_at, next_attempt_at = EXCLUDED.next_attempt_at, completed_at = NULL`,
        [
          consumerKey,
          producerId,
          eventId,
          attempts,
          attemptedAt,
          deadLettered ? 'dead-letter' : 'failed',
          deadLettered ? null : retryAt(attempts, attemptedAt),
        ],
      );
      await client.query('COMMIT');
    } catch (failureError) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asInboxError(failureError);
    }
  }
}
