import { randomBytes } from 'node:crypto';
import { getNavigatorAccess } from '@board-platform/contracts/auth/navigator';
import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import {
  ERole,
  isInviteCodeGrantRole,
  ROLE_RANK,
  type TInviteCodeGrantRole,
} from '@board-platform/contracts/auth/roles';
import {
  CUSTOM_INVITE_CODE_PATTERN,
  type IAdminInviteCodeSummary,
  type IAdminTableQuery,
  type IGenerateInviteCodeRequest,
} from '@board-platform/contracts/types/protocol/inviteCodes';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AccountExtensionsRegistry } from '@/auth/account-extensions.js';
import { resolveUserRole } from '@/auth/roleResolver.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { InviteCodeRepository } from '@/persistence/repository/InviteCodeRepository.js';
import { accountSecurityEvents } from '@/persistence/schema/accountSecurity.js';
import {
  inviteCodeRedemptions,
  inviteCodes,
  type TInviteCodeRow,
} from '@/persistence/schema/inviteCodes.js';
import { type TUserRow, users } from '@/persistence/schema/users.js';
import { toAdminTableResponse } from '@/shared/adminTable.js';

const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 10;
const MAX_GENERATE_ATTEMPTS = 8;

export interface IUserProfileResponse {
  id: string;
  name: string;
  email: string;
  role: ERole;
  baseRole: ERole;
  navigator: ReturnType<typeof getNavigatorAccess>;
  createdAt: Date;
}

@Injectable()
export class InviteCodeService {
  private readonly inviteCodeRepo: InviteCodeRepository;

