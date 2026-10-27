import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  assertNotificationTarget,
  type NotificationTarget,
} from '@/notifications/notification-target.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';

export const DEFAULT_MAIL_FOREGROUND_TTL_MS = 2 * 60_000;
const MAX_MAIL_FOREGROUND_TTL_MS = 10 * 60_000;

/**
 * Small shared presence record used by the HTTP process and the mail worker.
 * The table is deliberately TTL based: a crashed browser or API process
 * cannot leave a player suppressed forever.
 */
@Injectable()
export class MailForegroundPresenceService {
  public constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  public async touch(
    userId: string,
    gameId: string,
    ttlMs = DEFAULT_MAIL_FOREGROUND_TTL_MS,
  ): Promise<void> {
    const boundedTtlMs = Math.max(
      1_000,
      Math.min(MAX_MAIL_FOREGROUND_TTL_MS, Math.floor(ttlMs)),
    );
    await this.db.execute(sql`
      INSERT INTO game_foreground_presence (
        user_id,
        game_id,
        last_seen_at,
        expires_at
      )
      VALUES (
        ${userId}::uuid,
        ${gameId}::uuid,
        clock_timestamp(),
        clock_timestamp() + (${boundedTtlMs}::text || ' milliseconds')::interval
      )
      ON CONFLICT (user_id, game_id) DO UPDATE
      SET last_seen_at = clock_timestamp(),
          expires_at = clock_timestamp() + (${boundedTtlMs}::text || ' milliseconds')::interval
    `);
  }

  public async isActive(userId: string, gameId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM game_foreground_presence
      WHERE user_id = ${userId}::uuid
        AND game_id = ${gameId}::uuid
        AND expires_at > clock_timestamp()
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  public async clear(userId: string, gameId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM game_foreground_presence
      WHERE user_id = ${userId}::uuid
        AND game_id = ${gameId}::uuid
    `);
  }

  public async touchTarget(
    userId: string,
    target: NotificationTarget,
    ttlMs = DEFAULT_MAIL_FOREGROUND_TTL_MS,
  ): Promise<void> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy') {
      await this.touch(userId, target.legacyGameId as string, ttlMs);
      return;
    }
    const boundedTtlMs = Math.max(
      1_000,
      Math.min(MAX_MAIL_FOREGROUND_TTL_MS, Math.floor(ttlMs)),
    );
    await this.db.execute(sql`
      INSERT INTO platform_foreground_presence (
        user_id,
        session_id,
        last_seen_at,
        expires_at
      )
      VALUES (
        ${userId}::uuid,
        ${target.sessionId},
        clock_timestamp(),
        clock_timestamp() + (${boundedTtlMs}::text || ' milliseconds')::interval
      )
      ON CONFLICT (user_id, session_id) DO UPDATE
      SET last_seen_at = clock_timestamp(),
          expires_at = clock_timestamp() + (${boundedTtlMs}::text || ' milliseconds')::interval
    `);
  }

  public async isActiveTarget(
    userId: string,
    target: NotificationTarget,
  ): Promise<boolean> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy')
      return this.isActive(userId, target.legacyGameId as string);
    const result = await this.db.execute(sql`
      SELECT 1
      FROM platform_foreground_presence
      WHERE user_id = ${userId}::uuid
        AND session_id = ${target.sessionId}
        AND expires_at > clock_timestamp()
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  public async clearTarget(
    userId: string,
    target: NotificationTarget,
  ): Promise<void> {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy') {
      await this.clear(userId, target.legacyGameId as string);
      return;
    }
    await this.db.execute(sql`
      DELETE FROM platform_foreground_presence
      WHERE user_id = ${userId}::uuid
        AND session_id = ${target.sessionId}
    `);
  }

  public async clearExpired(): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM game_foreground_presence
      WHERE expires_at <= clock_timestamp()
    `);
    await this.db.execute(sql`
      DELETE FROM platform_foreground_presence
      WHERE expires_at <= clock_timestamp()
    `);
  }
}
