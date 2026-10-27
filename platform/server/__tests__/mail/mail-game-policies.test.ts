import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { MailGamePolicyRegistry } from '@/mail/mail-game-policies.js';
import type { IClaimedMailJob } from '@/mail/mail-outbox.repository.js';

const database = {} as NodePgDatabase;
const job = { sessionId: 'beta-session' } as IClaimedMailJob;

describe('installed game mail policies', () => {
  it('does not authorize legacy mail without its installed owner', async () => {
    const policies = new MailGamePolicyRegistry();
    await expect(
      policies.legacyReminder(database, 'game', 'user'),
    ).resolves.toBeNull();
    await expect(policies.legacyAction(database, job)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      policies.migrationChallenge(database, job, 'challenge'),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('resolves native sessions through the installed game adapters', async () => {
    const policies = new MailGamePolicyRegistry();
    const alpha = vi.fn(async () => null);
    const snapshot = {
      target: { runtimeOwner: 'platform' as const, sessionId: 'beta-session' },
      route: {
        gameId: 'beta',
        modeId: 'solo',
        releaseId: 'beta-v1',
        sessionId: 'beta-session',
        backendBindingId: 'embedded',
        storageBindingId: 'test',
        ownershipEpoch: '1',
      },
      status: 'active' as const,
      participants: [{ principalId: 'player' }],
      actionablePrincipalIds: ['player'],
    };
    policies.register('alpha', { nativeTarget: alpha });
    policies.register('beta', { nativeTarget: async () => snapshot });
    await expect(policies.nativeTarget(job)).resolves.toBe(snapshot);
    expect(alpha).toHaveBeenCalledWith(job);
  });

  it('rejects duplicate registrations and ambiguous legacy ownership', () => {
    const policies = new MailGamePolicyRegistry();
    policies.register('alpha', {
      legacyAction: async () => ({ allowed: true, reason: 'ok' }),
    });
    expect(() => policies.register('alpha', {})).toThrow('already registered');
    expect(() =>
      policies.register('beta', {
        legacyAction: async () => ({ allowed: true, reason: 'ok' }),
      }),
    ).toThrow('Legacy mail ownership');
  });
});
