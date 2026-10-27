import { ERole } from '@board-platform/contracts/auth/roles';
import { describe, expect, it, vi } from 'vitest';
import {
  MailGamePolicyRegistry,
  type MailPolicyDecision,
} from '@/mail/mail-game-policies.js';
import type {
  IClaimedMailJob,
  ICoalescibleTurnReminder,
} from '@/mail/mail-outbox.repository.js';
import { MailProviderError } from '@/mail/mail-provider.js';
import {
  getMailProcessMode,
  getMailProcessRole,
  isDedicatedMailWorkerProcess,
  isMailConsumerProcess,
  isRecipientAllowedForEnvironment,
  MailWorkerService,
} from '@/mail/mail-worker.service.js';

const USER_ID = '7c303e2b-590a-4a09-8647-0d0bf2a1cc24';
const GAME_ID = '3c0df260-a493-4bb1-9b9d-ea30a82cd076';

function createJob(attentionEpoch: number | null): IClaimedMailJob {
  return {
    id: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
    dedupeKey: 'turn-email',
    userId: USER_ID,
    emailVersion: 1,
    challengeId: null,
    gameId: GAME_ID,
    attentionEpoch,
    recipient: 'player@example.com',
    kind: 'turn_reminder',
    templateKey: 'turn_reminder',
    templateVariables: {},
    sensitivePayloadCiphertext: null,
    sensitivePayloadNonce: null,
    sensitivePayloadTag: null,
    sensitivePayloadKeyVersion: null,
    status: 'processing',
    deliveryStatus: 'unknown',
    priority: 10,
    attemptCount: 1,
    maxAttempts: 5,
    notBefore: null,
    expiresAt: null,
    nextAttemptAt: new Date(),
    leaseToken: 'f5e0a9b8-8cd0-4e87-8dd6-e3bd3ec0f9d0',
    providerMessageId: null,
    providerRequestId: null,
  };
}

