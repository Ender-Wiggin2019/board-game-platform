import { describe, expect, it, vi } from 'vitest';
import { MailStatusReconciler } from '@/mail/mail-status-reconciler.js';

describe('MailStatusReconciler process ownership', () => {
  it('does not query provider status from the HTTP process in standalone mode', async () => {
    vi.stubEnv('SETI_MAIL_PROCESS_MODE', 'standalone');
    vi.stubEnv('SETI_MAIL_PROCESS_ROLE', 'http');
    const provider = {
      isConfigured: vi.fn().mockReturnValue(true),
      getSendEmailStatus: vi.fn(),
    };
    const db = { execute: vi.fn() };
    const reconciler = new MailStatusReconciler(db as never, provider as never);

    try {
      await expect(reconciler.reconcileOnce()).resolves.toBe(0);
      expect(provider.getSendEmailStatus).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    } finally {
      reconciler.onModuleDestroy();
      vi.unstubAllEnvs();
    }
  });
});
