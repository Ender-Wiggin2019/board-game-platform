import { describe, expect, it, vi } from 'vitest';
import { MailOpsService } from '@/mail/mail-ops.service.js';

describe('MailOpsService', () => {
  it('returns bounded operational data without payload fields', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: 'pending', count: 2 }] })
      .mockResolvedValueOnce({
        rows: [{ deliveryStatus: 'unknown', count: 2 }],
      })
      .mockResolvedValueOnce({ rows: [{ kind: 'turn_reminder', count: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            dedupeKey: 'turn_email:game:user:1',
            recipient: 'alice@example.com',
            kind: 'turn_reminder',
            status: 'pending',
            deliveryStatus: 'unknown',
            attemptCount: 0,
            providerMessageId: null,
            providerSentAt: null,
            lastErrorCode: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      });
    const service = new MailOpsService({ execute } as never);

    const result = await service.getStatus(2);
    expect(result.byStatus).toEqual({ pending: 2 });
    expect(result.byDeliveryStatus).toEqual({ unknown: 2 });
    expect(result.byKind).toEqual({ turn_reminder: 2 });
    expect(result.byChannel).toEqual({ turn_reminder: 2 });
    expect(result.recent[0]).toMatchObject({
      recipientHint: 'al***@example.com',
      status: 'pending',
    });
    expect(result.recent[0]).not.toHaveProperty('templateVariables');
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('lists suppression metadata with a redacted recipient', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          recipient: 'alice@example.com',
          category: 'all',
          reason: 'complaint',
          source: 'tencent-ses',
          expiresAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });
    const service = new MailOpsService({ execute } as never);

    await expect(service.listSuppressions(1)).resolves.toEqual([
      expect.objectContaining({
        recipientHint: 'al***@example.com',
        category: 'all',
        reason: 'complaint',
      }),
    ]);
  });
});
