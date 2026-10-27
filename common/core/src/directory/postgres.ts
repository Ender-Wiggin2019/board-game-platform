import {
  canonicalStableStringify,
  type JsonValue,
  type SessionStatus,
} from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { DirectoryError } from './errors.js';
import {
  assertRecordMatchesAdmission,
  assertSessionId,
  assertSourceMatches,
  clone,
  decodeCursor,
  encodeCursor,
  validateAdmission,
  validateEnvelope,
  validateListOptions,
  validateRecord,
} from './invariants.js';
import {
  assertDirectorySchemaName,
  DEFAULT_DIRECTORY_SCHEMA,
  directoryMigrationStatements,
  directoryTableName,
} from './migration.js';
import { applyProjection, type StoredDirectoryFact } from './projection.js';
import type {
  SessionDirectoryAdmissionLookup,
  SessionDirectoryCapabilities,
  SessionDirectoryEnvelope,
  SessionDirectoryListOptions,
  SessionDirectoryOptions,
  SessionDirectoryPage,
  SessionDirectoryRecord,
  SessionDirectoryStore,
} from './types.js';

type Row = Record<string, unknown>;

export interface PostgresSessionDirectoryOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  /** Validated identifier; SQL always schema-qualifies and never changes search_path. */
  readonly schema?: string;
  readonly admission: SessionDirectoryOptions['admission'];
  readonly retentionResolver: SessionDirectoryOptions['retentionResolver'];
  readonly now?: () => number;
}

function asDirectoryError(error: unknown): DirectoryError {
  if (error instanceof DirectoryError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000')
    return new DirectoryError(
      'MIGRATION_REQUIRED',
      'directory schema has not been migrated',
      false,
    );
  if (code === '40001' || code === '40P01')
    return new DirectoryError(
      'DATABASE_ERROR',
      'directory transaction was aborted and may be retried',
      true,
    );
  if (code === '23505')
    return new DirectoryError(
      'FACT_CONFLICT',
      'directory fact conflicts with an existing record',
      false,
    );
  return new DirectoryError(
    'DATABASE_ERROR',
    error instanceof Error ? error.message : String(error),
  );
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new DirectoryError(
      'DATABASE_ERROR',
      `directory row has invalid ${key}`,
      false,
    );
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) && key === 'latest_aggregate_sequence')
    throw new DirectoryError(
      'DATABASE_ERROR',
      `directory row has invalid ${key}`,
      false,
    );
  if (!Number.isFinite(value))
    throw new DirectoryError(
      'DATABASE_ERROR',
      `directory row has invalid ${key}`,
      false,
    );
  return value;
}

function rowJson(row: Row, key: string): JsonValue {
  const value = row[key];
  try {
    canonicalStableStringify(value);
  } catch {
    throw new DirectoryError(
      'DATABASE_ERROR',
      `directory row has invalid ${key}`,
      false,
    );
  }
  return clone(value as JsonValue);
}

function optionalRowJson(row: Row, key: string): JsonValue | undefined {
  if (row[key] === null || row[key] === undefined) return undefined;
  return rowJson(row, key);
}

function rowToRecord(row: Row): SessionDirectoryRecord {
  const status = rowString(row, 'status');
  if (
    !['suspended', 'active', 'completed', 'cancelled', 'paused'].includes(
      status,
    )
  )
    throw new DirectoryError(
      'DATABASE_ERROR',
      'directory row has invalid status',
      false,
    );
  const visibility = rowString(row, 'visibility');
  if (visibility !== 'public' && visibility !== 'private')
    throw new DirectoryError(
      'DATABASE_ERROR',
      'directory row has invalid visibility',
      false,
    );
  const route = {
    gameId: rowString(row, 'game_id'),
    modeId: rowString(row, 'mode_id'),
    sessionId: rowString(row, 'session_id'),
    releaseId: rowString(row, 'release_id'),
    backendBindingId: rowString(row, 'backend_binding_id'),
    storageBindingId: rowString(row, 'storage_binding_id'),
    ownershipEpoch: rowString(row, 'ownership_epoch'),
  };
  const participants = rowJson(row, 'participants');
  const record: SessionDirectoryRecord = {
    sessionId: rowString(row, 'session_id'),
    admissionId: rowString(row, 'admission_id'),
    route,
    visibility,
    participants:
      participants as unknown as SessionDirectoryRecord['participants'],
    status: status as SessionStatus,
    latestAggregateSequence: rowNumber(row, 'latest_aggregate_sequence'),
    ...(optionalRowJson(row, 'summary') !== undefined
      ? { summary: optionalRowJson(row, 'summary') }
      : {}),
    ...(optionalRowJson(row, 'result') !== undefined
      ? { result: optionalRowJson(row, 'result') }
      : {}),
    createdAt: rowNumber(row, 'created_at'),
    updatedAt: rowNumber(row, 'updated_at'),
  };
  validateRecord(record);
  return record;
}

