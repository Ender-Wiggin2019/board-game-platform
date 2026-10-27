import { getTableConfig, integer, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { createAccountSchema, users } from '@/persistence/schema/users.js';

describe('account users schema factory', () => {
  it('keeps the complete neutral column set on the default table', () => {
    const columns = getTableConfig(users).columns;

    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'name_key',
      'email',
      'email_key',
      'password_hash',
      'email_verified_at',
      'email_version',
      'account_status',
      'session_version',
      'permission_version',
      'role',
      'navigator_granted_at',
      'navigator_expires_at',
      'created_at',
      'updated_at',
    ]);
    expect(users.nameKey).toBeDefined();
    expect(users.emailKey).toBeDefined();
  });

  it('preserves base and game extension columns through factory inference', () => {
    const gameUsers = createAccountSchema({
      reputation: integer('reputation').notNull().default(0),
    });
    const insert: typeof gameUsers.$inferInsert = {
      name: 'Example',
      email: 'example@example.test',
      passwordHash: 'hash',
      reputation: 10,
    };

    expect(insert.reputation).toBe(10);
    expect(
      getTableConfig(gameUsers).columns.map((column) => column.name),
    ).toContain('reputation');
    expect(gameUsers.id).toBeDefined();
    expect(gameUsers.reputation).toBeDefined();
  });

  it('rejects an extension that collides with a platform-owned column', () => {
    expect(() =>
      createAccountSchema({
        email: text('email'),
      }),
    ).toThrow('Account column already owned by platform: email');
  });
});
