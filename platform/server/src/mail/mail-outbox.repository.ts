import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  assertNotificationTarget,
  type NotificationRuntimeOwner,
} from '@/notifications/notification-target.js';
import {
  mailOutbox,
  type TMailDeliveryStatus,
  type TMailJobStatus,
  type TMailKind,
} from '@/persistence/schema/mailOutbox.js';
import {
  type IEncryptedMailPayload,
  MailPayloadCipher,
} from './mail-payload-crypto.js';
import { mailPolicyForKind } from './mail-policy.js';
import {
  normalizeRecipient,
  sanitizeTemplateVariables,
  type TMailTemplateKey,
} from './mail-provider.js';

export interface IEnqueueMailInput {
  dedupeKey: string;
  userId?: string;
  emailVersion?: number;
  challengeId?: string;
  gameId?: string;
  runtimeOwner?: NotificationRuntimeOwner;
  sessionId?: string;
  attentionEpoch?: number;
  recipient: string;
  kind: TMailKind;
  templateKey: TMailTemplateKey;
  templateVariables: Readonly<Record<string, string>>;
  sensitivePayload?: Readonly<Record<string, string>>;
  priority?: number;
  maxAttempts?: number;
  notBefore?: Date;
  expiresAt?: Date;
}

export interface IEnqueueMailResult {
  jobId: string;
  status: 'pending' | 'deduplicated';
}

export interface IClaimedMailJob {
  id: string;
  dedupeKey: string;
  userId: string | null;
  emailVersion: number | null;
  challengeId: string | null;
  gameId: string | null;
  runtimeOwner?: NotificationRuntimeOwner;
  sessionId?: string | null;
  attentionEpoch: number | null;
  recipient: string;
  kind: TMailKind;
  templateKey: TMailTemplateKey;
  templateVariables: Record<string, string>;
  sensitivePayloadCiphertext: string | null;
  sensitivePayloadNonce: string | null;
  sensitivePayloadTag: string | null;
  sensitivePayloadKeyVersion: number | null;
  status: TMailJobStatus;
  deliveryStatus: TMailDeliveryStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  notBefore: Date | null;
  expiresAt: Date | null;
  nextAttemptAt: Date;
  leaseToken: string;
  providerMessageId: string | null;
  providerRequestId: string | null;
}

/** Safe, non-secret fields used to build a turn reminder summary. */
export interface ICoalescibleTurnReminder {
  id: string;
  dedupeKey: string;
  userId: string;
  emailVersion: number | null;
  gameId: string;
  attentionEpoch: number;
  recipient: string;
  kind: 'turn_reminder';
  templateKey: 'turn_reminder';
  templateVariables: Record<string, string>;
  status: TMailJobStatus;
  deliveryStatus: TMailDeliveryStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  notBefore: Date | null;
  expiresAt: Date | null;
  nextAttemptAt: Date;
}

export type TCoalescedTurnReminderSettlement =
  | 'accepted'
  | 'unknown'
  | 'retry_wait'
  | 'dead';

export interface IMailReconciliationJob {
  id: string;
  recipient: string;
  providerMessageId: string;
  providerSentAt: Date | null;
  status: TMailJobStatus;
  deliveryStatus: TMailDeliveryStatus;
}

const DEFAULT_LEASE_SECONDS = 5 * 60;

/** SQL-backed queue operations. Every result update fences on the lease token. */
export class MailOutboxRepository {
  private readonly cipher: MailPayloadCipher | undefined;

  public constructor(
    private readonly db: NodePgDatabase,
    cipher: MailPayloadCipher | undefined = MailPayloadCipher.fromEnvironment(),
  ) {
    this.cipher = cipher;
  }

