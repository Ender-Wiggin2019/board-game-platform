import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TMailKind } from '@/persistence/schema/mailOutbox.js';
import { mailPolicyForKind, type TMailChannel } from './mail-policy.js';
import { normalizeRecipient } from './mail-provider.js';

export interface IMailBudgetConfig {
  globalDailyLimit: number;
  /** Units reserved for account-critical mail before lower-priority channels. */
  globalAccountReserve: number;
  /** Per-account (or anonymous recipient) account-critical daily limit. */
  accountCriticalDailyLimit: number;
  /** Per-account (or anonymous recipient) security-mail daily limit. */
  securityDailyLimit: number;
  turnReminderDailyLimit: number;
}

export interface IMailBudgetReservation {
  allowed: boolean;
  costUnits: number;
}

const DEFAULT_BUDGET_CONFIG: IMailBudgetConfig = {
  globalDailyLimit: 10_000,
  globalAccountReserve: 2_000,
  accountCriticalDailyLimit: 20,
  securityDailyLimit: 20,
  turnReminderDailyLimit: 5,
};

const MAX_TURN_REMINDERS_PER_USER_PER_DAY = 5;

interface IResolvedMailBudgetConfig {
  globalDailyLimit: number;
  globalAccountReserve: number;
  channelDailyLimits: Readonly<Record<TMailChannel, number>>;
}

/** Atomically reserves a unit from both the global and per-user daily caps. */
export class MailBudgetService {
  private readonly config: IResolvedMailBudgetConfig;

  public constructor(
    private readonly db: NodePgDatabase,
    config: IMailBudgetConfig = loadMailBudgetConfig(),
  ) {
    if (config.globalAccountReserve > config.globalDailyLimit) {
      throw new Error('Mail account reserve cannot exceed the global limit');
    }
    this.config = {
      globalDailyLimit: positiveIntegerValue(
        config.globalDailyLimit,
        'globalDailyLimit',
      ),
      globalAccountReserve: positiveIntegerValue(
        config.globalAccountReserve,
        'globalAccountReserve',
      ),
      channelDailyLimits: {
        account_critical: positiveIntegerValue(
          config.accountCriticalDailyLimit,
          'accountCriticalDailyLimit',
        ),
        security: positiveIntegerValue(
          config.securityDailyLimit,
          'securityDailyLimit',
        ),
        turn_reminder: Math.min(
          MAX_TURN_REMINDERS_PER_USER_PER_DAY,
          positiveIntegerValue(
            config.turnReminderDailyLimit,
            'turnReminderDailyLimit',
          ),
        ),
      },
    };
  }

  public async reserve(input: {
    userId: string;
    kind: TMailKind;
    costUnits?: number;
    now?: Date;
  }): Promise<IMailBudgetReservation> {
    const policy = mailPolicyForKind(input.kind);
    return this.reserveScoped({
      scope: channelScope('user', policy.channel),
      scopeKey: input.userId,
      kind: input.kind,
      limit: this.config.channelDailyLimits[policy.channel],
      costUnits: input.costUnits,
      now: input.now,
    });
  }

  /** Reserves account mail without a user ID by recipient. */
  public async reserveAnonymous(input: {
    recipient: string;
    kind: TMailKind;
    costUnits?: number;
    now?: Date;
  }): Promise<IMailBudgetReservation> {
    const policy = mailPolicyForKind(input.kind);
    return this.reserveScoped({
      scope: channelScope('recipient', policy.channel),
      scopeKey: protectedRecipientKey(input.recipient),
      kind: input.kind,
      limit: this.config.channelDailyLimits[policy.channel],
      costUnits: input.costUnits,
      now: input.now,
    });
  }

  private async reserveScoped(input: {
    scope: string;
    scopeKey: string;
    kind: TMailKind;
    limit: number;
    costUnits?: number;
    now?: Date;
  }): Promise<IMailBudgetReservation> {
    const costUnits = input.costUnits ?? 1;
    if (!Number.isInteger(costUnits) || costUnits <= 0) {
      throw new Error('Mail budget cost must be a positive integer');
    }
    const now = input.now ?? new Date();
    const windowStart = utcDayStart(now);

    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as NodePgDatabase;
      const globalAllowed = await reserveBucket(
        tx,
        'global',
        'all',
        windowStart,
        this.config.globalDailyLimit,
        costUnits,
      );
      if (!globalAllowed) return { allowed: false, costUnits };

      const policy = mailPolicyForKind(input.kind);
      const globalSubScope = policy.usesAccountReserve
        ? 'global_account'
        : 'global_turn';
      const globalSubLimit = policy.usesAccountReserve
        ? this.config.globalDailyLimit
        : this.config.globalDailyLimit - this.config.globalAccountReserve;
      const globalSubAllowed = await reserveBucket(
        tx,
        globalSubScope,
        'all',
        windowStart,
        globalSubLimit,
        costUnits,
      );
      if (!globalSubAllowed) {
        await releaseBucket(tx, 'global', 'all', windowStart, costUnits);
        return { allowed: false, costUnits };
      }

      const scopedAllowed = await reserveBucket(
        tx,
        input.scope,
        input.scopeKey,
        windowStart,
        input.limit,
        costUnits,
      );
      if (scopedAllowed) return { allowed: true, costUnits };

      // The transaction is still open, so release both global reservations
      // when the narrower per-user/recipient bucket rejects the mail.
      await releaseBucket(tx, globalSubScope, 'all', windowStart, costUnits);
      await releaseBucket(tx, 'global', 'all', windowStart, costUnits);
      return { allowed: false, costUnits };
    });
  }
}

