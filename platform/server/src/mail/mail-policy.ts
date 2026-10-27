import type { TMailKind } from '@/persistence/schema/mailOutbox.js';
import type { TMailProviderDisposition } from './mail-provider.js';

/** The product-facing delivery lanes used by mail budgets and queue order. */
export const MAIL_CHANNELS = [
  'account_critical',
  'security',
  'turn_reminder',
] as const;
export type TMailChannel = (typeof MAIL_CHANNELS)[number];

export type TMailFailureAction = 'retry' | 'unknown' | 'dead';

export interface IMailFailurePolicy {
  /** Maximum provider attempts before a retryable error becomes terminal. */
  maxAttempts: number;
  retryable: TMailFailureAction;
  unknown: TMailFailureAction;
  permanent: TMailFailureAction;
  suppressed: TMailFailureAction;
  configuration: TMailFailureAction;
}

export interface IMailChannelPolicy {
  channel: TMailChannel;
  /** Higher values are claimed before lower priority lanes. */
  priority: number;
  /** Whether this lane consumes the global account-critical reserve. */
  usesAccountReserve: boolean;
  failure: IMailFailurePolicy;
}

/**
 * Mail policy is intentionally code-owned. These values describe delivery
 * behavior; the daily counts are supplied by MailBudgetService configuration.
 */
export const MAIL_CHANNEL_POLICIES: Readonly<
  Record<TMailChannel, IMailChannelPolicy>
> = {
  account_critical: {
    channel: 'account_critical',
    priority: 300,
    usesAccountReserve: true,
    failure: {
      maxAttempts: 5,
      retryable: 'retry',
      unknown: 'unknown',
      permanent: 'dead',
      suppressed: 'dead',
      configuration: 'unknown',
    },
  },
  security: {
    channel: 'security',
    priority: 200,
    usesAccountReserve: false,
    failure: {
      maxAttempts: 3,
      retryable: 'retry',
      unknown: 'unknown',
      permanent: 'dead',
      suppressed: 'dead',
      configuration: 'unknown',
    },
  },
  turn_reminder: {
    channel: 'turn_reminder',
    priority: 100,
    usesAccountReserve: false,
    failure: {
      maxAttempts: 2,
      retryable: 'retry',
      // A turn opportunity is allowed to expire when the provider outcome is
      // unknown; the next attention epoch can create a fresh reminder.
      unknown: 'dead',
      permanent: 'dead',
      suppressed: 'dead',
      configuration: 'unknown',
    },
  },
};

const MAIL_KIND_CHANNELS: Readonly<Record<TMailKind, TMailChannel>> = {
  account_verification: 'account_critical',
  password_recovery: 'account_critical',
  email_change_verification: 'account_critical',
  security_notice: 'security',
  migration_completed: 'security',
  turn_reminder: 'turn_reminder',
};

const ENABLED_MAIL_KINDS: ReadonlySet<TMailKind> = new Set([
  'password_recovery',
  'email_change_verification',
  'turn_reminder',
]);

export function isEnabledMailKind(kind: TMailKind): boolean {
  return ENABLED_MAIL_KINDS.has(kind);
}

export function mailChannelForKind(kind: TMailKind | string): TMailChannel {
  const channel = (MAIL_KIND_CHANNELS as Record<string, TMailChannel>)[kind];
  if (!channel) throw new Error(`Unsupported mail kind: ${kind}`);
  return channel;
}

export function mailPolicyForKind(
  kind: TMailKind | string,
): IMailChannelPolicy {
  return MAIL_CHANNEL_POLICIES[mailChannelForKind(kind)];
}

export function mailPolicyForChannel(
  channel: TMailChannel,
): IMailChannelPolicy {
  return MAIL_CHANNEL_POLICIES[channel];
}

export function mailFailureActionForChannel(
  channel: TMailChannel,
  disposition: TMailProviderDisposition,
): TMailFailureAction {
  const policy = mailPolicyForChannel(channel).failure;
  if (disposition === 'retryable') return policy.retryable;
  if (disposition === 'unknown') return policy.unknown;
  if (disposition === 'permanent') return policy.permanent;
  if (disposition === 'suppressed') return policy.suppressed;
  return policy.configuration;
}
