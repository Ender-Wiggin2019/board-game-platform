import type { Pool } from 'pg';

const SOCIAL_TABLES = [
  'session_notes',
  'session_chat_streams',
  'session_chat_sender_streams',
  'session_chat_messages',
  'session_chat_read_cursors',
  'room_chat_streams',
  'room_chat_sender_streams',
  'room_chat_messages',
  'room_chat_read_cursors',
] as const;

/**
 * A product migration can adopt existing social tables without copying data or
 * depending on the game package that historically created their schema.
 */
export async function adoptLegacySocialStorage(
  pool: Pool,
  sourceSchema: string,
): Promise<void> {
  if (
    !/^[a-z_][a-z0-9_]*$/.test(sourceSchema) ||
    sourceSchema === 'board_platform_social'
  )
    throw new Error('Invalid legacy social schema');
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtext('platform-social-storage-migration'))",
    );
    await connection.query('CREATE SCHEMA IF NOT EXISTS board_platform_social');
    for (const table of SOCIAL_TABLES) {
      const result = await connection.query<{
        source: string | null;
        destination: string | null;
      }>(
        'SELECT to_regclass($1)::text AS source, to_regclass($2)::text AS destination',
        [`${sourceSchema}.${table}`, `board_platform_social.${table}`],
      );
      const row = result.rows[0];
      if (!row?.source) continue;
      if (row.destination)
        throw new Error(`Social table exists in both schemas: ${table}`);
      await connection.query(
        `ALTER TABLE ${sourceSchema}.${table} SET SCHEMA board_platform_social`,
      );
    }
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
