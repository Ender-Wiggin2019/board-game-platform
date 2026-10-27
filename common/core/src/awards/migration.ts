import { AwardError } from './errors.js';

export const DEFAULT_AWARD_SCHEMA = 'board_platform_awards';

export function assertAwardSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new AwardError(
      'INVALID_ARGUMENT',
      'award schema must be a lower-case SQL identifier',
      false,
    );
}

export function quoteAwardIdentifier(identifier: string): string {
  assertAwardSchemaName(identifier);
  return `"${identifier}"`;
}

export function awardTableName(schema: string, table: string): string {
  assertAwardSchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new AwardError(
      'INVALID_ARGUMENT',
      'award table must be a lower-case SQL identifier',
      false,
    );
  return `${quoteAwardIdentifier(schema)}.${quoteAwardIdentifier(table)}`;
}

/** Explicit migration. Constructing a PostgresAwardStore never calls this. */
export function awardMigrationStatements(
  schema = DEFAULT_AWARD_SCHEMA,
): readonly string[] {
  assertAwardSchemaName(schema);
  const qSchema = quoteAwardIdentifier(schema);
  const awards = awardTableName(schema, 'awards');
  const rewards = awardTableName(schema, 'rewards');
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${awards} (
      namespace text NOT NULL,
      principal_id text NOT NULL,
      award_id text NOT NULL,
      tier text NOT NULL,
      definition_version text NOT NULL,
      definition_digest text NOT NULL,
      source_record_id text NOT NULL,
      rewards jsonb NOT NULL,
      award_grant_id text NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (namespace, principal_id, award_id, tier),
      UNIQUE (award_grant_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteAwardIdentifier(`${schema}_awards_source_idx`)} ON ${awards} (namespace, principal_id, source_record_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${rewards} (
      reward_id text PRIMARY KEY,
      award_grant_id text NOT NULL,
      instruction_id text NOT NULL,
      award_namespace text NOT NULL,
      principal_id text NOT NULL,
      namespace text NOT NULL,
      asset text NOT NULL,
      quantity bigint NOT NULL CHECK (quantity > 0),
      metadata jsonb,
      status text NOT NULL CHECK (status IN ('pending', 'delivered')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at double precision,
      created_at double precision NOT NULL,
      delivered_at double precision,
      FOREIGN KEY (award_grant_id) REFERENCES ${awards} (award_grant_id) ON DELETE RESTRICT,
      UNIQUE (award_grant_id, instruction_id)
    )`,
    `ALTER TABLE ${rewards} ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0`,
    `ALTER TABLE ${rewards} ADD COLUMN IF NOT EXISTS next_attempt_at double precision`,
    `CREATE INDEX IF NOT EXISTS ${quoteAwardIdentifier(`${schema}_rewards_pending_idx`)} ON ${rewards} (status, created_at, reward_id)`,
    `CREATE INDEX IF NOT EXISTS ${quoteAwardIdentifier(`${schema}_rewards_retry_idx`)} ON ${rewards} (status, next_attempt_at, created_at, reward_id) WHERE status = 'pending'`,
  ];
}
