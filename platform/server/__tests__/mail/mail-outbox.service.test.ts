import { ERole } from '@board-platform/contracts/auth/roles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailGamePolicyRegistry } from '@/mail/mail-game-policies.js';
import { MailOutboxRepository } from '@/mail/mail-outbox.repository.js';
import { MailOutboxService } from '@/mail/mail-outbox.service.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';

function createService(role: string, optedIn = true, verified = true) {
  let reads = 0;
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () =>
      ++reads === 1
        ? [
            {
              role,
              email: 'player@example.com',
              emailVersion: 1,
              emailVerifiedAt: verified ? new Date() : null,
              accountStatus: 'active',
            },
          ]
        : [{ name: 'Game', status: 'playing', options: {} }],
    ),
  };
  const db = { select: vi.fn(() => query) };
  vi.spyOn(AccountPreferencesRepository.prototype, 'get').mockResolvedValue({
    emailTurnRemindersEnabled: optedIn,
  });
  const enqueue = vi
    .spyOn(MailOutboxRepository.prototype, 'enqueue')
    .mockResolvedValue({ jobId: 'mail-job', status: 'pending' });
  const policies = new MailGamePolicyRegistry();
  policies.register('example-game', {
    legacyReminder: async () => ({ name: 'Game', eligible: true }),
  });
  const service = new MailOutboxService(
    db as never,
    { createTurnToken: () => null } as never,
    policies,
  );
  return { service, enqueue };
}

const input = { gameId: 'game-id', userId: 'user-id', attentionEpoch: 3 };

describe('turn reminder enqueue eligibility', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([ERole.GUEST, ERole.PLAYER, 'unknown-role'])(
    'does not enqueue for opted-in %s accounts',
    async (role) => {
      const { service, enqueue } = createService(role);
      await expect(service.enqueueTurnReminder(input)).resolves.toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([ERole.NAVIGATOR, ERole.TESTER, ERole.ADMIN, ERole.SUPERADMIN])(
    'enqueues for opted-in %s accounts',
    async (role) => {
      const { service, enqueue } = createService(role);
      await expect(service.enqueueTurnReminder(input)).resolves.toEqual({
        jobId: 'mail-job',
        status: 'pending',
      });
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'turn_reminder', attentionEpoch: 3 }),
        expect.anything(),
      );
    },
  );

  it('does not enqueue for a Navigator who has not opted in', async () => {
    const { service, enqueue } = createService(ERole.NAVIGATOR, false);
    await expect(service.enqueueTurnReminder(input)).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues for an opted-in Navigator without verified email', async () => {
    const { service, enqueue } = createService(ERole.NAVIGATOR, true, false);
    await expect(service.enqueueTurnReminder(input)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

describe('mail enqueue policy', () => {
  it('rejects retired automatic mail kinds before inserting an outbox row', async () => {
    const insert = vi.fn();
    const service = new MailOutboxService({ insert } as never);
    await expect(
      service.enqueueTemplate({
        recipient: 'player@example.com',
        templateKey: 'reset_password',
        variables: {},
        kind: 'migration_completed',
        dedupeKey: 'migration_completed:old',
      }),
    ).rejects.toThrow('Mail kind is disabled: migration_completed');
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('native session turn reminder enqueue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores versioned unsubscribe and session-mute links in the encrypted payload', async () => {
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([
        {
          email: 'native@example.com',
          emailVersion: 4,
          accountStatus: 'active',
          role: ERole.NAVIGATOR,
        },
      ]),
    };
    const db = { select: vi.fn(() => query) };
    vi.spyOn(AccountPreferencesRepository.prototype, 'get').mockResolvedValue({
      emailTurnRemindersEnabled: true,
    });
    vi.spyOn(MailOutboxRepository.prototype, 'enqueue').mockResolvedValue({
      jobId: 'native-mail-job',
      status: 'pending',
    });
    const unsubscribeTokens = {
      createSessionTurnToken: vi.fn(
        (
          _userId: string,
          _sessionId: string,
          _expiresAt: Date | undefined,
          scope: 'all' | 'session',
        ) => (scope === 'all' ? 'global-native-token' : 'session-native-token'),
      ),
    };
    const service = new MailOutboxService(
      db as never,
      unsubscribeTokens as never,
    );

    await expect(
      service.enqueueSessionTurnReminder({
        target: { runtimeOwner: 'platform', sessionId: 'native-session-1' },
        userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
        attentionEpoch: 7,
      }),
    ).resolves.toEqual({ jobId: 'native-mail-job', status: 'pending' });
    expect(MailOutboxRepository.prototype.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOwner: 'platform',
        sessionId: 'native-session-1',
        sensitivePayload: {
          unsubscribeUrl: expect.stringContaining('global-native-token'),
          muteUrl: expect.stringContaining('session-native-token'),
        },
      }),
      db,
    );
  });
});
