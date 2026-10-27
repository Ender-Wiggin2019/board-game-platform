import type {
  ERole,
  TInviteCodeGrantRole,
} from '@board-platform/contracts/auth/roles';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

type TInviteCodeStoredRole = TInviteCodeGrantRole | ERole.NAVIGATOR;

export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    role: text('role').$type<TInviteCodeStoredRole>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    maxUsesPositiveCheck: check(
      'invite_codes_max_uses_positive_check',
      sql`${table.maxUses} IS NULL OR ${table.maxUses} > 0`,
    ),
    roleCheck: check(
      'invite_codes_role_check',
      sql`${table.role} IN ('player', 'navigator', 'tester')`,
    ),
    codeIdx: index('invite_codes_code_idx').on(table.code),
    createdAtIdx: index('invite_codes_created_at_idx').on(table.createdAt),
  }),
);

export const inviteCodeRedemptions = pgTable(
  'invite_code_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inviteCodeId: uuid('invite_code_id')
      .notNull()
      .references(() => inviteCodes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redeemedRole: text('redeemed_role')
      .$type<TInviteCodeStoredRole>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    roleCheck: check(
      'invite_code_redemptions_role_check',
      sql`${table.redeemedRole} IN ('player', 'navigator', 'tester')`,
    ),
    inviteUserUnique: unique('invite_code_redemptions_code_user_unique').on(
      table.inviteCodeId,
      table.userId,
    ),
    userIdx: index('invite_code_redemptions_user_idx').on(table.userId),
  }),
);

export type TInviteCodeRow = typeof inviteCodes.$inferSelect;
export type TInviteCodeInsert = typeof inviteCodes.$inferInsert;
export type TInviteCodeRedemptionRow =
  typeof inviteCodeRedemptions.$inferSelect;
export type TInviteCodeRedemptionInsert =
  typeof inviteCodeRedemptions.$inferInsert;
