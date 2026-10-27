import { describe, expect, it } from 'vitest';
import {
  assertNotificationTarget,
  legacyNotificationTarget,
  notificationTargetKey,
  platformNotificationTarget,
} from '@/notifications/notification-target.js';

describe('notification targets', () => {
  it('keeps native session targets separate from legacy UUID game targets', () => {
    const legacy = legacyNotificationTarget(
      '3c0df260-a493-4a09-8647-0d0bf2a1cc24',
    );
    const native = platformNotificationTarget('session-123');

    expect(notificationTargetKey(legacy)).toBe(
      'game:3c0df260-a493-4a09-8647-0d0bf2a1cc24',
    );
    expect(notificationTargetKey(native)).toBe('session:session-123');
  });

  it('rejects mixed or browser-shaped targets before they reach SQL', () => {
    expect(() =>
      assertNotificationTarget({
        runtimeOwner: 'platform',
        sessionId: 'session-123',
        legacyGameId: '3c0df260-a493-4a09-8647-0d0bf2a1cc24',
      }),
    ).toThrow('NOTIFICATION_PLATFORM_TARGET_INVALID');
    expect(() =>
      assertNotificationTarget({
        runtimeOwner: 'legacy',
        legacyGameId: 'not-a-uuid',
      }),
    ).toThrow('NOTIFICATION_LEGACY_TARGET_INVALID');
    expect(() => platformNotificationTarget('')).toThrow(
      'NOTIFICATION_PLATFORM_TARGET_INVALID',
    );
  });
});
