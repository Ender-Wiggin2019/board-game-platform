import { getNavigatorAccess } from '@board-platform/contracts/auth/navigator';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import { ERole, isRole, toRole } from '@board-platform/contracts/auth/roles';
import type { IPlatformAdminUserSummary } from '@board-platform/contracts/types/protocol/administration';
import type {
  IAdminInviteCodeSummary,
  IAdminTableResponse,
  IGenerateInviteCodeRequest,
} from '@board-platform/contracts/types/protocol/inviteCodes';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { currentAuditRequestId } from '@/auth/account-audit-request.js';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import type { IJwtPayload } from '@/auth/jwt-auth.guard.js';
import { PasswordRecoveryService } from '@/auth/password-recovery.service.js';
import { resolveEffectiveRole } from '@/auth/roleResolver.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { InviteCodeService } from '@/invite-codes/invite-code.service.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { UserRepository } from '@/persistence/repository/UserRepository.js';
import { accountSecurityEvents } from '@/persistence/schema/accountSecurity.js';
import { type TUserRow } from '@/persistence/schema/users.js';
import { parsePlatformListQuery } from '@/shared/listQuery.js';

interface IAdminRequest {
  user?: IJwtPayload;
}

/** Platform-owned account, role and invite-code administration. */
@Controller('platform/admin')
@UseGuards(RolesGuard)
export class PlatformAdministrationController {
  private readonly users: UserRepository;

  public constructor(
    @Inject(DRIZZLE_DB) db: NodePgDatabase,
    @Inject(InviteCodeService)
    private readonly inviteCodes: InviteCodeService,
    @Inject(PasswordRecoveryService)
    private readonly passwordRecovery: PasswordRecoveryService,
  ) {
    this.users = new UserRepository(db);
    this.db = db;
  }

  private readonly db: NodePgDatabase;

  @Get('users')
  @Capabilities(ECapability.USER_MANAGE)
  public async listUsers(
    @Query('search') search?: string,
    @Query('pageSize') pageSize?: string,
    @Query('pageNum') pageNum?: string,
    @Query('sort') sort?: string,
    @Query('filters') filters?: string,
  ): Promise<IAdminTableResponse<IPlatformAdminUserSummary>> {
    const query = parsePlatformListQuery({
      pageSize,
      pageNum,
      sort,
      filters,
    });
    const page = await this.users.findPage({
      search: stringFilter(query.filters.search) ?? search,
      role: stringFilter(query.filters.role),
      pageSize: query.pageSize,
      pageNum: query.pageNum,
      sort: query.sort,
    });
    return {
      list: page.list.map(toPlatformAdminUserSummary),
      total: page.total,
      pageSize: query.pageSize,
      pageNum: query.pageNum,
      sort: page.sort,
    };
  }

  @Get('users/:id')
  @Capabilities(ECapability.USER_MANAGE)
  public async getUser(
    @Param('id') userId: string,
  ): Promise<IPlatformAdminUserSummary> {
    return toPlatformAdminUserSummary(await this.requireUser(userId));
  }

  @Patch('users/:id/role')
  @Capabilities(ECapability.USER_MANAGE)
  public async setUserRole(
    @Param('id') userId: string,
    @Body() body: { role?: unknown },
    @Req() request: IAdminRequest,
  ): Promise<IPlatformAdminUserSummary> {
    if (!isRole(body.role) || body.role === ERole.NAVIGATOR) {
      throw new BadRequestException(
        'role must be one of: guest, player, tester, admin, superadmin',
      );
    }
    const target = await this.requireUser(userId);
    const actorRole = toRole(request.user?.role);
    const excludeSuperadmin = actorRole !== ERole.SUPERADMIN;
    const elevatedRoles = new Set<ERole>([
      ERole.TESTER,
      ERole.ADMIN,
      ERole.SUPERADMIN,
    ]);
    if (
      excludeSuperadmin &&
      (elevatedRoles.has(body.role) || elevatedRoles.has(target.role as ERole))
    ) {
      throw new ForbiddenException(
        'Only superadmins can grant or change elevated roles',
      );
    }
    const updated = await this.users.update(
      userId,
      { role: body.role },
      { excludeSuperadmin },
    );
    if (!updated) {
      throw new ForbiddenException('User does not exist or is protected');
    }
    await this.auditMutation({
      actorUserId: request.user?.sub,
      subjectUserId: updated.id,
      eventKind: 'admin_role_changed',
      context: { from: target.role, to: body.role },
    });
    return toPlatformAdminUserSummary(updated);
  }

  @Post('users/:id/reset-password')
  @Capabilities(ECapability.USER_MANAGE)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  public async resetUserPassword(
    @Param('id') userId: string,
    @Req() request: IAdminRequest,
  ): Promise<IPlatformAdminUserSummary> {
    const user = await this.requireUser(userId);
    if (
      toRole(request.user?.role) !== ERole.SUPERADMIN &&
      user.role === ERole.SUPERADMIN
    ) {
      throw new ForbiddenException('User is protected');
    }
    await this.passwordRecovery.request(user.email);
    await this.auditMutation({
      actorUserId: request.user?.sub,
      subjectUserId: user.id,
      eventKind: 'admin_password_reset_requested',
      context: {},
    });
    return toPlatformAdminUserSummary(user);
  }

  @Get('invite-codes')
  @Capabilities(ECapability.USER_MANAGE)
  public async listInviteCodes(
    @Query('pageSize') pageSize?: string,
    @Query('pageNum') pageNum?: string,
    @Query('sort') sort?: string,
    @Query('filters') filters?: string,
  ): Promise<IAdminTableResponse<IAdminInviteCodeSummary>> {
    return this.inviteCodes.listInviteCodes(
      parsePlatformListQuery({ pageSize, pageNum, sort, filters }),
    );
  }

  @Post('invite-codes')
  @Capabilities(ECapability.USER_MANAGE)
  public async generateInviteCode(
    @Req() request: IAdminRequest,
    @Body() body: Partial<IGenerateInviteCodeRequest>,
  ): Promise<IAdminInviteCodeSummary> {
    return this.inviteCodes.generateInviteCode(request.user?.sub ?? '', body);
  }

  @Post('invite-codes/:id/disable')
  @Capabilities(ECapability.USER_MANAGE)
  public async disableInviteCode(
    @Param('id') inviteCodeId: string,
  ): Promise<IAdminInviteCodeSummary> {
    return this.inviteCodes.disableInviteCode(inviteCodeId);
  }

  private async requireUser(userId: string): Promise<TUserRow> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new NotFoundException({
        message: 'User not found',
        i18n: { key: 'user_not_found' },
      });
    }
    return user;
  }

  private async auditMutation(input: {
    actorUserId: string | undefined;
    subjectUserId: string;
    eventKind: string;
    context: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(accountSecurityEvents).values({
      actorUserId: input.actorUserId ?? null,
      subjectUserId: input.subjectUserId,
      eventKind: input.eventKind,
      requestId: currentAuditRequestId(),
      context: input.context,
    });
  }
}

function toPlatformAdminUserSummary(user: TUserRow): IPlatformAdminUserSummary {
  const baseRole = user.role as ERole;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: resolveEffectiveRole(user.role, user),
    baseRole,
    navigator: getNavigatorAccess(baseRole, user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function stringFilter(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
