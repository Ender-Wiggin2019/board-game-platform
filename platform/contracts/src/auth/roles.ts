/** Account roles shared by platform authentication and game adapters. */
export enum ERole {
  GUEST = 'guest',
  PLAYER = 'player',
  NAVIGATOR = 'navigator',
  TESTER = 'tester',
  ADMIN = 'admin',
  SUPERADMIN = 'superadmin',
}

export const ALL_ROLES: readonly ERole[] = [
  ERole.GUEST,
  ERole.PLAYER,
  ERole.NAVIGATOR,
  ERole.TESTER,
  ERole.ADMIN,
  ERole.SUPERADMIN,
];

export const INVITE_CODE_GRANT_ROLES = [ERole.PLAYER, ERole.TESTER] as const;

export type TInviteCodeGrantRole = (typeof INVITE_CODE_GRANT_ROLES)[number];

export const ROLE_RANK: Record<ERole, number> = {
  [ERole.GUEST]: 0,
  [ERole.PLAYER]: 1,
  [ERole.NAVIGATOR]: 2,
  [ERole.TESTER]: 3,
  [ERole.ADMIN]: 4,
  [ERole.SUPERADMIN]: 5,
};

export function isRole(value: unknown): value is ERole {
  return (
    typeof value === 'string' &&
    (ALL_ROLES as readonly string[]).includes(value)
  );
}

export function isInviteCodeGrantRole(
  value: unknown,
): value is TInviteCodeGrantRole {
  return (
    typeof value === 'string' &&
    (INVITE_CODE_GRANT_ROLES as readonly string[]).includes(value)
  );
}

/** Coerce an arbitrary value (for example, a JWT claim) to a role. */
export function toRole(value: unknown): ERole {
  return isRole(value) ? value : ERole.GUEST;
}

export function isAtLeast(role: ERole, min: ERole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
