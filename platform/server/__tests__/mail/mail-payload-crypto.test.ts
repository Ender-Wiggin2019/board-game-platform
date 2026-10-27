import { describe, expect, it } from 'vitest';
import { MailPayloadCipher } from '@/mail/mail-payload-crypto.js';

describe('MailPayloadCipher', () => {
  it('round trips short-lived payloads without storing plaintext', () => {
    const cipher = new MailPayloadCipher(Buffer.alloc(32, 7));
    const encrypted = cipher.encrypt({
      code: '123456',
      link: 'https://seti.test/v',
    });

    expect(encrypted.ciphertext).not.toContain('123456');
    expect(cipher.decrypt(encrypted)).toEqual({
      code: '123456',
      link: 'https://seti.test/v',
    });
  });

  it('rejects tampered ciphertext and key versions', () => {
    const cipher = new MailPayloadCipher(Buffer.alloc(32, 1));
    const encrypted = cipher.encrypt({ code: '123456' });

    expect(() =>
      cipher.decrypt({ ...encrypted, ciphertext: `${encrypted.ciphertext}x` }),
    ).toThrow();
    expect(() =>
      cipher.decrypt({ ...encrypted, keyVersion: encrypted.keyVersion + 1 }),
    ).toThrow('key version');
  });

  it('accepts exactly 32-byte hex and base64 environment keys', () => {
    const hex = 'ab'.repeat(32);
    const base64 = Buffer.alloc(32, 9).toString('base64');

    expect(
      MailPayloadCipher.fromEnvironment({
        SETI_MAIL_PAYLOAD_ENCRYPTION_KEY: hex,
      }),
    ).toBeInstanceOf(MailPayloadCipher);
    expect(
      MailPayloadCipher.fromEnvironment({
        SETI_MAIL_PAYLOAD_ENCRYPTION_KEY: base64,
      }),
    ).toBeInstanceOf(MailPayloadCipher);
    expect(() =>
      MailPayloadCipher.fromEnvironment({
        SETI_MAIL_PAYLOAD_ENCRYPTION_KEY: 'short',
      }),
    ).toThrow();
  });
});
