import type { TRelationshipStatus } from '@board-platform/contracts/types/protocol/friends';
import { and, count, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { friendships, type TFriendshipRow } from '../schema/friendships.js';
import { type TUserRow, users } from '../schema/users.js';

/** Internal search projection; callers decide which public fields to expose. */
export interface IPublicUserSearchRow {
  id: string;
  name: string;
  email: string;
}

export class FriendRepository {
  public constructor(protected readonly db: NodePgDatabase) {}

  public async createRequest(
    requesterUserId: string,
    targetUserId: string,
  ): Promise<TFriendshipRow> {
    const pair = canonicalFriendPair(requesterUserId, targetUserId);
    const [row] = await this.db
      .insert(friendships)
      .values({
        userOneId: pair.userOneId,
        userTwoId: pair.userTwoId,
        requestedByUserId: requesterUserId,
        status: 'pending',
      })
      .returning();
    return row;
  }

  public async findById(friendshipId: string): Promise<TFriendshipRow | null> {
    const [row] = await this.db
      .select()
      .from(friendships)
      .where(eq(friendships.id, friendshipId))
      .limit(1);
    return row ?? null;
  }

  public async findByPair(
    userId: string,
    otherUserId: string,
  ): Promise<TFriendshipRow | null> {
    const pair = canonicalFriendPair(userId, otherUserId);
    const [row] = await this.db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.userOneId, pair.userOneId),
          eq(friendships.userTwoId, pair.userTwoId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  public async accept(friendshipId: string): Promise<TFriendshipRow> {
    const now = new Date();
    const [row] = await this.db
      .update(friendships)
      .set({ status: 'accepted', acceptedAt: now, updatedAt: now })
      .where(eq(friendships.id, friendshipId))
      .returning();
    return row;
  }

  public async delete(friendshipId: string): Promise<boolean> {
    const [row] = await this.db
      .delete(friendships)
      .where(eq(friendships.id, friendshipId))
      .returning({ id: friendships.id });
    return row !== undefined;
  }

  public async listAcceptedForUser(userId: string): Promise<TFriendshipRow[]> {
    return this.db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          or(
            eq(friendships.userOneId, userId),
            eq(friendships.userTwoId, userId),
          ),
        ),
      )
      .orderBy(desc(friendships.updatedAt));
  }

  public async listPendingForUser(userId: string): Promise<TFriendshipRow[]> {
    return this.db
      .select()
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'pending'),
          or(
            eq(friendships.userOneId, userId),
            eq(friendships.userTwoId, userId),
          ),
        ),
      )
      .orderBy(desc(friendships.createdAt));
  }

  public async countIncomingPendingForUser(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'pending'),
          ne(friendships.requestedByUserId, userId),
          or(
            eq(friendships.userOneId, userId),
            eq(friendships.userTwoId, userId),
          ),
        ),
      );
    return Number(row?.count ?? 0);
  }

  public async searchUsers(
    _currentUserId: string,
    query: string,
    limit = 12,
  ): Promise<IPublicUserSearchRow[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) {
      return [];
    }

    const searchConditions = [
      sql`lower(${users.name}) like ${`%${normalized}%`}`,
    ];
    if (normalized.includes('@')) {
      searchConditions.unshift(sql`lower(${users.email}) = ${normalized}`);
    }

    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(or(...searchConditions))
      .orderBy(desc(users.createdAt))
      .limit(limit);
  }

  public async findRelationshipsForTargets(
    currentUserId: string,
    targetUserIds: string[],
  ): Promise<Map<string, TFriendshipRow>> {
    if (targetUserIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select()
      .from(friendships)
      .where(
        or(
          and(
            eq(friendships.userOneId, currentUserId),
            inArray(friendships.userTwoId, targetUserIds),
          ),
          and(
            eq(friendships.userTwoId, currentUserId),
            inArray(friendships.userOneId, targetUserIds),
          ),
        ),
      );

    return new Map(
      rows.map((row) => [otherUserId(row, currentUserId), row] as const),
    );
  }

  public async getUsersByIds(userIds: string[]): Promise<TUserRow[]> {
    if (userIds.length === 0) {
      return [];
    }
    return this.db.select().from(users).where(inArray(users.id, userIds));
  }

  public async isFriendsWithAnyUser(
    currentUserId: string,
    targetUserIds: string[],
  ): Promise<boolean> {
    if (targetUserIds.length === 0) {
      return false;
    }
    const [row] = await this.db
      .select({ id: friendships.id })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, 'accepted'),
          or(
            and(
              eq(friendships.userOneId, currentUserId),
              inArray(friendships.userTwoId, targetUserIds),
            ),
            and(
              eq(friendships.userTwoId, currentUserId),
              inArray(friendships.userOneId, targetUserIds),
            ),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  public async areFriends(
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    const row = await this.findByPair(firstUserId, secondUserId);
    return row?.status === 'accepted';
  }
}

export function canonicalFriendPair(
  userId: string,
  otherUserId: string,
): { userOneId: string; userTwoId: string } {
  return userId < otherUserId
    ? { userOneId: userId, userTwoId: otherUserId }
    : { userOneId: otherUserId, userTwoId: userId };
}

export function otherUserId(row: TFriendshipRow, userId: string): string {
  return row.userOneId === userId ? row.userTwoId : row.userOneId;
}

export function relationshipStatusFor(
  row: TFriendshipRow | undefined,
  currentUserId: string,
  targetUserId: string,
): TRelationshipStatus {
  if (currentUserId === targetUserId) {
    return 'self';
  }
  if (!row) {
    return 'none';
  }
  if (row.status === 'accepted') {
    return 'friend';
  }
  return row.requestedByUserId === currentUserId
    ? 'outgoing_pending'
    : 'incoming_pending';
}