  public constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase,
    @Inject(AccountExtensionsRegistry)
    private readonly extensions: AccountExtensionsRegistry,
  ) {
    this.inviteCodeRepo = new InviteCodeRepository(db);
  }

  public async listInviteCodes(query: Required<IAdminTableQuery>) {
    const page = await this.inviteCodeRepo.listPage(query);
    return toAdminTableResponse({
      list: page.list,
      total: page.total,
      pageSize: query.pageSize,
      pageNum: query.pageNum,
      sort: page.sort,
    });
  }

  public async generateInviteCode(
    creatorUserId: string,
    input: Partial<IGenerateInviteCodeRequest> | undefined,
  ): Promise<IAdminInviteCodeSummary> {
    const role = parseInviteRole(input?.role);
    const expiresAt = parseFutureDate(input?.expiresAt, 'expiresAt');
    const maxUses = parseMaxUses(input?.maxUses);
    const customCode = parseCustomInviteCode(input?.code);
    const creator = await this.findCreator(creatorUserId);
    if (
      role === ERole.TESTER &&
      (creator.accountStatus !== 'active' ||
        !can(resolveUserRole(creator), ECapability.NAVIGATOR_MANAGE))
    ) {
      throw new UnauthorizedException(
        'Only superadmins can generate tester invite codes',
      );
    }

    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt += 1) {
      try {
        const row = await this.inviteCodeRepo.create({
          code: customCode ?? generateInviteCodeValue(),
          role,
          expiresAt,
          maxUses,
          createdByUserId: creatorUserId,
        });
        return { ...row, usedCount: 0 };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        if (customCode) {
          throw new ConflictException({
            message: 'Invite code already exists',
            i18n: { key: 'invite_code_already_exists' },
          });
        }
      }
    }

    throw new ConflictException('Could not generate a unique invite code');
  }

  public async disableInviteCode(
    inviteCodeId: string,
  ): Promise<IAdminInviteCodeSummary> {
    const disabledAt = new Date();
    const row = await this.inviteCodeRepo.disable(inviteCodeId, disabledAt);
    if (!row) {
      throw new NotFoundException('Invite code not found');
    }
    const [used] = await this.db
      .select({ count: count() })
      .from(inviteCodeRedemptions)
      .where(eq(inviteCodeRedemptions.inviteCodeId, row.id));
    return { ...row, usedCount: Number(used?.count ?? 0) };
  }

  private async findCreator(userId: string): Promise<TUserRow> {
    const [creator] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!creator) {
      throw new UnauthorizedException('Authenticated user not found');
    }
    return creator;
  }

  public async redeemInviteCode(
    userId: string,
    rawCode: unknown,
  ): Promise<IUserProfileResponse> {
    const codeValue = normalizeInviteCode(rawCode);
    if (!codeValue) {
      throw new BadRequestException('Invite code is required');
    }

    const profile = await this.db.transaction(async (tx) => {
      const [inviteCode] = await tx
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.code, codeValue))
        .limit(1)
        .for('update');
      if (!inviteCode) {
        throw new BadRequestException('Invite code is invalid');
      }

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for('update');
      if (!user) {
        throw new UnauthorizedException({
          message: 'User not found',
          i18n: { key: 'user_not_found' },
        });
      }

      const currentRole = resolveUserRole(user);
      const [existingRedemption] = await tx
        .select({ id: inviteCodeRedemptions.id })
        .from(inviteCodeRedemptions)
        .where(
          and(
            eq(inviteCodeRedemptions.inviteCodeId, inviteCode.id),
            eq(inviteCodeRedemptions.userId, user.id),
          ),
        )
        .limit(1);
      const [used] = await tx
        .select({ count: count() })
        .from(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.inviteCodeId, inviteCode.id));

      validateInviteCodeRedemption({
        inviteCode,
        usedCount: Number(used?.count ?? 0),
        alreadyRedeemed: existingRedemption !== undefined,
        currentRole,
        now: new Date(),
      });

      await tx.insert(inviteCodeRedemptions).values({
        inviteCodeId: inviteCode.id,
        userId: user.id,
        redeemedRole: inviteCode.role,
      });
      const [updatedUser] = await tx
        .update(users)
        .set({
          role: inviteCode.role,
          permissionVersion: sql`${users.permissionVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))
        .returning();
      if (!updatedUser) {
        throw new UnauthorizedException({
          message: 'User not found',
          i18n: { key: 'user_not_found' },
        });
      }

      await tx.insert(accountSecurityEvents).values({
        actorUserId: user.id,
        subjectUserId: user.id,
        eventKind: 'invite_code_redeemed',
        requestId: null,
        context: { inviteCodeId: inviteCode.id, role: inviteCode.role },
      });

      return toUserProfile(updatedUser);
    });
    await this.extensions.get().onAuthorizationChanged?.({
      userId,
    });
    return profile;
  }
}

export function validateInviteCodeRedemption(input: {
  inviteCode: Pick<
    TInviteCodeRow,
    'role' | 'expiresAt' | 'maxUses' | 'disabledAt'
  >;
  usedCount: number;
  alreadyRedeemed: boolean;
  currentRole: ERole;
  now: Date;
}): void {
  if (!isInviteCodeGrantRole(input.inviteCode.role)) {
    throw new BadRequestException('Invite code role is no longer valid');
  }
  if (input.inviteCode.disabledAt) {
    throw new BadRequestException('Invite code is disabled');
  }
  if (input.inviteCode.expiresAt && input.inviteCode.expiresAt <= input.now) {
    throw new BadRequestException({
      message: 'Invite code is expired',
      i18n: { key: 'invite_code_expired' },
    });
  }
  if (input.alreadyRedeemed) {
    throw new BadRequestException('Invite code already redeemed');
  }
  if (
    input.inviteCode.maxUses !== null &&
    input.usedCount >= input.inviteCode.maxUses
  ) {
    throw new BadRequestException({
      message: 'Invite code is exhausted',
      i18n: { key: 'invite_code_exhausted' },
    });
  }
  if (ROLE_RANK[input.inviteCode.role] <= ROLE_RANK[input.currentRole]) {
    throw new BadRequestException('Invite code does not grant a higher role');
  }
}

function parseInviteRole(value: unknown): TInviteCodeGrantRole {
  if (!isInviteCodeGrantRole(value)) {
    throw new BadRequestException('role must be one of: player, tester');
  }
  return value;
}

function parseFutureDate(value: unknown, field: string): Date | null {
  if (value === null) {
    return null;
  }
  const date =
    value instanceof Date || typeof value === 'string'
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date`);
  }
  if (date <= new Date()) {
    throw new BadRequestException(`${field} must be in the future`);
  }
  return date;
}

function parseMaxUses(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestException('maxUses must be a positive integer');
  }
  return value;
}

function parseCustomInviteCode(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException({
      message: 'Invite code must be 6-32 letters or numbers',
      i18n: { key: 'invite_code_format' },
    });
  }
  const code = value.trim();
  if (code === '') {
    return null;
  }
  if (!CUSTOM_INVITE_CODE_PATTERN.test(code)) {
    throw new BadRequestException({
      message: 'Invite code must be 6-32 letters or numbers',
      i18n: { key: 'invite_code_format' },
    });
  }
  return code.toUpperCase();
}

function normalizeInviteCode(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

function generateInviteCodeValue(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  return Array.from(bytes, (byte) => {
    const index = byte % INVITE_CODE_ALPHABET.length;
    return INVITE_CODE_ALPHABET[index];
  }).join('');
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === '23505' || isUniqueViolation(candidate.cause);
}

function toUserProfile(user: TUserRow): IUserProfileResponse {
  const baseRole = user.role as ERole;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: resolveUserRole(user),
    baseRole,
    navigator: getNavigatorAccess(baseRole, user),
    createdAt: user.createdAt,
  };
}
