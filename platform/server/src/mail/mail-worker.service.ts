import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import { toRole } from '@board-platform/contracts/auth/roles';
import {
  normalizeUserLanguage,
  type TUserLanguage,
} from '@board-platform/contracts/types/protocol/userLanguage';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getRuntimeConfig } from '@/config/runtimeConfig.js';
import type {
  NativeNotificationSnapshot,
  NotificationTarget,
} from '@/notifications/notification-target.js';
import { assertNotificationTarget } from '@/notifications/notification-target.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import { users } from '@/persistence/schema/users.js';
import { MailBudgetService } from './mail-budget.service.js';
import { MailForegroundPresenceService } from './mail-foreground-presence.service.js';
import { MailGamePolicyRegistry } from './mail-game-policies.js';
import { MailOnlinePresenceService } from './mail-online-presence.service.js';
import {
  type IClaimedMailJob,
  type ICoalescibleTurnReminder,
  MailOutboxRepository,
} from './mail-outbox.repository.js';
import { MailPayloadCipher } from './mail-payload-crypto.js';
import {
  isEnabledMailKind,
  mailFailureActionForChannel,
  mailPolicyForKind,
} from './mail-policy.js';
import { type MailProvider, MailProviderError } from './mail-provider.js';
import { createMailProvider } from './mail-provider-factory.js';
import { MailSuppressionService } from './mail-suppression.service.js';
import { buildTurnReminderSummary } from './mail-turn-coalescing.js';

export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

const WORK_INTERVAL_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const FOREGROUND_RETRY_MS = 5 * 60_000;
const TURN_COALESCE_LIMIT = 4;
const MAIL_PROCESS_MODE_ENV = 'SETI_MAIL_PROCESS_MODE';
const MAIL_PROCESS_ROLE_ENV = 'SETI_MAIL_PROCESS_ROLE';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TMailProcessMode = 'same-process' | 'standalone';
export type TMailProcessRole = 'http' | 'worker';

/**
 * The HTTP app keeps the in-process consumer unless standalone mode is
 * explicitly selected. A dedicated worker must opt into the worker role; an
 * unset or unknown role is treated as HTTP so a misconfigured web process
 * cannot start claiming mail rows.
 */
export function getMailProcessMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TMailProcessMode | null {
  const value = env[MAIL_PROCESS_MODE_ENV]?.trim().toLowerCase();
  if (!value || value === 'same-process') return 'same-process';
  if (value === 'standalone') return 'standalone';
  return null;
}

export function getMailProcessRole(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TMailProcessRole {
  return env[MAIL_PROCESS_ROLE_ENV]?.trim().toLowerCase() === 'worker'
    ? 'worker'
    : 'http';
}

/** Whether this process is allowed to claim or reconcile mail work. */
export function isMailConsumerProcess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const mode = getMailProcessMode(env);
  if (mode === null) return false;
  const role = getMailProcessRole(env);
  return mode === 'standalone' ? role === 'worker' : role === 'http';
}

export function isDedicatedMailWorkerProcess(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    getMailProcessMode(env) === 'standalone' &&
    getMailProcessRole(env) === 'worker'
  );
}

export type TMailForegroundResolver = (
  userId: string,
  gameId: string,
) => boolean | Promise<boolean>;

export type TNativeMailTargetResolver = (
  job: IClaimedMailJob,
) => Promise<NativeNotificationSnapshot | null>;

export type TMailTargetForegroundResolver = (
  userId: string,
  target: NotificationTarget,
) => boolean | Promise<boolean>;

export interface IMailReadiness {
  processMode: TMailProcessMode | null;
  processRole: TMailProcessRole;
  consumerProcess: boolean;
  providerConfigured: boolean;
  payloadEncryptionConfigured: boolean;
  workerEnabled: boolean;
  nonProductionRecipientAllowlistConfigured: boolean;
  ready: boolean;
}

/**
 * Post-commit mail consumer. Claiming, policy checks, budget reservation and
 * fenced result writes are separate from the provider network call.
 */
