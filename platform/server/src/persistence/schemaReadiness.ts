import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '../config/runtimeConfig.js';

export interface ISchemaReadinessClient {
  query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}
export interface ISchemaReadinessPool extends ISchemaReadinessClient {
  end(): Promise<void>;
}
export type TSchemaReadinessConnectionConfig = Pick<
  PoolConfig,
  | 'connectionString'
  | 'connectionTimeoutMillis'
  | 'max'
  | 'idleTimeoutMillis'
  | 'statement_timeout'
  | 'lock_timeout'
  | 'idle_in_transaction_session_timeout'
>;

type TSchemaTableCheck = {
  table: string;
  flag: string;
};
type TSchemaColumnCheck = {
  table: string;
  column: string;
  flag: string;
};
type TSchemaNullableColumnCheck = TSchemaColumnCheck;
type TSchemaIndexCheck = {
  index: string;
  flag: string;
};
type TSchemaConstraintCheck = {
  constraint: string;
  flag: string;
};

/** Tables needed by the platform account, mail, notification and social services. */
const ACCOUNT_SCHEMA_TABLES = [
  { table: 'users', flag: 'users' },
  { table: 'app_settings', flag: 'app_settings' },
  { table: 'auth_sessions', flag: 'auth_sessions' },
  { table: 'auth_challenges', flag: 'auth_challenges' },
  { table: 'registration_drafts', flag: 'registration_drafts' },
  { table: 'account_security_events', flag: 'account_security_events' },
  { table: 'friendships', flag: 'friendships' },
  { table: 'invite_codes', flag: 'invite_codes' },
  { table: 'invite_code_redemptions', flag: 'invite_code_redemptions' },
  { table: 'user_preferences', flag: 'user_preferences' },
  { table: 'mail_outbox', flag: 'mail_outbox' },
  { table: 'mail_suppressions', flag: 'mail_suppressions' },
  { table: 'mail_budget_buckets', flag: 'mail_budget_buckets' },
  { table: 'mail_online_presence', flag: 'mail_online_presence' },
  { table: 'push_subscriptions', flag: 'push_subscriptions' },
  {
    table: 'platform_notification_cursors',
    flag: 'platform_notification_cursors',
  },
  { table: 'platform_mail_turn_mutes', flag: 'platform_mail_turn_mutes' },
  {
    table: 'platform_foreground_presence',
    flag: 'platform_foreground_presence',
  },
  {
    table: 'platform_notification_deliveries',
    flag: 'platform_notification_deliveries',
  },
] as const satisfies readonly TSchemaTableCheck[];

