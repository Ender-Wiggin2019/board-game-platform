import { describe, expect, it, vi } from 'vitest';
import { MailUnsubscribeController } from '@/mail/mail-unsubscribe.controller.js';

const claims = {
  v: 1 as const,
  userId: '7c303e2b-590a-4a09-8647-0d0bf2a1cc24',
  gameId: '3c0df260-a493-4bb1-9b9d-ea30a82cd076',
  exp: Date.now() + 60_000,
  scope: 'game' as const,
};

describe('MailUnsubscribeController', () => {
  it('keeps GET preview read-only and mutates only on POST', async () => {
    const tokens = {
      verifyTurnToken: vi.fn().mockReturnValue(claims),
    };
    const suppression = { muteGame: vi.fn().mockResolvedValue(undefined) };
    const controller = new MailUnsubscribeController(
      tokens as never,
      suppression as never,
    );

    expect(controller.preview('token')).toEqual({
      ok: true,
      kind: 'turn_reminder',
      scope: 'game',
    });
    expect(suppression.muteGame).not.toHaveBeenCalled();

    await expect(controller.unsubscribe({ token: 'token' })).resolves.toEqual({
      ok: true,
      kind: 'turn_reminder',
      scope: 'game',
    });
    expect(suppression.muteGame).toHaveBeenCalledWith(
      claims.userId,
      claims.gameId,
    );
  });

  it('uses an all-scope token to disable the global turn preference', async () => {
    const tokens = {
      verifyTurnToken: vi.fn().mockReturnValue({ ...claims, scope: 'all' }),
    };
    const suppression = {
      disableTurnReminders: vi.fn().mockResolvedValue(undefined),
      muteGame: vi.fn(),
    };
    const controller = new MailUnsubscribeController(
      tokens as never,
      suppression as never,
    );

    await expect(controller.unsubscribe({ token: 'token' })).resolves.toEqual({
      ok: true,
      kind: 'turn_reminder',
      scope: 'all',
    });
    expect(suppression.disableTurnReminders).toHaveBeenCalledWith(
      claims.userId,
    );
    expect(suppression.muteGame).not.toHaveBeenCalled();
  });

  it('routes native session capabilities to the target mute store', async () => {
    const nativeClaims = {
      v: 2 as const,
      userId: claims.userId,
      sessionId: 'native-session-1',
      exp: Date.now() + 60_000,
      scope: 'session' as const,
    };
    const tokens = {
      verifyTurnToken: vi.fn().mockReturnValue(nativeClaims),
    };
    const suppression = { muteTarget: vi.fn().mockResolvedValue(undefined) };
    const controller = new MailUnsubscribeController(
      tokens as never,
      suppression as never,
    );

    await expect(controller.unsubscribe({ token: 'token' })).resolves.toEqual({
      ok: true,
      kind: 'turn_reminder',
      scope: 'session',
    });
    await expect(controller.mute({ token: 'token' })).resolves.toEqual({
      ok: true,
      kind: 'turn_reminder',
      scope: 'session',
    });
    expect(suppression.muteTarget).toHaveBeenCalledTimes(2);
    expect(suppression.muteTarget).toHaveBeenCalledWith(claims.userId, {
      runtimeOwner: 'platform',
      sessionId: nativeClaims.sessionId,
    });
  });
});
