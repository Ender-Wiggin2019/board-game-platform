import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ERole } from '@board-platform/contracts/auth/roles';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import {
  accountSecurityEvents,
  authSessions,
} from '@/persistence/schema/accountSecurity.js';
import { users } from '@/persistence/schema/users.js';
import { currentAuditRequestId } from './account-audit-request.js';
import { findActiveSession } from './active-session.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './jwtConfig.js';
import type { IJwtPayload } from './PrincipalResolver.js';
import { resolveUserRole } from './roleResolver.js';

export const REFRESH_TOKEN_BYTES = 32;
/**
 * Refresh sessions are rolling sessions. Every successful rotation extends the
 * session by another year while access tokens are valid for 180 days.
 */
export const REFRESH_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
export { ACCESS_TOKEN_TTL_SECONDS } from './jwtConfig.js';

export interface ISessionMetadata {
  userAgent?: string;
  ipAddress?: string;
}

export interface IAuthSessionTokens {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  sessionId: string;
  expiresAt: Date;
}

export interface IRotatedSession {
  userId: string;
  tokens: IAuthSessionTokens;
}

type TSessionRotationFailure = { failure: 'expired' };

/**
 * Server-side refresh session rotation and revocation.
 * Access tokens identify a revocable session without exposing its refresh secret.
 */
@Injectable()
export class SessionService {
  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {}