const ACCOUNT_SCHEMA_COLUMNS = [
  ...[
    'id',
    'name',
    'name_key',
    'email',
    'email_key',
    'password_hash',
    'email_verified_at',
    'email_version',
    'account_status',
    'session_version',
    'permission_version',
    'role',
    'navigator_granted_at',
    'navigator_expires_at',
    'created_at',
    'updated_at',
  ].map((column) => ({
    table: 'users',
    column,
    flag: `users_${column}`,
  })),
  ...[
    ['key', 'app_settings_key'],
    ['value', 'app_settings_value'],
  ].map(([column, flag]) => ({
    table: 'app_settings',
    column,
    flag,
  })),
  ...[
    'id',
    'user_id',
    'refresh_hash',
    'family_id',
    'csrf_hash',
    'created_at',
    'expires_at',
    'last_used_at',
    'revoked_at',
    'replacement_id',
    'user_agent',
    'ip_address',
  ].map((column) => ({
    table: 'auth_sessions',
    column,
    flag: `auth_sessions_${column}`,
  })),
  ...[
    'id',
    'purpose',
    'draft_id',
    'user_id',
    'email',
    'email_key',
    'secret_hash',
    'attempts',
    'max_attempts',
    'email_version',
    'session_version',
    'expires_at',
    'consumed_at',
    'invalidated_at',
    'created_at',
  ].map((column) => ({
    table: 'auth_challenges',
    column,
    flag: `auth_challenges_${column}`,
  })),
  ...[
    'id',
    'kind',
    'secret_hash',
    'csrf_hash',
    'status',
    'email',
    'email_key',
    'verified_email_key',
    'email_verified_at',
    'expires_at',
    'idempotency_key',
    'request_fingerprint',
    'receipt_id',
    'created_at',
    'updated_at',
  ].map((column) => ({
    table: 'registration_drafts',
    column,
    flag: `registration_drafts_${column}`,
  })),
  ...[
    'id',
    'actor_user_id',
    'subject_user_id',
    'event_kind',
    'request_id',
    'context',
    'created_at',
  ].map((column) => ({
    table: 'account_security_events',
    column,
    flag: `account_security_events_${column}`,
  })),
  ...[
    'id',
    'user_one_id',
    'user_two_id',
    'requested_by_user_id',
    'status',
    'accepted_at',
    'created_at',
    'updated_at',
  ].map((column) => ({
    table: 'friendships',
    column,
    flag: `friendships_${column}`,
  })),
  ...[
    'id',
    'code',
    'role',
    'expires_at',
    'max_uses',
    'disabled_at',
    'created_by_user_id',
    'created_at',
    'updated_at',
  ].map((column) => ({
    table: 'invite_codes',
    column,
    flag: `invite_codes_${column}`,
  })),
  ...['id', 'invite_code_id', 'user_id', 'redeemed_role', 'created_at'].map(
    (column) => ({
      table: 'invite_code_redemptions',
      column,
      flag: `invite_code_redemptions_${column}`,
    }),
  ),
  ...['user_id', 'preferences', 'updated_at'].map((column) => ({
    table: 'user_preferences',
    column,
    flag: `user_preferences_${column}`,
  })),
  ...[
    'id',
    'dedupe_key',
    'user_id',
    'email_version',
    'challenge_id',
    'runtime_owner',
    'session_id',
    'attention_epoch',
    'recipient',
    'kind',
    'template_key',
    'template_variables',
    'sensitive_payload_ciphertext',
    'sensitive_payload_nonce',
    'sensitive_payload_tag',
    'sensitive_payload_key_version',
    'status',
    'delivery_status',
    'priority',
    'attempt_count',
    'max_attempts',
    'not_before',
    'expires_at',
    'next_attempt_at',
    'lease_token',
    'lease_until',
    'provider_message_id',
    'provider_request_id',
    'provider_sent_at',
    'unknown_since',
    'last_status_checked_at',
    'last_error_code',
    'last_error_message',
    'cancelled_reason',
    'created_at',
    'updated_at',
  ].map((column) => ({
    table: 'mail_outbox',
    column,
    flag: `mail_outbox_${column}`,
  })),
  ...[
    'id',
    'recipient',
    'category',
    'reason',
    'source',
    'expires_at',
    'created_at',
  ].map((column) => ({
    table: 'mail_suppressions',
    column,
    flag: `mail_suppressions_${column}`,
  })),
  ...[
    'scope',
    'scope_key',
    'window_start',
    'limit_units',
    'used_units',
    'updated_at',
  ].map((column) => ({
    table: 'mail_budget_buckets',
    column,
    flag: `mail_budget_buckets_${column}`,
  })),
  ...['connection_id', 'user_id', 'expires_at'].map((column) => ({
    table: 'mail_online_presence',
    column,
    flag: `mail_online_presence_${column}`,
  })),
  ...[
    'id',
    'user_id',
    'endpoint',
    'p256dh',
    'auth',
    'user_agent',
    'created_at',
    'last_notified_at',
  ].map((column) => ({
    table: 'push_subscriptions',
    column,
    flag: `push_subscriptions_${column}`,
  })),
  ...[
    'session_id',
    'user_id',
    'attention_epoch',
    'actionable',
    'action_key',
    'updated_at',
  ].map((column) => ({
    table: 'platform_notification_cursors',
    column,
    flag: `platform_notification_cursors_${column}`,
  })),
  ...['user_id', 'session_id', 'muted_until', 'created_at', 'updated_at'].map(
    (column) => ({
      table: 'platform_mail_turn_mutes',
      column,
      flag: `platform_mail_turn_mutes_${column}`,
    }),
  ),
  ...['user_id', 'session_id', 'last_seen_at', 'expires_at'].map((column) => ({
    table: 'platform_foreground_presence',
    column,
    flag: `platform_foreground_presence_${column}`,
  })),
  ...['session_id', 'user_id', 'notification_key', 'created_at'].map(
    (column) => ({
      table: 'platform_notification_deliveries',
      column,
      flag: `platform_notification_deliveries_${column}`,
    }),
  ),
] as const satisfies readonly TSchemaColumnCheck[];

const ACCOUNT_SCHEMA_NULLABLE_COLUMNS = [
  {
    table: 'invite_codes',
    column: 'expires_at',
    flag: 'invite_codes_expires_at_nullable',
  },
  {
    table: 'invite_codes',
    column: 'max_uses',
    flag: 'invite_codes_max_uses_nullable',
  },
] as const satisfies readonly TSchemaNullableColumnCheck[];

