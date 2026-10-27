import { describe, expect, it, vi } from 'vitest';
import { MailOutboxRepository } from '@/mail/mail-outbox.repository.js';
import { MailPayloadCipher } from '@/mail/mail-payload-crypto.js';

function flattenQuery(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenQuery).join('');
  if (typeof value !== 'object' || value === null) return '';
  const record = value as {
    queryChunks?: unknown;
    value?: unknown;
  };
  if (record.queryChunks !== undefined) return flattenQuery(record.queryChunks);
  if (record.value !== undefined) return flattenQuery(record.value);
  return '';
}

describe('MailOutboxRepository', () => {
  it('applies channel priority and retry ceilings by default', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 'job-1' }]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const repository = new MailOutboxRepository({ insert } as never);

    await repository.enqueue({
      dedupeKey: 'auth-challenge:job-1',
      recipient: 'player@example.com',
      kind: 'password_recovery',
      templateKey: 'reset_password',
      templateVariables: {},
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 300, maxAttempts: 5 }),
    );

    values.mockClear();
    await repository.enqueue({
      dedupeKey: 'turn:job-1',
      recipient: 'player@example.com',
      kind: 'turn_reminder',
      templateKey: 'turn_reminder',
      templateVariables: {},
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 100, maxAttempts: 2 }),
    );
  });

  it('fences a stale processing lease as unknown before considering new work', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(repository.claimNext(30)).resolves.toBeNull();

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain("SET status = 'unknown'");
    expect(query).toContain("last_error_code = 'lease_expired'");
    expect(query).toContain("status IN ('pending', 'retry_wait')");
    expect(query).not.toContain("status IN ('processing'");
  });

  it('does not accept a provider result after the lease token has changed', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(
      repository.markAccepted(
        '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
        'provider-message',
        'provider-request',
      ),
    ).resolves.toBe(false);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain('lease_token =');
    expect(query).toContain("status = 'processing'");
  });

  it('does not cancel an expired row while its processing lease is active', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(repository.cancelExpired()).resolves.toBe(0);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain("status IN ('pending', 'retry_wait')");
    expect(query).toContain("status = 'processing'");
    expect(query).toContain('lease_until <= clock_timestamp()');
  });

  it('rejects sensitive values copied into plaintext template variables', async () => {
    const insert = vi.fn();
    const repository = new MailOutboxRepository(
      { insert } as never,
      new MailPayloadCipher(Buffer.alloc(32, 7)),
    );

    await expect(
      repository.enqueue({
        dedupeKey: 'auth-challenge:7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        recipient: 'player@example.com',
        kind: 'email_change_verification',
        templateKey: 'email_change_verify',
        templateVariables: { code: '123456' },
        sensitivePayload: { code: '123456' },
      }),
    ).rejects.toThrow('must not be copied into plaintext');
    expect(insert).not.toHaveBeenCalled();
  });

  it('lists due same-account reminders without returning sensitive payloads', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
          dedupeKey: 'turn_email:other:user:2',
          userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
          emailVersion: 1,
          gameId: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
          attentionEpoch: 2,
          recipient: 'player@example.com',
          kind: 'turn_reminder',
          templateKey: 'turn_reminder',
          templateVariables: { gameName: 'Other game' },
          status: 'pending',
          deliveryStatus: 'unknown',
          priority: 10,
          attemptCount: 0,
          maxAttempts: 5,
          notBefore: null,
          expiresAt: null,
          nextAttemptAt: new Date(),
          sensitivePayloadCiphertext: 'must-not-be-selected',
        },
      ],
    });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(
      repository.listCoalescibleTurnReminders({
        id: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
        userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        emailVersion: 1,
        recipient: 'player@example.com',
        gameId: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        gameId: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
        templateVariables: { gameName: 'Other game' },
      }),
    ]);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain("status IN ('pending', 'retry_wait')");
    expect(query).toContain('email_version IS NOT DISTINCT FROM');
    expect(query).toContain(
      "created_at >= clock_timestamp() - interval '5 minutes'",
    );
    expect(query).not.toContain('sensitive_payload_ciphertext');
  });

  it('cancels only pending or retrying jobs folded into a summary', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: 'one' }] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(
      repository.cancelByIds(
        [
          '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
          'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
        ],
        'coalesced_into:primary',
      ),
    ).resolves.toBe(1);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain("status IN ('pending', 'retry_wait')");
    expect(query).toContain('cancelled_reason = coalesced_into:primary');
    expect(query).toContain('sensitive_payload_ciphertext = NULL');
  });

  it('atomically fences a candidate before the primary provider call', async () => {
    const candidate = {
      id: '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
      dedupeKey: 'turn_email:other:user:2',
      userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
      emailVersion: 1,
      gameId: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      attentionEpoch: 2,
      recipient: 'player@example.com',
      kind: 'turn_reminder',
      templateKey: 'turn_reminder',
      templateVariables: { gameName: 'Other game' },
      status: 'processing',
      deliveryStatus: 'unknown',
      priority: 10,
      attemptCount: 1,
      maxAttempts: 5,
      notBefore: null,
      expiresAt: null,
      nextAttemptAt: new Date(),
    };
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new MailOutboxRepository({ execute } as never);
    const primary = {
      id: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
      emailVersion: 1,
      recipient: 'player@example.com',
      gameId: '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
      leaseToken: 'f5e0a9b8-8cd0-4e87-8dd6-e3bd3ec0f9d0',
    };
    const ids = ['3c0df260-a493-4bb1-9b9d-ea30a82cd076'];

    await expect(
      repository.reserveCoalescibleTurnReminders(primary, ids),
    ).resolves.toEqual([expect.objectContaining({ id: ids[0] })]);
    await expect(
      repository.reserveCoalescibleTurnReminders(primary, ids),
    ).resolves.toEqual([]);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain("SET status = 'processing'");
    expect(query).toContain('lease_token =');
    expect(query).toContain("status IN ('pending', 'retry_wait')");
    expect(query).toContain('next_attempt_at <= clock_timestamp()');
  });

  it('settles reserved children only when the primary lease still matches', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: 'one' }] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(
      repository.settleCoalescedTurnReminders(
        ['3c0df260-a493-4bb1-9b9d-ea30a82cd076'],
        'f5e0a9b8-8cd0-4e87-8dd6-e3bd3ec0f9d0',
        'accepted',
        'coalesced_into:primary',
      ),
    ).resolves.toBe(1);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain('status = cancelled');
    expect(query).toContain("status = 'processing'");
    expect(query).toContain('lease_token =');
    expect(query).toContain('sensitive_payload_ciphertext = CASE WHEN');
  });

  it('releases reserved children for a retry without dropping their payload', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: 'one' }] });
    const repository = new MailOutboxRepository({ execute } as never);

    await expect(
      repository.settleCoalescedTurnReminders(
        ['3c0df260-a493-4bb1-9b9d-ea30a82cd076'],
        'f5e0a9b8-8cd0-4e87-8dd6-e3bd3ec0f9d0',
        'retry_wait',
        'provider_throttled',
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(1);

    const query = flattenQuery(execute.mock.calls[0]?.[0]);
    expect(query).toContain('status = retry_wait');
    expect(query).toContain('next_attempt_at =');
    expect(query).toContain(
      'sensitive_payload_ciphertext = CASE WHEN  THEN NULL ELSE sensitive_payload_ciphertext END',
    );
  });
});
