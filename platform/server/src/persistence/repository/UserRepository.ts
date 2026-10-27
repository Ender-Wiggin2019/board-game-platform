import {
  normalizeAccountName,
  normalizeEmail,
  normalizeEmailAddress,
  usernameKey,
} from '@board-platform/contracts/auth/accountRules';
import { ERole, isRole } from '@board-platform/contracts/auth/roles';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  accountSecurityEvents,
  authSessions,
} from '../schema/accountSecurity.js';
import { type TUserInsert, type TUserRow, users } from '../schema/users.js';

export interface IUserPageInput {
  search?: string;
  role?: string;
  sort?: string;
  pageSize: number;
  pageNum: number;
}

export class UserRepository {
  public constructor(private readonly db: NodePgDatabase) {}

  public async create(
    input: Omit<TUserInsert, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<TUserRow> {
    const { name, email } = normalizeUserIdentity(input.name, input.email);
    const [row] = await this.db
      .insert(users)
      .values({ ...input, name, email })
      .returning();
    return row;
  }

  public async findByLogin(identifier: string): Promise<TUserRow | null> {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (trimmed.includes('@')) return this.findByEmail(trimmed);
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.nameKey, usernameKey(trimmed)))
      .limit(1);
    return row ?? null;
  }

  public async findByEmail(email: string): Promise<TUserRow | null> {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(email);
    } catch {
      return null;
    }
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.emailKey, normalizedEmail))
      .limit(1);
    return row ?? null;
  }

  public async findByName(name: string): Promise<TUserRow | null> {
    const normalizedName = normalizeAccountName(name).nameKey;
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.nameKey, normalizedName))
      .limit(1);
    return row ?? null;
  }

  public async findById(id: string): Promise<TUserRow | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  public async findAll(search?: string): Promise<TUserRow[]> {
    const query = this.db.select().from(users);
    const normalizedSearch = search?.trim().toLowerCase();
    if (!normalizedSearch) return query.orderBy(desc(users.createdAt));
    return query
      .where(
        or(
          sql`lower(${users.email}) like ${`%${normalizedSearch}%`}`,
          sql`lower(${users.name}) like ${`%${normalizedSearch}%`}`,
        ),
      )
      .orderBy(desc(users.createdAt));
  }

  public async findPage(
    input: IUserPageInput,
  ): Promise<{ list: TUserRow[]; total: number; sort: string }> {
    const where = buildUserWhere(input);
    const sort = normalizeUserSort(input.sort);
    const countQuery = this.db.select({ count: count() }).from(users);
    const totalRows = where ? await countQuery.where(where) : await countQuery;
    const listQuery = this.db
      .select()
      .from(users)
      .orderBy(sort.orderBy)
      .limit(input.pageSize)
      .offset(tableOffset(input));
    const list = where ? await listQuery.where(where) : await listQuery;
    return {
      list,
      total: Number(totalRows[0]?.count ?? 0),
      sort: sort.value,
    };
  }

  public async update(
    id: string,
    data: Partial<
      Pick<TUserInsert, 'name' | 'passwordHash' | 'role' | 'accountStatus'>
    >,
    options: { excludeSuperadmin?: boolean } = {},
  ): Promise<TUserRow | null> {
    const normalizedName =
      data.name === undefined
        ? undefined
        : normalizeAccountName(data.name).name;
    const updateData = {
      ...data,
      ...(normalizedName === undefined ? {} : { name: normalizedName }),
      ...(data.passwordHash !== undefined || data.accountStatus !== undefined
        ? { sessionVersion: sql`${users.sessionVersion} + 1` }
        : {}),
      ...(data.role !== undefined
        ? { permissionVersion: sql`${users.permissionVersion} + 1` }
        : {}),
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .update(users)
      .set(updateData)
      .where(
        and(
          eq(users.id, id),
          options.excludeSuperadmin
            ? data.role !== undefined
              ? notInArray(users.role, [
                  ERole.TESTER,
                  ERole.ADMIN,
                  ERole.SUPERADMIN,
                ])
              : ne(users.role, ERole.SUPERADMIN)
            : undefined,
        ),
      )
      .returning();
    return row ?? null;
  }

  public async changePassword(
    id: string,
    currentPasswordHash: string,
    passwordHash: string,
  ): Promise<TUserRow | null> {
    const now = new Date();
    const run = async (tx: NodePgDatabase): Promise<TUserRow | null> => {
      const [row] = await tx
        .update(users)
        .set({
          passwordHash,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(eq(users.id, id), eq(users.passwordHash, currentPasswordHash)),
        )
        .returning();
      if (!row) return null;
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(
          and(eq(authSessions.userId, id), isNull(authSessions.revokedAt)),
        );
      await tx.insert(accountSecurityEvents).values({
        actorUserId: id,
        subjectUserId: id,
        eventKind: 'password_changed',
        requestId: null,
        context: { sessionsRevoked: true },
      });
      return row;
    };
    return this.db.transaction((tx) => run(tx as unknown as NodePgDatabase));
  }
}

function buildUserWhere(
  input: Pick<IUserPageInput, 'search' | 'role'>,
): SQL | undefined {
  const conditions: SQL[] = [];
  const normalizedSearch = input.search?.trim().toLowerCase();
  if (normalizedSearch) {
    conditions.push(
      or(
        sql`lower(${users.email}) like ${`%${normalizedSearch}%`}`,
        sql`lower(${users.name}) like ${`%${normalizedSearch}%`}`,
      ) as SQL,
    );
  }
  if (input.role && isRole(input.role)) {
    const role = input.role as ERole;
    if (role === ERole.NAVIGATOR) {
      const now = new Date();
      conditions.push(
        and(
          inArray(users.role, [ERole.GUEST, ERole.PLAYER]),
          isNotNull(users.navigatorGrantedAt),
          or(
            isNull(users.navigatorExpiresAt),
            gt(users.navigatorExpiresAt, now),
          ),
        ) as SQL,
      );
    } else if (role === ERole.GUEST || role === ERole.PLAYER) {
      const now = new Date();
      conditions.push(
        and(
          eq(users.role, role),
          or(
            isNull(users.navigatorGrantedAt),
            and(
              isNotNull(users.navigatorExpiresAt),
              lte(users.navigatorExpiresAt, now),
            ),
          ),
        ) as SQL,
      );
    } else {
      conditions.push(eq(users.role, role));
    }
  }
  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : (and(...conditions) as SQL);
}

function normalizeUserSort(sort: string | undefined): {
  value: string;
  orderBy: SQL;
} {
  const [field, direction] = sort?.split(':') ?? [];
  const column =
    field === 'email'
      ? users.email
      : field === 'name'
        ? users.name
        : field === 'role'
          ? users.role
          : users.createdAt;
  const normalizedField =
    field === 'email' || field === 'name' || field === 'role'
      ? field
      : 'createdAt';
  const normalizedDirection = direction === 'asc' ? 'asc' : 'desc';
  return {
    value: `${normalizedField}:${normalizedDirection}`,
    orderBy:
      normalizedDirection === 'asc'
        ? (asc(column) as SQL)
        : (desc(column) as SQL),
  };
}

function tableOffset(
  input: Pick<IUserPageInput, 'pageSize' | 'pageNum'>,
): number {
  return Math.max(0, input.pageNum - 1) * input.pageSize;
}

function normalizeUserIdentity(
  name: string,
  email: string,
): { name: string; email: string } {
  return {
    name: normalizeAccountName(name).name,
    email: normalizeEmailAddress(email).email,
  };
}
