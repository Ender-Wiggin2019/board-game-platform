import { describe, expect, it, vi } from 'vitest';
import { MailForegroundPresenceService } from '@/mail/mail-foreground-presence.service.js';

function flattenQuery(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenQuery).join('');
  if (typeof value !== 'object' || value === null) return '';
  const record = value as { queryChunks?: unknown; value?: unknown };
  if (record.queryChunks !== undefined) return flattenQuery(record.queryChunks);
  if (record.value !== undefined) return flattenQuery(record.value);
  return '';
}

describe('MailForegroundPresenceService', () => {
  it('touches a bounded TTL row shared with the dedicated worker', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new MailForegroundPresenceService({ execute } as never);

    await service.touch(
      '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
      '3c0df260-a493-4a09-8647-0d0bf2a1cc24',
      60 * 60_000,
    );

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain('INSERT INTO game_foreground_presence');
    expect(query).toContain('ON CONFLICT (user_id, game_id) DO UPDATE');
    expect(query).toContain('expires_at');
  });

  it('reports only unexpired rows as active', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ present: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new MailForegroundPresenceService({ execute } as never);

    await expect(
      service.isActive(
        '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        '3c0df260-a493-4a09-8647-0d0bf2a1cc24',
      ),
    ).resolves.toBe(true);
    await expect(
      service.isActive(
        '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        '3c0df260-a493-4a09-8647-0d0bf2a1cc24',
      ),
    ).resolves.toBe(false);
  });
});
