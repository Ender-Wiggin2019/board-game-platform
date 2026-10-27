import { describe, expect, it } from 'vitest';
import {
  getNavigatorAccess,
  hasNavigatorGrant,
  isNavigatorDuration,
  isNavigatorIdentityVisible,
  navigatorExpiryForDuration,
  resolveNavigatorRole,
} from '../../src/auth/navigator.js';
import { ERole } from '../../src/auth/roles.js';

const now = new Date('2026-01-31T12:34:56.000Z');
const grant = {
  navigatorGrantedAt: '2026-01-01T00:00:00.000Z',
  navigatorExpiresAt: '2026-02-28T12:34:56.000Z',
};

describe('platform Navigator access', () => {
  it.each([ERole.GUEST, ERole.PLAYER])(
    'restores the %s base role at the exact deadline',
    (role) => {
      expect(resolveNavigatorRole(role, grant, now)).toBe(ERole.NAVIGATOR);
      expect(
        resolveNavigatorRole(role, grant, new Date(grant.navigatorExpiresAt)),
      ).toBe(role);
      expect(resolveNavigatorRole(role, {}, now)).toBe(role);
    },
  );

  it('distinguishes never granted, expired, and permanent access', () => {
    expect(getNavigatorAccess(ERole.PLAYER, {}, now)).toEqual({
      active: false,
      source: null,
      expiresAt: null,
    });
    expect(
      getNavigatorAccess(
        ERole.PLAYER,
        grant,
        new Date(grant.navigatorExpiresAt),
      ),
    ).toEqual({
      active: false,
      source: 'grant',
      expiresAt: grant.navigatorExpiresAt,
    });
    expect(
      hasNavigatorGrant(
        { navigatorGrantedAt: now, navigatorExpiresAt: null },
        new Date('2100-01-01'),
      ),
    ).toBe(true);
    expect(
      hasNavigatorGrant({ navigatorExpiresAt: grant.navigatorExpiresAt }, now),
    ).toBe(false);
  });

  it('preserves permanent role benefits', () => {
    for (const role of [ERole.TESTER, ERole.ADMIN, ERole.SUPERADMIN]) {
      expect(resolveNavigatorRole(role, grant, now)).toBe(role);
      expect(getNavigatorAccess(role, {}, now)).toEqual({
        active: true,
        source: 'role',
        expiresAt: null,
      });
    }
  });

  it.each([
    [true, undefined, true],
    [true, {}, true],
    [true, { showNavigatorIdentity: true }, true],
    [true, { showNavigatorIdentity: false }, false],
    [false, { showNavigatorIdentity: true }, false],
  ] as const)(
    'projects public Navigator identity from access and preference',
    (active, preferences, expected) => {
      expect(isNavigatorIdentityVisible({ active }, preferences)).toBe(
        expected,
      );
    },
  );
});

describe('Navigator durations', () => {
  it.each([
    ['1m', '2026-02-28T12:34:56.000Z'],
    ['3m', '2026-04-30T12:34:56.000Z'],
    ['6m', '2026-07-31T12:34:56.000Z'],
    ['1y', '2027-01-31T12:34:56.000Z'],
  ] as const)(
    'adds %s calendar months with month-end clamping',
    (duration, expected) => {
      expect(navigatorExpiryForDuration(duration, {}, now)?.toISOString()).toBe(
        expected,
      );
    },
  );

  it('handles leap years and renewal without losing remaining time', () => {
    expect(
      navigatorExpiryForDuration(
        '1y',
        {},
        new Date('2024-02-29T12:00:00Z'),
      )?.toISOString(),
    ).toBe('2025-02-28T12:00:00.000Z');
    expect(navigatorExpiryForDuration('3m', grant, now)?.toISOString()).toBe(
      '2026-05-28T12:34:56.000Z',
    );
  });

  it('accepts only the five duration choices', () => {
    expect(isNavigatorDuration('1m')).toBe(true);
    expect(isNavigatorDuration('permanent')).toBe(true);
    for (const invalid of [1, '2m', '', null, 'forever'])
      expect(isNavigatorDuration(invalid)).toBe(false);
  });
});
