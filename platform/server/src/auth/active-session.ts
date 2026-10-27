import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { authSessions } from '@/persistence/schema/accountSecurity.js';

/** Rotation consumes a refresh credential, not the browser's access session. */
export async function findActiveSession(
  db: NodePgDatabase,
  sessionId: string,
  userId?: string,
): Promise<{ id: string; userId: string; csrfHash: string } | undefined> {
  const credential = alias(authSessions, 'access_credential');
  const [session] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      csrfHash: authSessions.csrfHash,
    })
    .from(authSessions)
    .innerJoin(
      credential,
      and(
        eq(authSessions.familyId, credential.familyId),
        eq(authSessions.userId, credential.userId),
      ),
    )
    .where(
      and(
        eq(credential.id, sessionId),
        userId ? eq(authSessions.userId, userId) : undefined,
        isNull(authSessions.revokedAt),
        sql`${authSessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return session;
}