const ACCOUNT_SCHEMA_INDEXES = [
  { index: 'users_name_key_uq', flag: 'users_name_key_uq' },
  { index: 'users_email_key_uq', flag: 'users_email_key_uq' },
  {
    index: 'auth_sessions_refresh_hash_uq',
    flag: 'auth_sessions_refresh_hash_uq',
  },
  { index: 'auth_sessions_user_idx', flag: 'auth_sessions_user_idx' },
  { index: 'auth_sessions_family_idx', flag: 'auth_sessions_family_idx' },
  { index: 'auth_sessions_expiry_idx', flag: 'auth_sessions_expiry_idx' },
  { index: 'auth_challenges_draft_idx', flag: 'auth_challenges_draft_idx' },
  { index: 'auth_challenges_user_idx', flag: 'auth_challenges_user_idx' },
  { index: 'auth_challenges_expiry_idx', flag: 'auth_challenges_expiry_idx' },
  {
    index: 'registration_drafts_status_idx',
    flag: 'registration_drafts_status_idx',
  },
  {
    index: 'registration_drafts_expiry_idx',
    flag: 'registration_drafts_expiry_idx',
  },
  {
    index: 'account_security_events_subject_idx',
    flag: 'account_security_events_subject_idx',
  },
  {
    index: 'account_security_events_request_idx',
    flag: 'account_security_events_request_idx',
  },
  { index: 'friendships_user_one_idx', flag: 'friendships_user_one_idx' },
  { index: 'friendships_user_two_idx', flag: 'friendships_user_two_idx' },
  {
    index: 'friendships_requested_by_idx',
    flag: 'friendships_requested_by_idx',
  },
  { index: 'invite_codes_code_idx', flag: 'invite_codes_code_idx' },
  { index: 'invite_codes_created_at_idx', flag: 'invite_codes_created_at_idx' },
  {
    index: 'invite_code_redemptions_user_idx',
    flag: 'invite_code_redemptions_user_idx',
  },
  {
    index: 'mail_outbox_dedupe_key_idx',
    flag: 'mail_outbox_dedupe_key_idx',
  },
  { index: 'mail_outbox_claim_idx', flag: 'mail_outbox_claim_idx' },
  { index: 'mail_outbox_reconcile_idx', flag: 'mail_outbox_reconcile_idx' },
  {
    index: 'mail_outbox_platform_target_idx',
    flag: 'mail_outbox_platform_target_idx',
  },
  {
    index: 'mail_suppressions_recipient_category_idx',
    flag: 'mail_suppressions_recipient_category_idx',
  },
  {
    index: 'mail_online_presence_user_expiry_idx',
    flag: 'mail_online_presence_user_expiry_idx',
  },
  {
    index: 'push_subscriptions_user_id_idx',
    flag: 'push_subscriptions_user_id_idx',
  },
  {
    index: 'platform_notification_cursors_action_idx',
    flag: 'platform_notification_cursors_action_idx',
  },
  {
    index: 'platform_foreground_presence_expiry_idx',
    flag: 'platform_foreground_presence_expiry_idx',
  },
  {
    index: 'platform_notification_deliveries_created_idx',
    flag: 'platform_notification_deliveries_created_idx',
  },
] as const satisfies readonly TSchemaIndexCheck[];