  public async enqueue(
    input: IEnqueueMailInput,
    database: NodePgDatabase = this.db,
  ): Promise<IEnqueueMailResult> {
    const recipient = normalizeRecipient(input.recipient);
    const templateVariables = sanitizeTemplateVariables(
      input.templateVariables,
    );
    assertNoSensitiveVariableOverlap(templateVariables, input.sensitivePayload);
    const encrypted = this.encryptSensitivePayload(input.sensitivePayload);
    const policy = mailPolicyForKind(input.kind);
    const runtimeOwner = input.runtimeOwner ?? 'legacy';
    if (runtimeOwner === 'platform') {
      if (input.gameId !== undefined)
        throw new Error('Native mail rows cannot carry a legacy game target');
      assertNotificationTarget({
        runtimeOwner,
        sessionId: input.sessionId,
      });
    } else if (input.gameId) {
      assertNotificationTarget({
        runtimeOwner,
        legacyGameId: input.gameId,
      });
    } else if (input.sessionId) {
      throw new Error('Legacy mail rows cannot carry a session target');
    }
    const [inserted] = await database
      .insert(mailOutbox)
      .values({
        dedupeKey: input.dedupeKey,
        userId: input.userId,
        emailVersion: input.emailVersion,
        challengeId: input.challengeId,
        gameId: input.gameId,
        runtimeOwner,
        sessionId: input.sessionId,
        attentionEpoch: input.attentionEpoch,
        recipient,
        kind: input.kind,
        templateKey: input.templateKey,
        templateVariables,
        sensitivePayloadCiphertext: encrypted?.ciphertext,
        sensitivePayloadNonce: encrypted?.nonce,
        sensitivePayloadTag: encrypted?.tag,
        sensitivePayloadKeyVersion: encrypted?.keyVersion,
        priority: input.priority ?? policy.priority,
        maxAttempts: input.maxAttempts ?? policy.failure.maxAttempts,
        notBefore: input.notBefore,
        expiresAt: input.expiresAt,
        nextAttemptAt: input.notBefore ?? new Date(),
      })
      .onConflictDoNothing({ target: mailOutbox.dedupeKey })
      .returning({ id: mailOutbox.id });

    if (inserted) return { jobId: inserted.id, status: 'pending' };
    const [existing] = await database
      .select({ id: mailOutbox.id })
      .from(mailOutbox)
      .where(eq(mailOutbox.dedupeKey, input.dedupeKey))
      .limit(1);
    if (!existing) {
      throw new Error('Mail outbox dedupe row disappeared after conflict');
    }
    return { jobId: existing.id, status: 'deduplicated' };
  }

