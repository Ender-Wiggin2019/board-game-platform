import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MAIL_OUTBOX_SERVICE = Symbol('MAIL_OUTBOX_SERVICE');
export const EMAIL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_MAX_ATTEMPTS = 5;

export interface IAccountMailOutbox {
  enqueueTemplate(
    tx: unknown,
    input: {
      recipient: string;
      templateKey:
        | 'verify_email'
        | 'reset_password'
        | 'email_change_verify'
        | 'security_notice';
      variables: Readonly<Record<string, string>>;
      kind:
        | 'account_verification'
        | 'password_recovery'
        | 'email_change_verification'
        | 'security_notice';
      userId?: string;
      emailVersion?: number;
      challengeId?: string;
      dedupeKey?: string;
      priority?: number;
      notBefore?: Date;
      expiresAt?: Date;
      sensitivePayload?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
  cancelByDedupeKey?(
    tx: unknown,
    dedupeKey: string,
    reason: string,
  ): Promise<unknown>;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function codeHmac(
  challengeId: string,
  purpose: string,
  emailKey: string,
  code: string,
): string {
  return createHmac('sha256', challengeSecret())
    .update(`${challengeId}|${purpose}|${emailKey}|${code}`, 'utf8')
    .digest('hex');
}

/** Validate the independent challenge HMAC key at the application boundary. */
export function validateChallengeSecretConfiguration(): void {
  challengeSecret();
}

function challengeSecret(): string {
  const configured = process.env.AUTH_CHALLENGE_HMAC_SECRET?.trim();
  const jwtSecret = process.env.JWT_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error(
        'AUTH_CHALLENGE_HMAC_SECRET must be at least 32 characters',
      );
    }
    if (
      process.env.NODE_ENV?.trim().toLowerCase() === 'production' &&
      configured === jwtSecret
    ) {
      throw new Error(
        'AUTH_CHALLENGE_HMAC_SECRET must be independent from JWT_SECRET',
      );
    }
    return configured;
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new Error('AUTH_CHALLENGE_HMAC_SECRET is required in production');
  }
  if (jwtSecret) return jwtSecret;
  // Local tests and development can exercise the state machine without a
  // production secret. Production config validation must supply the value.
  return 'platform-development-auth-challenge-secret';
}

export function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
