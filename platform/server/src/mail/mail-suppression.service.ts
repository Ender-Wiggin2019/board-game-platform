import { Inject, Injectable } from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { currentAuditRequestId } from '@/auth/account-audit-request.js';
import {
  assertNotificationTarget,
  type NotificationTarget,
} from '@/notifications/notification-target.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import { accountSecurityEvents } from '@/persistence/schema/accountSecurity.js';
import {
  mailSuppressions,
  mailTurnMutes,
  platformMailTurnMutes,
  type TMailKind,
} from '@/persistence/schema/mailOutbox.js';
import { normalizeRecipient } from './mail-provider.js';

export type TMailSuppressionCategory = 'all' | TMailKind;

@Injectable()
export class MailSuppressionService {
  public constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  public async isSuppressed(
    recipient: string,
    category: TMailSuppressionCategory,
  ): Promise<boolean> {
    const normalized = normalizeRecipient(recipient);
    const [row] = await this.db
      .select({ id: mailSuppressions.id })
      .from(mailSuppressions)
      .where(
        and(
          sql`lower(${mailSuppressions.recipient}) = ${normalized}`,
          or(
            eq(mailSuppressions.category, 'all'),
            eq(mailSuppressions.category, category),
          ),
          or(
            sql`${mailSuppressions.expiresAt} IS NULL`,
            sql`${mailSuppressions.expiresAt} > clock_timestamp()`,
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async isGameMuted(userId: string, gameId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: mailTurnMutes.userId })
      .from(mailTurnMutes)
      .where(
        and(
          eq(mailTurnMutes.userId, userId),
          eq(mailTurnMutes.gameId, gameId),
          or(
            sql`${mailTurnMutes.mutedUntil} IS NULL`,
            sql`${mailTurnMutes.mutedUntil} > clock_timestamp()`,
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async muteGame(
    userId: string,
    gameId: string,
    mutedUntil?: Date | null,
  ): Promise<void> {
    const run = async (tx: NodePgDatabase): Promise<void> => {
      await tx.execute(sql`
        INSERT INTO mail_turn_mutes (user_id, game_id, muted_until)
        VALUES (${userId}::uuid, ${gameId}::uuid, ${mutedUntil ?? null})
        ON CONFLICT (user_id, game_id)
        DO UPDATE SET
          muted_until = EXCLUDED.muted_until,
          updated_at = clock_timestamp()
      `);
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'turn_email_game_muted',
        requestId: currentAuditRequestId(),
        context: { gameId, mutedUntil: mutedUntil?.toISOString() ?? null },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async unmuteGame(userId: string, gameId: string): Promise<void> {
    const run = async (tx: NodePgDatabase): Promise<void> => {
      await tx.execute(sql`
        DELETE FROM mail_turn_mutes
        WHERE user_id = ${userId}::uuid
          AND game_id = ${gameId}::uuid
      `);
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'turn_email_game_unmuted',
        requestId: currentAuditRequestId(),
        context: { gameId },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async isTargetMuted(
    userId: string,
    target: NotificationTarget,
  ): Promise<boolean> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy')
      return this.isGameMuted(userId, target.legacyGameId as string);
    const [row] = await this.db
      .select({ userId: platformMailTurnMutes.userId })
      .from(platformMailTurnMutes)
      .where(
        and(
          eq(platformMailTurnMutes.userId, userId),
          eq(platformMailTurnMutes.sessionId, target.sessionId as string),
          or(
            sql`${platformMailTurnMutes.mutedUntil} IS NULL`,
            sql`${platformMailTurnMutes.mutedUntil} > clock_timestamp()`,
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async muteTarget(
    userId: string,
    target: NotificationTarget,
    mutedUntil?: Date | null,
  ): Promise<void> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy') {
      await this.muteGame(userId, target.legacyGameId as string, mutedUntil);
      return;
    }
    const run = async (tx: NodePgDatabase): Promise<void> => {
      await tx.execute(sql`
        INSERT INTO platform_mail_turn_mutes (user_id, session_id, muted_until)
        VALUES (${userId}::uuid, ${target.sessionId}, ${mutedUntil ?? null})
        ON CONFLICT (user_id, session_id)
        DO UPDATE SET
          muted_until = EXCLUDED.muted_until,
          updated_at = clock_timestamp()
      `);
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'turn_email_session_muted',
        requestId: currentAuditRequestId(),
        context: {
          runtimeOwner: 'platform',
          sessionId: target.sessionId,
          mutedUntil: mutedUntil?.toISOString() ?? null,
        },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async unmuteTarget(
    userId: string,
    target: NotificationTarget,
  ): Promise<void> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy') {
      await this.unmuteGame(userId, target.legacyGameId as string);
      return;
    }
    const run = async (tx: NodePgDatabase): Promise<void> => {
      await tx.execute(sql`
        DELETE FROM platform_mail_turn_mutes
        WHERE user_id = ${userId}::uuid
          AND session_id = ${target.sessionId}
      `);
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'turn_email_session_unmuted',
        requestId: currentAuditRequestId(),
        context: {
          runtimeOwner: 'platform',
          sessionId: target.sessionId,
        },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async disableTurnReminders(userId: string): Promise<void> {
    await new AccountPreferencesRepository(this.db).upsert(userId, {
      emailTurnRemindersEnabled: false,
    });
  }

  public async suppress(input: {
    recipient: string;
    category?: TMailSuppressionCategory;
    reason: string;
    source?: string;
    expiresAt?: Date;
  }): Promise<void> {
    const recipient = normalizeRecipient(input.recipient);
    const category = input.category ?? 'all';
    await this.db.execute(sql`
      INSERT INTO mail_suppressions (recipient, category, reason, source, expires_at)
      VALUES (
        ${recipient},
        ${category},
        ${input.reason.replace(/[\r\n]/g, ' ').slice(0, 500)},
        ${input.source?.replace(/[\r\n]/g, ' ').slice(0, 100) ?? 'application'},
        ${input.expiresAt ?? null}
      )
      ON CONFLICT (lower(recipient), category)
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source = EXCLUDED.source,
        expires_at = EXCLUDED.expires_at,
        created_at = clock_timestamp()
    `);
  }

  public async suppressFromProvider(
    recipient: string,
    reason: string,
    source: 'tencent-ses' | 'resend' = 'tencent-ses',
  ): Promise<void> {
    await this.suppress({
      recipient,
      category: 'all',
      reason,
      source,
    });
  }
}