@Injectable()
export class MailWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailWorkerService.name);
  private readonly outbox: MailOutboxRepository;
  private readonly budget: MailBudgetService;
  private readonly suppression: MailSuppressionService;
  private readonly preferences: AccountPreferencesRepository;
  private readonly foregroundPresence: MailForegroundPresenceService;
  private readonly onlinePresence: MailOnlinePresenceService;
  private readonly provider: MailProvider;
  private readonly payloadEncryptionConfigured: boolean;
  private foregroundResolver: TMailForegroundResolver = () => false;
  private nativeTargetResolver: TNativeMailTargetResolver | undefined;
  private targetForegroundResolver: TMailTargetForegroundResolver = () => false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activeCycle: Promise<boolean> | undefined;
  private stopping = false;
  private running = false;
  private lastPresenceSweepAt = Date.now();

  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Optional() @Inject(MAIL_PROVIDER) provider?: MailProvider,
    @Optional()
    @Inject(MailForegroundPresenceService)
    foregroundPresence?: MailForegroundPresenceService,
    @Optional()
    @Inject(MailOnlinePresenceService)
    onlinePresence?: MailOnlinePresenceService,
    @Optional()
    @Inject(MailGamePolicyRegistry)
    private readonly gamePolicies = new MailGamePolicyRegistry(),
  ) {
    this.provider = provider ?? createMailProvider();
    this.outbox = new MailOutboxRepository(db);
    this.budget = new MailBudgetService(db);
    this.suppression = new MailSuppressionService(db);
    this.preferences = new AccountPreferencesRepository(db);
    this.foregroundPresence =
      foregroundPresence ?? new MailForegroundPresenceService(db);
    this.onlinePresence = onlinePresence ?? new MailOnlinePresenceService(db);
    this.payloadEncryptionConfigured = hasPayloadEncryptionKey();
    this.foregroundResolver = (userId, gameId) =>
      this.foregroundPresence.isActive(userId, gameId);
    this.targetForegroundResolver = (userId, target) =>
      this.foregroundPresence.isActiveTarget(userId, target);
    this.nativeTargetResolver = (job) => this.gamePolicies.nativeTarget(job);
  }

  public onModuleInit(): void {
    if (!isMailConsumerProcess()) {
      this.logger.log(
        'mail consumer is inactive in this process; outbox rows remain for the dedicated worker',
      );
      return;
    }
    const readiness = this.getReadiness();
    const production = process.env.NODE_ENV === 'production';
    if (
      !readiness.providerConfigured ||
      !readiness.payloadEncryptionConfigured
    ) {
      this.logger.error(
        'Mail provider or payload encryption is not configured; mail worker is paused',
      );
      if (production) {
        throw new Error(
          'Mail delivery is not configured for production: provider credentials and SETI_MAIL_PAYLOAD_ENCRYPTION_KEY are required',
        );
      }
      return;
    }
    if (!readiness.nonProductionRecipientAllowlistConfigured) {
      this.logger.error(
        'Non-production mail requires SETI_MAIL_ALLOWED_RECIPIENTS; delivery is paused',
      );
      return;
    }
    if (!readiness.workerEnabled) {
      this.logger.warn(
        'mail worker is disabled; account and turn mail remain pending until SETI_MAIL_WORKER_ENABLED=true',
      );
      if (production) {
        throw new Error(
          'Mail delivery is disabled in production; set SETI_MAIL_WORKER_ENABLED=true',
        );
      }
      return;
    }
    this.stopping = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce().catch((error) => {
        this.logger.error(
          `mail worker cycle failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, WORK_INTERVAL_MS);
    if (!isDedicatedMailWorkerProcess()) this.timer.unref?.();
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const activeCycle = this.activeCycle;
    if (activeCycle) {
      await activeCycle.catch((error: unknown) => {
        this.logger.warn(
          `mail worker shutdown drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  public setForegroundResolver(resolver: TMailForegroundResolver): void {
    this.foregroundResolver = resolver;
  }

  /** Supplies server-owned admission/directory rechecks for native jobs. */
  public setNativeTargetResolver(
    resolver: TNativeMailTargetResolver | undefined,
  ): void {
    this.nativeTargetResolver = resolver;
  }

  public setTargetForegroundResolver(
    resolver: TMailTargetForegroundResolver,
  ): void {
    this.targetForegroundResolver = resolver;
  }

  public getReadiness(): IMailReadiness {
    const processMode = getMailProcessMode();
    const processRole = getMailProcessRole();
    const consumerProcess = isMailConsumerProcess();
    const providerConfigured = this.provider.isConfigured();
    const payloadEncryptionConfigured = this.payloadEncryptionConfigured;
    const workerEnabled = process.env.SETI_MAIL_WORKER_ENABLED === 'true';
    const nonProductionRecipientAllowlistConfigured =
      isNonProductionRecipientAllowlistConfigured();
    return {
      processMode,
      processRole,
      consumerProcess,
      providerConfigured,
      payloadEncryptionConfigured,
      workerEnabled,
      nonProductionRecipientAllowlistConfigured,
      ready:
        consumerProcess &&
        providerConfigured &&
        payloadEncryptionConfigured &&
        workerEnabled &&
        nonProductionRecipientAllowlistConfigured,
    };
  }

  /** Processes at most one job and returns whether a row was claimed. */
  public async processOnce(): Promise<boolean> {
    if (
      !isMailConsumerProcess() ||
      process.env.SETI_MAIL_WORKER_ENABLED !== 'true' ||
      !this.provider.isConfigured() ||
      !this.payloadEncryptionConfigured ||
      !isNonProductionRecipientAllowlistConfigured() ||
      this.running ||
      this.stopping
    ) {
      return false;
    }
    this.running = true;
    const cycle = this.processCycle();
    this.activeCycle = cycle;
    try {
      return await cycle;
    } finally {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
      this.running = false;
    }
  }

  private async processCycle(): Promise<boolean> {
    if (Date.now() - this.lastPresenceSweepAt >= 15 * 60_000) {
      await this.foregroundPresence.clearExpired();
      await this.onlinePresence.clearExpired();
      this.lastPresenceSweepAt = Date.now();
    }
    // Expired rows may have no encrypted payload (for example, a reminder
    // that only contains safe template variables). Cancel them here so they
    // cannot remain claimable indefinitely.
    await this.outbox.cancelExpired();
    const job = await this.outbox.claimNext();
    if (!job) return false;
    await this.processClaimedJob(job);
    return true;
  }

  private async processClaimedJob(job: IClaimedMailJob): Promise<void> {
    if (!isEnabledMailKind(job.kind)) {
      await this.outbox.markCancelled(
        job.id,
        'mail_kind_disabled',
        job.leaseToken,
      );
      return;
    }
    if (!isRecipientAllowedForEnvironment(job.recipient)) {
      await this.outbox.markCancelled(
        job.id,
        'recipient_not_allowed_in_environment',
        job.leaseToken,
      );
      return;
    }
    const policy = await this.checkPolicy(job);
    if (!policy.allowed) {
      if (policy.retryAt) {
        await this.outbox.markRetry(
          job.id,
          job.leaseToken,
          policy.retryAt,
          policy.reason,
          policy.reason,
        );
      } else {
        await this.outbox.markCancelled(job.id, policy.reason, job.leaseToken);
      }
      return;
    }

    let sensitiveVariables: Record<string, string>;
    try {
      sensitiveVariables = this.outbox.decryptSensitivePayload(job);
    } catch (error) {
      await this.outbox.markDead(
        job.id,
        job.leaseToken,
        'payload_decrypt_failed',
        error instanceof Error ? error.message : 'Mail payload decrypt failed',
      );
      return;
    }

    const budget = job.userId
      ? await this.budget.reserve({
          userId: job.userId,
          kind: job.kind,
        })
      : await this.budget.reserveAnonymous({
          recipient: job.recipient,
          kind: job.kind,
        });
    if (!budget.allowed) {
      await this.outbox.markRetry(
        job.id,
        job.leaseToken,
        nextBudgetWindow(),
        'budget_exhausted',
        'Mail budget is exhausted',
      );
      return;
    }

    let coalesced = {
      variables: {},
      candidateIds: [] as string[],
    };
    if (job.kind === 'turn_reminder') {
      try {
        coalesced = await this.coalesceTurnReminders(job);
      } catch (error) {
        // A summary lookup must never strand the claimed primary row. The
        // primary reminder remains safe to send with its original variables.
        this.logger.warn(
          `turn reminder coalescing skipped for ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      let language: TUserLanguage | undefined;
      if (this.provider.provider === 'resend' && job.userId) {
        try {
          language = normalizeUserLanguage(
            (await this.preferences.get(job.userId)).language,
          );
        } catch (error) {
          throw new MailProviderError(
            'mail_language_unavailable',
            'Mail language preferences are unavailable',
            'retryable',
            { cause: error },
          );
        }
      }
      const accepted = await this.provider.sendTemplate({
        recipient: job.recipient,
        templateKey: job.templateKey,
        variables: {
          ...job.templateVariables,
          ...coalesced.variables,
          ...sensitiveVariables,
        },
        internalJobId: job.id,
        ...(language ? { language } : {}),
        channel: mailPolicyForKind(job.kind).channel,
        kind: job.kind === 'turn_reminder' ? 'notification' : 'transactional',
      });
      const fenced = await this.outbox.markAccepted(
        job.id,
        job.leaseToken,
        accepted.messageId,
        accepted.requestId,
      );
      if (fenced && coalesced.candidateIds.length > 0) {
        try {
          await this.outbox.settleCoalescedTurnReminders(
            coalesced.candidateIds,
            job.leaseToken,
            'accepted',
            `coalesced_into:${job.id}`,
          );
        } catch (error) {
          this.logger.error(
            `accepted turn reminder children could not be settled: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      const outcome = await this.handleProviderError(job, error);
      if (coalesced.candidateIds.length > 0) {
        await this.outbox.settleCoalescedTurnReminders(
          coalesced.candidateIds,
          job.leaseToken,
          outcome.settlement,
          outcome.reason,
          outcome.nextAttemptAt,
        );
      }
    }
  }

  private async coalesceTurnReminders(job: IClaimedMailJob): Promise<{
    variables: Record<string, string>;
    candidateIds: string[];
  }> {
    if (!job.userId || !job.gameId) {
      return { variables: {}, candidateIds: [] };
    }
    const primaryGame = {
      gameId: job.gameId,
      gameName: job.templateVariables.gameName ?? 'your game',
      actionUrl:
        job.templateVariables.actionUrl ?? buildGameActionUrl(job.gameId),
    };
    const candidates = await this.outbox.listCoalescibleTurnReminders(
      job,
      TURN_COALESCE_LIMIT,
    );
    const games = [primaryGame];
    const eligibleCandidates: ICoalescibleTurnReminder[] = [];
    const staleOrSuppressedIds: string[] = [];
    for (const candidate of candidates) {
      const policy = await this.checkPolicy(asPolicyJob(candidate, job));
      if (!policy.allowed) {
        if (!policy.retryAt) staleOrSuppressedIds.push(candidate.id);
        continue;
      }
      eligibleCandidates.push(candidate);
    }
    if (staleOrSuppressedIds.length > 0) {
      await this.outbox.cancelByIds(
        staleOrSuppressedIds,
        'coalesced_policy_rejected',
      );
    }
    if (eligibleCandidates.length === 0) {
      return { variables: {}, candidateIds: [] };
    }
    const allGamesActionUrl = buildAllGamesActionUrl();
    const reserved = await this.outbox.reserveCoalescibleTurnReminders(
      job,
      eligibleCandidates.map((candidate) => candidate.id),
    );
    if (reserved.length === 0) return { variables: {}, candidateIds: [] };
    const eligibleById = new Map(
      eligibleCandidates.map((candidate) => [candidate.id, candidate]),
    );
    const reservedGames = reserved.map((candidate) => ({
      gameId: candidate.gameId,
      gameName:
        candidate.templateVariables.gameName ??
        eligibleById.get(candidate.id)?.templateVariables.gameName ??
        'your game',
      actionUrl:
        candidate.templateVariables.actionUrl ??
        eligibleById.get(candidate.id)?.templateVariables.actionUrl ??
        buildGameActionUrl(candidate.gameId),
    }));
    games.push(...reservedGames);
    const summary = buildTurnReminderSummary(games, allGamesActionUrl);
    return {
      variables: summary.variables,
      candidateIds: reserved.map((candidate) => candidate.id),
    };
  }

  private async checkPolicy(job: IClaimedMailJob): Promise<{
    allowed: boolean;
    reason: string;
    retryAt?: Date;
  }> {
    const now = Date.now();
    if (job.expiresAt && job.expiresAt.getTime() <= now) {
      return { allowed: false, reason: 'expired' };
    }
    if (await this.suppression.isSuppressed(job.recipient, job.kind)) {
      return { allowed: false, reason: 'recipient_suppressed' };
    }

    const challengeKind = challengeKindForJob(job);
    if (!job.userId) {
      if (!challengeKind) {
        return { allowed: true, reason: 'ok' };
      }
      return this.checkChallengePolicy(job, challengeKind, null);
    }

    const [account] = await this.db
      .select({
        email: users.email,
        emailKey: users.emailKey,
        emailVersion: users.emailVersion,
        sessionVersion: users.sessionVersion,
        accountStatus: users.accountStatus,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, job.userId))
      .limit(1);
    if (!account) {
      return { allowed: false, reason: 'email_changed' };
    }
    if (account.accountStatus !== 'active') {
      return { allowed: false, reason: 'account_not_active' };
    }
    if (
      job.emailVersion !== null &&
      account.emailVersion !== job.emailVersion
    ) {
      return { allowed: false, reason: 'email_changed' };
    }
    const kind = job.kind as string;
    const isEmailChangeMail = challengeKind === 'email_change';
    const isSecurityNotice =
      kind === 'security_notice' || kind === 'account_security_notice';
    if (
      !isEmailChangeMail &&
      !isSecurityNotice &&
      account.email.trim().toLowerCase() !== job.recipient
    ) {
      return { allowed: false, reason: 'email_changed' };
    }
    if (challengeKind) {
      const challengePolicy = await this.checkChallengePolicy(
        job,
        challengeKind,
        account,
      );
      if (!challengePolicy.allowed) return challengePolicy;
    }
    if (job.kind === 'turn_reminder') {
      if (!can(toRole(account.role), ECapability.TURN_EMAIL_REMINDERS)) {
        return { allowed: false, reason: 'turn_reminder_not_entitled' };
      }
      const preferences = await this.preferences.get(job.userId);
      const preferenceRecord = preferences as unknown as Readonly<
        Record<string, unknown>
      >;
      if (!isTurnReminderEnabled(preferenceRecord)) {
        return { allowed: false, reason: 'turn_reminder_disabled' };
      }
      if (job.attentionEpoch === null) {
        return { allowed: false, reason: 'missing_attention_epoch' };
      }
      if (job.runtimeOwner === 'platform') {
        if (!job.sessionId || !this.nativeTargetResolver)
          return {
            allowed: false,
            reason: 'native_target_unavailable',
            retryAt: new Date(now + FOREGROUND_RETRY_MS),
          };
        const snapshot = await this.nativeTargetResolver(job);
        if (snapshot) {
          try {
            assertNotificationTarget(snapshot.target);
          } catch {
            return { allowed: false, reason: 'action_no_longer_required' };
          }
        }
        if (
          !snapshot ||
          snapshot.target.runtimeOwner !== 'platform' ||
          snapshot.target.sessionId !== job.sessionId ||
          snapshot.status !== 'active' ||
          !snapshot.actionablePrincipalIds.includes(job.userId)
        )
          return { allowed: false, reason: 'action_no_longer_required' };
        const cursorResult = await this.db.execute(sql`
          SELECT attention_epoch AS "attentionEpoch", actionable
          FROM platform_notification_cursors
          WHERE session_id = ${job.sessionId}
            AND user_id = ${job.userId}::uuid
          LIMIT 1
        `);
        const cursor = cursorResult.rows[0] as
          | { attentionEpoch?: number; actionable?: boolean }
          | undefined;
        if (
          !cursor ||
          cursor.actionable !== true ||
          cursor.attentionEpoch !== job.attentionEpoch
        )
          return { allowed: false, reason: 'action_no_longer_required' };
        if (await this.suppression.isTargetMuted(job.userId, snapshot.target))
          return { allowed: false, reason: 'game_muted' };
        const rateLimitRetryAt = await this.turnRateLimitRetryAt(job);
        if (rateLimitRetryAt)
          return {
            allowed: false,
            reason: 'turn_rate_limited',
            retryAt: rateLimitRetryAt,
          };
        try {
          if (await this.onlinePresence.isOnline(job.userId)) {
            return {
              allowed: false,
              reason: 'user_online',
              retryAt: new Date(now + FOREGROUND_RETRY_MS),
            };
          }
        } catch {
          return {
            allowed: false,
            reason: 'online_presence_unavailable',
            retryAt: new Date(now + FOREGROUND_RETRY_MS),
          };
        }
        let foregroundActive = false;
        try {
          foregroundActive = await this.targetForegroundResolver(
            job.userId,
            snapshot.target,
          );
        } catch {
          return {
            allowed: false,
            reason: 'foreground_presence_unavailable',
            retryAt: new Date(now + FOREGROUND_RETRY_MS),
          };
        }
        if (foregroundActive)
          return {
            allowed: false,
            reason: 'foreground_active',
            retryAt: new Date(now + FOREGROUND_RETRY_MS),
          };
        const quietUntil = quietHoursRetryAt(preferenceRecord, new Date(now));
        if (quietUntil)
          return { allowed: false, reason: 'quiet_hours', retryAt: quietUntil };
        return { allowed: true, reason: 'ok' };
      }
      if (!job.gameId) {
        return { allowed: false, reason: 'turn_reminder_disabled' };
      }
      if (await this.suppression.isGameMuted(job.userId, job.gameId)) {
        return { allowed: false, reason: 'game_muted' };
      }
      const legacyPolicy = await this.gamePolicies.legacyAction(this.db, job);
      if (!legacyPolicy.allowed) return legacyPolicy;
      try {
        if (await this.onlinePresence.isOnline(job.userId)) {
          return {
            allowed: false,
            reason: 'user_online',
            retryAt: new Date(now + FOREGROUND_RETRY_MS),
          };
        }
      } catch {
        this.logger.warn(
          'Online presence lookup failed; turn reminder deferred',
        );
        return {
          allowed: false,
          reason: 'online_presence_unavailable',
          retryAt: new Date(now + FOREGROUND_RETRY_MS),
        };
      }
      const rateLimitRetryAt = await this.turnRateLimitRetryAt(job);
      if (rateLimitRetryAt) {
        return {
          allowed: false,
          reason: 'turn_rate_limited',
          retryAt: rateLimitRetryAt,
        };
      }
      let foregroundActive = false;
      try {
        foregroundActive = await this.foregroundResolver(
          job.userId,
          job.gameId,
        );
      } catch (error) {
        this.logger.warn(
          `foreground presence check failed for ${job.gameId}/${job.userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          allowed: false,
          reason: 'foreground_presence_unavailable',
          retryAt: new Date(now + FOREGROUND_RETRY_MS),
        };
      }
      if (foregroundActive) {
        return {
          allowed: false,
          reason: 'foreground_active',
          retryAt: new Date(now + FOREGROUND_RETRY_MS),
        };
      }
      const quietUntil = quietHoursRetryAt(preferenceRecord, new Date(now));
      if (quietUntil) {
        return { allowed: false, reason: 'quiet_hours', retryAt: quietUntil };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  private async turnRateLimitRetryAt(
    job: IClaimedMailJob,
  ): Promise<Date | undefined> {
    if (
      job.kind !== 'turn_reminder' ||
      !job.userId ||
      (job.runtimeOwner === 'legacy' && !job.gameId) ||
      (job.runtimeOwner === 'platform' && !job.sessionId)
    ) {
      return undefined;
    }
    const result =
      job.runtimeOwner === 'platform'
        ? await this.db.execute(sql`
            SELECT provider_sent_at AS "providerSentAt"
            FROM mail_outbox
            WHERE user_id = ${job.userId}::uuid
              AND runtime_owner = 'platform'
              AND session_id = ${job.sessionId}
              AND kind = 'turn_reminder'
              AND status IN ('accepted', 'unknown')
              AND provider_sent_at > clock_timestamp() - interval '30 minutes'
            ORDER BY provider_sent_at DESC
            LIMIT 1
          `)
        : await this.db.execute(sql`
            SELECT provider_sent_at AS "providerSentAt"
            FROM mail_outbox
            WHERE user_id = ${job.userId}::uuid
              AND runtime_owner = 'legacy'
              AND game_id = ${job.gameId}::uuid
              AND kind = 'turn_reminder'
              AND status IN ('accepted', 'unknown')
              AND provider_sent_at > clock_timestamp() - interval '30 minutes'
            ORDER BY provider_sent_at DESC
            LIMIT 1
          `);
    const sentAt = result.rows[0]?.providerSentAt;
    const retryAt = dateFromUnknown(sentAt);
    if (!retryAt) return undefined;
    return new Date(
      Math.max(retryAt.getTime() + 30 * 60_000, Date.now() + 1000),
    );
  }

  private async checkChallengePolicy(
    job: IClaimedMailJob,
    kind: TChallengeKind,
    account: {
      email: string;
      emailKey: string;
      emailVersion: number;
      sessionVersion: number;
    } | null,
  ): Promise<{ allowed: boolean; reason: string }> {
    const challengeId = extractChallengeId(job);
    if (!challengeId) {
      return { allowed: false, reason: 'challenge_missing' };
    }
    if (kind === 'migration_email') {
      return this.checkMigrationChallengePolicy(job, challengeId);
    }
    const result = await this.db.execute(sql`
      SELECT
        c.id,
        c.purpose,
        c.user_id AS "userId",
        c.email_key AS "emailKey",
        c.email_version AS "emailVersion",
        c.session_version AS "sessionVersion",
        c.expires_at AS "expiresAt",
        c.consumed_at AS "consumedAt",
        c.invalidated_at AS "invalidatedAt",
        c.draft_id AS "draftId",
        d.email_key AS "draftEmailKey",
        d.status AS "draftStatus",
        d.expires_at AS "draftExpiresAt"
      FROM auth_challenges AS c
      LEFT JOIN registration_drafts AS d ON d.id = c.draft_id
      WHERE c.id = ${challengeId}::uuid
      LIMIT 1
    `);
    const challenge = result.rows[0] as
      | {
          purpose?: string;
          userId?: string | null;
          emailKey?: string;
          emailVersion?: number | null;
          sessionVersion?: number | null;
          expiresAt?: Date | string;
          consumedAt?: Date | string | null;
          invalidatedAt?: Date | string | null;
          draftId?: string | null;
          draftEmailKey?: string | null;
          draftStatus?: string | null;
          draftExpiresAt?: Date | string | null;
        }
      | undefined;
    if (
      !challenge ||
      challenge.purpose !== expectedChallengePurpose(kind) ||
      !challenge.expiresAt ||
      new Date(challenge.expiresAt).getTime() <= Date.now() ||
      challenge.consumedAt ||
      challenge.invalidatedAt
    ) {
      return { allowed: false, reason: 'challenge_invalid' };
    }

    if (kind === 'registration_email') {
      const recipient = job.recipient;
      if (
        !challenge.draftId ||
        challenge.draftStatus !== 'email_pending' ||
        !challenge.draftEmailKey ||
        challenge.draftEmailKey !== challenge.emailKey ||
        challenge.draftExpiresAt === null ||
        challenge.draftExpiresAt === undefined ||
        new Date(challenge.draftExpiresAt).getTime() <= Date.now() ||
        challenge.emailKey !== recipient
      ) {
        return { allowed: false, reason: 'challenge_email_changed' };
      }
      return { allowed: true, reason: 'ok' };
    }

    if (!account || challenge.userId !== job.userId) {
      return { allowed: false, reason: 'challenge_user_changed' };
    }
    if (
      (challenge.emailVersion !== null &&
        challenge.emailVersion !== undefined &&
        challenge.emailVersion !== account.emailVersion) ||
      (challenge.sessionVersion !== null &&
        challenge.sessionVersion !== undefined &&
        challenge.sessionVersion !== account.sessionVersion)
    ) {
      return { allowed: false, reason: 'challenge_version_changed' };
    }
    if (kind === 'password_reset') {
      if (
        challenge.emailKey !== account.emailKey ||
        challenge.emailKey !== job.recipient
      ) {
        return { allowed: false, reason: 'challenge_email_changed' };
      }
    } else if (kind === 'email_change') {
      if (challenge.emailKey !== job.recipient) {
        return { allowed: false, reason: 'challenge_email_changed' };
      }
    }
    return { allowed: true, reason: 'ok' };
  }

  private checkMigrationChallengePolicy(
    job: IClaimedMailJob,
    challengeId: string,
  ): Promise<{ allowed: boolean; reason: string }> {
    return this.gamePolicies.migrationChallenge(this.db, job, challengeId);
  }

  private async handleProviderError(
    job: IClaimedMailJob,
    error: unknown,
  ): Promise<{
    settlement: 'unknown' | 'retry_wait' | 'dead';
    reason: string;
    nextAttemptAt?: Date;
  }> {
    const providerError =
      error instanceof MailProviderError
        ? error
        : new MailProviderError(
            'provider_unknown',
            'Mail provider outcome is unknown',
            'unknown',
            { cause: error },
          );
    const channelPolicy = mailPolicyForKind(job.kind);
    const failureAction = mailFailureActionForChannel(
      channelPolicy.channel,
      providerError.disposition,
    );
    if (providerError.disposition === 'suppressed') {
      await this.suppression.suppressFromProvider(
        job.recipient,
        providerError.code,
        this.provider.provider,
      );
      await this.outbox.markDead(
        job.id,
        job.leaseToken,
        providerError.code,
        providerError.message,
      );
      return { settlement: 'dead', reason: providerError.message };
    }
    if (failureAction === 'unknown') {
      await this.outbox.markUnknown(
        job.id,
        job.leaseToken,
        providerError.code,
        providerError.message,
      );
      return { settlement: 'unknown', reason: providerError.message };
    }
    const maxAttempts = Math.min(
      job.maxAttempts,
      channelPolicy.failure.maxAttempts,
    );
    if (failureAction === 'dead' || job.attemptCount >= maxAttempts) {
      await this.outbox.markDead(
        job.id,
        job.leaseToken,
        providerError.code,
        providerError.message,
      );
      return { settlement: 'dead', reason: providerError.message };
    }
    const retryAt = new Date(
      Date.now() + retryDelayMs(job.attemptCount, DEFAULT_RETRY_BASE_MS),
    );
    await this.outbox.markRetry(
      job.id,
      job.leaseToken,
      retryAt,
      providerError.code,
      providerError.message,
    );
    return {
      settlement: 'retry_wait',
      reason: providerError.message,
      nextAttemptAt: retryAt,
    };
  }
}

function isTurnReminderEnabled(
  preferences: Readonly<Record<string, unknown>>,
): boolean {
  return preferences.emailTurnRemindersEnabled === true;
}

function asPolicyJob(
  candidate: ICoalescibleTurnReminder,
  primary: IClaimedMailJob,
): IClaimedMailJob {
  return {
    ...candidate,
    challengeId: null,
    sensitivePayloadCiphertext: null,
    sensitivePayloadNonce: null,
    sensitivePayloadTag: null,
    sensitivePayloadKeyVersion: null,
    leaseToken: primary.leaseToken,
    providerMessageId: null,
    providerRequestId: null,
  };
}

function buildGameActionUrl(gameId: string): string {
  return new URL(
    `/game/${encodeURIComponent(gameId)}`,
    getRuntimeConfig().server.publicOrigin,
  ).toString();
}

function buildAllGamesActionUrl(): string {
  return new URL(
    '/my-games',
    getRuntimeConfig().server.publicOrigin,
  ).toString();
}

export function isRecipientAllowedForEnvironment(
  recipient: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.NODE_ENV === 'production') return true;
  const normalized = recipient.trim().toLowerCase();
  const allowed = (env.SETI_MAIL_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(normalized);
}

function isNonProductionRecipientAllowlistConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env.NODE_ENV === 'production') return true;
  return (env.SETI_MAIL_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .some((item) => item.trim().length > 0);
}

function hasPayloadEncryptionKey(): boolean {
  try {
    return MailPayloadCipher.fromEnvironment() !== undefined;
  } catch {
    return false;
  }
}

function dateFromUnknown(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

type TChallengeKind =
  | 'registration_email'
  | 'password_reset'
  | 'email_change'
  | 'migration_email';

function challengeKindForJob(job: IClaimedMailJob): TChallengeKind | null {
  const kind = job.kind as string;
  const templateKey = job.templateKey as string;
  if (job.dedupeKey.startsWith('migration-email-challenge:')) {
    return 'migration_email';
  }
  if (
    kind === 'account_verification' ||
    templateKey === 'verify_email' ||
    templateKey === 'registration-email-verification'
  ) {
    return 'registration_email';
  }
  if (
    kind === 'password_recovery' ||
    templateKey === 'reset_password' ||
    templateKey === 'password-recovery'
  ) {
    return 'password_reset';
  }
  if (
    kind === 'email_change_verification' ||
    kind === 'account_email_change' ||
    templateKey === 'email_change_verify' ||
    templateKey === 'email-change-verification'
  ) {
    return 'email_change';
  }
  return null;
}

function expectedChallengePurpose(kind: TChallengeKind): string {
  return kind;
}

function extractChallengeId(job: IClaimedMailJob): string | null {
  if (job.challengeId && UUID_PATTERN.test(job.challengeId)) {
    return job.challengeId;
  }
  const dedupeParts = job.dedupeKey.split(':');
  const candidate = dedupeParts.at(-1);
  return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
}

export function retryDelayMs(
  attemptCount: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  const backoff = Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** exponent);
  const jitter = Math.floor(backoff * 0.1 * Math.random());
  return Math.min(MAX_RETRY_DELAY_MS, backoff + jitter);
}

function nextBudgetWindow(): Date {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

function quietHoursRetryAt(
  preferences: Readonly<Record<string, unknown>>,
  now: Date,
): Date | undefined {
  const quiet = preferences.emailQuietHours;
  if (
    typeof quiet !== 'object' ||
    quiet === null ||
    typeof (quiet as { start?: unknown }).start !== 'string' ||
    typeof (quiet as { end?: unknown }).end !== 'string'
  ) {
    return undefined;
  }
  const zone =
    typeof (quiet as { timezone?: unknown }).timezone === 'string'
      ? (quiet as { timezone: string }).timezone
      : 'UTC';
  const minutes = localMinutes(now, zone);
  if (minutes === null) return undefined;
  const start = parseClock((quiet as { start: string }).start);
  const end = parseClock((quiet as { end: string }).end);
  if (start === null || end === null || !isInQuietRange(minutes, start, end)) {
    return undefined;
  }
  const next = new Date(now.getTime() + 15 * 60_000);
  for (let i = 0; i < 24 * 4 + 1; i += 1) {
    const nextMinutes = localMinutes(next, zone);
    if (nextMinutes !== null && !isInQuietRange(nextMinutes, start, end)) {
      return next;
    }
    next.setTime(next.getTime() + 15 * 60_000);
  }
  return new Date(now.getTime() + 60 * 60_000);
}

function localMinutes(date: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute)
      ? hour * 60 + minute
      : null;
  } catch {
    return null;
  }
}

function parseClock(value: string): number | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  if (!match) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function isInQuietRange(minutes: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}
