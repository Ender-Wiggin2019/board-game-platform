import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import { toRole } from '@board-platform/contracts/auth/roles';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getRuntimeConfig } from '@/config/runtimeConfig.js';
import {
  assertNotificationTarget,
  type NotificationTarget,
} from '@/notifications/notification-target.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import type { TMailKind } from '@/persistence/schema/mailOutbox.js';
import { users } from '@/persistence/schema/users.js';
import { MailGamePolicyRegistry } from './mail-game-policies.js';
import {
  type IEnqueueMailInput,
  type IEnqueueMailResult,
  MailOutboxRepository,
} from './mail-outbox.repository.js';
import { MailPayloadCipher } from './mail-payload-crypto.js';
import { isEnabledMailKind } from './mail-policy.js';
import { sanitizeGameName, type TMailTemplateKey } from './mail-provider.js';
import { MailUnsubscribeTokenService } from './mail-unsubscribe.service.js';

export interface IEnqueueTemplateInput {
  recipient: string;
  templateKey: TMailTemplateKey;
  variables: Readonly<Record<string, string>>;
  kind: TMailKind;
  userId?: string;
  emailVersion?: number;
  challengeId?: string;
  gameId?: string;
  runtimeOwner?: 'legacy' | 'platform';
  sessionId?: string;
  attentionEpoch?: number;
  dedupeKey: string;
  priority?: number;
  maxAttempts?: number;
  notBefore?: Date;
  expiresAt?: Date;
  sensitivePayload?: Readonly<Record<string, string>>;
}

export interface IEnqueueTurnReminderInput {
  gameId: string;
  userId: string;
  attentionEpoch: number;
  gameName?: string | null;
  notBefore?: Date;
  expiresAt?: Date;
}

export interface IEnqueueSessionTurnReminderInput {
  target: NotificationTarget;
  userId: string;
  attentionEpoch: number;
  sessionName?: string | null;
  actionUrl?: string;
  notBefore?: Date;
  expiresAt?: Date;
}

