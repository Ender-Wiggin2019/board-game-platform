import type {
  IAdminInviteCodeSummary,
  IAdminTableQuery,
} from '@board-platform/contracts/types/protocol/inviteCodes';
import { and, asc, count, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { tableOffset } from '../../shared/adminTable.js';
import {
  inviteCodeRedemptions,
  inviteCodes,
  type TInviteCodeInsert,
  type TInviteCodeRow,
} from '../schema/inviteCodes.js';

export class InviteCodeRepository {
  public constructor(private readonly db: NodePgDatabase) {}

  public async create(input: TInviteCodeInsert): Promise<TInviteCodeRow> {
    const [row] = await this.db.insert(inviteCodes).values(input).returning();
    return row;
  }

  public async listPage(input: Required<IAdminTableQuery>): Promise<{
    list: IAdminInviteCodeSummary[];
    total: number;
    sort: string;
  }> {
    const totalRows = await this.db
      .select({ count: count() })
      .from(inviteCodes);
    const sort = normalizeInviteCodeSort(input.sort);
    const usedCount = sql<number>`count(${inviteCodeRedemptions.id})`;
    const rows = await this.db
      .select({
        id: inviteCodes.id,
        code: inviteCodes.code,
        role: inviteCodes.role,
        expiresAt: inviteCodes.expiresAt,
        maxUses: inviteCodes.maxUses,
        disabledAt: inviteCodes.disabledAt,
        createdByUserId: inviteCodes.createdByUserId,
        createdAt: inviteCodes.createdAt,
        updatedAt: inviteCodes.updatedAt,
        usedCount,
      })
      .from(inviteCodes)
      .leftJoin(
        inviteCodeRedemptions,
        eq(inviteCodeRedemptions.inviteCodeId, inviteCodes.id),
      )
      .groupBy(
        inviteCodes.id,
        inviteCodes.code,
        inviteCodes.role,
        inviteCodes.expiresAt,
        inviteCodes.maxUses,
        inviteCodes.disabledAt,
        inviteCodes.createdByUserId,
        inviteCodes.createdAt,
        inviteCodes.updatedAt,
      )
      .orderBy(sort.orderBy)
      .limit(input.pageSize)
      .offset(tableOffset(input));
    return {
      list: rows.map((row) => ({ ...row, usedCount: Number(row.usedCount) })),
      total: Number(totalRows[0]?.count ?? 0),
      sort: sort.value,
    };
  }

  public async disable(
    inviteCodeId: string,
    disabledAt: Date,
  ): Promise<TInviteCodeRow | null> {
    const [row] = await this.db
      .update(inviteCodes)
      .set({ disabledAt, updatedAt: disabledAt })
      .where(
        and(eq(inviteCodes.id, inviteCodeId), isNull(inviteCodes.disabledAt)),
      )
      .returning();
    return row ?? null;
  }
}

function normalizeInviteCodeSort(sort: string | undefined): {
  value: string;
  orderBy: SQL;
} {
  const [field, direction] = sort?.split(':') ?? [];
  const column =
    field === 'code'
      ? inviteCodes.code
      : field === 'role'
        ? inviteCodes.role
        : field === 'expiresAt'
          ? inviteCodes.expiresAt
          : field === 'maxUses'
            ? inviteCodes.maxUses
            : inviteCodes.createdAt;
  const normalizedField =
    field === 'code' ||
    field === 'role' ||
    field === 'expiresAt' ||
    field === 'maxUses'
      ? field
      : 'createdAt';
  const normalizedDirection = direction === 'asc' ? 'asc' : 'desc';
  const nullableSortField =
    normalizedField === 'expiresAt' || normalizedField === 'maxUses';
  return {
    value: `${normalizedField}:${normalizedDirection}`,
    orderBy:
      normalizedDirection === 'asc'
        ? nullableSortField
          ? sql`${column} asc nulls last`
          : (asc(column) as SQL)
        : nullableSortField
          ? sql`${column} desc nulls first`
          : (desc(column) as SQL),
  };
}
