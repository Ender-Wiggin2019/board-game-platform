import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS,
  MailOnlinePresenceService,
} from '@/mail/mail-online-presence.service.js';

function flattenQuery(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenQuery).join('');
  if (typeof value !== 'object' || value === null) return '';
  const record = value as { queryChunks?: unknown; value?: unknown };
  if (record.queryChunks !== undefined) return flattenQuery(record.queryChunks);
  if (record.value !== undefined) return flattenQuery(record.value);
  return '';
}

describe('MailOnlinePresenceService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a failed initial write while the socket remains locally connected', async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ rows: [] });
    const service = new MailOnlinePresenceService({ execute } as never);

    await expect(
      service.connect('7c303e2b-590a-4a09-8647-0d0bf2a1cc24', 'socket-1'),
    ).rejects.toThrow('database unavailable');

    await vi.advanceTimersByTimeAsync(MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(flattenQuery(execute.mock.calls[1]?.[0])).toContain(
      'INSERT INTO mail_online_presence',
    );
    service.onModuleDestroy();
  });

  it('keeps a user online while another tab remains connected', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new MailOnlinePresenceService({ execute } as never);
    const userId = '7c303e2b-590a-4a09-8647-0d0bf2a1cc24';

    await service.connect(userId, 'socket-a');
    await service.connect(userId, 'socket-b');
    await service.disconnect('socket-a');
    await vi.advanceTimersByTimeAsync(MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);

    expect(execute).toHaveBeenCalledTimes(3);
    const refreshQuery = flattenQuery(execute.mock.calls[2]?.[0]);
    expect(refreshQuery).toContain('mail_online_presence');
    expect(refreshQuery).not.toContain('socket-a');

    await service.disconnect('socket-b');
    await vi.advanceTimersByTimeAsync(MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);
    expect(execute).toHaveBeenCalledTimes(3);
    service.onModuleDestroy();
  });

  it('stops refreshing after shutdown', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new MailOnlinePresenceService({ execute } as never);

    await service.connect('7c303e2b-590a-4a09-8647-0d0bf2a1cc24', 'socket-1');
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a socket removed during its initial write', async () => {
    let releaseWrite!: () => void;
    const execute = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({ rows: [] });
        }),
    );
    const service = new MailOnlinePresenceService({ execute } as never);

    const connect = service.connect(
      '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
      'socket-1',
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await service.disconnect('socket-1');
    releaseWrite();
    await connect;

    expect(execute).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('drops a queued refresh batch when its socket disconnects first', async () => {
    vi.useFakeTimers();
    let releaseWrite!: () => void;
    const execute = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({ rows: [] });
        }),
    );
    const service = new MailOnlinePresenceService({ execute } as never);
    const connect = service.connect(
      '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
      'socket-1',
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);
    await Promise.resolve();
    await service.disconnect('socket-1');
    releaseWrite();
    await connect;
    await Promise.resolve();
    await Promise.resolve();

    expect(execute).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });

  it('reports only unexpired rows as online', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ present: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new MailOnlinePresenceService({ execute } as never);
    const userId = '7c303e2b-590a-4a09-8647-0d0bf2a1cc24';

    await expect(service.isOnline(userId)).resolves.toBe(true);
    await expect(service.isOnline(userId)).resolves.toBe(false);
    expect(flattenQuery(execute.mock.calls[0]?.[0])).toContain(
      'expires_at > clock_timestamp()',
    );
  });
});
