import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Read-only declaration of the account migration receipt ledger.
 *
 * The migration workflow remains game-owned for now.  Platform administration
 * only reads this existing table; this declaration does not add or alter a
 * database migration.
 */
export const accountImportReceipts = pgTable(
  'account_import_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSystem: text('source_system').notNull(),
    legacyUserId: text('legacy_user_id').notNull(),
    newUserId: uuid('new_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    snapshotId: uuid('snapshot_id').notNull(),
    preparedAssetDigest: text('prepared_asset_digest').notNull(),
    requestDigest: text('request_digest').notNull(),
    policyVersion: text('policy_version').notNull(),
    sourceManifestDigest: text('source_manifest_digest').notNull(),
    counts: jsonb('counts').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sourceIdentityUnique: unique(
      'account_import_receipts_source_system_legacy_user_id_key',
    ).on(table.sourceSystem, table.legacyUserId),
    newUserUnique: unique('account_import_receipts_new_user_id_key').on(
      table.newUserId,
    ),
    snapshotIdx: index('account_import_receipts_snapshot_idx').on(
      table.snapshotId,
    ),
  }),
);

export type TAccountImportReceipt = typeof accountImportReceipts.$inferSelect;
