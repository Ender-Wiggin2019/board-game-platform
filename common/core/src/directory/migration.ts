import { DirectoryError } from './errors.js';

export const DEFAULT_DIRECTORY_SCHEMA = 'board_platform_directory';

export function assertDirectorySchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'directory schema must be a lower-case SQL identifier',
      false,
    );
}

export function quoteDirectoryIdentifier(identifier: string): string {
  assertDirectorySchemaName(identifier);
  return `"${identifier}"`;
}

function directoryIndexName(schema: string, suffix: string): string {
  return quoteDirectoryIdentifier(
    `${schema.slice(0, 62 - suffix.length)}_${suffix}`,
  );
}

export function directoryTableName(schema: string, table: string): string {
  assertDirectorySchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new DirectoryError(
      'INVALID_ARGUMENT',
      'directory table must be a lower-case SQL identifier',
      false,
    );
  return `${quoteDirectoryIdentifier(schema)}.${quoteDirectoryIdentifier(table)}`;
}

/** Explicit migration. Constructing a PostgresSessionDirectory never calls this. */
export function directoryMigrationStatements(
  schema = DEFAULT_DIRECTORY_SCHEMA,
): readonly string[] {
  assertDirectorySchemaName(schema);
  const qSchema = quoteDirectoryIdentifier(schema);
  const sessions = directoryTableName(schema, 'sessions');
  const facts = directoryTableName(schema, 'facts');
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${sessions} (
      session_id text PRIMARY KEY,
      admission_id text NOT NULL,
      game_id text NOT NULL,
      mode_id text NOT NULL,
      release_id text NOT NULL,
      backend_binding_id text NOT NULL,
      storage_binding_id text NOT NULL,
      ownership_epoch text NOT NULL,
      visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
      participants jsonb NOT NULL,
      status text NOT NULL CHECK (status IN ('suspended', 'active', 'completed', 'cancelled', 'paused')),
      latest_aggregate_sequence bigint NOT NULL CHECK (latest_aggregate_sequence >= 0),
      summary jsonb,
      result jsonb,
      created_at double precision NOT NULL CHECK (created_at >= 0),
      updated_at double precision NOT NULL CHECK (updated_at >= 0)
    )`,
    `CREATE INDEX IF NOT EXISTS ${directoryIndexName(schema, 'sessions_game_updated_idx')} ON ${sessions} (game_id, updated_at DESC, session_id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${directoryIndexName(schema, 'sessions_visibility_updated_idx')} ON ${sessions} (visibility, updated_at DESC, session_id DESC)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDirectoryIdentifier('sessions_active_participants_idx')}
       ON ${sessions} USING gin (participants)
       WHERE status = 'active'`,
    `CREATE TABLE IF NOT EXISTS ${facts} (
      session_id text NOT NULL REFERENCES ${sessions} (session_id) ON DELETE CASCADE,
      aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence >= 0),
      kind text NOT NULL CHECK (kind IN ('SessionCreated', 'SessionActivated', 'SessionSummaryChanged', 'SessionCompleted', 'SessionControlled')),
      event_id text NOT NULL,
      digest text NOT NULL,
      recorded_at double precision NOT NULL CHECK (recorded_at >= 0),
      PRIMARY KEY (session_id, aggregate_sequence, kind),
      UNIQUE (session_id, event_id)
    )`,
    `ALTER TABLE ${facts}
      DROP CONSTRAINT IF EXISTS facts_kind_check,
      ADD CONSTRAINT facts_kind_check CHECK (kind IN ('SessionCreated', 'SessionActivated', 'SessionSummaryChanged', 'SessionCompleted', 'SessionControlled'))`,
    `CREATE INDEX IF NOT EXISTS ${directoryIndexName(schema, 'facts_event_idx')} ON ${facts} (session_id, event_id)`,
  ];
}
