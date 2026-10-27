import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const ASSOCIATED_DATA = 'seti-mail-payload:v1';

export interface IEncryptedMailPayload {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
}

/**
 * Encrypts challenge codes and other short-lived mail values before they
 * enter PostgreSQL. The key is process configuration, never a row value.
 */
export class MailPayloadCipher {
  public constructor(
    private readonly key: Buffer,
    private readonly keyVersion = 1,
  ) {
    if (key.length !== KEY_BYTES) {
      throw new Error('SETI_MAIL_PAYLOAD_ENCRYPTION_KEY must be 32 bytes');
    }
  }

  public encrypt(
    payload: Readonly<Record<string, string>>,
  ): IEncryptedMailPayload {
    const plaintext = JSON.stringify(payload);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    cipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64url'),
      nonce: nonce.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      keyVersion: this.keyVersion,
    };
  }

  public decrypt(encrypted: IEncryptedMailPayload): Record<string, string> {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error('Mail payload key version is not supported');
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(encrypted.nonce, 'base64url'),
    );
    decipher.setAAD(Buffer.from(ASSOCIATED_DATA, 'utf8'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!isStringRecord(parsed)) {
      throw new Error('Mail payload plaintext is invalid');
    }
    return parsed;
  }

  public static fromEnvironment(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): MailPayloadCipher | undefined {
    const raw = env.SETI_MAIL_PAYLOAD_ENCRYPTION_KEY?.trim();
    if (!raw) return undefined;
    const key = decodeKey(raw);
    return new MailPayloadCipher(key);
  }
}

function decodeKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }
  const base64 = Buffer.from(value, 'base64');
  if (base64.length === KEY_BYTES && base64.toString('base64') === value) {
    return base64;
  }
  throw new Error(
    'SETI_MAIL_PAYLOAD_ENCRYPTION_KEY must be a 64-character hex or 44-character base64 key',
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}
