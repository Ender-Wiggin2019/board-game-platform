import { StorageError } from './errors.js';

export const DEFAULT_STORAGE_SCHEMA = 'board_platform_storage';

export function assertStorageSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Storage schema must be a lower-case SQL identifier',
    );
  }
}

export function quoteIdentifier(identifier: string): string {
  assertStorageSchemaName(identifier);
  return `"${identifier}"`;
}

function schemaIndexName(schema: string, suffix: string): string {
  // Index names are scoped to their schema; keep the distinguishing suffix
  // intact when a valid 63-character schema leaves no room for a full prefix.
  return quoteIdentifier(`${schema.slice(0, 62 - suffix.length)}_${suffix}`);
}

export function tableName(schema: string, table: string): string {
  assertStorageSchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new StorageError(
      'INVALID_ARGUMENT',
      'Storage table must be a lower-case SQL identifier',
    );
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Explicit schema migration. PostgresStorageDriver never invokes this automatically. */
export function migrationStatements(
  schema = DEFAULT_STORAGE_SCHEMA,
): readonly string[] {
  assertStorageSchemaName(schema);
  const heads = tableName(schema, 'session_heads');
  const starts = tableName(schema, 'session_starts');
  const automationDecisions = tableName(schema, 'automation_decisions');
  const automationTraces = tableName(schema, 'automation_traces');
  const receipts = tableName(schema, 'command_receipts');
  const events = tableName(schema, 'domain_events');
  const outbox = tableName(schema, 'outbox');
  const qSchema = quoteIdentifier(schema);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${starts} (
      session_id text PRIMARY KEY,
      start_id text NOT NULL,
      start_generation bigint CHECK (start_generation IS NULL OR start_generation >= 0),
      start_digest text NOT NULL,
      route jsonb NOT NULL,
      participants jsonb NOT NULL,
      created_at double precision NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${heads} (
      session_id text PRIMARY KEY,
      start_id text NOT NULL,
      start_generation bigint CHECK (start_generation IS NULL OR start_generation >= 0),
      start_digest text NOT NULL,
      route jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('suspended', 'active', 'paused', 'completed', 'cancelled')),
      revision bigint NOT NULL CHECK (revision >= 0),
      encoded_state jsonb NOT NULL,
      schema_version integer NOT NULL CHECK (schema_version >= 1),
      participants jsonb NOT NULL,
      summary jsonb NOT NULL,
      logical_time double precision NOT NULL,
      activated_at double precision,
      deadline_id text,
      deadline_due_at double precision,
      automation_failure jsonb,
      event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL,
      CONSTRAINT session_heads_start_uq UNIQUE (session_id, start_id)
    )`,
    `ALTER TABLE ${heads} ADD COLUMN IF NOT EXISTS deadline_id text`,
    `ALTER TABLE ${heads} ADD COLUMN IF NOT EXISTS deadline_due_at double precision`,
    `ALTER TABLE ${heads} ADD COLUMN IF NOT EXISTS automation_failure jsonb`,
    `ALTER TABLE ${starts} ADD COLUMN IF NOT EXISTS start_generation bigint CHECK (start_generation IS NULL OR start_generation >= 0)`,
    `ALTER TABLE ${heads} ADD COLUMN IF NOT EXISTS start_generation bigint CHECK (start_generation IS NULL OR start_generation >= 0)`,
    `CREATE TABLE IF NOT EXISTS ${automationDecisions} (
      session_id text NOT NULL,
      decision_id text NOT NULL,
      command_id text NOT NULL,
      deadline_id text NOT NULL,
      expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
      seat_id text NOT NULL,
      turn_id text NOT NULL,
      command jsonb NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (session_id, decision_id),
      CONSTRAINT automation_decisions_head_fk FOREIGN KEY (session_id)
        REFERENCES ${heads} (session_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS ${automationTraces} (
      session_id text NOT NULL,
      trace_id text NOT NULL,
      trace_kind text NOT NULL DEFAULT 'automation' CHECK (trace_kind IN ('automation', 'command')),
      decision_id text NOT NULL,
      command_id text NOT NULL,
      deadline_id text NOT NULL,
      release_id text NOT NULL,
      policy_id text NOT NULL,
      policy_version text,
      expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
      seat_id text NOT NULL,
      turn_id text NOT NULL,
      state jsonb NOT NULL,
      input jsonb NOT NULL,
      schema_version integer NOT NULL CHECK (schema_version >= 1),
      options jsonb NOT NULL,
      command jsonb,
      diagnostics jsonb,
      outcome text NOT NULL CHECK (outcome IN ('deciding', 'decided', 'executed', 'rejected', 'timeout', 'failed')),
      started_at double precision NOT NULL,
      finished_at double precision,
      created_at double precision NOT NULL,
      event_sequence_start bigint,
      event_sequence_count integer,
      PRIMARY KEY (session_id, trace_id),
      CONSTRAINT automation_traces_head_fk FOREIGN KEY (session_id)
        REFERENCES ${heads} (session_id) ON DELETE CASCADE
    )`,
    `ALTER TABLE ${automationTraces} ADD COLUMN IF NOT EXISTS trace_kind text NOT NULL DEFAULT 'automation'`,
    `ALTER TABLE ${automationTraces} ADD COLUMN IF NOT EXISTS event_sequence_start bigint`,
    `ALTER TABLE ${automationTraces} ADD COLUMN IF NOT EXISTS event_sequence_count integer`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(schema, 'automation_traces_created_idx')}
      ON ${automationTraces} (session_id, created_at, trace_id)`,
    `CREATE TABLE IF NOT EXISTS ${receipts} (
      session_id text NOT NULL,
      command_id text NOT NULL,
      actor_principal_id text NOT NULL,
      input_hash text NOT NULL,
      status text NOT NULL CHECK (status IN ('accepted', 'rejected', 'unknown', 'tombstone')),
      result_retention text NOT NULL CHECK (result_retention IN ('replayable', 'ephemeral-result')),
      persisted_revision bigint,
      persisted_at double precision,
      error jsonb,
      PRIMARY KEY (session_id, command_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${events} (
      session_id text NOT NULL,
      event_id text NOT NULL,
      producer_id text NOT NULL,
      aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence >= 0),
      schema_version integer NOT NULL CHECK (schema_version >= 1),
      source_release text NOT NULL,
      payload jsonb NOT NULL,
      source jsonb,
      logical_time double precision NOT NULL,
      occurred_at double precision NOT NULL,
      PRIMARY KEY (session_id, event_id),
      CONSTRAINT domain_events_sequence_uq UNIQUE (session_id, producer_id, aggregate_sequence)
    )`,
    `ALTER TABLE ${events} ADD COLUMN IF NOT EXISTS source jsonb`,
    `CREATE TABLE IF NOT EXISTS ${outbox} (
      session_id text NOT NULL,
      outbox_id text NOT NULL,
      producer_id text NOT NULL,
      kind text NOT NULL,
      schema_version integer NOT NULL CHECK (schema_version >= 1),
      source_release text NOT NULL,
      payload jsonb NOT NULL,
      aggregate_sequence bigint,
      created_at double precision NOT NULL,
      delivered_at double precision,
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      PRIMARY KEY (session_id, outbox_id)
    )`,
    `ALTER TABLE ${outbox} ADD COLUMN IF NOT EXISTS next_attempt_at double precision`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(schema, 'outbox_pending_idx')} ON ${outbox} (created_at, outbox_id) WHERE delivered_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(schema, 'events_sequence_idx')} ON ${events} (session_id, aggregate_sequence)`,
    `CREATE INDEX IF NOT EXISTS ${schemaIndexName(schema, 'heads_due_idx')} ON ${heads} (deadline_due_at, session_id) WHERE status = 'active' AND deadline_due_at IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('automation_deadline_idx')} ON ${automationDecisions} (session_id, deadline_id, seat_id)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('automation_trace_created_idx')} ON ${automationTraces} (session_id, created_at, trace_id)`,
  ];
}
