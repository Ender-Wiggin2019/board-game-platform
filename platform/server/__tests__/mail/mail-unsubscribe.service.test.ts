import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailUnsubscribeTokenService } from '@/mail/mail-unsubscribe.service.js';

const USER_ID = '7c303e2b-590a-4a09-8647-0d0bf2a1cc24';
const GAME_ID = '3c0df260-a493-4bb1-9b9d-ea30a82cd076';
const SESSION_ID = 'session-native-123';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MailUnsubscribeTokenService', () => {
  it('round-trips a scoped turn reminder capability', () => {
    const service = new MailUnsubscribeTokenService(
      Buffer.from('test-unsubscribe-secret-32-bytes-long'),
    );
    const token = service.createTurnToken(
      USER_ID,
      GAME_ID,
      new Date(Date.now() + 60_000),
    );

    expect(token).toBeDefined();
    expect(service.verifyTurnToken(token)).toMatchObject({
      v: 1,
      userId: USER_ID,
      gameId: GAME_ID,
    });
  });

  it('rejects tampering and expired capabilities', () => {
    const service = new MailUnsubscribeTokenService(
      Buffer.from('test-unsubscribe-secret-32-bytes-long'),
    );
    const token = service.createTurnToken(
      USER_ID,
      GAME_ID,
      new Date(Date.now() - 1),
    );
    expect(service.verifyTurnToken(token)).toBeUndefined();

    const validToken = service.createTurnToken(
      USER_ID,
      GAME_ID,
      new Date(Date.now() + 60_000),
    );
    const [payload, signature] = validToken?.split('.') ?? [];
    const tamperedSignature = signature?.startsWith('a')
      ? `b${signature.slice(1)}`
      : `a${signature?.slice(1)}`;
    expect(
      service.verifyTurnToken(`${payload}.${tamperedSignature}`),
    ).toBeUndefined();
  });

  it('round-trips a versioned native-session capability', () => {
    const service = new MailUnsubscribeTokenService(
      Buffer.from('test-unsubscribe-secret-32-bytes-long'),
    );
    const token = service.createSessionTurnToken(
      USER_ID,
      SESSION_ID,
      new Date(Date.now() + 60_000),
      'session',
    );

    expect(service.verifyTurnToken(token)).toEqual({
      v: 2,
      userId: USER_ID,
      sessionId: SESSION_ID,
      exp: expect.any(Number),
      scope: 'session',
    });
    expect(() =>
      service.createSessionTurnToken(USER_ID, `${SESSION_ID}\n`),
    ).toThrow('Native mail unsubscribe subjects are invalid');
  });

  it('prefers a non-empty dedicated secret over the payload key', () => {
    const payloadKey = 'p'.repeat(64);
    const dedicated = `  ${'d'.repeat(64)}  `;
    const expiresAt = new Date('2045-09-24T00:00:00.000Z');
    vi.stubEnv('SETI_MAIL_UNSUBSCRIBE_SECRET', dedicated);
    vi.stubEnv('SETI_MAIL_PAYLOAD_ENCRYPTION_KEY', payloadKey);

    const configured = new MailUnsubscribeTokenService();
    expect(configured.createTurnToken(USER_ID, GAME_ID, expiresAt)).toBe(
      new MailUnsubscribeTokenService(Buffer.from(dedicated)).createTurnToken(
        USER_ID,
        GAME_ID,
        expiresAt,
      ),
    );
    expect(configured.createTurnToken(USER_ID, GAME_ID, expiresAt)).not.toBe(
      new MailUnsubscribeTokenService(Buffer.from(payloadKey)).createTurnToken(
        USER_ID,
        GAME_ID,
        expiresAt,
      ),
    );
  });

  it('uses the payload key when PM2 injects an empty or whitespace dedicated secret', () => {
    const payloadKey = 'p'.repeat(64);
    const expiresAt = new Date('2045-09-24T00:00:00.000Z');
    vi.stubEnv('SETI_MAIL_UNSUBSCRIBE_SECRET', '   ');
    vi.stubEnv('SETI_MAIL_PAYLOAD_ENCRYPTION_KEY', payloadKey);

    expect(
      new MailUnsubscribeTokenService().createTurnToken(
        USER_ID,
        GAME_ID,
        expiresAt,
      ),
    ).toBe(
      new MailUnsubscribeTokenService(Buffer.from(payloadKey)).createTurnToken(
        USER_ID,
        GAME_ID,
        expiresAt,
      ),
    );
  });
});
