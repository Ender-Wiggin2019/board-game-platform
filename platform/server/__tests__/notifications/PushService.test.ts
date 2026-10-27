import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

/**
 * Delivery is best-effort: it runs on gameplay paths, so a push service outage
 * must never surface as a failed turn. The subtle half is lifecycle — iOS
 * invalidates subscriptions readily, and an endpoint the service reports as
 * gone will never work again, so it has to be deleted rather than retried
 * forever.
 */

const SUBSCRIPTION = {
  endpoint: 'https://web.push.apple.com/abc',
  p256dh: 'key-1',
  auth: 'auth-1',
};

interface IStoredRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function createDbStub(
  rows: IStoredRow[],
  pushNotificationsEnabled = true,
  language?: 'zh-CN' | 'en',
) {
  const deleted: string[][] = [];
  const notified: string[][] = [];

  // The service builds a PushSubscriptionRepository over this; only the calls
  // sendToUser makes are modelled.
  const db = {
    select: (selection?: unknown) => ({
      from: () => ({
        where: () =>
          selection
            ? {
                limit: () =>
                  Promise.resolve([
                    {
                      preferences: { pushNotificationsEnabled, language },
                    },
                  ]),
              }
            : Promise.resolve(rows),
      }),
    }),
    delete: () => ({
      where: (clause: { __endpoints?: string[] }) => {
        deleted.push(clause?.__endpoints ?? ['<unknown>']);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: () => ({
        where: (clause: { __endpoints?: string[] }) => {
          notified.push(clause?.__endpoints ?? ['<unknown>']);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db, deleted, notified };
}

// `inArray` builds the clause the stub above inspects, so the endpoints the
// service targets are observable without a real database.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    and: (...clauses: Array<{ __endpoints?: string[] }>) => ({
      __endpoints: clauses.flatMap((clause) => clause.__endpoints ?? []),
    }),
    eq: () => ({}),
    inArray: (_column: unknown, values: string[]) => ({
      __endpoints: values,
    }),
  };
});

async function loadService(db: unknown) {
  const { PushService } = await import('@/notifications/push.service.js');
  return new PushService(db as never);
}

beforeEach(() => {
  sendNotification.mockReset();
  setVapidDetails.mockReset();
  process.env.SETI_VAPID_PUBLIC_KEY = 'public-key';
  process.env.SETI_VAPID_PRIVATE_KEY = 'private-key';
  process.env.SETI_VAPID_SUBJECT = 'mailto:test@example.com';
});

afterEach(() => {
  delete process.env.SETI_VAPID_PUBLIC_KEY;
  delete process.env.SETI_VAPID_PRIVATE_KEY;
  delete process.env.SETI_VAPID_SUBJECT;
  vi.resetModules();
});

describe('PushService', () => {
  it('is unconfigured without VAPID keys, and sending is a no-op', async () => {
    delete process.env.SETI_VAPID_PUBLIC_KEY;
    delete process.env.SETI_VAPID_PRIVATE_KEY;
    delete process.env.SETI_VAPID_SUBJECT;
    const { db } = createDbStub([SUBSCRIPTION]);
    const service = await loadService(db);

    expect(service.isConfigured()).toBe(false);
    expect(service.getPublicKey()).toBeNull();
    // Crucially it must not throw — a deployment without keys still plays games.
    await expect(
      service.sendToUser('user-1', { title: 't', body: 'b' }),
    ).resolves.toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of transferring another account endpoint', async () => {
    const db = {
      transaction: (run: (tx: unknown) => Promise<string>) =>
        run({
          execute: vi.fn().mockResolvedValue({ rows: [] }),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve([{ userId: 'other-user' }]),
              }),
            }),
          }),
        }),
    };
    const service = await loadService(db);

    await expect(
      service.saveSubscription(
        'current-user',
        {
          endpoint: SUBSCRIPTION.endpoint,
          p256dh: SUBSCRIPTION.p256dh,
          auth: SUBSCRIPTION.auth,
        },
        'enable',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('delivers to every registered device', async () => {
    const rows = [
      SUBSCRIPTION,
      { endpoint: 'https://fcm.googleapis.com/xyz', p256dh: 'k2', auth: 'a2' },
    ];
    const { db, notified } = createDbStub(rows);
    const service = await loadService(db);
    expect(service.getPublicKey()).toBe('public-key');
    expect(setVapidDetails).toHaveBeenCalledWith(
      'mailto:test@example.com',
      'public-key',
      'private-key',
    );
    sendNotification.mockResolvedValue({ statusCode: 201 });

    const delivered = await service.sendToUser('user-1', {
      title: 'SETI',
      body: 'Your turn',
      tag: 'turn:game-1',
    });

    expect(delivered).toBe(2);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    // The payload the service worker will read must carry the tag through.
    const [, payload] = sendNotification.mock.calls[0];
    expect(JSON.parse(payload as string)).toMatchObject({
      title: 'SETI',
      body: 'Your turn',
      tag: 'turn:game-1',
    });
    expect(notified.flat()).toEqual(
      expect.arrayContaining([rows[0].endpoint, rows[1].endpoint]),
    );
  });

  it('delivers through one online tab without touching Web Push', async () => {
    const { db } = createDbStub([]);
    const service = await loadService(db);
    const onlineDelivery = vi.fn().mockResolvedValue(true);
    service.setOnlineDelivery(onlineDelivery);

    await expect(
      service.sendToUser('user-1', { title: 'SETI', body: 'Your turn' }),
    ).resolves.toBe(1);

    expect(onlineDelivery).toHaveBeenCalledWith('user-1', {
      title: 'SETI',
      body: 'Your turn',
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('falls back to Web Push when the online tab cannot display', async () => {
    const { db } = createDbStub([SUBSCRIPTION]);
    const service = await loadService(db);
    service.setOnlineDelivery(vi.fn().mockResolvedValue(false));
    sendNotification.mockResolvedValue({ statusCode: 201 });

    await expect(
      service.sendToUser('user-1', { title: 'SETI', body: 'Your turn' }),
    ).resolves.toBe(1);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('delivers online when VAPID is unavailable', async () => {
    delete process.env.SETI_VAPID_PUBLIC_KEY;
    delete process.env.SETI_VAPID_PRIVATE_KEY;
    delete process.env.SETI_VAPID_SUBJECT;
    const { db } = createDbStub([]);
    const service = await loadService(db);
    service.setOnlineDelivery(vi.fn().mockResolvedValue(true));

    await expect(
      service.sendToUser('user-1', { title: 'SETI', body: 'Your turn' }),
    ).resolves.toBe(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('builds a recipient-specific payload from account preferences', async () => {
    const { db } = createDbStub([SUBSCRIPTION], true, 'en');
    const service = await loadService(db);
    sendNotification.mockResolvedValue({ statusCode: 201 });

    await service.sendToUser('user-1', (preferences) => ({
      title: 'Your turn',
      body: `language:${preferences.language}`,
    }));

    const [, payload] = sendNotification.mock.calls[0];
    expect(JSON.parse(payload as string)).toMatchObject({
      title: 'Your turn',
      body: 'language:en',
    });
  });

  it('does not deliver when the account preference is off', async () => {
    const { db } = createDbStub([SUBSCRIPTION], false);
    const service = await loadService(db);
    const buildPayload = vi.fn(() => ({ title: 't', body: 'b' }));
    const onlineDelivery = vi.fn().mockResolvedValue(true);
    service.setOnlineDelivery(onlineDelivery);

    await expect(service.sendToUser('user-1', buildPayload)).resolves.toBe(0);
    expect(buildPayload).not.toHaveBeenCalled();
    expect(onlineDelivery).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('prunes unsupported historical endpoints without requesting them', async () => {
    const unsafe = {
      ...SUBSCRIPTION,
      endpoint: 'https://127.0.0.1/internal',
    };
    const { db, deleted } = createDbStub([unsafe]);
    const service = await loadService(db);

    await expect(
      service.sendToUser('user-1', { title: 't', body: 'b' }),
    ).resolves.toBe(0);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(deleted.flat()).toEqual([unsafe.endpoint]);
  });

  it('deletes subscriptions the push service reports as gone', async () => {
    const rows = [
      SUBSCRIPTION,
      { endpoint: 'https://web.push.apple.com/dead', p256dh: 'k2', auth: 'a2' },
    ];
    const { db, deleted } = createDbStub(rows);
    const service = await loadService(db);
    sendNotification.mockImplementation((sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/dead')) {
        return Promise.reject(
          Object.assign(new Error('Gone'), { statusCode: 410 }),
        );
      }
      return Promise.resolve({ statusCode: 201 });
    });

    const delivered = await service.sendToUser('user-1', {
      title: 't',
      body: 'b',
    });

    expect(delivered).toBe(1);
    // 410 means permanently gone: retrying it forever is the failure mode this
    // guards against.
    expect(deleted.flat()).toEqual(['https://web.push.apple.com/dead']);
  });

  it('keeps subscriptions when the failure is transient', async () => {
    const { db, deleted } = createDbStub([SUBSCRIPTION]);
    const service = await loadService(db);
    sendNotification.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), { statusCode: 503 }),
    );

    const delivered = await service.sendToUser('user-1', {
      title: 't',
      body: 'b',
    });

    expect(delivered).toBe(0);
    // A push service having a bad afternoon must not unsubscribe the player.
    expect(deleted).toEqual([]);
  });

  it('sends turn alerts with high urgency so Doze cannot sit on them', async () => {
    const { db } = createDbStub([SUBSCRIPTION]);
    const service = await loadService(db);
    sendNotification.mockResolvedValue({ statusCode: 201 });

    await service.sendToUser('user-1', { title: 't', body: 'b' });

    const [, , options] = sendNotification.mock.calls[0];
    expect(options).toMatchObject({ urgency: 'high', timeout: 10_000 });
  });
});
