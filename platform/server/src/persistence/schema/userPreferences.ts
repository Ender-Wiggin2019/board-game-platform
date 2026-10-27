import type { IAccountPreferences } from '@board-platform/contracts/types/protocol/accountPreferences';
import { jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export type { IAccountPreferences } from '@board-platform/contracts/types/protocol/accountPreferences';

/** Account preferences live in one JSON blob, so new fields need no migration. */
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences')
    .$type<IAccountPreferences>()
    .notNull()
    .default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TUserPreferencesRow = typeof userPreferences.$inferSelect;
export type TUserPreferencesInsert = typeof userPreferences.$inferInsert;
