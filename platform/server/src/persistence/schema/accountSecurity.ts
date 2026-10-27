import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Server-side refresh sessions. Only a SHA-256 refresh token digest is kept. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshHash: text('refresh_hash')
      .notNull()
      .unique('auth_sessions_refresh_hash_uq'),
    familyId: uuid('family_id').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacementId: uuid('replacement_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (table) => ({
    userIdx: index('auth_sessions_user_idx').on(table.userId),
    familyIdx: index('auth_sessions_family_idx').on(table.familyId),
    expiryIdx: index('auth_sessions_expiry_idx').on(table.expiresAt),
  }),
);

/** One-time email proof or password recovery challenge. */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purpose: text('purpose').notNull(),
    draftId: uuid('draft_id').references(() => registrationDrafts.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    emailKey: text('email_key').notNull(),
    secretHash: text('secret_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    emailVersion: integer('email_version'),
    sessionVersion: integer('session_version'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    draftIdx: index('auth_challenges_draft_idx').on(table.draftId),
    userIdx: index('auth_challenges_user_idx').on(table.userId),
    expiryIdx: index('auth_challenges_expiry_idx').on(table.expiresAt),
  }),
);

/** A normal registration draft before an account exists. */
export const registrationDrafts = pgTable(
  'registration_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull().default('normal'),
    secretHash: text('secret_hash')
      .notNull()
      .unique('registration_drafts_secret_hash_uq'),
    csrfHash: text('csrf_hash').notNull(),
    status: text('status').notNull().default('email_pending'),
    email: text('email'),
    emailKey: text('email_key'),
    verifiedEmailKey: text('verified_email_key'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key'),
    requestFingerprint: text('request_fingerprint'),
    receiptId: uuid('receipt_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index('registration_drafts_status_idx').on(table.status),
    expiryIdx: index('registration_drafts_expiry_idx').on(table.expiresAt),
  }),
);

/** Security audit metadata. Secret material must never be put in context. */
export const accountSecurityEvents = pgTable(
  'account_security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    subjectUserId: uuid('subject_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    eventKind: text('event_kind').notNull(),
    requestId: text('request_id'),
    context: jsonb('context').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    subjectIdx: index('account_security_events_subject_idx').on(
      table.subjectUserId,
      table.createdAt,
    ),
    requestIdx: index('account_security_events_request_idx').on(
      table.requestId,
    ),
  }),
);

export type TAuthSessionRow = typeof authSessions.$inferSelect;
export type TAuthSessionInsert = typeof authSessions.$inferInsert;
export type TAuthChallengeRow = typeof authChallenges.$inferSelect;
export type TAuthChallengeInsert = typeof authChallenges.$inferInsert;
export type TRegistrationDraftRow = typeof registrationDrafts.$inferSelect;
export type TRegistrationDraftInsert = typeof registrationDrafts.$inferInsert;
export type TAccountSecurityEventRow =
  typeof accountSecurityEvents.$inferSelect;
