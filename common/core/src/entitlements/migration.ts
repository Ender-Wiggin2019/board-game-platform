import { EntitlementError } from './errors.js';

export const DEFAULT_ENTITLEMENT_SCHEMA = 'board_platform_entitlements';

export function assertEntitlementSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema))
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      'entitlement schema must be a lower-case SQL identifier',
      false,
    );
}

export function quoteEntitlementIdentifier(identifier: string): string {
  assertEntitlementSchemaName(identifier);
  return `"${identifier}"`;
}

export function entitlementTableName(schema: string, table: string): string {
  assertEntitlementSchemaName(schema);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(table))
    throw new EntitlementError(
      'INVALID_ARGUMENT',
      'entitlement table must be a lower-case SQL identifier',
      false,
    );
  return `${quoteEntitlementIdentifier(schema)}.${quoteEntitlementIdentifier(table)}`;
}

/** Explicit migration. Constructing a PostgresEntitlementStore never calls this. */
export function entitlementMigrationStatements(
  schema = DEFAULT_ENTITLEMENT_SCHEMA,
): readonly string[] {
  assertEntitlementSchemaName(schema);
  const qSchema = quoteEntitlementIdentifier(schema);
  const grants = entitlementTableName(schema, 'grants');
  const balances = entitlementTableName(schema, 'balances');
  const reservations = entitlementTableName(schema, 'reservations');
  return [
    `CREATE SCHEMA IF NOT EXISTS ${qSchema}`,
    `CREATE TABLE IF NOT EXISTS ${grants} (
      namespace text NOT NULL,
      source_record_id text NOT NULL,
      principal_id text NOT NULL,
      asset text NOT NULL,
      quantity bigint NOT NULL CHECK (quantity > 0),
      metadata jsonb,
      digest text NOT NULL,
      grant_id text NOT NULL,
      created_at double precision NOT NULL,
      PRIMARY KEY (namespace, source_record_id, principal_id, asset),
      UNIQUE (grant_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteEntitlementIdentifier(`${schema}_grants_balance_idx`)} ON ${grants} (namespace, principal_id, asset, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${balances} (
      namespace text NOT NULL,
      principal_id text NOT NULL,
      asset text NOT NULL,
      granted bigint NOT NULL CHECK (granted >= 0),
      consumed bigint NOT NULL CHECK (consumed >= 0),
      reserved bigint NOT NULL CHECK (reserved >= 0),
      revision bigint NOT NULL CHECK (revision >= 0),
      PRIMARY KEY (namespace, principal_id, asset),
      CHECK (consumed + reserved <= granted)
    )`,
    `CREATE TABLE IF NOT EXISTS ${reservations} (
      reservation_id text PRIMARY KEY,
      namespace text NOT NULL,
      session_id text NOT NULL,
      command_id text NOT NULL,
      principal_id text NOT NULL,
      asset text NOT NULL,
      quantity bigint NOT NULL CHECK (quantity > 0),
      intent jsonb NOT NULL,
      intent_digest text NOT NULL,
      status text NOT NULL CHECK (status IN ('reserved', 'confirmed', 'released')),
      created_at double precision NOT NULL,
      updated_at double precision NOT NULL,
      UNIQUE (namespace, session_id, command_id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${quoteEntitlementIdentifier(`${schema}_reservations_pending_idx`)} ON ${reservations} (namespace, status, created_at, reservation_id)`,
  ];
}