const ACCOUNT_SCHEMA_CONSTRAINTS = [
  { constraint: 'app_settings_pkey', flag: 'app_settings_pkey' },
  { constraint: 'auth_sessions_pkey', flag: 'auth_sessions_pkey' },
  {
    constraint: 'auth_sessions_refresh_hash_uq',
    flag: 'auth_sessions_refresh_hash_uq_constraint',
  },
  { constraint: 'auth_challenges_pkey', flag: 'auth_challenges_pkey' },
  { constraint: 'registration_drafts_pkey', flag: 'registration_drafts_pkey' },
  {
    constraint: 'registration_drafts_secret_hash_uq',
    flag: 'registration_drafts_secret_hash_uq',
  },
  {
    constraint: 'account_security_events_pkey',
    flag: 'account_security_events_pkey',
  },
  { constraint: 'user_preferences_pkey', flag: 'user_preferences_pkey' },
  {
    constraint: 'user_preferences_user_id_users_id_fk',
    flag: 'user_preferences_user_id_users_id_fk',
  },
  { constraint: 'friendships_pkey', flag: 'friendships_pkey' },
  { constraint: 'friendships_pair_unique', flag: 'friendships_pair_unique' },
  {
    constraint: 'friendships_distinct_users_check',
    flag: 'friendships_distinct_users_check',
  },
  { constraint: 'invite_codes_pkey', flag: 'invite_codes_pkey' },
  {
    constraint: 'invite_codes_code_unique',
    flag: 'invite_codes_code_unique',
  },
  {
    constraint: 'invite_code_redemptions_pkey',
    flag: 'invite_code_redemptions_pkey',
  },
  {
    constraint: 'invite_code_redemptions_code_user_unique',
    flag: 'invite_code_redemptions_code_user_unique',
  },
  { constraint: 'mail_outbox_pkey', flag: 'mail_outbox_pkey' },
  {
    constraint: 'mail_outbox_attempt_count_check',
    flag: 'mail_outbox_attempt_count_check',
  },
  {
    constraint: 'mail_outbox_delivery_status_check',
    flag: 'mail_outbox_delivery_status_check',
  },
  { constraint: 'mail_outbox_kind_check', flag: 'mail_outbox_kind_check' },
  {
    constraint: 'mail_outbox_max_attempts_check',
    flag: 'mail_outbox_max_attempts_check',
  },
  {
    constraint: 'mail_outbox_sensitive_payload_check',
    flag: 'mail_outbox_sensitive_payload_check',
  },
  {
    constraint: 'mail_outbox_status_check',
    flag: 'mail_outbox_status_check',
  },
  {
    constraint: 'mail_outbox_target_check',
    flag: 'mail_outbox_target_check',
  },
  {
    constraint: 'mail_suppressions_pkey',
    flag: 'mail_suppressions_pkey',
  },
  {
    constraint: 'mail_budget_buckets_pkey',
    flag: 'mail_budget_buckets_pkey',
  },
  { constraint: 'mail_budget_limit_check', flag: 'mail_budget_limit_check' },
  { constraint: 'mail_budget_used_check', flag: 'mail_budget_used_check' },
  {
    constraint: 'mail_online_presence_pkey',
    flag: 'mail_online_presence_pkey',
  },
  {
    constraint: 'mail_online_presence_user_id_users_id_fk',
    flag: 'mail_online_presence_user_id_users_id_fk',
  },
  {
    constraint: 'push_subscriptions_pkey',
    flag: 'push_subscriptions_pkey',
  },
  {
    constraint: 'push_subscriptions_endpoint_unique',
    flag: 'push_subscriptions_endpoint_unique',
  },
  {
    constraint: 'platform_notification_cursors_pkey',
    flag: 'platform_notification_cursors_pkey',
  },
  {
    constraint: 'platform_notification_cursors_epoch_check',
    flag: 'platform_notification_cursors_epoch_check',
  },
  {
    constraint: 'platform_mail_turn_mutes_pkey',
    flag: 'platform_mail_turn_mutes_pkey',
  },
  {
    constraint: 'platform_foreground_presence_pkey',
    flag: 'platform_foreground_presence_pkey',
  },
  {
    constraint: 'platform_notification_deliveries_pkey',
    flag: 'platform_notification_deliveries_pkey',
  },
] as const satisfies readonly TSchemaConstraintCheck[];

/** Every alias emitted by the neutral readiness query. */
export const ACCOUNT_SCHEMA_READINESS_FLAGS = [
  ...ACCOUNT_SCHEMA_TABLES.map(({ flag }) => flag),
  ...ACCOUNT_SCHEMA_COLUMNS.map(({ flag }) => flag),
  ...ACCOUNT_SCHEMA_NULLABLE_COLUMNS.map(({ flag }) => flag),
  ...ACCOUNT_SCHEMA_INDEXES.map(({ flag }) => flag),
  ...ACCOUNT_SCHEMA_CONSTRAINTS.map(({ flag }) => flag),
] as const;

function buildSchemaReadinessSelects(): string[] {
  const tableChecks = ACCOUNT_SCHEMA_TABLES.map(
    ({ table, flag }) =>
      `to_regclass('public.${table}') IS NOT NULL AS ${flag}`,
  );
  const columnChecks = ACCOUNT_SCHEMA_COLUMNS.map(
    ({ table, column, flag }) =>
      `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}') AS ${flag}`,
  );
  const nullableColumnChecks = ACCOUNT_SCHEMA_NULLABLE_COLUMNS.map(
    ({ table, column, flag }) =>
      `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}' AND is_nullable = 'YES') AS ${flag}`,
  );
  const indexChecks = ACCOUNT_SCHEMA_INDEXES.map(
    ({ index, flag }) =>
      `to_regclass('public.${index}') IS NOT NULL AS ${flag}`,
  );
  const constraintChecks = ACCOUNT_SCHEMA_CONSTRAINTS.map(
    ({ constraint, flag }) =>
      `EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = '${constraint}') AS ${flag}`,
  );
  return [
    ...tableChecks,
    ...columnChecks,
    ...nullableColumnChecks,
    ...indexChecks,
    ...constraintChecks,
  ];
}

