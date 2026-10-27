import type {
  EMessageSeverity,
  TMessageContent,
} from '@board-platform/contracts/types/protocol/messages';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** The storage layout is shared; each installed game owns its content codec. */
export function createMessageSchema<Content = TMessageContent>() {
  const globalMessages = pgTable(
    'global_messages',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      content: jsonb('content').$type<Content>().notNull(),
      requiresResolution: boolean('requires_resolution')
        .notNull()
        .default(false),
      severity: text('severity').$type<EMessageSeverity>().notNull(),
      createdByUserId: uuid('created_by_user_id').references(() => users.id, {
        onDelete: 'set null',
      }),
      recipientUserId: uuid('recipient_user_id').references(() => users.id, {
        onDelete: 'cascade',
      }),
      sourceKey: text('source_key'),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => ({
      createdAtIdx: index('global_messages_created_at_idx').on(table.createdAt),
      recipientCreatedAtIdx: index(
        'global_messages_recipient_created_at_idx',
      ).on(
        table.recipientUserId,
        table.createdAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      ),
      sourceKeyUnique: uniqueIndex('global_messages_source_key_unique')
        .on(table.sourceKey)
        .where(sql`${table.sourceKey} IS NOT NULL`),
      resolutionRecipientCheck: check(
        'global_messages_resolution_recipient_check',
        sql`NOT ${table.requiresResolution} OR ${table.recipientUserId} IS NOT NULL`,
      ),
    }),
  );

  const userMessageReads = pgTable(
    'user_message_reads',
    {
      messageId: uuid('message_id')
        .notNull()
        .references(() => globalMessages.id, { onDelete: 'cascade' }),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      readAt: timestamp('read_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => ({
      pk: primaryKey({ columns: [table.userId, table.messageId] }),
      userIdx: index('user_message_reads_user_idx').on(table.userId),
      readAtIdx: index('user_message_reads_read_at_idx').on(
        table.readAt,
        table.messageId,
        table.userId,
      ),
    }),
  );

  const userMessageResolutions = pgTable(
    'user_message_resolutions',
    {
      messageId: uuid('message_id')
        .notNull()
        .references(() => globalMessages.id, { onDelete: 'cascade' }),
      userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    },
    (table) => ({
      pk: primaryKey({ columns: [table.userId, table.messageId] }),
      pendingUserIdx: index('user_message_resolutions_pending_user_idx')
        .on(table.userId, table.messageId)
        .where(sql`${table.resolvedAt} IS NULL`),
    }),
  );

  return { globalMessages, userMessageReads, userMessageResolutions };
}

export const { globalMessages, userMessageReads, userMessageResolutions } =
  createMessageSchema();

export type TGlobalMessageRow = typeof globalMessages.$inferSelect;
export type TGlobalMessageInsert = typeof globalMessages.$inferInsert;
export type TUserMessageReadRow = typeof userMessageReads.$inferSelect;
export type TUserMessageResolutionRow =
  typeof userMessageResolutions.$inferSelect;