function rowToFact(row: Row): StoredDirectoryFact {
  const sequence = rowNumber(row, 'aggregate_sequence');
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new DirectoryError(
      'DATABASE_ERROR',
      'directory fact sequence is invalid',
      false,
    );
  const kind = rowString(row, 'kind');
  if (
    kind !== 'SessionCreated' &&
    kind !== 'SessionActivated' &&
    kind !== 'SessionSummaryChanged' &&
    kind !== 'SessionCompleted' &&
    kind !== 'SessionControlled'
  )
    throw new DirectoryError(
      'DATABASE_ERROR',
      'directory fact kind is invalid',
      false,
    );
  return {
    sessionId: rowString(row, 'session_id'),
    aggregateSequence: sequence,
    kind,
    eventId: rowString(row, 'event_id'),
    digest: rowString(row, 'digest'),
    recordedAt: rowNumber(row, 'recorded_at'),
  };
}

function appendCursorWhere(
  clauses: string[],
  params: unknown[],
  cursor: string | undefined,
): void {
  if (!cursor) return;
  const decoded = decodeCursor(cursor);
  params.push(decoded.updatedAt, decoded.sessionId);
  const first = params.length - 1;
  clauses.push(`(updated_at, session_id) < ($${first}, $${first + 1})`);
}

/** Durable directory projection with explicit migration and per-session advisory locks. */
export class PostgresSessionDirectory implements SessionDirectoryStore {
  readonly capabilities: SessionDirectoryCapabilities = {
    durable: true,
    serializableTransactions: true,
    boundedReads: true,
  };

  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly admission: SessionDirectoryAdmissionLookup;
  private readonly retentionResolver: SessionDirectoryOptions['retentionResolver'];
  private readonly now: () => number;

