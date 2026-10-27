import {
  type INavigatorGrant,
  resolveNavigatorRole,
} from '@board-platform/contracts/auth/navigator';
import { type ERole, isRole } from '@board-platform/contracts/auth/roles';

/** Raised when persisted account data contains a role outside the contract. */
export class InvalidPersistedRoleError extends Error {
  public constructor(role: unknown) {
    super(`Unknown persisted account role: ${String(role)}`);
    this.name = 'InvalidPersistedRoleError';
  }
}

/**
 * Resolve the role that may be used for authorization.
 *
 * The database value is the only authority. Email addresses, JWT role claims,
 * and bootstrap environment variables never participate in this decision.
 */
export function resolveEffectiveRole(
  dbRole: unknown,
  grant: INavigatorGrant = {},
  now = new Date(),
): ERole {
  if (!isRole(dbRole)) {
    throw new InvalidPersistedRoleError(dbRole);
  }
  return resolveNavigatorRole(dbRole, grant, now);
}

/** Resolve an account row while keeping the persisted role as its base role. */
export function resolveUserRole(
  user: Pick<
    {
      role: unknown;
      navigatorGrantedAt?: Date | string | null;
      navigatorExpiresAt?: Date | string | null;
    },
    'role' | 'navigatorGrantedAt' | 'navigatorExpiresAt'
  >,
  now = new Date(),
): ERole {
  return resolveEffectiveRole(
    user.role,
    {
      navigatorGrantedAt: user.navigatorGrantedAt,
      navigatorExpiresAt: user.navigatorExpiresAt,
    },
    now,
  );
}