  public async createSession(
    user: Pick<TUserForSession, 'id' | 'email' | 'role' | 'sessionVersion'>,
    metadata: ISessionMetadata = {},
  ): Promise<IAuthSessionTokens> {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE_MS);
    await this.db.insert(authSessions).values({
      id: sessionId,
      userId: user.id,
      refreshHash: digestRefreshToken(refreshToken),
      familyId,
      csrfHash: digestRefreshToken(csrfToken),
      expiresAt,
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress,
    });
    return {
      accessToken: this.signAccessToken(user, sessionId),
      refreshToken,
      csrfToken,
      sessionId,
      expiresAt,
    };
  }

  public async rotateRefreshToken(
    refreshToken: string,
    csrfToken: string | undefined,
    metadata: ISessionMetadata = {},
  ): Promise<IRotatedSession> {
    if (!refreshToken || !csrfToken) {
      throw new UnauthorizedException('Refresh session is invalid');
    }
    const refreshHash = digestRefreshToken(refreshToken);
    const run = async (
      tx: NodePgDatabase,
    ): Promise<IRotatedSession | TSessionRotationFailure | null> => {
      const [credential] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshHash, refreshHash))
        .limit(1);
      if (!credential) {
        throw new UnauthorizedException('Refresh session is invalid');
      }
      await lockSessionFamily(tx, credential.familyId);
      const [session] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.id, credential.id))
        .limit(1);
      if (!session) {
        throw new UnauthorizedException('Refresh session is invalid');
      }
      const now = new Date();
      if (session.revokedAt) {
        if (session.replacementId) {
          await tx
            .update(authSessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(authSessions.familyId, session.familyId),
                isNull(authSessions.revokedAt),
              ),
            );
          return null;
        }
        throw new UnauthorizedException('Refresh session is revoked');
      }
      if (session.expiresAt <= now) {
        if (!session.revokedAt) {
          await tx
            .update(authSessions)
            .set({ revokedAt: now })
            .where(eq(authSessions.id, session.id));
        }
        return { failure: 'expired' };
      }
      if (session.csrfHash !== digestRefreshToken(csrfToken)) {
        throw new UnauthorizedException('Refresh session is invalid');
      }

      const [user] = await tx
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          navigatorGrantedAt: users.navigatorGrantedAt,
          navigatorExpiresAt: users.navigatorExpiresAt,
          sessionVersion: users.sessionVersion,
          accountStatus: users.accountStatus,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, session.userId))
        .limit(1);
      if (!user || user.accountStatus !== 'active') {
        throw new UnauthorizedException('Account is not active');
      }

      const replacementId = randomUUID();
      const nextRefreshToken =
        randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      const nextCsrfToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + REFRESH_MAX_AGE_MS);
      const [revoked] = await tx
        .update(authSessions)
        .set({
          lastUsedAt: now,
          revokedAt: now,
          replacementId,
        })
        .where(
          and(eq(authSessions.id, session.id), isNull(authSessions.revokedAt)),
        )
        .returning({ id: authSessions.id });
      if (!revoked) {
        await tx
          .update(authSessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(authSessions.familyId, session.familyId),
              isNull(authSessions.revokedAt),
            ),
          );
        return null;
      }
      await tx.insert(authSessions).values({
        id: replacementId,
        userId: user.id,
        refreshHash: digestRefreshToken(nextRefreshToken),
        familyId: session.familyId,
        csrfHash: digestRefreshToken(nextCsrfToken),
        expiresAt,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
      });
      const typedUser = {
        id: user.id,
        email: user.email,
        role: resolveUserRole(user),
        sessionVersion: user.sessionVersion,
      } satisfies TUserForSession;
      return {
        userId: user.id,
        tokens: {
          accessToken: this.signAccessToken(typedUser, replacementId),
          refreshToken: nextRefreshToken,
          csrfToken: nextCsrfToken,
          sessionId: replacementId,
          expiresAt,
        },
      };
    };

    const rotated = await this.db.transaction((tx) =>
      run(tx as unknown as NodePgDatabase),
    );
    if (!rotated) {
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if ('failure' in rotated && rotated.failure === 'expired') {
      throw new UnauthorizedException('Refresh session is expired');
    }
    return rotated as IRotatedSession;
  }

  public async revokeSession(sessionId: string): Promise<void> {
    const run = async (tx: NodePgDatabase): Promise<void> => {
      const [session] = await tx
        .select({
          familyId: authSessions.familyId,
          userId: authSessions.userId,
        })
        .from(authSessions)
        .where(eq(authSessions.id, sessionId))
        .limit(1);
      if (!session) return;
      await lockSessionFamily(tx, session.familyId);
      const revoked = await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.familyId, session.familyId),
            eq(authSessions.userId, session.userId),
            isNull(authSessions.revokedAt),
          ),
        )
        .returning({ userId: authSessions.userId });
      if (revoked.length === 0) return;
      await tx.insert(accountSecurityEvents).values({
        actorUserId: session.userId,
        subjectUserId: session.userId,
        eventKind: 'session_revoked',
        requestId: currentAuditRequestId(),
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async assertCsrfToken(
    sessionId: string | undefined,
    csrfToken: string | undefined,
  ): Promise<void> {
    if (!sessionId || !csrfToken) {
      throw new UnauthorizedException('CSRF token is invalid');
    }
    const session = await findActiveSession(this.db, sessionId);
    if (!session || session.csrfHash !== digestRefreshToken(csrfToken)) {
      throw new UnauthorizedException('CSRF token is invalid');
    }
  }

  public async revokeAllSessions(userId: string): Promise<void> {
    const now = new Date();
    const run = async (tx: NodePgDatabase): Promise<void> => {
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
        );
      await tx
        .update(users)
        .set({
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'all_sessions_revoked',
        requestId: currentAuditRequestId(),
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }

  public async isActiveSession(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = await findActiveSession(this.db, sessionId, userId);
    return Boolean(session);
  }

  public static digest(value: string): string {
    return digestRefreshToken(value);
  }

  private signAccessToken(user: TUserForSession, sessionId: string): string {
    const payload: IJwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: sessionId,
      sessionVersion: user.sessionVersion,
    };
    return this.jwtService.sign(payload, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }
}

/** Serialize rotation and logout across every credential in the same family. */
async function lockSessionFamily(db: NodePgDatabase, familyId: string) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'auth-session:' + familyId}, 0))`,
  );
}

export interface TUserForSession {
  id: string;
  email: string;
  role: ERole;
  sessionVersion: number;
}

export function digestRefreshToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
