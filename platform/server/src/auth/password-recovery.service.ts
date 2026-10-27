import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeEmail } from '@board-platform/contracts/auth/accountRules';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import {
  accountSecurityEvents,
  authChallenges,
  authSessions,
} from '@/persistence/schema/accountSecurity.js';
import { users } from '@/persistence/schema/users.js';
import { currentAuditRequestId } from './account-audit-request.js';
import { AccountExtensionsRegistry } from './account-extensions.js';
import {
  digest,
  equalDigest,
  type IAccountMailOutbox,
  MAIL_OUTBOX_SERVICE,
} from './email-proof.js';
import {
  hashPassword,
  validateAccountPasswordConfirmation,
} from './password.js';

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export interface IPasswordRecoveryRequestResult {
  accepted: true;
}

export interface IPasswordResetResult {
  completed: true;
}

/** One-time password recovery, restricted to verified production accounts. */
@Injectable()
export class PasswordRecoveryService {
  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Inject(MAIL_OUTBOX_SERVICE)
    private readonly mailOutbox: IAccountMailOutbox,
    @Inject(AccountExtensionsRegistry)
    private readonly extensions: AccountExtensionsRegistry,
  ) {}

  /** Always returns the same public response shape to avoid account lookup. */
  public async request(
    emailInput: string,
  ): Promise<IPasswordRecoveryRequestResult> {
    let emailKey: string;
    try {
      emailKey = normalizeEmail(emailInput);
    } catch {
      return { accepted: true };
    }
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        emailKey: users.emailKey,
        emailVersion: users.emailVersion,
        sessionVersion: users.sessionVersion,
        accountStatus: users.accountStatus,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.emailKey, emailKey))
      .limit(1);
    if (!user || !user.emailVerifiedAt || user.accountStatus !== 'active') {
      return { accepted: true };
    }

    const rawToken = randomBytes(32).toString('base64url');
    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    const now = new Date();
    const run = async (tx: NodePgDatabase) => {
      const previous = await tx
        .select({ id: authChallenges.id })
        .from(authChallenges)
        .where(
          and(
            eq(authChallenges.userId, user.id),
            eq(authChallenges.purpose, 'password_reset'),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
          ),
        );
      await tx
        .update(authChallenges)
        .set({ invalidatedAt: now })
        .where(
          and(
            eq(authChallenges.userId, user.id),
            eq(authChallenges.purpose, 'password_reset'),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
          ),
        );
      for (const oldChallenge of previous) {
        await this.mailOutbox.cancelByDedupeKey?.(
          tx,
          `auth-password-reset:${oldChallenge.id}`,
          'challenge_replaced',
        );
      }
      await tx.insert(authChallenges).values({
        id: challengeId,
        purpose: 'password_reset',
        userId: user.id,
        emailKey: user.emailKey,
        secretHash: digest(rawToken),
        maxAttempts: 1,
        emailVersion: user.emailVersion,
        sessionVersion: user.sessionVersion,
        expiresAt,
      });
      await this.mailOutbox.enqueueTemplate(tx, {
        recipient: user.email,
        templateKey: 'reset_password',
        variables: {},
        sensitivePayload: { token: `${challengeId}.${rawToken}` },
        kind: 'password_recovery',
        userId: user.id,
        emailVersion: user.emailVersion,
        challengeId,
        dedupeKey: `auth-password-reset:${challengeId}`,
        priority: 100,
        expiresAt,
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
    return { accepted: true };
  }

  public async reset(
    token: string,
    passwordInput: string,
    passwordConfirmInput: string,
  ): Promise<IPasswordResetResult> {
    const [challengeId, rawToken] = token.split('.', 2);
    if (!challengeId || !rawToken || rawToken.length > 200) {
      throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
    }
    const password = validateAccountPasswordConfirmation(
      passwordInput,
      passwordConfirmInput,
    );
    const [challenge] = await this.db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.id, challengeId),
          eq(authChallenges.purpose, 'password_reset'),
        ),
      )
      .limit(1);
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.invalidatedAt ||
      challenge.expiresAt <= new Date() ||
      !equalDigest(challenge.secretHash, digest(rawToken))
    ) {
      throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
    }
    if (!challenge.userId) {
      throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
    }
    const [user] = await this.db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        emailVersion: users.emailVersion,
        sessionVersion: users.sessionVersion,
        accountStatus: users.accountStatus,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, challenge.userId))
      .limit(1);
    if (!user || user.accountStatus !== 'active' || !user.emailVerifiedAt) {
      throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
    }
    if (
      challenge.emailVersion !== user.emailVersion ||
      challenge.sessionVersion !== user.sessionVersion
    ) {
      throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
    }
    const passwordHash = await hashPassword(password, {
      username: user.name,
      email: user.email,
    });
    const now = new Date();
    const run = async (tx: NodePgDatabase) => {
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.accountStatus, 'active'),
            isNotNull(users.emailVerifiedAt),
            eq(users.emailVersion, challenge.emailVersion ?? user.emailVersion),
            eq(
              users.sessionVersion,
              challenge.sessionVersion ?? user.sessionVersion,
            ),
          ),
        )
        .returning({ id: users.id });
      if (!updated) {
        throw new UnauthorizedException({ code: 'PASSWORD_RESET_INVALID' });
      }
      await tx
        .update(authChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authChallenges.id, challenge.id),
            isNull(authChallenges.consumedAt),
          ),
        );
      await this.mailOutbox.cancelByDedupeKey?.(
        tx,
        `auth-password-reset:${challenge.id}`,
        'challenge_consumed',
      );
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(authSessions.userId, user.id), isNull(authSessions.revokedAt)),
        );
      await tx.insert(accountSecurityEvents).values({
        actorUserId: user.id,
        subjectUserId: user.id,
        eventKind: 'password_reset_completed',
        requestId: currentAuditRequestId(),
        context: { emailVersion: user.emailVersion },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
    await this.extensions.get().onPasswordReset?.({
      userId: user.id,
    });
    return { completed: true };
  }
}
