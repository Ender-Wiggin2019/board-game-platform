import { RatingError } from './errors.js';

export const DEFAULT_RATING_SCHEMA = 'board_platform_ratings';

export function assertSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating schema must be a lower-case SQL identifier',
      false,
    );
}

export function quoteIdentifier(identifier: string): string {
  assertSchemaName(identifier);
  return `"${identifier}"`;
}

export function tableName(schema: string, table: string): string {
  assertSchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new RatingError(
      'INVALID_ARGUMENT',
      'rating table must be a lower-case SQL identifier',
      false,
    );
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Explicit migration. Constructing a PostgresRatingStore never calls this. */
export function migrationStatements(
  schema = DEFAULT_RATING_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  const qSchema = quoteIdentifier(schema);
  const sequences = tableName(schema, 'pool_sequences');
  const ratings = tableName(schema, 'ratings');
  const settlements = tableName(schema, 'settlements');
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${sequences} (
      pool_id text PRIMARY KEY,
      next_sequence bigint NOT NULL CHECK (next_sequence >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS ${ratings} (
      pool_id text NOT NULL,
      participant_id text NOT NULL,
      policy_version text NOT NULL,
      progression_policy_version text NOT NULL,
      initial_state jsonb NOT NULL,
      state jsonb NOT NULL,
      ranking_score double precision,
      updated_sequence bigint NOT NULL CHECK (updated_sequence >= 1),
      PRIMARY KEY (pool_id, participant_id)
    )`,
    `ALTER TABLE ${ratings} ADD COLUMN IF NOT EXISTS ranking_score double precision`,
    `CREATE INDEX IF NOT EXISTS "ratings_ranking_idx" ON ${ratings} (pool_id, ranking_score DESC NULLS LAST, participant_id ASC)`,
    `CREATE TABLE IF NOT EXISTS ${settlements} (
      pool_id text NOT NULL,
      session_id text NOT NULL,
      result_revision integer NOT NULL CHECK (result_revision >= 1),
      digest text NOT NULL,
      occurred_at double precision NOT NULL,
      sequence bigint NOT NULL CHECK (sequence >= 1),
      policy_version text NOT NULL,
      progression_policy_version text NOT NULL,
      season_id text,
      route jsonb NOT NULL,
      result jsonb NOT NULL,
      participants jsonb NOT NULL,
      PRIMARY KEY (session_id, result_revision),
      UNIQUE (pool_id, sequence)
    )`,
    `CREATE INDEX IF NOT EXISTS "settlements_pool_idx" ON ${settlements} (pool_id, sequence)`,
  ];
}
