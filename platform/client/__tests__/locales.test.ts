import { describe, expect, it } from 'vitest';
import en from '../src/locales/en/common.json';
import zhCN from '../src/locales/zh-CN/common.json';

describe('platform shell locale contract', () => {
  it.each([
    ['en', en],
    ['zh-CN', zhCN],
  ] as const)(
    '%s provides the shared rankings navigation label',
    (_language, messages) => {
      expect(messages.client.app_shell.rankings).toEqual(expect.any(String));
      expect(messages.client.app_shell.rankings.trim()).not.toHaveLength(0);
    },
  );
});
