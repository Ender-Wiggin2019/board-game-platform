import { ECapability } from '@board-platform/contracts/auth/permissions';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CAPABILITIES_KEY } from '@/auth/capabilities.decorator.js';
import { ROLES_KEY } from '@/auth/roles.decorator.js';
import { PushController } from '@/notifications/push.controller.js';

const THROTTLER_LIMIT_METADATA = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_METADATA = 'THROTTLER:TTLdefault';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/subscription',
  keys: {
    p256dh: 'p'.repeat(87),
    auth: 'a'.repeat(22),
  },
  mode: 'enable' as const,
};

function createController() {
  const push = {
    isConfigured: vi.fn(() => true),
    getPublicKey: vi.fn(() => 'public-key'),
    countForUser: vi.fn(async () => 0),
    saveSubscription: vi.fn(async () => undefined),
    enableForUser: vi.fn(async () => undefined),
    removeSubscription: vi.fn(async () => undefined),
    removeAllForUser: vi.fn(async () => undefined),
    sendToUser: vi.fn(async () => 1),
  };
  return { controller: new PushController(push as never), push };
}

describe('PushController', () => {
  it('authorizes every PLAYER+ role through the shared game-play capability', () => {
    expect(Reflect.getMetadata(CAPABILITIES_KEY, PushController)).toEqual([
      ECapability.GAME_PLAY,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, PushController)).toBeUndefined();
  });

  it('applies stricter per-route throttles to subscription writes and tests', () => {
    const subscribe = PushController.prototype.subscribe;
    const enable = PushController.prototype.enable;
    const unsubscribe = PushController.prototype.unsubscribe;
    const test = PushController.prototype.test;

    expect(Reflect.getMetadata(THROTTLER_LIMIT_METADATA, subscribe)).toBe(10);
    expect(Reflect.getMetadata(THROTTLER_TTL_METADATA, subscribe)).toBe(60_000);
    expect(Reflect.getMetadata(THROTTLER_LIMIT_METADATA, enable)).toBe(10);
    expect(Reflect.getMetadata(THROTTLER_TTL_METADATA, enable)).toBe(60_000);
    expect(Reflect.getMetadata(THROTTLER_LIMIT_METADATA, unsubscribe)).toBe(10);
    expect(Reflect.getMetadata(THROTTLER_TTL_METADATA, unsubscribe)).toBe(
      60_000,
    );
    expect(Reflect.getMetadata(THROTTLER_LIMIT_METADATA, test)).toBe(3);
    expect(Reflect.getMetadata(THROTTLER_TTL_METADATA, test)).toBe(60_000);
  });

  it('accepts boundary-sized subscription fields and bounds the user agent', async () => {
    const { controller, push } = createController();
    const endpointPrefix = 'https://fcm.googleapis.com/';
    const endpoint = `${endpointPrefix}${'e'.repeat(2_048 - endpointPrefix.length)}`;
    const p256dh = 'p'.repeat(87);
    const auth = 'a'.repeat(22);

    await controller.subscribe(
      {
        user: { sub: USER_ID } as never,
        headers: { 'user-agent': 'u'.repeat(600) },
      },
      { endpoint, keys: { p256dh, auth }, mode: 'enable' },
    );

    expect(push.saveSubscription).toHaveBeenCalledWith(
      USER_ID,
      {
        endpoint,
        p256dh,
        auth,
        userAgent: 'u'.repeat(512),
      },
      'enable',
    );
  });

  it('enables push for the authenticated account without requiring a subscription', async () => {
    const { controller, push } = createController();

    await expect(
      controller.enable({ user: { sub: USER_ID } as never }),
    ).resolves.toEqual({ ok: true });

    expect(push.enableForUser).toHaveBeenCalledWith(USER_ID);
  });

  it.each([
    'https://127.0.0.1/internal',
    'https://push.example/subscription',
    'http://fcm.googleapis.com/subscription',
    'https://fcm.googleapis.com:8443/subscription',
    'https://fcm.googleapis.com.evil.test/subscription',
    ' https://fcm.googleapis.com/subscription',
    'https://FCM.GOOGLEAPIS.COM/subscription',
    'https://fcm.googleapis.com:443/subscription',
    'https://push.apple.com.evil.test/subscription',
  ])('rejects an unsupported push endpoint: %s', async (endpoint) => {
    const { controller, push } = createController();

    await expect(
      controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        { ...VALID_SUBSCRIPTION, endpoint },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it.each([
    'https://fcm.googleapis.com/subscription',
    'https://android.googleapis.com/gcm/send/subscription',
    'https://updates.push.services.mozilla.com/wpush/v2/subscription',
    'https://web.push.apple.com/subscription',
    'https://regional.push.apple.com/subscription',
    'https://cloud.notify.windows.com/subscription',
  ])(
    'accepts a canonical endpoint from a supported push service: %s',
    async (endpoint) => {
      const { controller, push } = createController();

      await controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        { ...VALID_SUBSCRIPTION, endpoint },
      );

      expect(push.saveSubscription).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ endpoint }),
        'enable',
      );
    },
  );

  it.each([
    ['p256dh', { p256dh: 'not_base64!', auth: 'a'.repeat(22) }],
    ['p256dh', { p256dh: 'p'.repeat(86), auth: 'a'.repeat(22) }],
    ['auth', { p256dh: 'p'.repeat(87), auth: 'a'.repeat(21) }],
  ])('rejects a malformed %s subscription key', async (_field, keys) => {
    const { controller, push } = createController();

    await expect(
      controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        { ...VALID_SUBSCRIPTION, keys },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['endpoint', { ...VALID_SUBSCRIPTION, endpoint: 'e'.repeat(2_049) }],
    [
      'p256dh',
      {
        ...VALID_SUBSCRIPTION,
        keys: { ...VALID_SUBSCRIPTION.keys, p256dh: 'p'.repeat(257) },
      },
    ],
    [
      'auth',
      {
        ...VALID_SUBSCRIPTION,
        keys: { ...VALID_SUBSCRIPTION.keys, auth: 'a'.repeat(129) },
      },
    ],
  ])('rejects an oversized %s before persistence', async (_field, body) => {
    const { controller, push } = createController();

    await expect(
      controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        body,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects blank subscription fields before persistence', async () => {
    const { controller, push } = createController();

    await expect(
      controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        {
          endpoint: '   ',
          keys: { p256dh: '\t', auth: '\n' },
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it('rejects a subscription without an explicit mode', async () => {
    const { controller, push } = createController();
    const { mode: _, ...legacySubscription } = VALID_SUBSCRIPTION;

    await expect(
      controller.subscribe(
        { user: { sub: USER_ID } as never, headers: {} },
        legacySubscription,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.saveSubscription).not.toHaveBeenCalled();
  });

  it.each([true, 'background', 'legacy'])(
    'rejects an invalid subscription mode: %s',
    async (mode) => {
      const { controller, push } = createController();

      await expect(
        controller.subscribe(
          { user: { sub: USER_ID } as never, headers: {} },
          { ...VALID_SUBSCRIPTION, mode },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(push.saveSubscription).not.toHaveBeenCalled();
    },
  );

  it('rejects an oversized unsubscribe endpoint before persistence', async () => {
    const { controller, push } = createController();

    await expect(
      controller.unsubscribe(
        { user: { sub: USER_ID } as never },
        { endpoint: 'e'.repeat(2_049) },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.removeSubscription).not.toHaveBeenCalled();
    expect(push.removeAllForUser).not.toHaveBeenCalled();
  });

  it('scopes a single-device unsubscribe to the authenticated user', async () => {
    const { controller, push } = createController();

    await controller.unsubscribe(
      { user: { sub: USER_ID } as never },
      { endpoint: VALID_SUBSCRIPTION.endpoint },
    );

    expect(push.removeSubscription).toHaveBeenCalledWith(
      USER_ID,
      VALID_SUBSCRIPTION.endpoint,
    );
  });

  it('removes all subscriptions only when the endpoint is omitted', async () => {
    const { controller, push } = createController();

    await controller.unsubscribe(
      { user: { sub: USER_ID } as never },
      undefined,
    );

    expect(push.removeAllForUser).toHaveBeenCalledWith(USER_ID);
    expect(push.removeSubscription).not.toHaveBeenCalled();

    await expect(
      controller.unsubscribe(
        { user: { sub: USER_ID } as never },
        { endpoint: '   ' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(push.removeAllForUser).toHaveBeenCalledTimes(1);
  });
});
