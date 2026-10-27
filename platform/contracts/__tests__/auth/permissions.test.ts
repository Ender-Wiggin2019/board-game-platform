import { describe, expect, it } from 'vitest';
import {
  can,
  capabilitiesOf,
  ECapability,
} from '../../src/auth/permissions.js';
import { ERole } from '../../src/auth/roles.js';

describe('platform account capabilities', () => {
  it('keeps game lifecycle access separate from operator access', () => {
    expect(can(ERole.GUEST, ECapability.GAME_PLAY)).toBe(false);
    expect(can(ERole.PLAYER, ECapability.GAME_PLAY)).toBe(true);
    expect(can(ERole.PLAYER, ECapability.GAME_MODIFY_ANY)).toBe(false);
    expect(can(ERole.ADMIN, ECapability.GAME_MODIFY_ANY)).toBe(true);
  });

  it('keeps Navigator benefits and management on their original boundaries', () => {
    expect(can(ERole.NAVIGATOR, ECapability.NAVIGATOR_BENEFITS)).toBe(true);
    expect(can(ERole.ADMIN, ECapability.NAVIGATOR_MANAGE)).toBe(false);
    expect(can(ERole.SUPERADMIN, ECapability.NAVIGATOR_MANAGE)).toBe(true);
  });

  it('gives superadmins every platform capability', () => {
    expect(capabilitiesOf(ERole.SUPERADMIN)).toEqual(
      Object.values(ECapability),
    );
  });
});