export function loadMailBudgetConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IMailBudgetConfig {
  const globalDailyLimit = positiveInteger(
    env.SETI_MAIL_GLOBAL_DAILY_LIMIT,
    DEFAULT_BUDGET_CONFIG.globalDailyLimit,
  );
  return {
    globalDailyLimit,
    globalAccountReserve: positiveInteger(
      env.SETI_MAIL_GLOBAL_ACCOUNT_RESERVE,
      Math.min(DEFAULT_BUDGET_CONFIG.globalAccountReserve, globalDailyLimit),
    ),
    accountCriticalDailyLimit: positiveInteger(
      env.SETI_MAIL_ACCOUNT_CRITICAL_DAILY_LIMIT,
      DEFAULT_BUDGET_CONFIG.accountCriticalDailyLimit,
    ),
    securityDailyLimit: positiveInteger(
      env.SETI_MAIL_SECURITY_DAILY_LIMIT,
      DEFAULT_BUDGET_CONFIG.securityDailyLimit,
    ),
    turnReminderDailyLimit: Math.min(
      MAX_TURN_REMINDERS_PER_USER_PER_DAY,
      positiveInteger(
        env.SETI_MAIL_TURN_DAILY_LIMIT,
        DEFAULT_BUDGET_CONFIG.turnReminderDailyLimit,
      ),
    ),
  };
}

function channelScope(
  subject: 'user' | 'recipient',
  channel: TMailChannel,
): string {
  return `${subject}_${channel}`;
}

async function reserveBucket(
  db: NodePgDatabase,
  scope: string,
  scopeKey: string,
  windowStart: Date,
  limitUnits: number,
  costUnits: number,
): Promise<boolean> {
  if (costUnits > limitUnits) return false;
  const result = await db.execute(sql`
    INSERT INTO mail_budget_buckets (
      scope, scope_key, window_start, limit_units, used_units, updated_at
    )
    VALUES (
      ${scope}, ${scopeKey}, ${windowStart}, ${limitUnits}, ${costUnits}, clock_timestamp()
    )
    ON CONFLICT (scope, scope_key, window_start)
    DO UPDATE SET
      limit_units = least(mail_budget_buckets.limit_units, EXCLUDED.limit_units),
      used_units = mail_budget_buckets.used_units + ${costUnits},
      updated_at = clock_timestamp()
    WHERE mail_budget_buckets.used_units + ${costUnits} <=
      least(mail_budget_buckets.limit_units, EXCLUDED.limit_units)
    RETURNING scope
  `);
  return result.rows.length > 0;
}

async function releaseBucket(
  db: NodePgDatabase,
  scope: string,
  scopeKey: string,
  windowStart: Date,
  costUnits: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE mail_budget_buckets
    SET used_units = greatest(used_units - ${costUnits}, 0),
        updated_at = clock_timestamp()
    WHERE scope = ${scope}
      AND scope_key = ${scopeKey}
      AND window_start = ${windowStart}
  `);
}

function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('Mail budget values must be positive integers');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Mail budget values must be positive integers');
  }
  return parsed;
}

function positiveIntegerValue(value: number | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Mail budget ${name} must be a positive integer`);
  }
  return value;
}

export function protectedRecipientKey(
  recipient: string,
  secret?: string,
): string {
  const resolvedSecret =
    nonEmptySecret(secret) ??
    nonEmptySecret(process.env.SETI_MAIL_BUDGET_HASH_SECRET) ??
    nonEmptySecret(process.env.SETI_MAIL_PAYLOAD_ENCRYPTION_KEY);
  if (!resolvedSecret) {
    throw new Error(
      'SETI_MAIL_BUDGET_HASH_SECRET or SETI_MAIL_PAYLOAD_ENCRYPTION_KEY is required for anonymous mail budgets',
    );
  }
  return createHmac('sha256', resolvedSecret)
    .update(normalizeRecipient(recipient))
    .digest('hex');
}

function nonEmptySecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? value : undefined;
}
