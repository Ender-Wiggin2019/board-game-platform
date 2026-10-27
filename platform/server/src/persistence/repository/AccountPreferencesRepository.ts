import type {
  IAccountPreferences,
  TAccountPreferencesPatch,
} from '@board-platform/contracts/types/protocol/accountPreferences';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { currentAuditRequestId } from '../../auth/account-audit-request.js';
import { accountSecurityEvents } from '../schema/accountSecurity.js';
import { userPreferences } from '../schema/userPreferences.js';

/** Account keys merge atomically while game-owned preference fields are preserved. */
export class AccountPreferencesRepository {
  constructor(private readonly db: NodePgDatabase) {}
  async get(userId: string): Promise<IAccountPreferences> {
    const [row] = await this.db
      .select({ preferences: userPreferences.preferences })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return (row?.preferences ?? {}) as IAccountPreferences;
  }
  async upsert(
    userId: string,
    patch: TAccountPreferencesPatch,
  ): Promise<IAccountPreferences> {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const save = async (
      database: NodePgDatabase,
    ): Promise<IAccountPreferences> => {
      const [row] = await database
        .insert(userPreferences)
        .values({ userId, preferences: defined })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: {
            preferences: sql`${userPreferences.preferences} || ${JSON.stringify(defined)}::jsonb`,
            updatedAt: new Date(),
          },
        })
        .returning({ preferences: userPreferences.preferences });
      for (const [key, eventKind] of [
        ['emailTurnRemindersEnabled', 'turn_email_subscription_changed'],
        ['emailQuietHours', 'turn_email_quiet_hours_changed'],
      ] as const) {
        if (patch[key] !== undefined)
          await database.insert(accountSecurityEvents).values({
            actorUserId: userId,
            subjectUserId: userId,
            eventKind,
            requestId: currentAuditRequestId(),
            context: {
              enabled:
                key === 'emailQuietHours' ? patch[key] !== null : patch[key],
            },
          });
      }
      return row.preferences as IAccountPreferences;
    };
    if (
      patch.emailTurnRemindersEnabled !== undefined ||
      patch.emailQuietHours !== undefined
    )
      return this.db.transaction((tx) => save(tx as unknown as NodePgDatabase));
    return save(this.db);
  }
}
