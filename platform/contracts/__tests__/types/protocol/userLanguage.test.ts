import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_LANGUAGE,
  normalizeUserLanguage,
  SUPPORTED_USER_LANGUAGES,
} from '../../../src/types/protocol/userLanguage.js';

describe('platform user language', () => {
  it('keeps the account language selector bounded', () => {
    expect(SUPPORTED_USER_LANGUAGES).toEqual(['zh-CN', 'en']);
    expect(DEFAULT_USER_LANGUAGE).toBe('zh-CN');
  });

  it('normalizes supported language families to the account vocabulary', () => {
    expect(normalizeUserLanguage(undefined)).toBe('zh-CN');
    expect(normalizeUserLanguage('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeUserLanguage('en-US')).toBe('en');
    expect(normalizeUserLanguage('pt-BR')).toBe('zh-CN');
    expect(normalizeUserLanguage('english')).toBe('zh-CN');
  });
});
