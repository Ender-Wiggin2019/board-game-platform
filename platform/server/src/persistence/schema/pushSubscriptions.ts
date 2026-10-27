import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Web Push subscriptions, one row per device.
 *
 * A single account legitimately has several (phone, tablet, desktop), so these
 * cannot live in the `user_preferences` blob. The push endpoint is the device's
 * identity as far as the push service is concerned, so it carries the unique
 * constraint: re-subscribing the same device must update the existing row
 * rather than accumulate duplicates that would each deliver the same alert.
 *
 * `p256dh` and `auth` are the subscription's client keys, needed to encrypt
 * payloads. They are useless without the server's VAPID private key.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** For telling devices apart in the settings UI. */
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Last successful delivery, for pruning long-dead devices. */
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  },
  (table) => [index('push_subscriptions_user_id_idx').on(table.userId)],
);

export type TPushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type TPushSubscriptionInsert = typeof pushSubscriptions.$inferInsert;
