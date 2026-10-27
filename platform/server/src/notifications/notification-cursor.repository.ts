import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  assertNotificationTarget,
  type NotificationTarget,
} from './notification-target.js';

export interface IAdvanceNotificationCursorInput {
  gameId: string;
  userId: string;
  actionable: boolean;
  actionKey?: string | null;
}

export interface IAdvanceNotificationTargetInput
  extends Omit<IAdvanceNotificationCursorInput, 'gameId'> {
  target: NotificationTarget;
}

export interface IAdvanceNotificationCursorResult {
  attentionEpoch: number;
  shouldEnqueue: boolean;
}

/** Durable attention epochs for action-required mail dedupe. */
@Injectable()
export class NotificationCursorRepository {
  public constructor(private readonly db: NodePgDatabase) {}

  public async listForGame(
    gameId: string,
    database: NodePgDatabase = this.db,
  ): Promise<
    Array<{ userId: string; actionable: boolean; actionKey: string | null }>
  > {
    const result = await database.execute(sql`
      SELECT
        user_id AS "userId",
        actionable,
        action_key AS "actionKey"
      FROM notification_cursors
      WHERE game_id = ${gameId}::uuid
    `);
    return result.rows as Array<{
      userId: string;
      actionable: boolean;
      actionKey: string | null;
    }>;
  }

  public async advance(
    input: IAdvanceNotificationCursorInput,
    database?: NodePgDatabase,
  ): Promise<IAdvanceNotificationCursorResult> {
    if (database) return this.advanceInDatabase(input, database);
    return this.db.transaction((tx) =>
      this.advanceInDatabase(input, tx as unknown as NodePgDatabase),
    );
  }

  public async listForTarget(
    target: NotificationTarget,
    database: NodePgDatabase = this.db,
  ): Promise<
    Array<{ userId: string; actionable: boolean; actionKey: string | null }>
  > {
    assertNotificationTarget(target);
    if (target.runtimeOwner === 'legacy')
      return this.listForGame(target.legacyGameId as string, database);
    const result = await database.execute(sql`
      SELECT
        user_id AS "userId",
        actionable,
        action_key AS "actionKey"
      FROM platform_notification_cursors
      WHERE session_id = ${target.sessionId}
    `);
    return result.rows as Array<{
      userId: string;
      actionable: boolean;
      actionKey: string | null;
    }>;
  }

  public async advanceTarget(
    input: IAdvanceNotificationTargetInput,
    database?: NodePgDatabase,
  ): Promise<IAdvanceNotificationCursorResult> {
    assertNotificationTarget(input.target);
    if (input.target.runtimeOwner === 'legacy')
      return this.advance(
        {
          gameId: input.target.legacyGameId as string,
          userId: input.userId,
          actionable: input.actionable,
          actionKey: input.actionKey,
        },
        database,
      );
    if (database) return this.advancePlatformInDatabase(input, database);
    return this.db.transaction((tx) =>
      this.advancePlatformInDatabase(input, tx as unknown as NodePgDatabase),
    );
  }

  private async advanceInDatabase(
    input: IAdvanceNotificationCursorInput,
    database: NodePgDatabase,
  ): Promise<IAdvanceNotificationCursorResult> {
    const existing = await database.execute(sql`
      SELECT
        attention_epoch AS "attentionEpoch",
        actionable,
        action_key AS "actionKey"
      FROM notification_cursors
      WHERE game_id = ${input.gameId}::uuid
        AND user_id = ${input.userId}::uuid
      FOR UPDATE
    `);
    const row = existing.rows[0] as
      | {
          attentionEpoch?: number;
          actionable?: boolean;
          actionKey?: string | null;
        }
      | undefined;
    const wasActionable = row?.actionable === true;
    const actionChanged =
      (row?.actionKey ?? null) !== (input.actionKey ?? null);
    const shouldEnqueue = input.actionable && (!wasActionable || actionChanged);
    const attentionEpoch = (row?.attentionEpoch ?? 0) + (shouldEnqueue ? 1 : 0);
    const actionKey = input.actionable ? (input.actionKey ?? null) : null;

    if (!row) {
      await database.execute(sql`
        INSERT INTO notification_cursors (
          game_id, user_id, attention_epoch, actionable, action_key, updated_at
        )
        VALUES (
          ${input.gameId}::uuid,
          ${input.userId}::uuid,
          ${attentionEpoch},
          ${input.actionable},
          ${actionKey},
          clock_timestamp()
        )
      `);
    } else {
      await database.execute(sql`
        UPDATE notification_cursors
        SET attention_epoch = ${attentionEpoch},
            actionable = ${input.actionable},
            action_key = ${actionKey},
            updated_at = clock_timestamp()
        WHERE game_id = ${input.gameId}::uuid
          AND user_id = ${input.userId}::uuid
      `);
    }
    return { attentionEpoch, shouldEnqueue };
  }

  private async advancePlatformInDatabase(
    input: IAdvanceNotificationTargetInput,
    database: NodePgDatabase,
  ): Promise<IAdvanceNotificationCursorResult> {
    // Lock the logical key before reading so two first-seen facts cannot both
    // attempt the absent-row insert and lose an attention epoch.
    await database.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${input.target.sessionId}:${input.userId}`}, 0)
      )
    `);
    const existing = await database.execute(sql`
      SELECT
        attention_epoch AS "attentionEpoch",
        actionable,
        action_key AS "actionKey"
      FROM platform_notification_cursors
      WHERE session_id = ${input.target.sessionId}
        AND user_id = ${input.userId}::uuid
      FOR UPDATE
    `);
    const row = existing.rows[0] as
      | {
          attentionEpoch?: number;
          actionable?: boolean;
          actionKey?: string | null;
        }
      | undefined;
    const wasActionable = row?.actionable === true;
    const actionChanged =
      (row?.actionKey ?? null) !== (input.actionKey ?? null);
    const shouldEnqueue = input.actionable && (!wasActionable || actionChanged);
    const attentionEpoch = (row?.attentionEpoch ?? 0) + (shouldEnqueue ? 1 : 0);
    const actionKey = input.actionable ? (input.actionKey ?? null) : null;

    if (!row) {
      await database.execute(sql`
        INSERT INTO platform_notification_cursors (
          session_id, user_id, attention_epoch, actionable, action_key, updated_at
        )
        VALUES (
          ${input.target.sessionId},
          ${input.userId}::uuid,
          ${attentionEpoch},
          ${input.actionable},
          ${actionKey},
          clock_timestamp()
        )
      `);
    } else {
      await database.execute(sql`
        UPDATE platform_notification_cursors
        SET attention_epoch = ${attentionEpoch},
            actionable = ${input.actionable},
            action_key = ${actionKey},
            updated_at = clock_timestamp()
        WHERE session_id = ${input.target.sessionId}
          AND user_id = ${input.userId}::uuid
      `);
    }
    return { attentionEpoch, shouldEnqueue };
  }
}
