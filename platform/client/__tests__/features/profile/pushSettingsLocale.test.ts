import { describe, expect, it } from 'vitest';
import enCommon from '@/locales/en/common.json';
import zhCommon from '@/locales/zh-CN/common.json';

/**
 * The push settings strings were originally written as inline `defaultValue`s
 * only, so a Chinese-locale admin saw English. Pin that both locales carry every
 * key the component asks for, and that the Chinese entries are actually
 * translated rather than copied English.
 */

/** Every key `PushNotificationSettings` looks up, minus the namespace prefix. */
const REQUIRED_KEYS = [
  'label',
  'loading',
  'config_failed',
  'retry',
  'needs_install',
  'insecure_context',
  'service_worker_unavailable',
  'push_api_unavailable',
  'notifications_api_unavailable',
  'denied',
  'server_unconfigured',
  'test',
  'test_none',
  'test_failed',
  'diagnostic_code',
  'permission_dismissed',
  'permission_request_failed',
  'service_worker_not_ready',
  'subscription_not_allowed',
  'subscription_service_unavailable',
  'subscription_failed',
  'invalid_push_endpoint',
  'server_registration_rejected',
  'server_registration_unavailable',
  'server_enable_rejected',
  'server_enable_unavailable',
  'session_changed',
  'server_config_invalid',
  'online_only',
  'unexpected_enable_error',
] as const;

type TPushStrings = Record<string, string>;

function pushStrings(bundle: unknown): TPushStrings {
  const client = (bundle as { client?: { profile?: { push?: TPushStrings } } })
    .client;
  const push = client?.profile?.push;
  if (!push) throw new Error('client.profile.push is missing');
  return push;
}

describe('push settings localization', () => {
  it('defines every key the settings row renders, in both locales', () => {
    const en = pushStrings(enCommon);
    const zh = pushStrings(zhCommon);

    for (const key of REQUIRED_KEYS) {
      expect(en[key], `en is missing ${key}`).toBeTruthy();
      expect(zh[key], `zh-CN is missing ${key}`).toBeTruthy();
    }
  });

  it('translates the Chinese strings instead of echoing English', () => {
    const en = pushStrings(enCommon);
    const zh = pushStrings(zhCommon);

    for (const key of REQUIRED_KEYS) {
      expect(zh[key], `zh-CN ${key} still reads as English`).not.toBe(en[key]);
      // Any Han character is enough to show it was actually translated.
      expect(zh[key]).toMatch(/[一-鿿]/);
    }
  });

  it('uses the plural forms each language needs for the device count', () => {
    const en = pushStrings(enCommon);
    const zh = pushStrings(zhCommon);

    // i18next resolves `count` through suffixed keys; English needs both forms
    // or it falls back to the inline default.
    expect(en.test_sent_one).toContain('{{count}}');
    expect(en.test_sent_other).toContain('{{count}}');
    // Chinese has a single plural category, so `_other` alone is correct.
    expect(zh.test_sent_other).toContain('{{count}}');
    expect(zh.test_sent_one).toBeUndefined();
  });
});
