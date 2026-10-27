import { describe, expect, it, vi } from 'vitest';
import {
  attachAuditRequestId,
  currentAuditRequestId,
} from '@/auth/account-audit-request.js';

describe('account audit request correlation', () => {
  it('keeps a safe incoming request ID through asynchronous work', async () => {
    const setHeader = vi.fn();
    await new Promise<void>((resolve) => {
      attachAuditRequestId(
        { headers: { 'x-request-id': 'account-request-42' } },
        { setHeader },
        () => {
          void Promise.resolve().then(() => {
            expect(currentAuditRequestId()).toBe('account-request-42');
            resolve();
          });
        },
      );
    });
    expect(setHeader).toHaveBeenCalledWith(
      'x-request-id',
      'account-request-42',
    );
    expect(currentAuditRequestId()).toBeNull();
  });

  it('replaces untrusted header text with an opaque ID', () => {
    const setHeader = vi.fn();
    attachAuditRequestId(
      { headers: { 'x-request-id': 'secret\r\nInjected: value' } },
      { setHeader },
      () => expect(currentAuditRequestId()).toMatch(/^[0-9a-f-]{36}$/u),
    );
    expect(setHeader.mock.calls[0]?.[1]).not.toContain('secret');
  });
});
