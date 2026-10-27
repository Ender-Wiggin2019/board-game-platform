import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const MAIL_JOB_STATUSES = [
  'pending',
  'processing',
  'retry_wait',
  'accepted',
  'unknown',
  'cancelled',
  'dead',
] as const;
export type TMailJobStatus = (typeof MAIL_JOB_STATUSES)[number];

export const MAIL_DELIVERY_STATUSES = [
  'unknown',
  'delivered',
  'bounced',
  'complained',
] as const;
export type TMailDeliveryStatus = (typeof MAIL_DELIVERY_STATUSES)[number];

export const MAIL_KINDS = [
  'account_verification',
  'password_recovery',
  'email_change_verification',
  'security_notice',
  'migration_completed',
  'turn_reminder',
] as const;
export type TMailKind = (typeof MAIL_KINDS)[number];

/** The application binds a legacy game foreign key only in its migration schema. */
export function createMailSchema(legacyGameColumn?: AnyPgColumn) {
  const legacyGameForeignKey = (column: AnyPgColumn, name: string) =>
    legacyGameColumn
      ? [
          foreignKey({
            name,
            columns: [column],
            foreignColumns: [legacyGameColumn],
          }).onDelete('cascade'),
        ]
      : [];

  /** HTTP/worker foreground presence used to suppress turn reminders briefly. */
  const gameForegroundPresence = pgTable(
    'game_foreground_presence',
    {
      userId: uuid('user_id').notNull(),
      gameId: uuid('game_id').notNull(),
      lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      primaryKey({
        name: 'game_foreground_presence_pkey',
        columns: [table.userId, table.gameId],
      }),
      foreignKey({
        name: 'game_foreground_presence_user_id_fkey',
        columns: [table.userId],
        foreignColumns: [users.id],
      }).onDelete('cascade'),
      ...legacyGameForeignKey(
        table.gameId,
        'game_foreground_presence_game_id_fkey',
      ),
      index('game_foreground_presence_expiry_idx').on(table.expiresAt),
    ],
  );

  /**
   * Durable mail work. The dedupe key is the application idempotency boundary;
   * provider MessageId is deliberately stored separately because Tencent SES
   * does not expose the key as an idempotency token.
   */
  const mailOutbox = pgTable(
    'mail_outbox',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      dedupeKey: text('dedupe_key').notNull(),
      userId: uuid('user_id').references(() => users.id, {
        onDelete: 'cascade',
      }),
      /** Snapshot of the account email binding used to enqueue the job. */
      emailVersion: integer('email_version'),
      /** Opaque challenge id; account and migration challenge tables differ. */
      challengeId: uuid('challenge_id'),
      gameId: uuid('game_id'),
      /** Legacy rows retain game_id; native rows use session_id instead. */
      runtimeOwner: text('runtime_owner').notNull().default('legacy'),
      sessionId: text('session_id'),
      attentionEpoch: integer('attention_epoch'),
      recipient: text('recipient').notNull(),
      kind: text('kind').$type<TMailKind>().notNull(),
      templateKey: text('template_key').notNull(),
      /** Only non-sensitive, validated template variables live in this JSON. */
      templateVariables: jsonb('template_variables')
        .$type<Record<string, string>>()
        .notNull()
        .default({}),
      /** AES-GCM payload fields. All three are cleared after terminal handling. */
      sensitivePayloadCiphertext: text('sensitive_payload_ciphertext'),
      sensitivePayloadNonce: text('sensitive_payload_nonce'),
      sensitivePayloadTag: text('sensitive_payload_tag'),
      sensitivePayloadKeyVersion: integer('sensitive_payload_key_version'),
      status: text('status')
        .$type<TMailJobStatus>()
        .notNull()
        .default('pending'),
      deliveryStatus: text('delivery_status')
        .$type<TMailDeliveryStatus>()
        .notNull()
        .default('unknown'),
      priority: integer('priority').notNull().default(0),
      attemptCount: integer('attempt_count').notNull().default(0),
      maxAttempts: integer('max_attempts').notNull().default(5),
      notBefore: timestamp('not_before', { withTimezone: true }),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      leaseToken: uuid('lease_token'),
      leaseUntil: timestamp('lease_until', { withTimezone: true }),
      providerMessageId: text('provider_message_id'),
      providerRequestId: text('provider_request_id'),
      providerSentAt: timestamp('provider_sent_at', { withTimezone: true }),
      unknownSince: timestamp('unknown_since', { withTimezone: true }),
      lastStatusCheckedAt: timestamp('last_status_checked_at', {
        withTimezone: true,
      }),
      lastErrorCode: text('last_error_code'),
      lastErrorMessage: text('last_error_message'),
      cancelledReason: text('cancelled_reason'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      ...legacyGameForeignKey(table.gameId, 'mail_outbox_game_id_games_id_fk'),
      uniqueIndex('mail_outbox_dedupe_key_idx').on(table.dedupeKey),
      index('mail_outbox_claim_idx')
        .on(table.status, table.nextAttemptAt, table.priority)
        .where(sql`${table.status} NOT IN ('cancelled', 'dead')`),
      index('mail_outbox_reconcile_idx').on(
        table.status,
        table.deliveryStatus,
        table.lastStatusCheckedAt,
      ),
      check('mail_outbox_attempt_count_check', sql`${table.attemptCount} >= 0`),
      check(
        'mail_outbox_delivery_status_check',
        sql`${table.deliveryStatus} IN ('unknown', 'delivered', 'bounced', 'complained')`,
      ),
      check(
        'mail_outbox_kind_check',
        sql`${table.kind} IN ('account_verification', 'password_recovery', 'email_change_verification', 'security_notice', 'migration_completed', 'turn_reminder')`,
      ),
      check('mail_outbox_max_attempts_check', sql`${table.maxAttempts} > 0`),
      check(
        'mail_outbox_sensitive_payload_check',
        sql`(${table.sensitivePayloadCiphertext} IS NULL AND ${table.sensitivePayloadNonce} IS NULL AND ${table.sensitivePayloadTag} IS NULL AND ${table.sensitivePayloadKeyVersion} IS NULL) OR (${table.sensitivePayloadCiphertext} IS NOT NULL AND ${table.sensitivePayloadNonce} IS NOT NULL AND ${table.sensitivePayloadTag} IS NOT NULL AND ${table.sensitivePayloadKeyVersion} IS NOT NULL)`,
      ),
      check(
        'mail_outbox_status_check',
        sql`${table.status} IN ('pending', 'processing', 'retry_wait', 'accepted', 'unknown', 'cancelled', 'dead')`,
      ),
      check(
        'mail_outbox_target_check',
        sql`(
          ${table.runtimeOwner} = 'legacy' AND ${table.sessionId} IS NULL
        ) OR (
          ${table.runtimeOwner} = 'platform' AND ${table.sessionId} IS NOT NULL AND ${table.gameId} IS NULL
        )`,
      ),
      index('mail_outbox_platform_target_idx').on(
        table.runtimeOwner,
        table.sessionId,
        table.userId,
        table.attentionEpoch,
      ),
    ],
  );

  const mailSuppressions = pgTable(
    'mail_suppressions',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      recipient: text('recipient').notNull(),
      category: text('category').notNull().default('all'),
      reason: text('reason').notNull(),
      source: text('source').notNull().default('application'),
      expiresAt: timestamp('expires_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      uniqueIndex('mail_suppressions_recipient_category_idx').on(
        sql`lower(${table.recipient})`,
        table.category,
      ),
    ],
  );

  /** Per-account, per-game mute state for voluntary turn reminders. */
  const mailTurnMutes = pgTable(
    'mail_turn_mutes',
    {
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      gameId: uuid('game_id').notNull(),
      mutedUntil: timestamp('muted_until', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'mail_turn_mutes_pkey',
        columns: [table.userId, table.gameId],
      }),
      ...legacyGameForeignKey(
        table.gameId,
        'mail_turn_mutes_game_id_games_id_fk',
      ),
    ],
  );

  const mailBudgetBuckets = pgTable(
    'mail_budget_buckets',
    {
      scope: text('scope').notNull(),
      scopeKey: text('scope_key').notNull(),
      windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
      limitUnits: integer('limit_units').notNull(),
      usedUnits: integer('used_units').notNull().default(0),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'mail_budget_buckets_pkey',
        columns: [table.scope, table.scopeKey, table.windowStart],
      }),
      check('mail_budget_limit_check', sql`${table.limitUnits} >= 0`),
      check('mail_budget_used_check', sql`${table.usedUnits} >= 0`),
    ],
  );

  /**
   * Tracks the lifecycle of a projected action opportunity. A cursor row is
   * updated in the same transaction as the authoritative projection and its
   * outbox insert.
   */
  const notificationCursors = pgTable(
    'notification_cursors',
    {
      gameId: uuid('game_id').notNull(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      attentionEpoch: integer('attention_epoch').notNull().default(0),
      actionable: boolean('actionable').notNull().default(false),
      actionKey: text('action_key'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'notification_cursors_pkey',
        columns: [table.gameId, table.userId],
      }),
      ...legacyGameForeignKey(
        table.gameId,
        'notification_cursors_game_id_games_id_fk',
      ),
      index('notification_cursors_game_action_idx').on(
        table.gameId,
        table.actionable,
        table.updatedAt,
      ),
      check(
        'notification_cursors_epoch_check',
        sql`${table.attentionEpoch} >= 0`,
      ),
    ],
  );

  /** Native session target state; legacy game rows remain in notificationCursors. */
  const platformNotificationCursors = pgTable(
    'platform_notification_cursors',
    {
      sessionId: text('session_id').notNull(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      attentionEpoch: integer('attention_epoch').notNull().default(0),
      actionable: boolean('actionable').notNull().default(false),
      actionKey: text('action_key'),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'platform_notification_cursors_pkey',
        columns: [table.sessionId, table.userId],
      }),
      index('platform_notification_cursors_action_idx').on(
        table.sessionId,
        table.actionable,
        table.updatedAt,
      ),
      check(
        'platform_notification_cursors_epoch_check',
        sql`${table.attentionEpoch} >= 0`,
      ),
    ],
  );

  /** Native session mute state; legacy game mute rows remain in mailTurnMutes. */
  const platformMailTurnMutes = pgTable(
    'platform_mail_turn_mutes',
    {
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      sessionId: text('session_id').notNull(),
      mutedUntil: timestamp('muted_until', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'platform_mail_turn_mutes_pkey',
        columns: [table.userId, table.sessionId],
      }),
    ],
  );

  /** Native session foreground presence; intentionally has no games FK. */
  const platformForegroundPresence = pgTable(
    'platform_foreground_presence',
    {
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      sessionId: text('session_id').notNull(),
      lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
      primaryKey({
        name: 'platform_foreground_presence_pkey',
        columns: [table.userId, table.sessionId],
      }),
      index('platform_foreground_presence_expiry_idx').on(table.expiresAt),
    ],
  );

  /** Durable push/lifecycle dedupe for native session facts. */
  const platformNotificationDeliveries = pgTable(
    'platform_notification_deliveries',
    {
      sessionId: text('session_id').notNull(),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      notificationKey: text('notification_key').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'platform_notification_deliveries_pkey',
        columns: [table.sessionId, table.userId, table.notificationKey],
      }),
      index('platform_notification_deliveries_created_idx').on(table.createdAt),
    ],
  );

  return {
    gameForegroundPresence,
    mailOutbox,
    mailSuppressions,
    mailTurnMutes,
    mailBudgetBuckets,
    notificationCursors,
    platformNotificationCursors,
    platformMailTurnMutes,
    platformForegroundPresence,
    platformNotificationDeliveries,
  };
}

export const {
  gameForegroundPresence,
  mailOutbox,
  mailSuppressions,
  mailTurnMutes,
  mailBudgetBuckets,
  notificationCursors,
  platformNotificationCursors,
  platformMailTurnMutes,
  platformForegroundPresence,
  platformNotificationDeliveries,
} = createMailSchema();

export type TMailOutboxRow = typeof mailOutbox.$inferSelect;
export type TMailOutboxInsert = typeof mailOutbox.$inferInsert;
export type TGameForegroundPresenceRow =
  typeof gameForegroundPresence.$inferSelect;
export type TMailSuppressionRow = typeof mailSuppressions.$inferSelect;
export type TMailTurnMuteRow = typeof mailTurnMutes.$inferSelect;
export type TMailBudgetBucketRow = typeof mailBudgetBuckets.$inferSelect;
export type TNotificationCursorRow = typeof notificationCursors.$inferSelect;
