import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MailBudgetService,
  protectedRecipientKey,
} from '@/mail/mail-budget.service.js';

const config = {
  globalDailyLimit: 100,
  globalAccountReserve: 20,
  accountCriticalDailyLimit: 2,
  securityDailyLimit: 3,
  turnReminderDailyLimit: 2,
};
const TEST_PAYLOAD_KEY = 'p'.repeat(64);

beforeEach(() => {
  vi.stubEnv('SETI_MAIL_BUDGET_HASH_SECRET', '');
  vi.stubEnv('SETI_MAIL_PAYLOAD_ENCRYPTION_KEY', TEST_PAYLOAD_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function flattenQuery(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenQuery).join('');
  if (typeof value !== 'object' || value === null) return '';
  const record = value as { queryChunks?: unknown; value?: unknown };
  if (record.queryChunks !== undefined) return flattenQuery(record.queryChunks);
  if (record.value !== undefined) return flattenQuery(record.value);
  return '';
}

describe('MailBudgetService anonymous reservations', () => {
  it('reserves both global and recipient account buckets', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ scope: 'global' }] })
      .mockResolvedValueOnce({ rows: [{ scope: 'global_account' }] })
      .mockResolvedValueOnce({ rows: [{ scope: 'recipient_account' }] });
    const transaction = vi.fn(async (callback) => callback({ execute }));
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserveAnonymous({
        recipient: 'User@Example.com',
        kind: 'account_verification',
      }),
    ).resolves.toEqual({ allowed: true, costUnits: 1 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('releases the global reservation when a recipient bucket is full', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ scope: 'global' }] })
      .mockResolvedValueOnce({ rows: [{ scope: 'global_account' }] })
      .mockResolvedValueOnce({ rows: [] });
    const transaction = vi.fn(async (callback) => callback({ execute }));
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserveAnonymous({
        recipient: 'user@example.com',
        kind: 'account_verification',
      }),
    ).resolves.toEqual({ allowed: false, costUnits: 1 });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('keeps turn reservations inside the non-account global budget', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ scope: 'global' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const transaction = vi.fn(async (callback) => callback({ execute }));
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserve({ userId: 'user-1', kind: 'turn_reminder' }),
    ).resolves.toEqual({ allowed: false, costUnits: 1 });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('uses independent per-channel account scopes and limits', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ scope: 'ok' }] });
    const transaction = vi.fn(async (callback) => callback({ execute }));
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserve({ userId: 'user-1', kind: 'account_verification' }),
    ).resolves.toEqual({ allowed: true, costUnits: 1 });
    await expect(
      service.reserve({ userId: 'user-1', kind: 'security_notice' }),
    ).resolves.toEqual({ allowed: true, costUnits: 1 });

    const accountScopeQuery = flattenQuery(execute.mock.calls[2]?.[0]);
    const securityScopeQuery = flattenQuery(execute.mock.calls[5]?.[0]);
    expect(accountScopeQuery).toContain('user_account_critical');
    expect(securityScopeQuery).toContain('user_security');
  });

  it('keeps account-critical capacity after the turn pool is exhausted', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ scope: 'global' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ scope: 'global' }] })
      .mockResolvedValueOnce({ rows: [{ scope: 'global_account' }] })
      .mockResolvedValueOnce({ rows: [{ scope: 'user_account_critical' }] });
    const transaction = vi.fn(async (callback) => callback({ execute }));
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserve({ userId: 'user-1', kind: 'turn_reminder' }),
    ).resolves.toEqual({ allowed: false, costUnits: 1 });
    await expect(
      service.reserve({ userId: 'user-1', kind: 'password_recovery' }),
    ).resolves.toEqual({ allowed: true, costUnits: 1 });
  });

  it('loads explicit channel limits and ignores the removed account alias', async () => {
    const { loadMailBudgetConfig } = await import(
      '@/mail/mail-budget.service.js'
    );
    expect(
      loadMailBudgetConfig({
        SETI_MAIL_GLOBAL_DAILY_LIMIT: '100',
        SETI_MAIL_GLOBAL_ACCOUNT_RESERVE: '20',
        SETI_MAIL_ACCOUNT_CRITICAL_DAILY_LIMIT: '4',
        SETI_MAIL_SECURITY_DAILY_LIMIT: '5',
        SETI_MAIL_TURN_DAILY_LIMIT: '6',
      }),
    ).toMatchObject({
      accountCriticalDailyLimit: 4,
      securityDailyLimit: 5,
      turnReminderDailyLimit: 5,
    });
    expect(loadMailBudgetConfig({}).turnReminderDailyLimit).toBe(5);
    expect(
      loadMailBudgetConfig({ SETI_MAIL_ACCOUNT_DAILY_LIMIT: '7' })
        .accountCriticalDailyLimit,
    ).toBe(20);
  });

  it('uses a protected recipient key for anonymous buckets', () => {
    const key = protectedRecipientKey('User@Example.com', 'test-secret');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('User@Example.com');
  });

  it('prefers a non-empty dedicated hash secret over the payload key', () => {
    const dedicated = `  ${'d'.repeat(64)}  `;
    vi.stubEnv('SETI_MAIL_BUDGET_HASH_SECRET', dedicated);

    expect(protectedRecipientKey('User@Example.com')).toBe(
      protectedRecipientKey('User@Example.com', dedicated),
    );
    expect(protectedRecipientKey('User@Example.com')).not.toBe(
      protectedRecipientKey('User@Example.com', TEST_PAYLOAD_KEY),
    );
  });

  it('treats an empty or whitespace PM2-injected dedicated secret as missing', () => {
    vi.stubEnv('SETI_MAIL_BUDGET_HASH_SECRET', '   ');

    expect(protectedRecipientKey('User@Example.com')).toBe(
      protectedRecipientKey('User@Example.com', TEST_PAYLOAD_KEY),
    );
  });

  it('rejects anonymous reservations when no hash secret is configured', async () => {
    vi.stubEnv('SETI_MAIL_BUDGET_HASH_SECRET', '');
    vi.stubEnv('SETI_MAIL_PAYLOAD_ENCRYPTION_KEY', '');
    const transaction = vi.fn();
    const service = new MailBudgetService({ transaction } as never, config);

    await expect(
      service.reserveAnonymous({
        recipient: 'user@example.com',
        kind: 'account_verification',
      }),
    ).rejects.toThrow(
      'SETI_MAIL_BUDGET_HASH_SECRET or SETI_MAIL_PAYLOAD_ENCRYPTION_KEY is required for anonymous mail budgets',
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
