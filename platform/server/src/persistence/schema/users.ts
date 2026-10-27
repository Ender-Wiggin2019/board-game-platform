import { type BuildColumns, type SQL, sql } from 'drizzle-orm';
import {
  check,
  integer,
  type PgColumnBuilderBase,
  type PgTableWithColumns,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Keep generated key columns non-null in the application type. */
const generatedText = (name: string, expression: SQL) => {
  const column = text(name).generatedAlwaysAs(expression);
  return column as Omit<typeof column, '_'> & {
    _: Omit<(typeof column)['_'], 'notNull'> & { notNull: true };
  };
};

type AccountColumnBuilders = Record<string, PgColumnBuilderBase>;

const accountColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  nameKey: generatedText('name_key', sql`lower(name)`),
  email: text('email').notNull().unique(),
  emailKey: generatedText('email_key', sql`lower(btrim(email))`),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  emailVersion: integer('email_version').notNull().default(1),
  accountStatus: text('account_status').notNull().default('active'),
  sessionVersion: integer('session_version').notNull().default(0),
  permissionVersion: integer('permission_version').notNull().default(0),
  /** The persisted role is the base role; navigator is a time-bound grant. */
  role: text('role').notNull().default('guest'),
  navigatorGrantedAt: timestamp('navigator_granted_at', {
    withTimezone: true,
  }),
  navigatorExpiresAt: timestamp('navigator_expires_at', {
    withTimezone: true,
  }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;

type AccountSchema<ExtraColumns extends AccountColumnBuilders> =
  PgTableWithColumns<{
    name: 'users';
    schema: undefined;
    columns: BuildColumns<'users', typeof accountColumns & ExtraColumns, 'pg'>;
    dialect: 'pg';
  }>;

/** Platform owns identity columns; an installed game may bind legacy extension columns. */
export function createAccountSchema<
  ExtraColumns extends AccountColumnBuilders = Record<never, never>,
>(
  extensionColumns: ExtraColumns = {} as ExtraColumns,
): AccountSchema<ExtraColumns> {
  for (const key of Object.keys(extensionColumns)) {
    if (Object.hasOwn(accountColumns, key))
      throw new Error(`Account column already owned by platform: ${key}`);
  }
  const columns = {
    ...accountColumns,
    ...extensionColumns,
  } as typeof accountColumns & ExtraColumns;
  return pgTable('users', columns, (table) => ({
    nameKeyUnique: uniqueIndex('users_name_key_uq').on(table.nameKey),
    emailKeyUnique: uniqueIndex('users_email_key_uq').on(table.emailKey),
    accountStatusCheck: check(
      'users_account_status_check',
      sql`${table.accountStatus} IN ('active', 'suspended', 'deleted')`,
    ),
    roleCheck: check(
      'users_role_check',
      sql`${table.role} IN ('guest', 'player', 'tester', 'admin', 'superadmin')`,
    ),
  })) as AccountSchema<ExtraColumns>;
}

export const users = createAccountSchema();

export type TUserRow = typeof users.$inferSelect;
export type TUserInsert = typeof users.$inferInsert;