function createWorker(
  gameDecision: MailPolicyDecision,
  role: string = ERole.NAVIGATOR,
  verified = true,
) {
  let selectCall = 0;
  const select = vi.fn(() => {
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    query.from = vi.fn(() => query);
    query.innerJoin = vi.fn(() => query);
    query.where = vi.fn(() => query);
    query.limit = vi.fn(async () => {
      selectCall += 1;
      return selectCall === 1
        ? [
            {
              email: 'player@example.com',
              emailVersion: 1,
              emailVerifiedAt: verified ? new Date() : null,
              accountStatus: 'active',
              role,
            },
          ]
        : [{ status: 'playing', requiresAction: true }];
    });
    return query;
  });
  const db = {
    select,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
  const policies = new MailGamePolicyRegistry();
  policies.register('example-game', { legacyAction: async () => gameDecision });
  const worker = new MailWorkerService(
    db as never,
    { isConfigured: () => true } as never,
    undefined,
    undefined,
    policies,
  );
  const internals = worker as unknown as {
    checkPolicy: (job: IClaimedMailJob) => Promise<{
      allowed: boolean;
      reason: string;
      retryAt?: Date;
    }>;
    preferences: { get: ReturnType<typeof vi.fn> };
    onlinePresence: { isOnline: ReturnType<typeof vi.fn> };
    setForegroundResolver: (resolver: () => boolean) => void;
    suppression: {
      isSuppressed: ReturnType<typeof vi.fn>;
      isGameMuted: ReturnType<typeof vi.fn>;
    };
  };
  internals.preferences.get = vi.fn().mockResolvedValue({
    emailTurnRemindersEnabled: true,
  });
  internals.onlinePresence.isOnline = vi.fn().mockResolvedValue(false);
  internals.suppression.isSuppressed = vi.fn().mockResolvedValue(false);
  internals.suppression.isGameMuted = vi.fn().mockResolvedValue(false);
  return { worker: internals, db, select };
}

describe('MailWorkerService attention epochs', () => {
  it('cancels queued mail from retired automatic scenarios without contacting the provider', async () => {
    const sendTemplate = vi.fn();
    const worker = new MailWorkerService(
      {} as never,
      {
        isConfigured: () => true,
        sendTemplate,
      } as never,
    ) as unknown as {
      processClaimedJob: (job: IClaimedMailJob) => Promise<void>;
      outbox: { markCancelled: ReturnType<typeof vi.fn> };
    };
    worker.outbox.markCancelled = vi.fn().mockResolvedValue(undefined);
    const job = {
      ...createJob(null),
      kind: 'migration_completed' as const,
      templateKey: 'reset_password' as const,
    };

    await worker.processClaimedJob(job);

    expect(worker.outbox.markCancelled).toHaveBeenCalledWith(
      job.id,
      'mail_kind_disabled',
      job.leaseToken,
    );
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('defers while the user is connected elsewhere in the site', async () => {
    const { worker } = createWorker({ allowed: true, reason: 'ok' });
    worker.setForegroundResolver(() => false);
    worker.onlinePresence.isOnline.mockResolvedValue(true);
    await expect(worker.checkPolicy(createJob(3))).resolves.toMatchObject({
      allowed: false,
      reason: 'user_online',
      retryAt: expect.any(Date),
    });
    expect(worker.onlinePresence.isOnline).toHaveBeenCalledWith(USER_ID);
  });

  it('defers when online status cannot be read', async () => {
    const { worker } = createWorker({ allowed: true, reason: 'ok' });
    worker.onlinePresence.isOnline.mockRejectedValue(
      new Error('database unavailable'),
    );
    await expect(worker.checkPolicy(createJob(3))).resolves.toMatchObject({
      allowed: false,
      reason: 'online_presence_unavailable',
      retryAt: expect.any(Date),
    });
  });

  it('cancels a queued reminder when the user turns the preference off', async () => {
    const { worker } = createWorker({ allowed: true, reason: 'ok' });
    worker.preferences.get.mockResolvedValue({
      emailTurnRemindersEnabled: false,
    });
    await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
      allowed: false,
      reason: 'turn_reminder_disabled',
    });
  });

  it.each([ERole.GUEST, ERole.PLAYER, 'unknown-role'])(
    'cancels an opted-in queued reminder after the account has role %s',
    async (role) => {
      const { worker, db } = createWorker(
        { allowed: true, reason: 'ok' },
        role,
      );
      worker.setForegroundResolver(() => false);
      await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
        allowed: false,
        reason: 'turn_reminder_not_entitled',
      });
      expect(db.execute).not.toHaveBeenCalled();
    },
  );

  it.each([ERole.NAVIGATOR, ERole.TESTER, ERole.ADMIN, ERole.SUPERADMIN])(
    'allows an opted-in actionable reminder for role %s',
    async (role) => {
      const { worker } = createWorker({ allowed: true, reason: 'ok' }, role);
      worker.setForegroundResolver(() => false);
      await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
        allowed: true,
        reason: 'ok',
      });
    },
  );

  it('allows an opted-in reminder without verified email', async () => {
    const { worker } = createWorker(
      { allowed: true, reason: 'ok' },
      ERole.NAVIGATOR,
      false,
    );
    worker.setForegroundResolver(() => false);
    await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
      allowed: true,
      reason: 'ok',
    });
  });

  it('preserves a stale-epoch rejection returned by the installed game', async () => {
    const { worker, db, select } = createWorker({
      allowed: false,
      reason: 'stale_attention_epoch',
    });

    await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
      allowed: false,
      reason: 'stale_attention_epoch',
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('preserves a non-actionable rejection returned by the installed game', async () => {
    const { worker, db, select } = createWorker({
      allowed: false,
      reason: 'stale_attention_epoch',
    });

    await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
      allowed: false,
      reason: 'stale_attention_epoch',
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('defers a second reminder for the same user and game within thirty minutes', async () => {
    const { worker, db } = createWorker({ allowed: true, reason: 'ok' });
    db.execute.mockResolvedValueOnce({
      rows: [{ providerSentAt: new Date(Date.now() - 60_000) }],
    });

    const policy = await worker.checkPolicy(createJob(3));
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toBe('turn_rate_limited');
    expect(policy.retryAt?.getTime()).toBeGreaterThan(Date.now() + 28 * 60_000);
  });

  it('cancels a reminder muted for this game', async () => {
    const { worker } = createWorker({ allowed: true, reason: 'ok' });
    worker.suppression.isGameMuted.mockResolvedValue(true);

    await expect(worker.checkPolicy(createJob(3))).resolves.toEqual({
      allowed: false,
      reason: 'game_muted',
    });
  });

  it('defers a reminder until quiet hours end in the account time zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T14:00:00.000Z'));
    try {
      const { worker } = createWorker({ allowed: true, reason: 'ok' });
      worker.setForegroundResolver(() => false);
      worker.preferences.get.mockResolvedValue({
        emailTurnRemindersEnabled: true,
        emailQuietHours: {
          start: '22:00',
          end: '08:00',
          timezone: 'Asia/Shanghai',
        },
      });

      const policy = await worker.checkPolicy(createJob(3));
      expect(policy.allowed).toBe(false);
      expect(policy.reason).toBe('quiet_hours');
      expect(policy.retryAt?.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MailWorkerService environment guard', () => {
  it('allows production recipients without a test allowlist', () => {
    expect(
      isRecipientAllowedForEnvironment('player@example.com', {
        NODE_ENV: 'production',
      }),
    ).toBe(true);
  });

  it('requires an exact non-production recipient allowlist entry', () => {
    expect(
      isRecipientAllowedForEnvironment('Player@Example.com', {
        NODE_ENV: 'staging',
        SETI_MAIL_ALLOWED_RECIPIENTS: 'qa@example.com,player@example.com',
      }),
    ).toBe(true);
    expect(
      isRecipientAllowedForEnvironment('other@example.com', {
        NODE_ENV: 'staging',
        SETI_MAIL_ALLOWED_RECIPIENTS: 'qa@example.com,player@example.com',
      }),
    ).toBe(false);
    expect(
      isRecipientAllowedForEnvironment('player@example.com', {
        NODE_ENV: 'staging',
      }),
    ).toBe(false);
  });
});

describe('MailWorkerService process ownership', () => {
  it('keeps the HTTP process from claiming rows in standalone mode', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_PROCESS_MODE', 'standalone');
    vi.stubEnv('SETI_MAIL_PROCESS_ROLE', 'http');
    vi.stubEnv('SETI_MAIL_ALLOWED_RECIPIENTS', 'player@example.com');
    const execute = vi.fn();
    const worker = new MailWorkerService(
      { execute } as never,
      { isConfigured: () => true } as never,
    );

    try {
      expect(worker.getReadiness()).toMatchObject({
        processMode: 'standalone',
        processRole: 'http',
        consumerProcess: false,
        ready: false,
      });
      worker.onModuleInit();
      await expect(worker.processOnce()).resolves.toBe(false);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      worker.onModuleDestroy();
      vi.unstubAllEnvs();
    }
  });

  it('requires the dedicated worker role for standalone consumption', () => {
    expect(
      isMailConsumerProcess({ SETI_MAIL_PROCESS_MODE: 'standalone' }),
    ).toBe(false);
    expect(
      isMailConsumerProcess({
        SETI_MAIL_PROCESS_MODE: 'standalone',
        SETI_MAIL_PROCESS_ROLE: 'worker',
      }),
    ).toBe(true);
    expect(
      isDedicatedMailWorkerProcess({
        SETI_MAIL_PROCESS_MODE: 'standalone',
        SETI_MAIL_PROCESS_ROLE: 'worker',
      }),
    ).toBe(true);
    expect(getMailProcessMode({ SETI_MAIL_PROCESS_MODE: 'invalid' })).toBe(
      null,
    );
    expect(getMailProcessMode({})).toBe('same-process');
    expect(getMailProcessRole({ SETI_MAIL_PROCESS_ROLE: 'invalid' })).toBe(
      'http',
    );
  });
});

describe('MailWorkerService shared foreground presence', () => {
  it('defers a reminder while the dedicated worker sees a live TTL row', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_PROCESS_MODE', 'standalone');
    vi.stubEnv('SETI_MAIL_PROCESS_ROLE', 'worker');
    const { worker, db } = createWorker({ allowed: true, reason: 'ok' });
    db.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ active: 1 }] });

    try {
      await expect(worker.checkPolicy(createJob(3))).resolves.toMatchObject({
        allowed: false,
        reason: 'foreground_active',
      });
      const queries = db.execute.mock.calls.map((call) => call[0]);
      expect(queries).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defers rather than sends when the shared presence table is unavailable', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_PROCESS_MODE', 'standalone');
    vi.stubEnv('SETI_MAIL_PROCESS_ROLE', 'worker');
    const { worker, db } = createWorker({ allowed: true, reason: 'ok' });
    db.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('relation does not exist'));

    try {
      await expect(worker.checkPolicy(createJob(3))).resolves.toMatchObject({
        allowed: false,
        reason: 'foreground_presence_unavailable',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('MailWorkerService turn reminder coalescing', () => {
  it('passes the current account language to the Resend renderer', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_ALLOWED_RECIPIENTS', 'player@example.com');
    const provider = {
      provider: 'resend' as const,
      isConfigured: () => true,
      sendTemplate: vi.fn().mockResolvedValue({
        messageId: 'provider-message',
        requestId: 'provider-request',
      }),
    };
    const worker = new MailWorkerService({} as never, provider as never);
    const internals = worker as unknown as {
      preferences: { get: ReturnType<typeof vi.fn> };
      outbox: {
        decryptSensitivePayload: ReturnType<typeof vi.fn>;
        markAccepted: ReturnType<typeof vi.fn>;
      };
      budget: { reserve: ReturnType<typeof vi.fn> };
      checkPolicy: ReturnType<typeof vi.fn>;
      processClaimedJob: (value: IClaimedMailJob) => Promise<void>;
    };
    internals.preferences.get = vi.fn().mockResolvedValue({ language: 'en' });
    internals.outbox.decryptSensitivePayload = vi.fn().mockReturnValue({
      token: 'challenge.secret',
    });
    internals.outbox.markAccepted = vi.fn().mockResolvedValue(true);
    internals.budget.reserve = vi.fn().mockResolvedValue({ allowed: true });
    internals.checkPolicy = vi.fn().mockResolvedValue({
      allowed: true,
      reason: 'ok',
    });

    try {
      await internals.processClaimedJob({
        ...createJob(1),
        kind: 'password_recovery',
        templateKey: 'reset_password',
        gameId: null,
      });

      expect(provider.sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'en' }),
      );
      expect(internals.preferences.get).toHaveBeenCalledWith(USER_ID);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retries when account language lookup fails after coalescing', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_ALLOWED_RECIPIENTS', 'player@example.com');
    const provider = {
      provider: 'resend' as const,
      isConfigured: () => true,
      sendTemplate: vi.fn(),
    };
    const worker = new MailWorkerService({} as never, provider as never);
    const candidate: ICoalescibleTurnReminder = {
      id: 'b3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      dedupeKey: 'turn_email:game-b:user:2',
      userId: USER_ID,
      emailVersion: 1,
      gameId: 'b3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      attentionEpoch: 2,
      recipient: 'player@example.com',
      kind: 'turn_reminder',
      templateKey: 'turn_reminder',
      templateVariables: {
        gameName: 'Beta',
        actionUrl: 'https://example.test/game/b',
      },
      status: 'pending',
      deliveryStatus: 'unknown',
      priority: 10,
      attemptCount: 0,
      maxAttempts: 5,
      notBefore: null,
      expiresAt: null,
      nextAttemptAt: new Date(),
    };
    const internals = worker as unknown as {
      preferences: { get: ReturnType<typeof vi.fn> };
      outbox: {
        listCoalescibleTurnReminders: ReturnType<typeof vi.fn>;
        reserveCoalescibleTurnReminders: ReturnType<typeof vi.fn>;
        decryptSensitivePayload: ReturnType<typeof vi.fn>;
        markRetry: ReturnType<typeof vi.fn>;
        settleCoalescedTurnReminders: ReturnType<typeof vi.fn>;
      };
      budget: { reserve: ReturnType<typeof vi.fn> };
      checkPolicy: ReturnType<typeof vi.fn>;
      processClaimedJob: (value: IClaimedMailJob) => Promise<void>;
    };
    internals.preferences.get = vi
      .fn()
      .mockRejectedValue(new Error('preferences unavailable'));
    internals.outbox.listCoalescibleTurnReminders = vi
      .fn()
      .mockResolvedValue([candidate]);
    internals.outbox.reserveCoalescibleTurnReminders = vi
      .fn()
      .mockResolvedValue([{ ...candidate, status: 'processing' }]);
    internals.outbox.decryptSensitivePayload = vi.fn().mockReturnValue({});
    internals.outbox.markRetry = vi.fn().mockResolvedValue(true);
    internals.outbox.settleCoalescedTurnReminders = vi
      .fn()
      .mockResolvedValue(1);
    internals.budget.reserve = vi.fn().mockResolvedValue({ allowed: true });
    internals.checkPolicy = vi.fn().mockResolvedValue({
      allowed: true,
      reason: 'ok',
    });

    try {
      const job = {
        ...createJob(1),
        templateVariables: {
          gameName: 'Alpha',
          actionUrl: 'https://example.test/game/a',
        },
      };
      await internals.processClaimedJob(job);

      expect(provider.sendTemplate).not.toHaveBeenCalled();
      expect(internals.outbox.markRetry).toHaveBeenCalledWith(
        job.id,
        job.leaseToken,
        expect.any(Date),
        'mail_language_unavailable',
        'Mail language preferences are unavailable',
      );
      expect(
        internals.outbox.settleCoalescedTurnReminders,
      ).toHaveBeenCalledWith(
        [candidate.id],
        job.leaseToken,
        'retry_wait',
        'Mail language preferences are unavailable',
        expect.any(Date),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends one bounded summary and cancels accepted child jobs', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_ALLOWED_RECIPIENTS', 'player@example.com');
    const provider = {
      isConfigured: () => true,
      sendTemplate: vi.fn().mockResolvedValue({
        messageId: 'provider-message',
        requestId: 'provider-request',
      }),
    };
    const worker = new MailWorkerService({} as never, provider as never);
    const candidate: ICoalescibleTurnReminder = {
      id: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      dedupeKey: 'turn_email:game-b:user:2',
      userId: USER_ID,
      emailVersion: 1,
      gameId: 'a3e0f93e-6674-44e9-9d99-b5c9d4108f8e',
      attentionEpoch: 2,
      recipient: 'player@example.com',
      kind: 'turn_reminder',
      templateKey: 'turn_reminder',
      templateVariables: {
        gameName: 'Beta',
        actionUrl: 'https://example.test/game/b',
      },
      status: 'pending',
      deliveryStatus: 'unknown',
      priority: 10,
      attemptCount: 0,
      maxAttempts: 5,
      notBefore: null,
      expiresAt: null,
      nextAttemptAt: new Date(),
    };
    const job = {
      ...createJob(1),
      templateVariables: {
        gameName: 'Alpha',
        actionUrl: 'https://example.test/game/a',
      },
      sensitivePayloadCiphertext: null,
      sensitivePayloadNonce: null,
      sensitivePayloadTag: null,
      sensitivePayloadKeyVersion: null,
    };
    const internals = worker as unknown as {
      outbox: {
        listCoalescibleTurnReminders: ReturnType<typeof vi.fn>;
        reserveCoalescibleTurnReminders: ReturnType<typeof vi.fn>;
        decryptSensitivePayload: ReturnType<typeof vi.fn>;
        markAccepted: ReturnType<typeof vi.fn>;
        cancelByIds: ReturnType<typeof vi.fn>;
        settleCoalescedTurnReminders: ReturnType<typeof vi.fn>;
      };
      budget: { reserve: ReturnType<typeof vi.fn> };
      checkPolicy: ReturnType<typeof vi.fn>;
      processClaimedJob: (value: IClaimedMailJob) => Promise<void>;
    };
    internals.outbox.listCoalescibleTurnReminders = vi
      .fn()
      .mockResolvedValue([candidate]);
    internals.outbox.reserveCoalescibleTurnReminders = vi
      .fn()
      .mockResolvedValue([{ ...candidate, status: 'processing' }]);
    internals.outbox.decryptSensitivePayload = vi.fn().mockReturnValue({
      unsubscribeUrl: 'https://example.test/unsubscribe',
      muteUrl: 'https://example.test/mute',
    });
    internals.outbox.markAccepted = vi.fn().mockResolvedValue(true);
    internals.outbox.cancelByIds = vi.fn().mockResolvedValue(1);
    internals.outbox.settleCoalescedTurnReminders = vi
      .fn()
      .mockResolvedValue(1);
    internals.budget.reserve = vi.fn().mockResolvedValue({ allowed: true });
    internals.checkPolicy = vi.fn().mockResolvedValue({
      allowed: true,
      reason: 'ok',
    });

    try {
      await internals.processClaimedJob(job);

      expect(provider.sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'turn_reminder',
          variables: {
            gameName: 'Alpha · Beta',
            gameSummary: '2 games',
            actionUrl: 'http://localhost:5173/my-games',
            unsubscribeUrl: 'https://example.test/unsubscribe',
            muteUrl: 'https://example.test/mute',
          },
        }),
      );
      expect(internals.outbox.markAccepted).toHaveBeenCalledOnce();
      expect(
        internals.outbox.settleCoalescedTurnReminders,
      ).toHaveBeenCalledWith(
        [candidate.id],
        job.leaseToken,
        'accepted',
        `coalesced_into:${job.id}`,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('drops an unknown turn-reminder provider outcome according to its channel policy', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SETI_MAIL_ALLOWED_RECIPIENTS', 'player@example.com');
    const provider = {
      isConfigured: () => true,
      sendTemplate: vi
        .fn()
        .mockRejectedValue(
          new MailProviderError(
            'provider_unknown',
            'provider outcome is unknown',
            'unknown',
          ),
        ),
    };
    const worker = new MailWorkerService({} as never, provider as never);
    const internals = worker as unknown as {
      outbox: {
        decryptSensitivePayload: ReturnType<typeof vi.fn>;
        markDead: ReturnType<typeof vi.fn>;
        markUnknown: ReturnType<typeof vi.fn>;
      };
      budget: { reserve: ReturnType<typeof vi.fn> };
      checkPolicy: ReturnType<typeof vi.fn>;
      processClaimedJob: (value: IClaimedMailJob) => Promise<void>;
    };
    internals.outbox.decryptSensitivePayload = vi.fn().mockReturnValue({});
    internals.outbox.markDead = vi.fn().mockResolvedValue(true);
    internals.outbox.markUnknown = vi.fn().mockResolvedValue(true);
    internals.budget.reserve = vi.fn().mockResolvedValue({ allowed: true });
    internals.checkPolicy = vi.fn().mockResolvedValue({
      allowed: true,
      reason: 'ok',
    });

    try {
      await internals.processClaimedJob(createJob(1));
      expect(internals.outbox.markDead).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'provider_unknown',
        'provider outcome is unknown',
      );
      expect(internals.outbox.markUnknown).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
