import { randomInt, randomUUID } from 'node:crypto';
import { normalizeEmailAddress } from '@board-platform/contracts/auth/accountRules';
import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
  codeHmac,
  EMAIL_CHALLENGE_TTL_MS,
  EMAIL_MAX_ATTEMPTS,
  equalDigest,
  type IAccountMailOutbox,
  MAIL_OUTBOX_SERVICE,
} from './email-proof.js';
import { accountRuleBoundary, verifyAccountPassword } from './password.js';

export interface IEmailChangeStartResult {
  challengeId: string;
  expiresAt: Date;
}

/** Re-authenticated, two-step email replacement. */
@Injectable()
export class EmailChangeService {
  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Inject(MAIL_OUTBOX_SERVICE)
    private readonly mailOutbox: IAccountMailOutbox,
    @Inject(AccountExtensionsRegistry)
    private readonly extensions: AccountExtensionsRegistry,
  ) {}

  public async start(
    userId: string,
    newEmailInput: string,
    currentPassword: string,
  ): Promise<IEmailChangeStartResult> {
    const normalized = accountRuleBoundary(() =>
      normalizeEmailAddress(newEmailInput),
    );
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || user.accountStatus !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }
    if (!(await verifyAccountPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException({
        code: 'REAUTH_REQUIRED',
        i18n: { key: 'auth_reauth_required' },
      });
    }
    if (normalized.emailKey === user.emailKey && user.emailVerifiedAt) {
      throw new ConflictException({
        code: 'EMAIL_UNCHANGED',
        i18n: { key: 'auth_email_unchanged' },
      });
    }
    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(Date.now() + EMAIL_CHALLENGE_TTL_MS);
    const now = new Date();
    const run = async (tx: NodePgDatabase) => {
      const previous = await tx
        .select({ id: authChallenges.id })
        .from(authChallenges)
        .where(
          and(
            eq(authChallenges.userId, userId),
            eq(authChallenges.purpose, 'email_change'),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
          ),
        );
      await tx
        .update(authChallenges)
        .set({ invalidatedAt: now })
        .where(
          and(
            eq(authChallenges.userId, userId),
            eq(authChallenges.purpose, 'email_change'),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
          ),
        );
      for (const oldChallenge of previous) {
        await this.mailOutbox.cancelByDedupeKey?.(
          tx,
          `auth-email-change:${oldChallenge.id}`,
          'challenge_replaced',
        );
      }
      await tx.insert(authChallenges).values({
        id: challengeId,
        purpose: 'email_change',
        userId,
        email: normalized.email,
        emailKey: normalized.emailKey,
        secretHash: codeHmac(
          challengeId,
          'email_change',
          normalized.emailKey,
          code,
        ),
        maxAttempts: EMAIL_MAX_ATTEMPTS,
        emailVersion: user.emailVersion,
        sessionVersion: user.sessionVersion,
        expiresAt,
      });
      await this.mailOutbox.enqueueTemplate(tx, {
        recipient: normalized.email,
        templateKey: 'email_change_verify',
        variables: {},
        sensitivePayload: { code },
        kind: 'email_change_verification',
        userId,
        emailVersion: user.emailVersion,
        challengeId,
        dedupeKey: `auth-email-change:${challengeId}`,
        priority: 100,
        expiresAt,
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
    return { challengeId, expiresAt };
  }

  public async confirm(
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<{ email: string; emailKey: string }> {
    if (!/^\d{6}$/.test(code)) {
      throw new UnauthorizedException({
        code: 'EMAIL_CODE_INVALID',
        i18n: { key: 'auth_email_code_invalid' },
      });
    }
    const [challenge] = await this.db
      .select()
      .from(authChallenges)
      .where(
        and(
          eq(authChallenges.id, challengeId),
          eq(authChallenges.userId, userId),
          eq(authChallenges.purpose, 'email_change'),
        ),
      )
      .limit(1);
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.invalidatedAt ||
      challenge.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException({
        code: 'EMAIL_PROOF_EXPIRED',
        i18n: { key: 'auth_email_proof_expired' },
      });
    }
    if (
      !challenge.emailKey ||
      challenge.attempts >= challenge.maxAttempts ||
      !equalDigest(
        codeHmac(challenge.id, challenge.purpose, challenge.emailKey, code),
        challenge.secretHash,
      )
    ) {
      await this.db
        .update(authChallenges)
        .set({
          attempts: sql`${authChallenges.attempts} + 1`,
          invalidatedAt: sql`CASE
            WHEN ${authChallenges.attempts} + 1 >= ${authChallenges.maxAttempts}
              THEN now()
            ELSE ${authChallenges.invalidatedAt}
          END`,
        })
        .where(
          and(
            eq(authChallenges.id, challenge.id),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
            sql`${authChallenges.attempts} < ${authChallenges.maxAttempts}`,
            sql`${authChallenges.expiresAt} > now()`,
          ),
        );
      throw new UnauthorizedException({
        code: 'EMAIL_CODE_INVALID',
        i18n: { key: 'auth_email_code_invalid' },
      });
    }

    const now = new Date();
    const run = async (tx: NodePgDatabase) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!user || user.accountStatus !== 'active') {
        throw new UnauthorizedException('Account is not active');
      }
      if (
        challenge.emailVersion !== user.emailVersion ||
        challenge.sessionVersion !== user.sessionVersion
      ) {
        throw new UnauthorizedException({
          code: 'EMAIL_PROOF_EXPIRED',
          i18n: { key: 'auth_email_proof_expired' },
        });
      }
      const [occupied] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.emailKey, challenge.emailKey))
        .limit(1);
      if (occupied && occupied.id !== userId) {
        throw new ConflictException({
          code: 'EMAIL_IN_USE',
          i18n: { key: 'auth_email_in_use' },
        });
      }
      const [consumed] = await tx
        .update(authChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authChallenges.id, challenge.id),
            eq(authChallenges.userId, userId),
            eq(authChallenges.emailKey, challenge.emailKey),
            isNull(authChallenges.consumedAt),
            isNull(authChallenges.invalidatedAt),
            sql`${authChallenges.attempts} < ${authChallenges.maxAttempts}`,
            sql`${authChallenges.expiresAt} > ${now}`,
          ),
        )
        .returning({ id: authChallenges.id });
      if (!consumed)
        throw new UnauthorizedException({
          code: 'EMAIL_PROOF_EXPIRED',
          i18n: { key: 'auth_email_proof_expired' },
        });
      await this.mailOutbox.cancelByDedupeKey?.(
        tx,
        `auth-email-change:${challenge.id}`,
        'challenge_consumed',
      );
      const [updated] = await tx
        .update(users)
        .set({
          email: challenge.email ?? challenge.emailKey,
          emailVerifiedAt: now,
          emailVersion: sql`${users.emailVersion} + 1`,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(users.id, userId),
            eq(users.emailVersion, user.emailVersion),
            eq(users.sessionVersion, user.sessionVersion),
          ),
        )
        .returning({ id: users.id });
      if (!updated)
        throw new UnauthorizedException({
          code: 'EMAIL_PROOF_EXPIRED',
          i18n: { key: 'auth_email_proof_expired' },
        });
      await tx
        .update(authChallenges)
        .set({ invalidatedAt: now })
        .where(
          and(
            eq(authChallenges.userId, userId),
            eq(authChallenges.purpose, 'password_reset'),
            isNull(authChallenges.consumedAt),
          ),
        );
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)),
        );
      await tx.insert(accountSecurityEvents).values({
        actorUserId: userId,
        subjectUserId: userId,
        eventKind: 'email_changed',
        requestId: currentAuditRequestId(),
        context: { emailVersion: user.emailVersion + 1 },
      });
    };
    await this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
    await this.extensions.get().onEmailChanged?.({
      userId,
      email: challenge.email ?? challenge.emailKey,
      emailKey: challenge.emailKey,
    });
    return {
      email: challenge.email ?? challenge.emailKey,
      emailKey: challenge.emailKey,
    };
  }
}