  /**
   * Claim one due row in a short transaction. The network call happens after
   * this method returns, so no database row lock is held during SES I/O.
   */
  public async claimNext(
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  ): Promise<IClaimedMailJob | null> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new Error('Mail lease duration must be a positive integer');
    }
    const leaseToken = randomUUID();
    const result = await this.db.execute(sql`
      WITH expired AS (
        UPDATE mail_outbox
        SET status = 'unknown',
            unknown_since = coalesce(unknown_since, clock_timestamp()),
            lease_token = NULL,
            lease_until = NULL,
            last_error_code = 'lease_expired',
            last_error_message = 'Lease expired before the provider outcome was fenced',
            sensitive_payload_ciphertext = NULL,
            sensitive_payload_nonce = NULL,
            sensitive_payload_tag = NULL,
            sensitive_payload_key_version = NULL,
            updated_at = clock_timestamp()
        WHERE status = 'processing'
          AND lease_until IS NOT NULL
          AND lease_until < clock_timestamp()
        RETURNING id
      ), candidate AS (
        SELECT id
        FROM mail_outbox
        WHERE (
          status IN ('pending', 'retry_wait')
          AND next_attempt_at <= clock_timestamp()
          AND (not_before IS NULL OR not_before <= clock_timestamp())
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        )
        ORDER BY priority DESC, created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE mail_outbox AS item
      SET status = 'processing',
          lease_token = ${leaseToken}::uuid,
          lease_until = clock_timestamp() + (${leaseSeconds}::text || ' seconds')::interval,
          attempt_count = item.attempt_count + 1,
          updated_at = clock_timestamp(),
          last_error_code = NULL,
          last_error_message = NULL
      FROM candidate
      WHERE item.id = candidate.id
      RETURNING
        item.id,
        item.dedupe_key AS "dedupeKey",
        item.user_id AS "userId",
        item.email_version AS "emailVersion",
        item.challenge_id AS "challengeId",
        item.game_id AS "gameId",
        item.runtime_owner AS "runtimeOwner",
        item.session_id AS "sessionId",
        item.attention_epoch AS "attentionEpoch",
        item.recipient,
        item.kind,
        item.template_key AS "templateKey",
        item.template_variables AS "templateVariables",
        item.sensitive_payload_ciphertext AS "sensitivePayloadCiphertext",
        item.sensitive_payload_nonce AS "sensitivePayloadNonce",
        item.sensitive_payload_tag AS "sensitivePayloadTag",
        item.sensitive_payload_key_version AS "sensitivePayloadKeyVersion",
        item.status,
        item.delivery_status AS "deliveryStatus",
        item.priority,
        item.attempt_count AS "attemptCount",
        item.max_attempts AS "maxAttempts",
        item.not_before AS "notBefore",
        item.expires_at AS "expiresAt",
        item.next_attempt_at AS "nextAttemptAt",
        item.lease_token AS "leaseToken",
        item.provider_message_id AS "providerMessageId",
        item.provider_request_id AS "providerRequestId"
    `);
    const row =
      (result.rows[0] as Partial<IClaimedMailJob> | undefined) ?? null;
    if (!row?.id || !row.leaseToken) return null;
    return normalizeClaimedJob(row);
  }

  public decryptSensitivePayload(
    job: Pick<
      IClaimedMailJob,
      | 'sensitivePayloadCiphertext'
      | 'sensitivePayloadNonce'
      | 'sensitivePayloadTag'
      | 'sensitivePayloadKeyVersion'
    >,
  ): Record<string, string> {
    const encrypted = toEncryptedPayload(job);
    if (!encrypted) return {};
    if (!this.cipher)
      throw new Error('Mail payload encryption key is not configured');
    return this.cipher.decrypt(encrypted);
  }

  /** Cancels expired pending work and removes any leftover encrypted payload. */
  public async cancelExpired(): Promise<number> {
    const result = await this.db.execute(sql`
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
    `);
    return result.rows.length;
  }

  public async markAccepted(
    id: string,
    leaseToken: string,
    providerMessageId: string,
    providerRequestId: string | null,
  ): Promise<boolean> {
    return this.updateWithLease(
      id,
      leaseToken,
      sql`
        status = 'accepted',
        delivery_status = 'unknown',
        provider_message_id = ${providerMessageId},
        provider_request_id = ${providerRequestId},
        provider_sent_at = clock_timestamp(),
        unknown_since = NULL,
        lease_token = NULL,
        lease_until = NULL,
        sensitive_payload_ciphertext = NULL,
        sensitive_payload_nonce = NULL,
        sensitive_payload_tag = NULL,
        sensitive_payload_key_version = NULL,
        updated_at = clock_timestamp()
      `,
    );
  }

  public async markUnknown(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return this.updateWithLease(
      id,
      leaseToken,
      sql`
        status = 'unknown',
        unknown_since = coalesce(unknown_since, clock_timestamp()),
        lease_token = NULL,
        lease_until = NULL,
        last_error_code = ${safeErrorCode(errorCode)},
        last_error_message = ${safeErrorMessage(errorMessage)},
        sensitive_payload_ciphertext = NULL,
        sensitive_payload_nonce = NULL,
        sensitive_payload_tag = NULL,
        sensitive_payload_key_version = NULL,
        updated_at = clock_timestamp()
      `,
    );
  }

  public async markRetry(
    id: string,
    leaseToken: string,
    nextAttemptAt: Date,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return this.updateWithLease(
      id,
      leaseToken,
      sql`
        status = 'retry_wait',
        next_attempt_at = ${nextAttemptAt},
        lease_token = NULL,
        lease_until = NULL,
        last_error_code = ${safeErrorCode(errorCode)},
        last_error_message = ${safeErrorMessage(errorMessage)},
        updated_at = clock_timestamp()
      `,
    );
  }

  public async markDead(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return this.updateWithLease(
      id,
      leaseToken,
      sql`
        status = 'dead',
        lease_token = NULL,
        lease_until = NULL,
        last_error_code = ${safeErrorCode(errorCode)},
        last_error_message = ${safeErrorMessage(errorMessage)},
        sensitive_payload_ciphertext = NULL,
        sensitive_payload_nonce = NULL,
        sensitive_payload_tag = NULL,
        sensitive_payload_key_version = NULL,
        updated_at = clock_timestamp()
      `,
    );
  }

  public async markCancelled(
    id: string,
    reason: string,
    leaseToken?: string,
  ): Promise<boolean> {
    const tokenCondition = leaseToken
      ? sql`AND lease_token = ${leaseToken}::uuid`
      : sql``;
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET status = 'cancelled',
          cancelled_reason = ${safeErrorMessage(reason)},
          lease_token = NULL,
          lease_until = NULL,
          sensitive_payload_ciphertext = NULL,
          sensitive_payload_nonce = NULL,
          sensitive_payload_tag = NULL,
          sensitive_payload_key_version = NULL,
          updated_at = clock_timestamp()
      WHERE id = ${id}::uuid ${tokenCondition}
        AND status NOT IN ('accepted', 'cancelled', 'dead')
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  public async cancelByDedupeKey(
    dedupeKey: string,
    reason: string,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET status = 'cancelled',
          cancelled_reason = ${safeErrorMessage(reason)},
          lease_token = NULL,
          lease_until = NULL,
          sensitive_payload_ciphertext = NULL,
          sensitive_payload_nonce = NULL,
          sensitive_payload_tag = NULL,
          sensitive_payload_key_version = NULL,
          updated_at = clock_timestamp()
      WHERE dedupe_key = ${dedupeKey}
        AND status NOT IN ('accepted', 'cancelled', 'dead')
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  /**
   * Finds due reminders for the same account that were enqueued in the same
   * short delivery window. Only safe template fields are returned; encrypted
   * payloads remain inaccessible until the selected primary job is sent.
   */
  public async listCoalescibleTurnReminders(
    job: Pick<
      IClaimedMailJob,
      'id' | 'userId' | 'emailVersion' | 'recipient' | 'gameId' | 'runtimeOwner'
    >,
    limit = 4,
  ): Promise<ICoalescibleTurnReminder[]> {
    if (!job.userId || !job.gameId || job.runtimeOwner === 'platform')
      return [];
    const boundedLimit = Math.max(1, Math.min(4, Math.floor(limit)));
    const result = await this.db.execute(sql`
      SELECT
        id,
        dedupe_key AS "dedupeKey",
        user_id AS "userId",
        email_version AS "emailVersion",
        game_id AS "gameId",
        attention_epoch AS "attentionEpoch",
        recipient,
        kind,
        template_key AS "templateKey",
        template_variables AS "templateVariables",
        status,
        delivery_status AS "deliveryStatus",
        priority,
        attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts",
        not_before AS "notBefore",
        expires_at AS "expiresAt",
        next_attempt_at AS "nextAttemptAt"
      FROM mail_outbox
      WHERE id <> ${job.id}::uuid
        AND user_id = ${job.userId}::uuid
        AND runtime_owner = 'legacy'
        AND game_id IS NOT NULL
        AND game_id <> ${job.gameId}::uuid
        AND kind = 'turn_reminder'
        AND template_key = 'turn_reminder'
        AND status IN ('pending', 'retry_wait')
        AND recipient = ${job.recipient}
        AND email_version IS NOT DISTINCT FROM ${job.emailVersion}
        AND next_attempt_at <= clock_timestamp()
        AND (not_before IS NULL OR not_before <= clock_timestamp())
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND created_at >= clock_timestamp() - interval '5 minutes'
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT ${boundedLimit}
    `);
    return result.rows
      .map((row) => normalizeCoalescibleReminder(row))
      .filter((row): row is ICoalescibleTurnReminder => row !== null);
  }

  /**
   * Fences candidate rows to the primary worker lease before network I/O.
   * A second worker can therefore neither claim nor send a candidate while
   * the primary request is in flight.
   */
  public async reserveCoalescibleTurnReminders(
    job: Pick<
      IClaimedMailJob,
      | 'id'
      | 'userId'
      | 'emailVersion'
      | 'recipient'
      | 'gameId'
      | 'runtimeOwner'
      | 'leaseToken'
    >,
    ids: readonly string[],
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  ): Promise<ICoalescibleTurnReminder[]> {
    if (
      !job.userId ||
      !job.gameId ||
      job.runtimeOwner === 'platform' ||
      ids.length === 0
    )
      return [];
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
      throw new Error('Mail lease duration must be a positive integer');
    }
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET status = 'processing',
          lease_token = ${job.leaseToken}::uuid,
          lease_until = clock_timestamp() + (${leaseSeconds}::text || ' seconds')::interval,
          updated_at = clock_timestamp(),
          last_error_code = NULL,
          last_error_message = NULL
      WHERE id IN (${idList})
        AND id <> ${job.id}::uuid
        AND user_id = ${job.userId}::uuid
        AND runtime_owner = 'legacy'
        AND game_id IS NOT NULL
        AND game_id <> ${job.gameId}::uuid
        AND kind = 'turn_reminder'
        AND template_key = 'turn_reminder'
        AND status IN ('pending', 'retry_wait')
        AND recipient = ${job.recipient}
        AND email_version IS NOT DISTINCT FROM ${job.emailVersion}
        AND next_attempt_at <= clock_timestamp()
        AND (not_before IS NULL OR not_before <= clock_timestamp())
        AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AND created_at >= clock_timestamp() - interval '5 minutes'
      RETURNING
        id,
        dedupe_key AS "dedupeKey",
        user_id AS "userId",
        email_version AS "emailVersion",
        game_id AS "gameId",
        attention_epoch AS "attentionEpoch",
        recipient,
        kind,
        template_key AS "templateKey",
        template_variables AS "templateVariables",
        status,
        delivery_status AS "deliveryStatus",
        priority,
        attempt_count AS "attemptCount",
        max_attempts AS "maxAttempts",
        not_before AS "notBefore",
        expires_at AS "expiresAt",
        next_attempt_at AS "nextAttemptAt"
    `);
    return result.rows
      .map((row) => normalizeCoalescibleReminder(row))
      .filter((row): row is ICoalescibleTurnReminder => row !== null);
  }

  /** Settles candidate rows using the primary worker's lease token. */
  public async settleCoalescedTurnReminders(
    ids: readonly string[],
    leaseToken: string,
    settlement: TCoalescedTurnReminderSettlement,
    reason: string,
    nextAttemptAt?: Date,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const clearPayload = settlement !== 'retry_wait';
    const status =
      settlement === 'retry_wait'
        ? 'retry_wait'
        : settlement === 'dead'
          ? 'dead'
          : 'cancelled';
    const retryFields =
      settlement === 'retry_wait'
        ? sql`
            next_attempt_at = ${nextAttemptAt ?? new Date()},
            last_error_code = ${safeErrorCode(reason)},
            last_error_message = ${safeErrorMessage(reason)},
          `
        : sql``;
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET status = ${status},
          ${retryFields}
          cancelled_reason = ${settlement === 'retry_wait' ? null : safeErrorMessage(reason)},
          lease_token = NULL,
          lease_until = NULL,
          sensitive_payload_ciphertext = CASE WHEN ${clearPayload} THEN NULL ELSE sensitive_payload_ciphertext END,
          sensitive_payload_nonce = CASE WHEN ${clearPayload} THEN NULL ELSE sensitive_payload_nonce END,
          sensitive_payload_tag = CASE WHEN ${clearPayload} THEN NULL ELSE sensitive_payload_tag END,
          sensitive_payload_key_version = CASE WHEN ${clearPayload} THEN NULL ELSE sensitive_payload_key_version END,
          updated_at = clock_timestamp()
      WHERE id IN (${idList})
        AND status = 'processing'
        AND lease_token = ${leaseToken}::uuid
      RETURNING id
    `);
    return result.rows.length;
  }

  /** Cancels rows that were folded into an accepted summary email. */
  public async cancelByIds(
    ids: readonly string[],
    reason: string,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET status = 'cancelled',
          cancelled_reason = ${safeErrorMessage(reason)},
          lease_token = NULL,
          lease_until = NULL,
          sensitive_payload_ciphertext = NULL,
          sensitive_payload_nonce = NULL,
          sensitive_payload_tag = NULL,
          sensitive_payload_key_version = NULL,
          updated_at = clock_timestamp()
      WHERE id IN (${idList})
        AND status IN ('pending', 'retry_wait')
      RETURNING id
    `);
    return result.rows.length;
  }

  public async markDeliveryStatus(
    id: string,
    providerMessageId: string,
    deliveryStatus: TMailDeliveryStatus,
    detail?: string,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET delivery_status = ${deliveryStatus},
          last_status_checked_at = clock_timestamp(),
          last_error_message = ${detail ? safeErrorMessage(detail) : null},
          updated_at = clock_timestamp()
      WHERE id = ${id}::uuid
        AND provider_message_id = ${providerMessageId}
        AND status IN ('accepted', 'unknown')
      RETURNING id
    `);
    return result.rows.length > 0;
  }

  public async listForReconciliation(
    limit = 100,
  ): Promise<IMailReconciliationJob[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.db.execute(sql`
      SELECT
        id,
        recipient,
        provider_message_id AS "providerMessageId",
        provider_sent_at AS "providerSentAt",
        status,
        delivery_status AS "deliveryStatus"
      FROM mail_outbox
      WHERE provider_message_id IS NOT NULL
        AND status IN ('accepted', 'unknown')
        AND delivery_status = 'unknown'
        AND (
          last_status_checked_at IS NULL
          OR last_status_checked_at < clock_timestamp() - interval '5 minutes'
        )
      ORDER BY coalesce(last_status_checked_at, provider_sent_at) ASC, id ASC
      LIMIT ${boundedLimit}
    `);
    return result.rows as unknown as IMailReconciliationJob[];
  }

  private encryptSensitivePayload(
    payload: Readonly<Record<string, string>> | undefined,
  ): IEncryptedMailPayload | undefined {
    if (!payload) return undefined;
    if (!this.cipher) {
      throw new Error('Mail payload encryption key is not configured');
    }
    return this.cipher.encrypt(payload);
  }

  private async updateWithLease(
    id: string,
    leaseToken: string,
    assignments: ReturnType<typeof sql>,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE mail_outbox
      SET ${assignments}
      WHERE id = ${id}::uuid
        AND lease_token = ${leaseToken}::uuid
        AND status = 'processing'
      RETURNING id
    `);
    return result.rows.length > 0;
  }
}

function toEncryptedPayload(
  job: Pick<
    IClaimedMailJob,
    | 'sensitivePayloadCiphertext'
    | 'sensitivePayloadNonce'
    | 'sensitivePayloadTag'
    | 'sensitivePayloadKeyVersion'
  >,
): IEncryptedMailPayload | undefined {
  const fields = [
    job.sensitivePayloadCiphertext,
    job.sensitivePayloadNonce,
    job.sensitivePayloadTag,
    job.sensitivePayloadKeyVersion,
  ];
  if (fields.every((value) => value === null)) return undefined;
  if (
    typeof job.sensitivePayloadCiphertext !== 'string' ||
    typeof job.sensitivePayloadNonce !== 'string' ||
    typeof job.sensitivePayloadTag !== 'string' ||
    typeof job.sensitivePayloadKeyVersion !== 'number'
  ) {
    throw new Error('Mail sensitive payload is incomplete');
  }
  return {
    ciphertext: job.sensitivePayloadCiphertext,
    nonce: job.sensitivePayloadNonce,
    tag: job.sensitivePayloadTag,
    keyVersion: job.sensitivePayloadKeyVersion,
  };
}

function normalizeClaimedJob(row: Partial<IClaimedMailJob>): IClaimedMailJob {
  if (
    typeof row.dedupeKey !== 'string' ||
    typeof row.recipient !== 'string' ||
    typeof row.kind !== 'string' ||
    typeof row.templateKey !== 'string' ||
    typeof row.status !== 'string' ||
    typeof row.deliveryStatus !== 'string' ||
    typeof row.attemptCount !== 'number' ||
    typeof row.maxAttempts !== 'number' ||
    typeof row.nextAttemptAt === 'undefined'
  ) {
    throw new Error('Mail outbox claim returned an invalid row');
  }
  if (row.runtimeOwner !== 'legacy' && row.runtimeOwner !== 'platform') {
    throw new Error('Mail outbox claim returned an invalid target owner');
  }
  return {
    ...(row as IClaimedMailJob),
    templateVariables: isStringRecord(row.templateVariables)
      ? row.templateVariables
      : {},
    notBefore: row.notBefore ? new Date(row.notBefore) : null,
    expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
    nextAttemptAt: new Date(row.nextAttemptAt),
  };
}

function normalizeCoalescibleReminder(
  row: Record<string, unknown>,
): ICoalescibleTurnReminder | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.dedupeKey !== 'string' ||
    typeof row.userId !== 'string' ||
    typeof row.gameId !== 'string' ||
    typeof row.attentionEpoch !== 'number' ||
    typeof row.recipient !== 'string' ||
    row.kind !== 'turn_reminder' ||
    row.templateKey !== 'turn_reminder' ||
    typeof row.status !== 'string' ||
    typeof row.deliveryStatus !== 'string' ||
    typeof row.priority !== 'number' ||
    typeof row.attemptCount !== 'number' ||
    typeof row.maxAttempts !== 'number' ||
    typeof row.nextAttemptAt === 'undefined'
  ) {
    return null;
  }
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    userId: row.userId,
    emailVersion:
      typeof row.emailVersion === 'number' ? row.emailVersion : null,
    gameId: row.gameId,
    attentionEpoch: row.attentionEpoch,
    recipient: row.recipient,
    kind: 'turn_reminder',
    templateKey: 'turn_reminder',
    templateVariables: isStringRecord(row.templateVariables)
      ? row.templateVariables
      : {},
    status: row.status as TMailJobStatus,
    deliveryStatus: row.deliveryStatus as TMailDeliveryStatus,
    priority: row.priority,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    notBefore: row.notBefore
      ? new Date(row.notBefore as string | number)
      : null,
    expiresAt: row.expiresAt
      ? new Date(row.expiresAt as string | number)
      : null,
    nextAttemptAt: new Date(row.nextAttemptAt as string | number | Date),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function assertNoSensitiveVariableOverlap(
  templateVariables: Readonly<Record<string, string>>,
  sensitivePayload: Readonly<Record<string, string>> | undefined,
): void {
  if (!sensitivePayload) return;
  const overlap = Object.keys(sensitivePayload).find((key) =>
    Object.hasOwn(templateVariables, key),
  );
  if (overlap) {
    throw new Error(
      `Sensitive mail variable ${overlap} must not be copied into plaintext template variables`,
    );
  }
}

function safeErrorCode(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
}

function safeErrorMessage(value: string): string {
  return value.replace(/[\r\n]/g, ' ').slice(0, 500);
}
