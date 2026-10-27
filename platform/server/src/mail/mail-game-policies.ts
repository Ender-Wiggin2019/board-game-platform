import { Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { NativeNotificationSnapshot } from '../notifications/notification-target.js';
import type { IClaimedMailJob } from './mail-outbox.repository.js';

export interface LegacyReminderGame {
  readonly name: string | null;
  readonly eligible: boolean;
}
export interface MailPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}
export interface MailGamePolicies {
  readonly legacyReminder?: (
    database: NodePgDatabase,
    gameId: string,
    userId: string,
  ) => Promise<LegacyReminderGame | null>;
  readonly legacyAction?: (
    database: NodePgDatabase,
    job: IClaimedMailJob,
  ) => Promise<MailPolicyDecision>;
  readonly nativeTarget?: (
    job: IClaimedMailJob,
  ) => Promise<NativeNotificationSnapshot | null>;
  readonly migrationChallenge?: (
    database: NodePgDatabase,
    job: IClaimedMailJob,
    challengeId: string,
  ) => Promise<MailPolicyDecision>;
}

/** The delivery worker owns retries and account policy; games own action relevance. */
@Injectable()
export class MailGamePolicyRegistry {
  private readonly policies = new Map<string, MailGamePolicies>();
  register(gameId: string, policy: MailGamePolicies): void {
    if (this.policies.has(gameId))
      throw new Error(`Mail game policy already registered: ${gameId}`);
    if (
      [...this.policies.values()].some(
        (existing) =>
          (existing.legacyReminder && policy.legacyReminder) ||
          (existing.legacyAction && policy.legacyAction) ||
          (existing.migrationChallenge && policy.migrationChallenge),
      )
    )
      throw new Error('Legacy mail ownership already registered');
    this.policies.set(gameId, policy);
  }
  async legacyReminder(
    database: NodePgDatabase,
    gameId: string,
    userId: string,
  ): Promise<LegacyReminderGame | null> {
    const owner = [...this.policies.values()].find(
      (policy) => policy.legacyReminder,
    );
    return owner?.legacyReminder?.(database, gameId, userId) ?? null;
  }
  async legacyAction(
    database: NodePgDatabase,
    job: IClaimedMailJob,
  ): Promise<MailPolicyDecision> {
    const owner = [...this.policies.values()].find(
      (policy) => policy.legacyAction,
    );
    return (
      owner?.legacyAction?.(database, job) ?? {
        allowed: false,
        reason: 'action_no_longer_required',
      }
    );
  }
  async nativeTarget(
    job: IClaimedMailJob,
  ): Promise<NativeNotificationSnapshot | null> {
    for (const policy of this.policies.values()) {
      const snapshot = await policy.nativeTarget?.(job);
      if (snapshot) return snapshot;
    }
    return null;
  }
  async migrationChallenge(
    database: NodePgDatabase,
    job: IClaimedMailJob,
    challengeId: string,
  ): Promise<MailPolicyDecision> {
    const owner = [...this.policies.values()].find(
      (policy) => policy.migrationChallenge,
    );
    return (
      owner?.migrationChallenge?.(database, job, challengeId) ?? {
        allowed: false,
        reason: 'challenge_invalid',
      }
    );
  }
}
