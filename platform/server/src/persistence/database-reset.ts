import { Pool } from 'pg';
import {
  getTargetConnectionConfig,
  getTargetDatabaseName,
} from './database-admin.js';

export interface DatabaseResetClient {
  query(sql: string): Promise<unknown>;
}

type ClosableDatabaseResetClient = DatabaseResetClient & {
  end(): Promise<void>;
};

export function buildDatabaseResetSql(tables: readonly string[]): string {
  return `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`;
}

export async function resetDatabase(
  client: DatabaseResetClient,
  tables: readonly string[],
): Promise<void> {
  await client.query(buildDatabaseResetSql(tables));
}

export async function resetTargetDatabase(
  tables: readonly string[],
): Promise<string> {
  const targetDatabase = getTargetDatabaseName();
  const pool = new Pool(
    getTargetConnectionConfig(targetDatabase),
  ) as unknown as ClosableDatabaseResetClient;

  try {
    await resetDatabase(pool, tables);
    return targetDatabase;
  } finally {
    await pool.end();
  }
}