/** SQL fragments for composing neutral checks into a game's readiness query. */
export function buildAccountSchemaReadinessSelects(): string[] {
  return buildSchemaReadinessSelects();
}

function formatMissingTables(missingTables: string[]): string {
  return missingTables.map((table) => `public.${table}`).join(', ');
}

function formatMissingColumns(
  missingColumns: Array<{ table: string; column: string }>,
): string {
  return missingColumns
    .map(({ table, column }) => `public.${table}.${column}`)
    .join(', ');
}

function formatMissingIndexes(missingIndexes: string[]): string {
  return missingIndexes.map((index) => `public.${index}`).join(', ');
}

/** Validate a row produced by buildAccountSchemaReadinessSelects. */
export function assertAccountSchemaRowReady(
  row: QueryResultRow | undefined,
  migrationCommand = 'pnpm --filter @board-platform/server db:migrate',
): void {
  const readinessRow = row as Record<string, unknown> | undefined;
  const missingTables = ACCOUNT_SCHEMA_TABLES.filter(
    ({ flag }) => readinessRow?.[flag] !== true,
  ).map(({ table }) => table);
  if (missingTables.length > 0) {
    throw new Error(
      `Database schema is not ready: missing required table(s) ${formatMissingTables(missingTables)}. Run \`${migrationCommand}\` before starting the server.`,
    );
  }

  const missingColumns = ACCOUNT_SCHEMA_COLUMNS.filter(
    ({ flag }) => readinessRow?.[flag] !== true,
  ).map(({ table, column }) => ({ table, column }));
  if (missingColumns.length > 0) {
    throw new Error(
      `Database schema is not ready: missing required column(s) ${formatMissingColumns(missingColumns)}. Run \`${migrationCommand}\` before starting the server.`,
    );
  }

  const missingNullableColumns = ACCOUNT_SCHEMA_NULLABLE_COLUMNS.filter(
    ({ flag }) => readinessRow?.[flag] !== true,
  ).map(({ table, column }) => ({ table, column }));
  if (missingNullableColumns.length > 0) {
    throw new Error(
      `Database schema is not ready: missing required nullable column(s) ${formatMissingColumns(missingNullableColumns)}. Run \`${migrationCommand}\` before starting the server.`,
    );
  }

  const missingIndexes = ACCOUNT_SCHEMA_INDEXES.filter(
    ({ flag }) => readinessRow?.[flag] !== true,
  ).map(({ index }) => index);
  if (missingIndexes.length > 0) {
    throw new Error(
      `Database schema is not ready: missing required index(es) ${formatMissingIndexes(missingIndexes)}. Run \`${migrationCommand}\` before starting the server.`,
    );
  }

  const missingConstraints = ACCOUNT_SCHEMA_CONSTRAINTS.filter(
    ({ flag }) => readinessRow?.[flag] !== true,
  ).map(({ constraint }) => constraint);
  if (missingConstraints.length > 0) {
    throw new Error(
      `Database schema is not ready: missing required constraint(s) ${missingConstraints.join(', ')}. Run \`${migrationCommand}\` before starting the server.`,
    );
  }
}

export async function assertAccountSchemaReady(
  client: ISchemaReadinessClient,
): Promise<void> {
  const result = await client.query(
    `SELECT\n  ${buildSchemaReadinessSelects().join(',\n  ')}\n`,
  );
  assertAccountSchemaRowReady(result.rows[0]);
}

export function createDatabaseConnectionConfig(
  config: RuntimeConfig = getRuntimeConfig(),
): TSchemaReadinessConnectionConfig {
  return {
    connectionString: config.database.url,
    connectionTimeoutMillis: 10_000,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  };
}

export function createReadyPool(
  connectionConfig?: TSchemaReadinessConnectionConfig,
): Promise<Pool>;
export function createReadyPool<TPool extends ISchemaReadinessPool>(
  poolFactory: () => TPool,
): Promise<TPool>;
export async function createReadyPool<TPool extends ISchemaReadinessPool>(
  input?: (() => TPool) | TSchemaReadinessConnectionConfig,
): Promise<Pool | TPool> {
  const pool =
    typeof input === 'function'
      ? input()
      : new Pool(input ?? createDatabaseConnectionConfig());
  try {
    await assertAccountSchemaReady(pool);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
