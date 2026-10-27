import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';

export const MAIL_ONLINE_PRESENCE_TTL_MS = 75_000;
export const MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Tracks every authenticated WebSocket connection in a shared, expiring
 * database lease. Only this process's connection ids are retained in memory;
 * the worker can therefore read the same table without owning a timer.
 */
@Injectable()
export class MailOnlinePresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(MailOnlinePresenceService.name);
  private readonly localConnections = new Map<string, string>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private dbWriteChain: Promise<void> = Promise.resolve();
  private refreshInFlight = false;

  public constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  public async connect(userId: string, connectionId: string): Promise<void> {
    // Register before touching the database so a failed first write is picked
    // up by the next batch refresh while the socket remains connected.
    this.localConnections.set(connectionId, userId);
    this.startRefreshTimer();

    await this.enqueueDbWrite(() =>
      this.db.execute(sql`
        INSERT INTO mail_online_presence (
          connection_id,
          user_id,
          expires_at
        )
        VALUES (
          ${connectionId},
          ${userId}::uuid,
          clock_timestamp() + (${MAIL_ONLINE_PRESENCE_TTL_MS}::text || ' milliseconds')::interval
        )
        ON CONFLICT (connection_id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            expires_at = EXCLUDED.expires_at
      `),
    );
  }

  public async disconnect(connectionId: string): Promise<void> {
    // Let the current lease expire naturally. This gives a reconnecting tab a
    // short grace period while ensuring this process never refreshes it again.
    this.localConnections.delete(connectionId);
    if (this.localConnections.size === 0) this.stopRefreshTimer();
  }

  public async isOnline(userId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 AS present
      FROM mail_online_presence
      WHERE user_id = ${userId}::uuid
        AND expires_at > clock_timestamp()
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  public async clearExpired(): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM mail_online_presence
      WHERE expires_at <= clock_timestamp()
    `);
  }

  public onModuleDestroy(): void {
    this.stopRefreshTimer();
    this.localConnections.clear();
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshLocalConnections();
    }, MAIL_ONLINE_PRESENCE_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async refreshLocalConnections(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    const connections = [...this.localConnections.entries()];
    if (connections.length === 0) {
      this.stopRefreshTimer();
      this.refreshInFlight = false;
      return;
    }

    try {
      await this.enqueueDbWrite(async () => {
        // A slow earlier write may leave this batch queued after a socket has
        // disconnected. Re-read the local map before building SQL so that
        // queued refreshes cannot extend a removed lease.
        const activeConnections = connections.filter(
          ([connectionId, userId]) =>
            this.localConnections.get(connectionId) === userId,
        );
        if (activeConnections.length === 0) return;
        const values = sql.join(
          activeConnections.map(
            ([connectionId, userId]) => sql`
              (${connectionId}, ${userId}::uuid, clock_timestamp() + (${MAIL_ONLINE_PRESENCE_TTL_MS}::text || ' milliseconds')::interval)
            `,
          ),
          sql`,`,
        );
        await this.db.execute(sql`
          INSERT INTO mail_online_presence (
            connection_id,
            user_id,
            expires_at
          )
          VALUES ${values}
          ON CONFLICT (connection_id) DO UPDATE
          SET user_id = EXCLUDED.user_id,
              expires_at = EXCLUDED.expires_at
        `);
      });
    } catch {
      // Refresh is best effort. The lease remains bounded and the next tick
      // will retry without exposing account or connection identifiers.
      this.logger.warn(
        'Mail online presence refresh failed; active leases may expire',
      );
    } finally {
      this.refreshInFlight = false;
    }
  }

  private enqueueDbWrite(write: () => Promise<unknown>): Promise<void> {
    const operation = this.dbWriteChain
      .catch(() => undefined)
      .then(async () => {
        await write();
      });
    this.dbWriteChain = operation.catch(() => undefined);
    return operation;
  }
}
