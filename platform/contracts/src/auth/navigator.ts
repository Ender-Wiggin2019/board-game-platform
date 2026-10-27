import { ERole } from './roles.js';

export const NAVIGATOR_DURATIONS = [
  '1m',
  '3m',
  '6m',
  '1y',
  'permanent',
] as const;
export type TNavigatorDuration = (typeof NAVIGATOR_DURATIONS)[number];

export interface INavigatorGrant {
  navigatorGrantedAt?: Date | string | null;
  navigatorExpiresAt?: Date | string | null;
}

export interface INavigatorAccess {
  active: boolean;
  source: 'grant' | 'role' | null;
  expiresAt: Date | string | null;
}

export interface INavigatorIdentityPreferences {
  showNavigatorIdentity?: boolean;
}

export function isNavigatorDuration(
  value: unknown,
): value is TNavigatorDuration {
  return (
    typeof value === 'string' &&
    (NAVIGATOR_DURATIONS as readonly string[]).includes(value)
  );
}

export function hasNavigatorGrant(
  grant: INavigatorGrant,
  now = new Date(),
): boolean {
  return (
    Boolean(grant.navigatorGrantedAt) &&
    (grant.navigatorExpiresAt == null ||
      new Date(grant.navigatorExpiresAt).getTime() > now.getTime())
  );
}

export function hasRoleNavigatorAccess(role: ERole): boolean {
  return (
    role === ERole.TESTER || role === ERole.ADMIN || role === ERole.SUPERADMIN
  );
}

export function resolveNavigatorRole(
  baseRole: ERole,
  grant: INavigatorGrant,
  now = new Date(),
): ERole {
  return (baseRole === ERole.GUEST || baseRole === ERole.PLAYER) &&
    hasNavigatorGrant(grant, now)
    ? ERole.NAVIGATOR
    : baseRole;
}

export function getNavigatorAccess(
  baseRole: ERole,
  grant: INavigatorGrant,
  now = new Date(),
): INavigatorAccess {
  if (hasRoleNavigatorAccess(baseRole))
    return { active: true, source: 'role', expiresAt: null };
  const active = hasNavigatorGrant(grant, now);
  return {
    active,
    source: grant.navigatorGrantedAt ? 'grant' : null,
    expiresAt: grant.navigatorExpiresAt ?? null,
  };
}

/**
 * Returns the Navigator marker for public identity projections. Presentation
 * preferences are deliberately structural so games can extend their own
 * preference documents without this package importing them.
 */
export function isNavigatorIdentityVisible(
  access: Pick<INavigatorAccess, 'active'>,
  preferences?: INavigatorIdentityPreferences,
): boolean {
  return access.active && preferences?.showNavigatorIdentity !== false;
}

/** Calendar-month renewal in UTC; a permanent grant is never shortened. */
export function navigatorExpiryForDuration(
  duration: TNavigatorDuration,
  grant: INavigatorGrant,
  now = new Date(),
): Date | null {
  if (
    duration === 'permanent' ||
    (hasNavigatorGrant(grant, now) && grant.navigatorExpiresAt == null)
  )
    return null;
  const start =
    hasNavigatorGrant(grant, now) && grant.navigatorExpiresAt
      ? new Date(grant.navigatorExpiresAt)
      : new Date(now);
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[duration];
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  return start;
}

export const NAVIGATOR_REPLAY_KEEP_LIMIT = 10;
export const PLAYER_REPLAY_KEEP_LIMIT = 3;

export function navigatorReplayKeepLimit(role: ERole): number {
  if (role === ERole.ADMIN || role === ERole.SUPERADMIN) return 50;
  return role === ERole.NAVIGATOR || role === ERole.TESTER
    ? NAVIGATOR_REPLAY_KEEP_LIMIT
    : PLAYER_REPLAY_KEEP_LIMIT;
}
