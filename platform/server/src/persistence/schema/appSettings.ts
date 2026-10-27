import { pgTable, text } from 'drizzle-orm/pg-core';

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
