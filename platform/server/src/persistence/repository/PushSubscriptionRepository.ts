import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  pushSubscriptions,
  type TPushSubscriptionRow,
} from '../schema/pushSubscriptions.js';
import { userPreferences } from '../schema/userPreferences.js';

export interface IPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export type TPushSubscriptionSaveMode = 'enable' | 'refresh';
export type TPushSubscriptionSaveResult = 'saved' | 'conflict' | 'disabled';

const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Merge `pushNotificationsEnabled` into the account's preferences JSON.
 *
 * The column names are written out rather than interpolated from the schema on
 * purpose. Interpolating a drizzle column renders it table-qualified —
 * `"user_preferences"."user_id"` — and Postgres rejects a qualified name in an
 * INSERT column list, an ON CONFLICT target, and an UPDATE SET target. That made
 * every call here throw, so DELETE /push/subscribe answered 500, the client
 * showed its "connection lost, please refresh" dialog (it shows that for any
 * 5xx), and the preference was never flipped — the reported "turn notifications
 * on and you cannot turn them off again".
 *
 * The table itself is still interpolated: a table renders unqualified, and
 * qualifying the existing row on the right-hand side of SET is valid.
 */
async function writePushPreference(
  tx: Pick<NodePgDatabase, 'execute'>,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const patch = JSON.stringify({ pushNotificationsEnabled: enabled });
  await tx.execute(sql`
    insert into ${userPreferences} (user_id, preferences, updated_at)
    values (${userId}, ${patch}::jsonb, clock_timestamp())
    on conflict (user_id) do update
    set preferences = ${userPreferences}.preferences || ${patch}::jsonb,
        updated_at = clock_timestamp()
  `);
}

/**
 * Persistence for Web Push subscriptions, keyed per device by endpoint.
 *
 * Browsers hand out a fresh subscription whenever the old one is invalidated,
 * and clients re-subscribe on every launch, so `save` is an upsert on the
 * endpoint. Dead endpoints are removed rather than flagged: the push service
 * tells us with a 404/410 that the device is gone for good, and keeping the row
 * would just mean retrying a delivery that can never succeed.
 */
export class PushSubscriptionRepository {
  public constructor(private readonly db: NodePgDatabase) {}

  public async enableForUser(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`seti:push-user:${userId}`}, 0)
        )
      `);
      await writePushPreference(tx, userId, true);
    });
  }

  public async save(
    userId: string,
    input: IPushSubscriptionInput,
    mode: TPushSubscriptionSaveMode,
  ): Promise<TPushSubscriptionSaveResult> {
    return this.db.transaction(async (tx) => {
      // Serialize ownership checks for this endpoint. Two accounts may present
      // the same browser subscription during an account switch; silently
      // transferring it can deliver an already queued notification for the old
      // account to the new one.
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`seti:push-endpoint:${input.endpoint}`}, 0)
        )
      `);

      const [owner] = await tx
        .select({ userId: pushSubscriptions.userId })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, input.endpoint))
        .limit(1);
      if (owner && owner.userId !== userId) return 'conflict';

      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`seti:push-user:${userId}`}, 0)
        )
      `);

      if (mode === 'refresh') {
        // A background refresh may repair an enabled account, but must never
        // reverse a user opt-out that committed while the refresh was waiting
        // for this lock.
        const [row] = await tx
          .select({ preferences: userPreferences.preferences })
          .from(userPreferences)
          .where(eq(userPreferences.userId, userId))
          .limit(1);
        if (row?.preferences.pushNotificationsEnabled !== true) {
          return 'disabled';
        }
      } else if (mode === 'enable') {
        // An explicit enable and its first device row are one state transition.
        await writePushPreference(tx, userId, true);
      }

      const registeredAt = sql`clock_timestamp()`;
      await tx
        .insert(pushSubscriptions)
        .values({
          userId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgent: input.userAgent ?? null,
          createdAt: registeredAt,
        })
        .onConflictDoUpdate({
          target: [pushSubscriptions.endpoint],
          set: {
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: input.userAgent ?? null,
            // A refreshed endpoint is current and must not be evicted as the
            // oldest device immediately after this upsert.
            createdAt: registeredAt,
          },
        });

      await tx.execute(sql`
        delete from ${pushSubscriptions}
        where ${pushSubscriptions.userId} = ${userId}
          and ${pushSubscriptions.id} in (
            select ${pushSubscriptions.id}
            from ${pushSubscriptions}
            where ${pushSubscriptions.userId} = ${userId}
            order by
              ${pushSubscriptions.createdAt} desc,
              ${pushSubscriptions.id} desc
            offset ${MAX_SUBSCRIPTIONS_PER_USER}
          )
      `);
      return 'saved';
    });
  }

  public async listForUser(userId: string): Promise<TPushSubscriptionRow[]> {
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
  }

  public async deleteByEndpoint(
    userId: string,
    endpoint: string,
  ): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      );
  }

  public async deleteEndpoints(
    userId: string,
    endpoints: string[],
  ): Promise<void> {
    if (endpoints.length === 0) return;
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          inArray(pushSubscriptions.endpoint, endpoints),
        ),
      );
  }

  public async deleteForUser(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${`seti:push-user:${userId}`}, 0)
        )
      `);

      await writePushPreference(tx, userId, false);

      await tx
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
    });
  }

  public async markNotified(
    userId: string,
    endpoints: string[],
    at: Date,
  ): Promise<void> {
    if (endpoints.length === 0) return;
    await this.db
      .update(pushSubscriptions)
      .set({ lastNotifiedAt: at })
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          inArray(pushSubscriptions.endpoint, endpoints),
        ),
      );
  }
}
