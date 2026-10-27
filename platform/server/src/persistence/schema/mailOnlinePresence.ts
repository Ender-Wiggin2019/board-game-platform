import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Shared lease for every authenticated WebSocket connection. */
export const mailOnlinePresence = pgTable(
  'mail_online_presence',
  {
    connectionId: text('connection_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('mail_online_presence_user_expiry_idx').on(
      table.userId,
      table.expiresAt,
    ),
  ],
);

export type TMailOnlinePresenceRow = typeof mailOnlinePresence.$inferSelect;