@Injectable()
export class MailOutboxService {
  private readonly cipher: MailPayloadCipher | undefined;
  private readonly outbox: MailOutboxRepository;
  private readonly unsubscribeTokens: MailUnsubscribeTokenService;

  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Optional()
    @Inject(MailUnsubscribeTokenService)
    unsubscribeTokens?: MailUnsubscribeTokenService,
    @Optional()
    @Inject(MailGamePolicyRegistry)
    private readonly gamePolicies = new MailGamePolicyRegistry(),
  ) {
    this.cipher = MailPayloadCipher.fromEnvironment();
    this.outbox = new MailOutboxRepository(db, this.cipher);
    this.unsubscribeTokens =
      unsubscribeTokens ?? new MailUnsubscribeTokenService();
  }

  /**
   * The caller may pass its active transaction so account challenges and the
   * durable mail row commit together.
   */
  public async enqueueTemplate(
    input: IEnqueueTemplateInput,
    database: NodePgDatabase = this.db,
  ): Promise<IEnqueueMailResult> {
    if (!isEnabledMailKind(input.kind)) {
      throw new Error(`Mail kind is disabled: ${input.kind}`);
    }
    const repository =
      database === this.db
        ? this.outbox
        : new MailOutboxRepository(database, this.cipher);
    const outboxInput: IEnqueueMailInput = {
      dedupeKey: input.dedupeKey,
      userId: input.userId,
      emailVersion: input.emailVersion,
      challengeId: input.challengeId,
      gameId: input.gameId,
      runtimeOwner: input.runtimeOwner,
      sessionId: input.sessionId,
      attentionEpoch: input.attentionEpoch,
      recipient: input.recipient,
      kind: input.kind,
      templateKey: input.templateKey,
      templateVariables: input.variables,
      sensitivePayload: input.sensitivePayload,
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      notBefore: input.notBefore,
      expiresAt: input.expiresAt,
    };
    return repository.enqueue(outboxInput, database);
  }

  /**
   * Creates a reminder for an opted-in account that is still a member of a
   * live game. Current action ownership is checked again before SES I/O.
   */
  public async enqueueTurnReminder(
    input: IEnqueueTurnReminderInput,
    database: NodePgDatabase = this.db,
  ): Promise<IEnqueueMailResult | null> {
    const [account] = await database
      .select({
        email: users.email,
        emailVersion: users.emailVersion,
        accountStatus: users.accountStatus,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!account) return null;

    const preferences = await new AccountPreferencesRepository(database).get(
      input.userId,
    );
    if (
      account.accountStatus !== 'active' ||
      !can(toRole(account.role), ECapability.TURN_EMAIL_REMINDERS) ||
      !isTurnReminderEnabled(
        preferences as unknown as Readonly<Record<string, unknown>>,
      )
    ) {
      return null;
    }

    const game = await this.gamePolicies.legacyReminder(
      database,
      input.gameId,
      input.userId,
    );
    if (!game?.eligible) return null;

    const safeName = sanitizeGameName(input.gameName ?? game.name);
    const actionUrl = buildActionUrl(input.gameId);
    const unsubscribeToken = this.unsubscribeTokens.createTurnToken(
      input.userId,
      input.gameId,
      undefined,
      'all',
    );
    const muteToken = this.unsubscribeTokens.createTurnToken(
      input.userId,
      input.gameId,
    );
    const unsubscribeUrl = unsubscribeToken
      ? buildUnsubscribeUrl(unsubscribeToken)
      : undefined;
    const muteUrl = muteToken ? buildMuteUrl(muteToken) : undefined;
    return this.enqueueTemplate(
      {
        recipient: account.email,
        templateKey: 'turn_reminder',
        kind: 'turn_reminder',
        userId: input.userId,
        emailVersion: account.emailVersion,
        gameId: input.gameId,
        attentionEpoch: input.attentionEpoch,
        dedupeKey: `turn_email:${input.gameId}:${input.userId}:${input.attentionEpoch}`,
        variables: {
          gameName: safeName,
          actionUrl,
        },
        sensitivePayload:
          unsubscribeUrl || muteUrl
            ? {
                ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
                ...(muteUrl ? { muteUrl } : {}),
              }
            : undefined,
        notBefore: input.notBefore ?? new Date(Date.now() + 2 * 60 * 1000),
        expiresAt:
          input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      database,
    );
  }

  /** Enqueues one native-session reminder through the same durable writer. */
  public async enqueueSessionTurnReminder(
    input: IEnqueueSessionTurnReminderInput,
    database: NodePgDatabase = this.db,
  ): Promise<IEnqueueMailResult | null> {
    assertNotificationTarget(input.target);
    if (input.target.runtimeOwner !== 'platform' || !input.target.sessionId)
      throw new Error(
        'Native turn reminders require a platform session target',
      );
    const [account] = await database
      .select({
        email: users.email,
        emailVersion: users.emailVersion,
        accountStatus: users.accountStatus,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!account) return null;
    const preferences = await new AccountPreferencesRepository(database).get(
      input.userId,
    );
    if (
      account.accountStatus !== 'active' ||
      !can(toRole(account.role), ECapability.TURN_EMAIL_REMINDERS) ||
      !isTurnReminderEnabled(
        preferences as unknown as Readonly<Record<string, unknown>>,
      )
    )
      return null;
    const sessionId = input.target.sessionId;
    const safeName = sanitizeGameName(input.sessionName ?? 'your game');
    const actionUrl = input.actionUrl ?? buildSessionActionUrl(sessionId);
    const unsubscribeToken = this.unsubscribeTokens.createSessionTurnToken(
      input.userId,
      sessionId,
      undefined,
      'all',
    );
    const muteToken = this.unsubscribeTokens.createSessionTurnToken(
      input.userId,
      sessionId,
    );
    const unsubscribeUrl = unsubscribeToken
      ? buildUnsubscribeUrl(unsubscribeToken)
      : undefined;
    const muteUrl = muteToken ? buildMuteUrl(muteToken) : undefined;
    return this.enqueueTemplate(
      {
        recipient: account.email,
        templateKey: 'turn_reminder',
        kind: 'turn_reminder',
        userId: input.userId,
        emailVersion: account.emailVersion,
        runtimeOwner: 'platform',
        sessionId,
        attentionEpoch: input.attentionEpoch,
        dedupeKey: `turn_email:platform:${sessionId}:${input.userId}:${input.attentionEpoch}`,
        variables: {
          gameName: safeName,
          actionUrl,
        },
        sensitivePayload:
          unsubscribeUrl || muteUrl
            ? {
                ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
                ...(muteUrl ? { muteUrl } : {}),
              }
            : undefined,
        notBefore: input.notBefore ?? new Date(Date.now() + 2 * 60 * 1000),
        expiresAt:
          input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      database,
    );
  }

  public async cancelByDedupeKey(
    dedupeKey: string,
    reason: string,
    database: NodePgDatabase = this.db,
  ): Promise<boolean> {
    const repository =
      database === this.db
        ? this.outbox
        : new MailOutboxRepository(database, this.cipher);
    return repository.cancelByDedupeKey(dedupeKey, reason);
  }

  public async clearExpiredSensitivePayloads(
    database: NodePgDatabase = this.db,
  ): Promise<number> {
    const result = await database.execute(
      // The row remains as an audit record; only ephemeral payload material is
      // removed once its challenge or reminder window has elapsed.
      sql`
        UPDATE mail_outbox
        SET sensitive_payload_ciphertext = NULL,
            sensitive_payload_nonce = NULL,
            sensitive_payload_tag = NULL,
            sensitive_payload_key_version = NULL,
            status = CASE
              WHEN status IN ('pending', 'retry_wait') THEN 'cancelled'
              WHEN status = 'processing'
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                THEN 'unknown'
              ELSE status
            END,
            cancelled_reason = CASE
              WHEN status IN ('pending', 'retry_wait') THEN 'expired'
              ELSE cancelled_reason
            END,
            unknown_since = CASE
              WHEN status = 'processing'
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                THEN coalesce(unknown_since, clock_timestamp())
              ELSE unknown_since
            END,
            last_error_code = CASE
              WHEN status = 'processing'
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                THEN 'lease_expired'
              ELSE last_error_code
            END,
            last_error_message = CASE
              WHEN status = 'processing'
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
                THEN 'Lease expired before the provider outcome was fenced'
              ELSE last_error_message
            END,
            lease_token = NULL,
            lease_until = NULL,
            updated_at = clock_timestamp()
        WHERE expires_at IS NOT NULL
          AND expires_at <= clock_timestamp()
          AND (
            status IN ('pending', 'retry_wait')
            OR (
              status = 'processing'
              AND (lease_until IS NULL OR lease_until <= clock_timestamp())
            )
            OR (
              status NOT IN ('pending', 'retry_wait', 'processing')
              AND sensitive_payload_ciphertext IS NOT NULL
            )
          )
        RETURNING id
      `,
    );
    return result.rows.length;
  }
}

function isTurnReminderEnabled(
  preferences: Readonly<Record<string, unknown>>,
): boolean {
  return preferences.emailTurnRemindersEnabled === true;
}

function buildActionUrl(gameId: string): string {
  const origin = getRuntimeConfig().server.publicOrigin;
  return new URL(`/game/${encodeURIComponent(gameId)}`, origin).toString();
}

function buildSessionActionUrl(sessionId: string): string {
  const origin = getRuntimeConfig().server.publicOrigin;
  return new URL(
    `/platform/sessions/${encodeURIComponent(sessionId)}`,
    origin,
  ).toString();
}

function buildUnsubscribeUrl(token: string): string {
  const url = new URL(
    '/mail/unsubscribe',
    getRuntimeConfig().server.publicOrigin,
  );
  url.searchParams.set('token', token);
  return url.toString();
}

function buildMuteUrl(token: string): string {
  const url = new URL('/mail/mute', getRuntimeConfig().server.publicOrigin);
  url.searchParams.set('token', token);
  return url.toString();
}
