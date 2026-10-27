import { describe, expect, it } from 'vitest';
import {
  AccountRuleError,
  normalizeAccountName,
  normalizeEmailAddress,
  validatePassword,
  validatePasswordConfirmation,
} from '../../src/auth/accountRules.js';

describe('platform account rules', () => {
  it('applies NFKC, trimming, and ASCII case folding to usernames', () => {
    expect(normalizeAccountName(' Ａlice ')).toEqual({
      name: 'Alice',
      nameKey: 'alice',
    });
    expect(normalizeAccountName('星际探索者').nameKey).toBe('星际探索者');
  });

  it('rejects invisible and unsupported username characters', () => {
    expect(() => normalizeAccountName('a\u200Db')).toThrow(AccountRuleError);
    expect(() => normalizeAccountName('a b')).toThrow(AccountRuleError);
    expect(() => normalizeAccountName('admin')).toThrow(AccountRuleError);
  });

  it('lets an adapter add its own reserved account names', () => {
    const reserved = new Set(['game']);
    expect(() => normalizeAccountName('game', reserved)).toThrow(
      AccountRuleError,
    );
    expect(normalizeAccountName('game').nameKey).toBe('game');
  });

  it('keeps tags and dots while normalizing the email key', () => {
    expect(normalizeEmailAddress(' Alice+tag@Example.com ')).toEqual({
      email: 'Alice+tag@Example.com',
      emailKey: 'alice+tag@example.com',
    });
  });

  it('allows significant password spaces and normalizes only NFC', () => {
    const password = `  ${'安全'.repeat(8)}  `;
    expect(validatePassword(password)).toBe(password.normalize('NFC'));
    expect(validatePasswordConfirmation(password, password)).toBe(
      password.normalize('NFC'),
    );
    expect(() =>
      validatePasswordConfirmation(password, password.trim()),
    ).toThrow(AccountRuleError);
  });

  it('rejects passwords outside the account bounds', () => {
    expect(validatePassword('123456')).toBe('123456');
    expect(() => validatePassword('12345')).toThrow(AccountRuleError);
    expect(() => validatePassword('a'.repeat(129))).toThrow(AccountRuleError);
  });
});