  constructor(options: PostgresSessionDirectoryOptions) {
    if (!options || typeof options !== 'object')
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'directory options are required',
        false,
      );
    this.schema = options.schema ?? DEFAULT_DIRECTORY_SCHEMA;
    assertDirectorySchemaName(this.schema);
    if (
      !options.admission ||
      typeof options.admission.getAdmission !== 'function'
    )
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'admission lookup is required',
        false,
      );
    if (typeof options.retentionResolver !== 'function')
      throw new DirectoryError(
        'INVALID_ARGUMENT',
        'retentionResolver is required',
        false,
      );
    this.admission = options.admission;
    this.retentionResolver = options.retentionResolver;
    this.now = options.now ?? Date.now;
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...options.poolConfig,
        connectionString:
          options.connectionString ?? options.poolConfig?.connectionString,
      });
      this.ownsPool = true;
    }
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of directoryMigrationStatements(this.schema))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDirectoryError(error);
    } finally {
      client.release();
    }
  }

  async applyFact(
    envelope: SessionDirectoryEnvelope,
  ): Promise<SessionDirectoryRecord> {
    validateEnvelope(envelope);
    const admission = await this.admission.getAdmission(envelope.sessionId);
    if (!admission)
      throw new DirectoryError(
        'ADMISSION_NOT_FOUND',
        `no frozen admission exists for ${envelope.sessionId}`,
        false,
      );
    validateAdmission(admission, envelope.sessionId);
    assertSourceMatches(envelope, admission.route);
    const retentionValue = await this.retentionResolver(clone(admission));
    const retention = normalizeRetentionValue(retentionValue);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `directory:${envelope.sessionId}`,
      ]);
      const current = await this.readCurrent(client, envelope.sessionId);
      if (current) assertRecordMatchesAdmission(current, admission);
      const currentFacts = await this.readRelevantFacts(client, envelope);
      const projection = applyProjection({
        envelope,
        admission: clone(admission),
        retention,
        now: this.now(),
        current,
        currentFacts,
      });
      if (projection.applied) {
        await this.writeRecord(client, projection.record);
        await this.writeFact(client, projection.fact);
      }
      await client.query('COMMIT');
      return clone(projection.record);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDirectoryError(error);
    } finally {
      client.release();
    }
  }

  async getSession(sessionId: string): Promise<SessionDirectoryRecord | null> {
    assertSessionId(sessionId);
    const client = await this.pool.connect();
    try {
      const table = directoryTableName(this.schema, 'sessions');
      const result = await client.query(
        `SELECT * FROM ${table} WHERE session_id = $1`,
        [sessionId],
      );
      return result.rows[0] ? rowToRecord(result.rows[0]) : null;
    } catch (error) {
      throw asDirectoryError(error);
    } finally {
      client.release();
    }
  }

  async listForPrincipal(
    principalId: string,
    options: SessionDirectoryListOptions = {},
  ): Promise<SessionDirectoryPage> {
    assertSessionId(principalId);
    validateListOptions(options);
    const limit = options.limit ?? 100;
    const table = directoryTableName(this.schema, 'sessions');
    const clauses = [
      `(visibility = 'public' OR participants @> $1::jsonb OR participants @> $2::jsonb)`,
    ];
    const params: unknown[] = [
      JSON.stringify([{ principalId }]),
      JSON.stringify([{ controlledBy: principalId }]),
    ];
    this.appendListFilters(clauses, params, options);
    appendCursorWhere(clauses, params, options.cursor);
    params.push(limit);
    return this.queryPage(
      `SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, session_id DESC LIMIT $${params.length}`,
      params,
    );
  }

  async listPublic(
    gameId: string,
    options: Omit<SessionDirectoryListOptions, 'gameId'> = {},
  ): Promise<SessionDirectoryPage> {
    assertSessionId(gameId);
    validateListOptions(options);
    const limit = options.limit ?? 100;
    const table = directoryTableName(this.schema, 'sessions');
    const clauses = ["visibility = 'public'", 'game_id = $1'];
    const params: unknown[] = [gameId];
    this.appendListFilters(clauses, params, options, true);
    appendCursorWhere(clauses, params, options.cursor);
    params.push(limit);
    return this.queryPage(
      `SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, session_id DESC LIMIT $${params.length}`,
      params,
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async readCurrent(
    client: PoolClient,
    sessionId: string,
  ): Promise<SessionDirectoryRecord | null> {
    const table = directoryTableName(this.schema, 'sessions');
    const result = await client.query(
      `SELECT * FROM ${table} WHERE session_id = $1 FOR UPDATE`,
      [sessionId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  private async readRelevantFacts(
    client: PoolClient,
    envelope: SessionDirectoryEnvelope & {
      readonly sessionId: string;
      readonly aggregateSequence: number;
    },
  ): Promise<readonly StoredDirectoryFact[]> {
    const table = directoryTableName(this.schema, 'facts');
    const result = await client.query(
      `SELECT * FROM ${table}
       WHERE session_id = $1
         AND ((event_id = $2) OR (aggregate_sequence = $3 AND kind = $4))`,
      [
        envelope.sessionId,
        envelope.eventId,
        envelope.aggregateSequence,
        envelope.kind,
      ],
    );
    const byKey = new Map<string, StoredDirectoryFact>();
    for (const row of result.rows) {
      const fact = rowToFact(row);
      byKey.set(`${fact.eventId}:${fact.aggregateSequence}:${fact.kind}`, fact);
    }
    return [...byKey.values()];
  }

  private async writeRecord(
    client: PoolClient,
    record: SessionDirectoryRecord,
  ): Promise<void> {
    const table = directoryTableName(this.schema, 'sessions');
    await client.query(
      `INSERT INTO ${table} (
        session_id, admission_id, game_id, mode_id, release_id,
        backend_binding_id, storage_binding_id, ownership_epoch,
        visibility, participants, status, latest_aggregate_sequence,
        summary, result, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb, $15, $16)
      ON CONFLICT (session_id) DO UPDATE SET
        admission_id = EXCLUDED.admission_id,
        game_id = EXCLUDED.game_id,
        mode_id = EXCLUDED.mode_id,
        release_id = EXCLUDED.release_id,
        backend_binding_id = EXCLUDED.backend_binding_id,
        storage_binding_id = EXCLUDED.storage_binding_id,
        ownership_epoch = EXCLUDED.ownership_epoch,
        visibility = EXCLUDED.visibility,
        participants = EXCLUDED.participants,
        status = EXCLUDED.status,
        latest_aggregate_sequence = EXCLUDED.latest_aggregate_sequence,
        summary = EXCLUDED.summary,
        result = EXCLUDED.result,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [
        record.sessionId,
        record.admissionId,
        record.route.gameId,
        record.route.modeId,
        record.route.releaseId,
        record.route.backendBindingId,
        record.route.storageBindingId,
        record.route.ownershipEpoch,
        record.visibility,
        JSON.stringify(record.participants),
        record.status,
        record.latestAggregateSequence,
        record.summary === undefined ? null : JSON.stringify(record.summary),
        record.result === undefined ? null : JSON.stringify(record.result),
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  private async writeFact(
    client: PoolClient,
    fact: StoredDirectoryFact,
  ): Promise<void> {
    const table = directoryTableName(this.schema, 'facts');
    await client.query(
      `INSERT INTO ${table} (
        session_id, aggregate_sequence, kind, event_id, digest, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fact.sessionId,
        fact.aggregateSequence,
        fact.kind,
        fact.eventId,
        fact.digest,
        fact.recordedAt,
      ],
    );
  }

  private appendListFilters(
    clauses: string[],
    params: unknown[],
    options: SessionDirectoryListOptions,
    gameAlreadySet = false,
  ): void {
    if (options.gameId !== undefined && !gameAlreadySet) {
      params.push(options.gameId);
      clauses.push(`game_id = $${params.length}`);
    }
    if (options.status !== undefined) {
      params.push(options.status);
      clauses.push(`status = $${params.length}`);
    }
  }

  private async queryPage(
    query: string,
    params: readonly unknown[],
  ): Promise<SessionDirectoryPage> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(query, [...params]);
      const items = result.rows.map(rowToRecord);
      return {
        items,
        ...(items.length === Number(params[params.length - 1])
          ? {
              nextCursor: encodeCursor({
                updatedAt: items[items.length - 1].updatedAt,
                sessionId: items[items.length - 1].sessionId,
              }),
            }
          : {}),
      };
    } catch (error) {
      throw asDirectoryError(error);
    } finally {
      client.release();
    }
  }
}

function normalizeRetentionValue(
  value: Awaited<ReturnType<SessionDirectoryOptions['retentionResolver']>>,
): { readonly retainSummary: boolean; readonly retainResult: boolean } {
  if (typeof value === 'string') {
    if (value === 'summary-and-replay')
      return { retainSummary: true, retainResult: true };
    if (value === 'progress-only')
      return { retainSummary: true, retainResult: false };
    if (value === 'ephemeral-result')
      return { retainSummary: false, retainResult: false };
  } else if (
    value &&
    typeof value === 'object' &&
    typeof value.retainSummary === 'boolean' &&
    typeof value.retainResult === 'boolean'
  )
    return value;
  throw new DirectoryError(
    'INVALID_ARGUMENT',
    'retention policy is invalid',
    false,
  );
}
