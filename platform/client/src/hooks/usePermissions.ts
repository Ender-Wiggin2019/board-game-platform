import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import { ERole, toRole } from '@board-platform/contracts/auth/roles';
import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore.js';

/**
 * Resolve the role used by client capability gates from the server projection.
 * A time-bound grant can leave an old JWT role in memory until `/auth/me`
 * refreshes, so an explicitly expired Navigator projection must fall back to
 * its stable base role immediately.
 */
export function effectiveAuthRole(
  user:
    | {
        role?: string;
        baseRole?: ERole | string;
        navigator?: { active: boolean; expiresAt?: Date | string | null };
      }
    | null
    | undefined,
): ERole {
  const role = toRole(user?.role);
  const baseRole = user?.baseRole ? toRole(user.baseRole) : undefined;

  if (!user?.navigator || !baseRole) {
    return role;
  }

  if (
    baseRole === ERole.TESTER ||
    baseRole === ERole.ADMIN ||
    baseRole === ERole.SUPERADMIN
  ) {
    return baseRole;
  }

  const expiresAtMs = user.navigator.expiresAt
    ? new Date(user.navigator.expiresAt).getTime()
    : null;
  const active =
    user.navigator.active &&
    (expiresAtMs === null ||
      (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()));
  return active ? ERole.NAVIGATOR : baseRole;
}

/** Shared reactive access to the common role capability configuration. */
export function usePermissions() {
  const user = useAuthStore((state) => state.user);
  const [expiryTick, setExpiryTick] = useState(0);
  const expiresAt = user?.navigator?.expiresAt;
  useEffect(() => {
    if (expiresAt == null) return;
    const delay = new Date(expiresAt).getTime() - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = setTimeout(
      () => setExpiryTick((current) => current + 1),
      Math.min(delay + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, expiryTick]);
  const role = effectiveAuthRole(user);
  const hasPermission = useCallback(
    (permission: ECapability) => can(role, permission),
    [role],
  );
  return { role, can: hasPermission };
}
