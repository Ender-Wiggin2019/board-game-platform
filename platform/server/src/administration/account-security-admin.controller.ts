import { randomUUID } from 'node:crypto';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import type {
  IAdminAccountSecurityEvent,
  IAdminAccountSecurityList,
  IAdminMigrationReceipt,
} from '@board-platform/contracts/types/protocol/accountSecurityAdmin';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { currentAuditRequestId } from '@/auth/account-audit-request.js';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import type { IJwtPayload } from '@/auth/jwt-auth.guard.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { accountImportReceipts } from '@/persistence/schema/accountMigration.js';
import { accountSecurityEvents } from '@/persistence/schema/accountSecurity.js';

interface IAuditRequest {
  user: IJwtPayload;
  headers?: Record<string, string | undefined>;
}

/** Platform-owned, bounded reads of account migration and security history. */
@Controller(['platform/admin/account-security', 'admin/account-security'])
@UseGuards(RolesGuard)
@Capabilities(ECapability.USER_MANAGE)
export class AccountSecurityAdminController {
  public constructor(@Inject(DRIZZLE_DB) private readonly db: NodePgDatabase) {}

  @Get('receipts')
  public async receipts(
    @Req() request: IAuditRequest,
    @Query('userId') userIdInput?: string,
    @Query('limit') limitInput?: string,
  ): Promise<IAdminAccountSecurityList<IAdminMigrationReceipt>> {
    const userId = parseUserId(userIdInput);
    const rows = await this.db
      .select({
        id: accountImportReceipts.id,
        sourceSystem: accountImportReceipts.sourceSystem,
        legacyUserId: accountImportReceipts.legacyUserId,
        newUserId: accountImportReceipts.newUserId,
        snapshotId: accountImportReceipts.snapshotId,
        policyVersion: accountImportReceipts.policyVersion,
        counts: accountImportReceipts.counts,
        createdAt: accountImportReceipts.createdAt,
      })
      .from(accountImportReceipts)
      .where(userId ? eq(accountImportReceipts.newUserId, userId) : undefined)
      .orderBy(
        desc(accountImportReceipts.createdAt),
        desc(accountImportReceipts.id),
      )
      .limit(parseLimit(limitInput));
    await this.auditRead(
      request,
      'admin_migration_receipts_viewed',
      userId,
      rows.length,
    );
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Get('events')
  public async events(
    @Req() request: IAuditRequest,
    @Query('userId') userIdInput?: string,
    @Query('limit') limitInput?: string,
  ): Promise<IAdminAccountSecurityList<IAdminAccountSecurityEvent>> {
    const userId = parseUserId(userIdInput);
    const rows = await this.db
      .select({
        id: accountSecurityEvents.id,
        actorUserId: accountSecurityEvents.actorUserId,
        subjectUserId: accountSecurityEvents.subjectUserId,
        eventKind: accountSecurityEvents.eventKind,
        requestId: accountSecurityEvents.requestId,
        context: accountSecurityEvents.context,
        createdAt: accountSecurityEvents.createdAt,
      })
      .from(accountSecurityEvents)
      .where(
        userId ? eq(accountSecurityEvents.subjectUserId, userId) : undefined,
      )
      .orderBy(
        desc(accountSecurityEvents.createdAt),
        desc(accountSecurityEvents.id),
      )
      .limit(parseLimit(limitInput));
    await this.auditRead(
      request,
      'admin_security_events_viewed',
      userId,
      rows.length,
    );
    return {
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  private async auditRead(
    request: IAuditRequest,
    eventKind: string,
    subjectUserId: string | undefined,
    rowCount: number,
  ): Promise<void> {
    const incomingRequestId = request.headers?.['x-request-id'];
    const requestId =
      currentAuditRequestId() ??
      (incomingRequestId && /^[a-zA-Z0-9:._-]{1,80}$/u.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID());
    await this.db.insert(accountSecurityEvents).values({
      actorUserId: request.user.sub,
      subjectUserId,
      eventKind,
      requestId,
      context: { rowCount, filtered: Boolean(subjectUserId) },
    });
  }
}

function parseUserId(value: string | undefined): string | undefined {
  const userId = value?.trim();
  if (!userId) return undefined;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      userId,
    )
  ) {
    throw new BadRequestException({ code: 'USER_ID_INVALID' });
  }
  return userId.toLowerCase();
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException({ code: 'LIMIT_INVALID' });
  }
  return Math.min(parsed, 100);
}
