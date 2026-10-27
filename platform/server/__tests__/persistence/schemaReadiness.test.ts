import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SCHEMA_READINESS_FLAGS,
  assertAccountSchemaReady,
  createReadyPool,
} from '@/persistence/schemaReadiness.js';

function readySchemaRow() {
  return Object.fromEntries(
    ACCOUNT_SCHEMA_READINESS_FLAGS.map((flag) => [flag, true]),
  );
}

describe('platform schema readiness', () => {
  it('checks neutral account, social, mail and notification schema', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [readySchemaRow()],
    });

    await expect(assertAccountSchemaReady({ query })).resolves.toBeUndefined();

    const queryText = query.mock.calls[0]?.[0] as string;
    expect(queryText).toContain('public.friendships');
    expect(queryText).toContain('public.push_subscriptions');
    expect(queryText).toContain('public.platform_notification_cursors');
    expect(queryText).not.toMatch(/public\.(games|game_players)/);
  });

  it('reports a missing friendship table without relying on SETI tables', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...readySchemaRow(), friendships: false }],
    });

    await expect(assertAccountSchemaReady({ query })).rejects.toThrow(
      'public.friendships',
    );
  });

  it('closes a pool when neutral schema readiness fails', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ ...readySchemaRow(), push_subscriptions: false }],
      }),
      end: vi.fn().mockResolvedValue(undefined),
    };

    await expect(createReadyPool(() => pool)).rejects.toThrow(
      'public.push_subscriptions',
    );
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
