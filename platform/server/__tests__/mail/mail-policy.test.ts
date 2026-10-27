import { describe, expect, it } from 'vitest';
import {
  isEnabledMailKind,
  mailChannelForKind,
  mailFailureActionForChannel,
  mailPolicyForChannel,
  mailPolicyForKind,
} from '@/mail/mail-policy.js';

describe('mail channel policy', () => {
  it('only enables requested account mail and opted-in turn reminders', () => {
    expect(isEnabledMailKind('password_recovery')).toBe(true);
    expect(isEnabledMailKind('email_change_verification')).toBe(true);
    expect(isEnabledMailKind('turn_reminder')).toBe(true);
    expect(isEnabledMailKind('account_verification')).toBe(false);
    expect(isEnabledMailKind('security_notice')).toBe(false);
    expect(isEnabledMailKind('migration_completed')).toBe(false);
  });
  it('keeps account-critical, security, and turn work on separate lanes', () => {
    expect(mailChannelForKind('account_verification')).toBe('account_critical');
    expect(mailChannelForKind('password_recovery')).toBe('account_critical');
    expect(mailChannelForKind('email_change_verification')).toBe(
      'account_critical',
    );
    expect(mailChannelForKind('security_notice')).toBe('security');
    expect(mailChannelForKind('migration_completed')).toBe('security');
    expect(mailChannelForKind('turn_reminder')).toBe('turn_reminder');
  });

  it('prioritizes critical work and gives turn mail the smallest retry budget', () => {
    expect(mailPolicyForKind('account_verification')).toMatchObject({
      priority: 300,
      usesAccountReserve: true,
      failure: { maxAttempts: 5, unknown: 'unknown' },
    });
    expect(mailPolicyForKind('security_notice')).toMatchObject({
      priority: 200,
      usesAccountReserve: false,
      failure: { maxAttempts: 3, unknown: 'unknown' },
    });
    expect(mailPolicyForChannel('turn_reminder')).toMatchObject({
      priority: 100,
      usesAccountReserve: false,
      failure: { maxAttempts: 2, unknown: 'dead' },
    });
  });

  it('drops an uncertain turn reminder while preserving account uncertainty', () => {
    expect(mailFailureActionForChannel('turn_reminder', 'unknown')).toBe(
      'dead',
    );
    expect(mailFailureActionForChannel('account_critical', 'unknown')).toBe(
      'unknown',
    );
    expect(mailFailureActionForChannel('security', 'retryable')).toBe('retry');
  });
});
