import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { adoptLegacySocialStorage } from '@/platform/socialStorage.js';

function storage(sourceTables: string[], destinationTables: string[] = []) {
  const source = new Set(sourceTables);
  const destination = new Set(destinationTables);
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: string[]) => {
    if (sql.startsWith('SELECT to_regclass')) {
      const table = values?.[0]?.split('.')[1] ?? '';
      return {
        rows: [
          {
            source: source.has(table) ? values?.[0] : null,
            destination: destination.has(table) ? values?.[1] : null,
          },
        ],
      };
    }
    if (sql.startsWith('ALTER TABLE')) {
      const table = sql.split(' ')[2]?.split('.')[1] ?? '';
      source.delete(table);
      destination.add(table);
    }
    return { rows: [] };
  });
  return {
    pool: { connect: async () => ({ query, release }) } as unknown as Pool,
    query,
    release,
    source,
    destination,
  };
}

describe('adopting legacy social storage', () => {
  it('moves existing tables in a transaction and safely repeats after migration', async () => {
    const db = storage(['session_notes', 'room_chat_messages']);
    await adoptLegacySocialStorage(db.pool, 'legacy_social');
    expect(db.source.size).toBe(0);
    expect([...db.destination]).toEqual([
      'session_notes',
      'room_chat_messages',
    ]);
    expect(db.query).toHaveBeenCalledWith('BEGIN');
    expect(db.query).toHaveBeenCalledWith('COMMIT');
    const alters = () =>
      db.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER TABLE'))
        .length;
    expect(alters()).toBe(2);
    await adoptLegacySocialStorage(db.pool, 'legacy_social');
    expect(alters()).toBe(2);
    expect(db.release).toHaveBeenCalledTimes(2);
  });

  it('rolls back instead of overwriting a destination table', async () => {
    const db = storage(['session_notes'], ['session_notes']);
    await expect(
      adoptLegacySocialStorage(db.pool, 'legacy_social'),
    ).rejects.toThrow('both schemas');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.query).not.toHaveBeenCalledWith('COMMIT');
    expect(db.release).toHaveBeenCalledOnce();
  });

  it('rejects unsafe or self-referential identifiers before opening a connection', async () => {
    const db = storage([]);
    for (const schema of [
      'public;DROP SCHEMA public',
      'board_platform_social',
      '',
    ])
      await expect(adoptLegacySocialStorage(db.pool, schema)).rejects.toThrow(
        'Invalid legacy social schema',
      );
    expect(db.query).not.toHaveBeenCalled();
  });
});
