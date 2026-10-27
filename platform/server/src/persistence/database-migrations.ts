import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import {
  getTargetConnectionConfig,
  getTargetDatabaseName,
} from './database-admin.js';

export interface DatabaseMigrationOptions {
  readonly migrationsFolder: string;
  readonly afterMigrate?: (pool: Pool) => Promise<void>;
}

/**
 * Checks that an empty database is being initialized from the immutable
 * production baseline. Game packages may add their own post-migration hooks,
 * but this preflight remains game-independent.
 */
export async function assertMigrationBaseline(
  pool: Pool,
  migrationsFolder: string,
): Promise<void> {
  const [baseline] = readMigrationFiles({ migrationsFolder });
  if (!baseline) throw new Error('The database migration baseline is missing.');

  const history = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  );
  if (history.rows[0]?.exists) {
    const first = await pool.query<{ hash: string }>(
      `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id LIMIT 1`,
    );
    if (first.rows[0]) {
      if (first.rows[0].hash === baseline.hash) return;
      throw new Error(
        'This database uses a different migration baseline. Back it up and use a new database for the production baseline; import accounts through the account migration workflow. Do not clear or rewrite its migration history.',
      );
    }
  }

  const existing = await pool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'migration_private')
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.deptype = 'e'
        )
    ) AS exists
  `);
  if (existing.rows[0]?.exists) {
    throw new Error(
      'The database contains existing objects without the production migration baseline. Use a new empty database; do not mark an existing schema as migrated.',
    );
  }
}

export async function runDatabaseMigrations(
  options: DatabaseMigrationOptions,
): Promise<string> {
  const targetDatabase = getTargetDatabaseName();
  const pool = new Pool(getTargetConnectionConfig(targetDatabase));
  const db = drizzle(pool);
  const lock = await pool.connect();

  try {
    await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      'board-platform:migrations',
    ]);
    await assertMigrationBaseline(pool, options.migrationsFolder);
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await migrate(db, { migrationsFolder: options.migrationsFolder });
    await options.afterMigrate?.(pool);
    return targetDatabase;
  } finally {
    await lock
      .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
        'board-platform:migrations',
      ])
      .catch(() => undefined);
    lock.release();
    await pool.end();
  }
}
