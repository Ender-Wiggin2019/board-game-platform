import {
  AccountRuleError,
  normalizeAccountName,
  normalizeEmailAddress,
} from '@board-platform/contracts/auth/accountRules';
import { getNavigatorAccess } from '@board-platform/contracts/auth/navigator';
import { ERole } from '@board-platform/contracts/auth/roles';
import type { TAccountPreferencesPatch } from '@board-platform/contracts/types/protocol/accountPreferences';
import type {
  IAccountProfile,
  IRegisterRequest,
} from '@board-platform/contracts/types/protocol/auth';
import { DEFAULT_USER_LANGUAGE } from '@board-platform/contracts/types/protocol/userLanguage';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import { UserRepository } from '@/persistence/repository/UserRepository.js';
import { accountSecurityEvents } from '@/persistence/schema/accountSecurity.js';
import { userPreferences } from '@/persistence/schema/userPreferences.js';
import type { TUserRow } from '@/persistence/schema/users.js';
import { users } from '@/persistence/schema/users.js';
import { currentAuditRequestId } from './account-audit-request.js';
import { AccountExtensionsRegistry } from './account-extensions.js';
import {
  accountRuleBoundary,
  accountRuleBoundaryAsync,
  hashPassword,
  validateAccountPassword,
  validateAccountPasswordConfirmation,
  verifyAccountPassword,
} from './password.js';
import { resolveUserRole } from './roleResolver.js';
import { type IAuthSessionTokens, SessionService } from './session.service.js';

/** Internal session result; HTTP controllers project only the stable fields. */
export interface IAuthTokenResponse extends IAuthSessionTokens {
  user: IAccountProfile;
}

export const ACCOUNT_REGISTRATION_CONSENT_VERSION = 'account-registration-v1';

