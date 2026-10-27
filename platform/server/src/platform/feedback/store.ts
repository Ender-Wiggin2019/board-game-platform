import { randomUUID } from 'node:crypto';
import type { AutomationTrace } from '@board-game/storage';
import type {
  IClientCrashReport,
  IPlatformNativeDiagnostics,
  TPlatformFeedbackCategory,
  TPlatformFeedbackKind,
  TPlatformFeedbackScope,
  TPlatformFeedbackStatus,
} from '@board-platform/contracts';
import type { Pool } from 'pg';

const SCHEMA = 'board_platform_feedback';
const LIST_COLUMNS = `report_id, event_id, payload_fingerprint, source_record_id,
  reporter_id, kind, category, message, expected_behavior, game_id, release_id,
  session_id, event_sequence, trace_id, status, created_at, updated_at`;

export interface PlatformFeedbackRecord {
  readonly reportId: string;
  readonly eventId: string;
  /** Hash of the accepted event payload used to reject key reuse. */
  readonly fingerprint?: string;
  readonly sourceRecordId: string;
  readonly reporterId: string;
  readonly kind: TPlatformFeedbackKind;
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  readonly expectedBehavior?: string;
  readonly gameId?: string;
  readonly releaseId?: string;
  readonly sessionId?: string;
  readonly eventSequence?: number;
  readonly traceId?: string;
  readonly traceSnapshot?: AutomationTrace;
  readonly nativeDiagnostics?: IPlatformNativeDiagnostics;
  readonly clientCrash?: IClientCrashReport;
  readonly status: TPlatformFeedbackStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePlatformFeedbackRecord {
  readonly reportId?: string;
  readonly eventId: string;
  /** Hash of the accepted event payload used to reject key reuse. */
  readonly fingerprint?: string;
  readonly sourceRecordId: string;
  readonly reporterId: string;
  readonly kind?: TPlatformFeedbackKind;
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  readonly expectedBehavior?: string;
  readonly gameId?: string;
  readonly releaseId?: string;
  readonly sessionId?: string;
  readonly eventSequence?: number;
  readonly traceId?: string;
  readonly traceSnapshot?: AutomationTrace;
  readonly nativeDiagnostics?: IPlatformNativeDiagnostics;
  readonly clientCrash?: IClientCrashReport;
  readonly createdAt?: Date;
}

export interface PlatformFeedbackListOptions {
  readonly limit: number;
  readonly status?: TPlatformFeedbackStatus;
  readonly gameId?: string;
  readonly scope?: TPlatformFeedbackScope;
  readonly reporterId?: string;
  readonly kind?: TPlatformFeedbackKind;
}

export interface PlatformFeedbackStore {
  create(input: CreatePlatformFeedbackRecord): Promise<PlatformFeedbackRecord>;
  findByEvent(
    reporterId: string,
    eventId: string,
  ): Promise<PlatformFeedbackRecord | null>;
  list(options: PlatformFeedbackListOptions): Promise<{
    readonly items: readonly PlatformFeedbackRecord[];
    readonly total: number;
  }>;
  get(reportId: string): Promise<PlatformFeedbackRecord | null>;
  updateStatus(
    reportId: string,
    status: TPlatformFeedbackStatus,
    updatedAt: Date,
  ): Promise<PlatformFeedbackRecord | null>;
}

export function platformFeedbackMigrationStatements(): readonly string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`,
    `CREATE TABLE IF NOT EXISTS ${SCHEMA}.reports (
      report_id uuid PRIMARY KEY,
      event_id text NOT NULL,
      payload_fingerprint text,
      source_record_id text NOT NULL UNIQUE,
      reporter_id text NOT NULL,
      kind text NOT NULL DEFAULT 'game' CHECK (kind IN ('game', 'ai')),
      category text NOT NULL CHECK (category IN ('bug', 'rules', 'ux', 'other', 'behavior', 'optimization')),
      message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 20000),
      expected_behavior text CHECK (expected_behavior IS NULL OR char_length(expected_behavior) BETWEEN 1 AND 5000),
      game_id text,
      release_id text,
      session_id text,
      event_sequence bigint,
      trace_id text,
      trace_snapshot jsonb,
      native_diagnostics jsonb,
      client_crash jsonb,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'resolved', 'ignored')),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      UNIQUE (reporter_id, event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS reports_status_created_idx
      ON ${SCHEMA}.reports (status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS reports_game_created_idx
      ON ${SCHEMA}.reports (game_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS reports_reporter_created_idx
      ON ${SCHEMA}.reports (reporter_id, created_at DESC, report_id DESC)`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS client_crash jsonb`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS payload_fingerprint text`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'game'`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS event_sequence bigint`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS expected_behavior text`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS trace_id text`,
    `ALTER TABLE ${SCHEMA}.reports ADD COLUMN IF NOT EXISTS trace_snapshot jsonb`,
    `CREATE INDEX IF NOT EXISTS reports_kind_created_idx
      ON ${SCHEMA}.reports (kind, created_at DESC)`,
    `ALTER TABLE ${SCHEMA}.reports DROP CONSTRAINT IF EXISTS reports_kind_check`,
    `ALTER TABLE ${SCHEMA}.reports ADD CONSTRAINT reports_kind_check CHECK (kind IN ('game', 'ai'))`,
    `ALTER TABLE ${SCHEMA}.reports DROP CONSTRAINT IF EXISTS reports_category_check`,
    `ALTER TABLE ${SCHEMA}.reports ADD CONSTRAINT reports_category_check CHECK (category IN ('bug', 'rules', 'ux', 'other', 'behavior', 'optimization'))`,
  ];
}

function clone(record: PlatformFeedbackRecord): PlatformFeedbackRecord {
  return {
    ...record,
    ...(record.nativeDiagnostics
      ? { nativeDiagnostics: structuredClone(record.nativeDiagnostics) }
      : {}),
    ...(record.clientCrash
      ? { clientCrash: structuredClone(record.clientCrash) }
      : {}),
    ...(record.traceSnapshot
      ? { traceSnapshot: structuredClone(record.traceSnapshot) }
      : {}),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function row(record: Record<string, unknown>): PlatformFeedbackRecord {
  return {
    reportId: String(record.report_id),
    eventId: String(record.event_id),
    ...(record.payload_fingerprint === null ||
    record.payload_fingerprint === undefined
      ? {}
      : { fingerprint: String(record.payload_fingerprint) }),
    sourceRecordId: String(record.source_record_id),
    reporterId: String(record.reporter_id),
    kind: (record.kind ?? 'game') as TPlatformFeedbackKind,
    category: record.category as TPlatformFeedbackCategory,
    message: String(record.message),
    ...(record.expected_behavior === null ||
    record.expected_behavior === undefined
      ? {}
      : { expectedBehavior: String(record.expected_behavior) }),
    ...(record.game_id === null ? {} : { gameId: String(record.game_id) }),
    ...(record.release_id === null
      ? {}
      : { releaseId: String(record.release_id) }),
    ...(record.session_id === null
      ? {}
      : { sessionId: String(record.session_id) }),
    ...(record.event_sequence === null || record.event_sequence === undefined
      ? {}
      : { eventSequence: Number(record.event_sequence) }),
    ...(record.trace_id === null || record.trace_id === undefined
      ? {}
      : { traceId: String(record.trace_id) }),
    ...(record.trace_snapshot === null || record.trace_snapshot === undefined
      ? {}
      : {
          traceSnapshot: structuredClone(
            record.trace_snapshot as AutomationTrace,
          ),
        }),
    ...(record.native_diagnostics === null ||
    record.native_diagnostics === undefined
      ? {}
      : {
          nativeDiagnostics: structuredClone(
            record.native_diagnostics as IPlatformNativeDiagnostics,
          ),
        }),
    ...(record.client_crash === null || record.client_crash === undefined
      ? {}
      : {
          clientCrash: structuredClone(
            record.client_crash as IClientCrashReport,
          ),
        }),
    status: record.status as TPlatformFeedbackStatus,
    createdAt: new Date(String(record.created_at)),
    updatedAt: new Date(String(record.updated_at)),
  };
}

/** PostgreSQL persistence with event-key idempotency for retried reports. */
export class PostgresPlatformFeedbackStore implements PlatformFeedbackStore {
  public constructor(private readonly pool: Pool) {}

  public async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of platformFeedbackMigrationStatements())
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async create(
    input: CreatePlatformFeedbackRecord,
  ): Promise<PlatformFeedbackRecord> {
    const now = input.createdAt ?? new Date();
    const reportId = input.reportId ?? randomUUID();
    const inserted = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO ${SCHEMA}.reports
        (report_id, event_id, payload_fingerprint, source_record_id, reporter_id, kind, category, message,
         expected_behavior, game_id, release_id, session_id, event_sequence, trace_id,
         trace_snapshot, native_diagnostics, client_crash, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15::jsonb, $16::jsonb, $17::jsonb, $18, $18)
       ON CONFLICT (reporter_id, event_id) DO NOTHING
       RETURNING *`,
      [
        reportId,
        input.eventId,
        input.fingerprint ?? null,
        input.sourceRecordId,
        input.reporterId,
        input.kind ?? 'game',
        input.category,
        input.message,
        input.expectedBehavior ?? null,
        input.gameId ?? null,
        input.releaseId ?? null,
        input.sessionId ?? null,
        input.eventSequence ?? null,
        input.traceId ?? null,
        input.traceSnapshot ? JSON.stringify(input.traceSnapshot) : null,
        input.nativeDiagnostics
          ? JSON.stringify(input.nativeDiagnostics)
          : null,
        input.clientCrash ? JSON.stringify(input.clientCrash) : null,
        now,
      ],
    );
    const created = inserted.rows[0];
    if (created) return row(created);
    const existing = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SCHEMA}.reports WHERE reporter_id = $1 AND event_id = $2`,
      [input.reporterId, input.eventId],
    );
    if (!existing.rows[0])
      throw new Error('PLATFORM_FEEDBACK_IDEMPOTENCY_RACE');
    return row(existing.rows[0]);
  }

  public async findByEvent(
    reporterId: string,
    eventId: string,
  ): Promise<PlatformFeedbackRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SCHEMA}.reports
       WHERE reporter_id = $1 AND event_id = $2`,
      [reporterId, eventId],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }

  public async list(options: PlatformFeedbackListOptions): Promise<{
    readonly items: readonly PlatformFeedbackRecord[];
    readonly total: number;
  }> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (options.status !== undefined) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    }
    if (options.gameId !== undefined) {
      values.push(options.gameId);
      where.push(`game_id = $${values.length}`);
    }
    if (options.scope === 'platform') where.push('game_id IS NULL');
    if (options.kind !== undefined) {
      values.push(options.kind);
      where.push(`kind = $${values.length}`);
    }
    if (options.reporterId !== undefined) {
      values.push(options.reporterId);
      where.push(`reporter_id = $${values.length}`);
    }
    const predicate = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitParam = values.length + 1;
    values.push(options.limit);
    const [items, total] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT ${LIST_COLUMNS} FROM ${SCHEMA}.reports ${predicate}
         ORDER BY created_at DESC, report_id DESC LIMIT $${limitParam}`,
        values,
      ),
      this.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${SCHEMA}.reports ${predicate}`,
        values.slice(0, -1),
      ),
    ]);
    return {
      items: items.rows.map(row),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  public async get(reportId: string): Promise<PlatformFeedbackRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${SCHEMA}.reports WHERE report_id = $1::uuid`,
      [reportId],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }

  public async updateStatus(
    reportId: string,
    status: TPlatformFeedbackStatus,
    updatedAt: Date,
  ): Promise<PlatformFeedbackRecord | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `UPDATE ${SCHEMA}.reports SET status = $2, updated_at = $3
       WHERE report_id = $1::uuid RETURNING *`,
      [reportId, status, updatedAt],
    );
    return result.rows[0] ? row(result.rows[0]) : null;
  }
}

/** Clone-isolated store for service tests and small local adapters. */
export class MemoryPlatformFeedbackStore implements PlatformFeedbackStore {
  private readonly records = new Map<string, PlatformFeedbackRecord>();
  private readonly keys = new Map<string, string>();

  public async create(
    input: CreatePlatformFeedbackRecord,
  ): Promise<PlatformFeedbackRecord> {
    const key = `${input.reporterId}:${input.eventId}`;
    const existingId = this.keys.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) return clone(existing);
      this.keys.delete(key);
    }
    const now = input.createdAt ?? new Date();
    const record: PlatformFeedbackRecord = {
      reportId: input.reportId ?? randomUUID(),
      eventId: input.eventId,
      ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      sourceRecordId: input.sourceRecordId,
      reporterId: input.reporterId,
      kind: input.kind ?? 'game',
      category: input.category,
      message: input.message,
      ...(input.expectedBehavior
        ? { expectedBehavior: input.expectedBehavior }
        : {}),
      ...(input.gameId ? { gameId: input.gameId } : {}),
      ...(input.releaseId ? { releaseId: input.releaseId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.eventSequence === undefined
        ? {}
        : { eventSequence: input.eventSequence }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.traceSnapshot === undefined
        ? {}
        : { traceSnapshot: structuredClone(input.traceSnapshot) }),
      ...(input.nativeDiagnostics
        ? { nativeDiagnostics: structuredClone(input.nativeDiagnostics) }
        : {}),
      ...(input.clientCrash
        ? { clientCrash: structuredClone(input.clientCrash) }
        : {}),
      status: 'open',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    this.records.set(record.reportId, record);
    this.keys.set(key, record.reportId);
    return clone(record);
  }

  public async findByEvent(
    reporterId: string,
    eventId: string,
  ): Promise<PlatformFeedbackRecord | null> {
    for (const record of this.records.values()) {
      if (record.reporterId === reporterId && record.eventId === eventId)
        return clone(record);
    }
    return null;
  }

  public async list(options: PlatformFeedbackListOptions): Promise<{
    readonly items: readonly PlatformFeedbackRecord[];
    readonly total: number;
  }> {
    const filtered = [...this.records.values()]
      .filter(
        (record) =>
          (options.status === undefined || record.status === options.status) &&
          (options.gameId === undefined || record.gameId === options.gameId) &&
          (options.scope !== 'platform' || record.gameId === undefined) &&
          (options.kind === undefined || record.kind === options.kind) &&
          (options.reporterId === undefined ||
            record.reporterId === options.reporterId),
      )
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      );
    return {
      items: filtered.slice(0, options.limit).map(clone),
      total: filtered.length,
    };
  }

  public async get(reportId: string): Promise<PlatformFeedbackRecord | null> {
    const record = this.records.get(reportId);
    return record ? clone(record) : null;
  }

  public async updateStatus(
    reportId: string,
    status: TPlatformFeedbackStatus,
    updatedAt: Date,
  ): Promise<PlatformFeedbackRecord | null> {
    const record = this.records.get(reportId);
    if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date(updatedAt) };
    this.records.set(reportId, updated);
    return clone(updated);
  }
}
