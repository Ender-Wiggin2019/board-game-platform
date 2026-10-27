import type { TFriendshipStatus } from '@board-platform/contracts/types/protocol/friends';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Account-to-account friendship state, independent of any installed game. */
export const friendships = pgTable(
  'friendships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userOneId: uuid('user_one_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userTwoId: uuid('user_two_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').$type<TFriendshipStatus>().notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pairUnique: unique('friendships_pair_unique').on(
      table.userOneId,
      table.userTwoId,
    ),
    userOneIdx: index('friendships_user_one_idx').on(table.userOneId),
    userTwoIdx: index('friendships_user_two_idx').on(table.userTwoId),
    requestedByIdx: index('friendships_requested_by_idx').on(
      table.requestedByUserId,
    ),
    distinctUsersCheck: check(
      'friendships_distinct_users_check',
      sql`${table.userOneId} <> ${table.userTwoId}`,
    ),
  }),
);

export type TFriendshipRow = typeof friendships.$inferSelect;
export type TFriendshipInsert = typeof friendships.$inferInsert;