@Injectable()
export class AuthService {
  private readonly userRepo: UserRepository;
  private readonly accountPreferences: AccountPreferencesRepository;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(AccountExtensionsRegistry)
    private readonly extensions: AccountExtensionsRegistry,
  ) {
    this.userRepo = new UserRepository(db);
    this.accountPreferences = new AccountPreferencesRepository(db);
  }

  private async buildProfile(
    user: TUserRow,
    role = resolveUserRole(user),
  ): Promise<IAccountProfile> {
    const profile: IAccountProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      role,
      baseRole: user.role as ERole,
      navigator: getNavigatorAccess(user.role as ERole, user, new Date()),
      createdAt: user.createdAt,
    };
    const extension = await this.extensions.get().extendProfile?.({
      user,
      role,
      profile,
    });
    return extension ? { ...profile, ...extension } : profile;
  }

  public async register(input: IRegisterRequest): Promise<IAuthTokenResponse> {
    if (input.consentVersion !== ACCOUNT_REGISTRATION_CONSENT_VERSION) {
      throw new BadRequestException({ code: 'CONSENT_VERSION_UNSUPPORTED' });
    }
    const { email, emailKey } = accountRuleBoundary(() =>
      normalizeEmailAddress(input.email),
    );
    const { name, nameKey } = this.normalizeAccountName(input.name);
    const password = validateAccountPasswordConfirmation(
      input.password,
      input.passwordConfirm,
    );
    validateAccountPassword(password, { username: name, email: emailKey });
    const passwordHash = await hashPassword(password, {
      username: name,
      email: emailKey,
    });

    const create = async (tx: NodePgDatabase): Promise<TUserRow> => {
      const [existingEmail] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.emailKey, emailKey))
        .limit(1);
      if (existingEmail) {
        throw new ConflictException({
          code: 'EMAIL_IN_USE',
          i18n: { key: 'auth_email_in_use' },
        });
      }
      const [existingName] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.nameKey, nameKey))
        .limit(1);
      if (existingName) {
        throw new ConflictException({
          code: 'USERNAME_TAKEN',
          i18n: { key: 'auth_username_taken' },
        });
      }
      const [user] = await tx
        .insert(users)
        .values({
          name,
          email,
          passwordHash,
          emailVerifiedAt: null,
          emailVersion: 1,
          accountStatus: 'active',
          permissionVersion: 0,
        })
        .returning();
      if (!user) throw new ConflictException({ code: 'ACCOUNT_CREATE_FAILED' });
      await tx.insert(accountSecurityEvents).values({
        actorUserId: user.id,
        subjectUserId: user.id,
        eventKind: 'account_registered',
        requestId: currentAuditRequestId(),
        context: { consentVersion: input.consentVersion },
      });
      if (input.language && input.language !== DEFAULT_USER_LANGUAGE) {
        await tx.insert(userPreferences).values({
          userId: user.id,
          preferences: { language: input.language },
        });
      }
      await this.extensions.get().onAccountRegistered?.({
        transaction: tx,
        user,
        request: input,
      });
      return user;
    };

    let user: TUserRow;
    try {
      user = await this.db.transaction((tx) =>
        create(tx as unknown as NodePgDatabase),
      );
    } catch (error) {
      const conflict = uniqueAccountConflict(error);
      if (conflict)
        throw new ConflictException({
          code: conflict,
          i18n: { key: `auth_${conflict.toLowerCase()}` },
        });
      throw error;
    }
    return this.issueAuthTokenResponse(user);
  }

  public async login(
    identifier: string,
    password: string,
  ): Promise<IAuthTokenResponse> {
    const user = await this.userRepo.findByLogin(identifier);
    if (!user || user.accountStatus !== 'active') {
      throw new UnauthorizedException({
        message: 'Invalid email, username, or password',
        i18n: { key: 'invalid_credentials' },
      });
    }
    if (!(await verifyAccountPassword(password, user.passwordHash))) {
      throw new UnauthorizedException({
        message: 'Invalid email, username, or password',
        i18n: { key: 'invalid_credentials' },
      });
    }
    return this.issueAuthTokenResponse(user, resolveUserRole(user));
  }

  public async usernameAvailability(
    input: string,
  ): Promise<{ status: 'available' | 'invalid' | 'taken' }> {
    try {
      const name = this.normalizeAccountName(input).name;
      const existing = await this.userRepo.findByName(name);
      return { status: existing ? 'taken' : 'available' };
    } catch (error) {
      if (error instanceof AccountRuleError) return { status: 'invalid' };
      throw error;
    }
  }

  public async getProfile(userId: string): Promise<IAccountProfile> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new UnauthorizedException({
        message: 'User not found',
        i18n: { key: 'user_not_found' },
      });
    }
    return this.buildProfile(user);
  }

  public async updatePreferences(
    userId: string,
    input: unknown,
  ): Promise<IAccountProfile> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new BadRequestException({ code: 'INVALID_PREFERENCES' });
    }
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    const accountPatch: TAccountPreferencesPatch = {};
    const gamePatch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (ACCOUNT_PREFERENCE_KEYS.has(key as keyof TAccountPreferencesPatch)) {
        (accountPatch as Record<string, unknown>)[key] = value;
      } else {
        gamePatch[key] = value;
      }
    }
    if (Object.keys(gamePatch).length > 0) {
      const unknownKeys = await this.extensions.updatePreferences(
        userId,
        gamePatch,
      );
      if (unknownKeys.length > 0) {
        throw new BadRequestException({
          code: 'UNSUPPORTED_PREFERENCES',
          fields: unknownKeys,
        });
      }
    }
    if (Object.keys(accountPatch).length > 0) {
      await this.accountPreferences.upsert(userId, accountPatch);
    }
    return this.buildProfile(user);
  }

  public async updateProfile(
    userId: string,
    data: { name?: string; email?: string },
  ): Promise<IAccountProfile> {
    if (data.email !== undefined) {
      throw new ConflictException({
        code: 'EMAIL_CHANGE_REQUIRES_VERIFICATION',
      });
    }
    const current = await this.userRepo.findById(userId);
    if (!current) throw new UnauthorizedException('User not found');
    const normalizedName =
      data.name === undefined
        ? undefined
        : this.normalizeAccountName(data.name).name;
    const user = await accountRuleBoundaryAsync(() =>
      this.userRepo.update(
        userId,
        normalizedName === undefined ? {} : { name: normalizedName },
      ),
    );
    if (!user) throw new UnauthorizedException('User not found');
    if (data.name !== undefined && user.name !== current.name) {
      await this.extensions.get().onNameChanged?.({
        userId,
        previousName: current.name,
        name: user.name,
      });
    }
    return this.buildProfile(user);
  }

  public async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    passwordConfirm: string,
  ): Promise<IAuthTokenResponse> {
    const currentUser = await this.assertCurrentPassword(
      userId,
      currentPassword,
    );
    const normalizedNewPassword = validateAccountPasswordConfirmation(
      newPassword,
      passwordConfirm,
    );
    validateAccountPassword(normalizedNewPassword, {
      username: currentUser.name,
      email: currentUser.email,
    });
    const passwordHash = await hashPassword(normalizedNewPassword, {
      username: currentUser.name,
      email: currentUser.email,
    });
    const user = await this.userRepo.changePassword(
      userId,
      currentUser.passwordHash,
      passwordHash,
    );
    if (!user)
      throw new UnauthorizedException('Password changed; sign in again');
    await this.extensions.get().onPasswordChanged?.({ userId });
    return this.issueAuthTokenResponse(user);
  }

  public async assertCurrentPassword(
    userId: string,
    currentPassword: string,
  ): Promise<TUserRow> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    if (!(await verifyAccountPassword(currentPassword, user.passwordHash))) {
      throw new BadRequestException({
        message: 'Current password is incorrect',
        i18n: { key: 'invalid_current_password' },
      });
    }
    return user;
  }

  public async onLogoutAll(userId: string): Promise<void> {
    await this.extensions.get().onLogoutAll?.({ userId });
  }

  public async onSessionRevoked(userId: string): Promise<void> {
    await this.extensions.get().onSessionRevoked?.({ userId });
  }

  public async onPasswordReset(userId: string): Promise<void> {
    await this.extensions.get().onPasswordReset?.({ userId });
  }

  public async onEmailChanged(input: {
    userId: string;
    email: string;
    emailKey: string;
  }): Promise<void> {
    await this.extensions.get().onEmailChanged?.(input);
  }

  private async issueAuthTokenResponse(
    user: TUserRow,
    resolvedRole = resolveUserRole(user),
  ): Promise<IAuthTokenResponse> {
    const tokens = await this.sessionService.createSession({
      id: user.id,
      email: user.email,
      role: resolvedRole,
      sessionVersion: user.sessionVersion,
    });
    return {
      ...tokens,
      user: await this.buildProfile(user, resolvedRole),
    };
  }

  private normalizeAccountName(input: string) {
    return accountRuleBoundary(() => {
      const normalized = normalizeAccountName(input);
      this.extensions.get().validateAccountName?.(normalized);
      return normalized;
    });
  }
}

const ACCOUNT_PREFERENCE_KEYS = new Set<keyof TAccountPreferencesPatch>([
  'language',
  'showNavigatorIdentity',
  'pushNotificationsEnabled',
  'emailTurnRemindersEnabled',
  'emailQuietHours',
]);

function uniqueAccountConflict(
  error: unknown,
): 'USERNAME_TAKEN' | 'EMAIL_IN_USE' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  if (databaseError.code !== '23505') return undefined;
  if (databaseError.constraint === 'users_name_key_uq') return 'USERNAME_TAKEN';
  if (databaseError.constraint === 'users_email_key_uq') return 'EMAIL_IN_USE';
  return undefined;
}
