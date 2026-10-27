import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

const TOKEN_VERSION = 1;
const NATIVE_TOKEN_VERSION = 2;
const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAIL_UNSUBSCRIBE_SCOPES = ['all', 'game'] as const;
export type TMailUnsubscribeScope = (typeof MAIL_UNSUBSCRIBE_SCOPES)[number];
export const MAIL_NATIVE_UNSUBSCRIBE_SCOPES = ['all', 'session'] as const;
export type TMailNativeUnsubscribeScope =
  (typeof MAIL_NATIVE_UNSUBSCRIBE_SCOPES)[number];

export interface ILegacyMailTurnUnsubscribeClaims {
  v: typeof TOKEN_VERSION;
  userId: string;
  gameId: string;
  exp: number;
  scope: TMailUnsubscribeScope;
}

export interface INativeMailTurnUnsubscribeClaims {
  v: typeof NATIVE_TOKEN_VERSION;
  userId: string;
  sessionId: string;
  exp: number;
  scope: TMailNativeUnsubscribeScope;
}

export type IMailTurnUnsubscribeClaims =
  | ILegacyMailTurnUnsubscribeClaims
  | INativeMailTurnUnsubscribeClaims;

/** Signs narrow, non-authentication unsubscribe capabilities. */
@Injectable()
export class MailUnsubscribeTokenService {
  private readonly secret: Buffer | undefined;

  public constructor(secret = loadUnsubscribeSecret()) {
    this.secret = secret;
  }

  public isConfigured(): boolean {
    return this.secret !== undefined;
  }

  public createTurnToken(
    userId: string,
    gameId: string,
    expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS),
    scope: TMailUnsubscribeScope = 'game',
  ): string | undefined {
    if (!this.secret) return undefined;
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(gameId)) {
      throw new Error('Mail unsubscribe token subjects must be UUIDs');
    }
    const claims: IMailTurnUnsubscribeClaims = {
      v: TOKEN_VERSION,
      userId,
      gameId,
      exp: expiresAt.getTime(),
      scope,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** Versioned native-session capability; it never aliases a legacy game id. */
  public createSessionTurnToken(
    userId: string,
    sessionId: string,
    expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS),
    scope: TMailNativeUnsubscribeScope = 'session',
  ): string | undefined {
    if (!this.secret) return undefined;
    if (!UUID_PATTERN.test(userId) || !isSessionId(sessionId))
      throw new Error('Native mail unsubscribe subjects are invalid');
    const claims: INativeMailTurnUnsubscribeClaims = {
      v: NATIVE_TOKEN_VERSION,
      userId,
      sessionId,
      exp: expiresAt.getTime(),
      scope,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  public verifyTurnToken(
    token: unknown,
  ): IMailTurnUnsubscribeClaims | undefined {
    if (!this.secret || typeof token !== 'string' || token.length > 2048) {
      return undefined;
    }
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length > 0) return undefined;
    const expected = this.sign(payload);
    const actualBytes = Buffer.from(signature, 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
    if (!isClaims(parsed) || parsed.exp <= Date.now()) return undefined;
    return parsed;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret as Buffer)
      .update(payload)
      .digest('base64url');
  }
}

function loadUnsubscribeSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer | undefined {
  const raw =
    nonEmptySecret(env.SETI_MAIL_UNSUBSCRIBE_SECRET) ??
    nonEmptySecret(env.SETI_MAIL_PAYLOAD_ENCRYPTION_KEY);
  if (!raw || raw.length < 32) return undefined;
  return Buffer.from(raw, 'utf8');
}

function nonEmptySecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}

function isClaims(value: unknown): value is IMailTurnUnsubscribeClaims {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const claims = value as Partial<ILegacyMailTurnUnsubscribeClaims> &
    Partial<INativeMailTurnUnsubscribeClaims>;
  if (
    typeof claims.userId !== 'string' ||
    !UUID_PATTERN.test(claims.userId) ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp)
  )
    return false;
  if (claims.v === TOKEN_VERSION)
    return (
      typeof claims.gameId === 'string' &&
      UUID_PATTERN.test(claims.gameId) &&
      (claims.scope === 'all' || claims.scope === 'game')
    );
  return (
    claims.v === NATIVE_TOKEN_VERSION &&
    typeof claims.sessionId === 'string' &&
    isSessionId(claims.sessionId) &&
    (claims.scope === 'all' || claims.scope === 'session')
  );
}

function isSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 200 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  );
}
