import { describe, expect, it } from 'vitest';
import {
  ALL_ROLES,
  ERole,
  INVITE_CODE_GRANT_ROLES,
  isAtLeast,
  isInviteCodeGrantRole,
  isRole,
  toRole,
} from '../../src/auth/roles.js';

describe('platform account roles', () => {
  it('keeps the explicit role vocabulary and rank ordering', () => {
    expect(ALL_ROLES).toEqual([
      ERole.GUEST,
      ERole.PLAYER,
      ERole.NAVIGATOR,
      ERole.TESTER,
      ERole.ADMIN,
      ERole.SUPERADMIN,
    ]);
    expect(isAtLeast(ERole.ADMIN, ERole.NAVIGATOR)).toBe(true);
    expect(isAtLeast(ERole.PLAYER, ERole.ADMIN)).toBe(false);
  });

  it('validates and coerces serialized role values', () => {
    expect(isRole(ERole.PLAYER)).toBe(true);
    expect(isRole('unknown')).toBe(false);
    expect(toRole('unknown')).toBe(ERole.GUEST);
  });

  it('keeps invite grants below operator roles', () => {
    expect(INVITE_CODE_GRANT_ROLES).toEqual([ERole.PLAYER, ERole.TESTER]);
    expect(isInviteCodeGrantRole(ERole.ADMIN)).toBe(false);
  });
});
