import { InboxError } from './errors.js';

export const DEFAULT_INBOX_SCHEMA = 'board_platform_inbox';

export function assertSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new InboxError(
      'INVALID_ARGUMENT',
      'Inbox schema must be a lower-case SQL identifier',
    );
}

export function quoteIdentifier(identifier: string): string {
  assertSchemaName(identifier);
  return `"${identifier}"`;
}

export function tableName(schema: string, table: string): string {
  assertSchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new InboxError(
      'INVALID_ARGUMENT',
      'Inbox table must be a lower-case SQL identifier',
    );
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Explicit migration. Constructing a PostgresInboxStore never calls this. */
export function migrationStatements(
  schema = DEFAULT_INBOX_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  const qSchema = quoteIdentifier(schema);
  const facts = tableName(schema, 'facts');
  const receipts = tableName(schema, 'consumer_receipts');
  const effects = tableName(schema, 'consumer_effects');
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${facts} (
      producer_id text NOT NULL,
      event_id text NOT NULL,
      session_id text,
      kind text NOT NULL,
      schema_version integer NOT NULL CHECK (schema_version >= 1),
      source_release text NOT NULL,
      aggregate_sequence bigint CHECK (aggregate_sequence IS NULL OR aggregate_sequence >= 0),
      payload jsonb NOT NULL,
      occurred_at double precision,
      received_at double precision NOT NULL,
      digest text NOT NULL,
      PRIMARY KEY (producer_id, event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_facts_received_idx`)} ON ${facts} (received_at, producer_id, event_id)`,
    `CREATE TABLE IF NOT EXISTS ${receipts} (
      consumer_key text NOT NULL,
      producer_id text NOT NULL,
      event_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('failed', 'dead-letter', 'completed')),
      attempts integer NOT NULL CHECK (attempts >= 1),
      last_attempt_at double precision NOT NULL,
      next_attempt_at double precision,
      completed_at double precision,
      PRIMARY KEY (consumer_key, producer_id, event_id),
      FOREIGN KEY (producer_id, event_id) REFERENCES ${facts} (producer_id, event_id) ON DELETE CASCADE
    )`,
    `ALTER TABLE ${receipts} ADD COLUMN IF NOT EXISTS next_attempt_at double precision`,
    `DO $inbox_migration$
      DECLARE
        has_dead_letter_status boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = '${schema}.consumer_receipts'::regclass
             AND conname = 'consumer_receipts_status_check'
             AND position('dead-letter' IN pg_get_constraintdef(oid)) > 0
        ) INTO has_dead_letter_status;

        IF NOT has_dead_letter_status THEN
          ALTER TABLE ${receipts}
            DROP CONSTRAINT IF EXISTS ${quoteIdentifier('consumer_receipts_status_check')};
          UPDATE ${receipts}
             SET status = 'dead-letter', next_attempt_at = NULL
           WHERE status = 'failed' AND attempts >= 10;
          ALTER TABLE ${receipts}
            ADD CONSTRAINT ${quoteIdentifier('consumer_receipts_status_check')}
            CHECK (status IN ('failed', 'dead-letter', 'completed'));
        END IF;
      END
    $inbox_migration$`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_receipts_consumer_idx`)} ON ${receipts} (consumer_key, last_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_receipts_retry_idx`)} ON ${receipts} (consumer_key, next_attempt_at, producer_id, event_id) WHERE status = 'failed'`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_receipts_dead_letter_idx`)} ON ${receipts} (consumer_key, last_attempt_at, producer_id, event_id) WHERE status = 'dead-letter'`,
    `CREATE TABLE IF NOT EXISTS ${effects} (
      consumer_key text NOT NULL,
      effect_id text NOT NULL,
      producer_id text NOT NULL,
      event_id text NOT NULL,
      digest text NOT NULL,
      payload jsonb NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (consumer_key, effect_id),
      FOREIGN KEY (producer_id, event_id) REFERENCES ${facts} (producer_id, event_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_effects_consumer_idx`)} ON ${effects} (consumer_key, created_at, effect_id)`,
  ];
}
