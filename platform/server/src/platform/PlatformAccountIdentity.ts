import { contractError } from '@board-game/contracts';
import type {
  PlatformIdentityReference,
  ResolvedIdentity,
} from '@board-game/core';
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { findActiveSession } from '../auth/active-session.js';
import { FriendRepository } from '../persistence/repository/FriendRepository.js';
import { users } from '../persistence/schema/users.js';

/** The account fields needed by platform identity policy decisions. */
export interface PlatformIdentityAccount {
  readonly id: string;
  readonly accountStatus: string;
  readonly sessionVersion: number;
  readonly permissionVersion: number;
  readonly role: unknown;
  readonly navigatorGrantedAt: Date | string | null;
  readonly navigatorExpiresAt: Date | string | null;
  /** Platform account mutations advance this timestamp even when versions do not. */
  readonly updatedAt?: Date | string | null;
}

/** Account authority exists even when no games are installed. */
export class PlatformAccountIdentity {
  constructor(
    private readonly baseDb: NodePgDatabase,
    private readonly currentDatabase?: () => NodePgDatabase,
  ) {}
  private get db(): NodePgDatabase {
    return this.currentDatabase?.() ?? this.baseDb;
  }

  async resolve(
    reference: PlatformIdentityReference,
  ): Promise<ResolvedIdentity> {
    return (await this.resolveCurrent(reference)).identity;
  }

  async resolveCurrent(reference: PlatformIdentityReference) {
    const account = await this.account(reference.principalId);
    if (
      !account ||
      account.accountStatus !== 'active' ||
      !(await findActiveSession(
        this.db,
        reference.authSessionId,
        reference.principalId,
      ))
    )
      throw contractError('UNAUTHENTICATED', 'platform.identity.inactive');
    return {
      account,
      identity: {
        principalId: account.id,
        authEpoch: JSON.stringify([
          reference.authSessionId,
          account.sessionVersion,
          account.permissionVersion,
        ]),
        active: true,
      },
    };
  }

  async resolvePublicAccount(
    principalId: string,
  ): Promise<PlatformIdentityAccount> {
    if (
      typeof principalId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        principalId,
      )
    )
      throw contractError('INVALID_REQUEST', 'platform.request.identifier');
    const account = await this.account(principalId);
    if (!account || account.accountStatus !== 'active')
      throw contractError('NOT_FOUND', 'platform.identity.public_account');
    return account;
  }

  async publicNames(
    principalIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (!principalIds.length) return new Map();
    const rows = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...principalIds]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  async areFriends(firstId: string, secondId: string): Promise<boolean> {
    return new FriendRepository(this.db).areFriends(firstId, secondId);
  }

  async account(
    principalId: string,
  ): Promise<PlatformIdentityAccount | undefined> {
    const [account] = await this.db
      .select({
        id: users.id,
        accountStatus: users.accountStatus,
        sessionVersion: users.sessionVersion,
        permissionVersion: users.permissionVersion,
        role: users.role,
        navigatorGrantedAt: users.navigatorGrantedAt,
        navigatorExpiresAt: users.navigatorExpiresAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, principalId))
      .limit(1);
    return account;
  }
}
