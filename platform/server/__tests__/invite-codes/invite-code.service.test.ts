import { ERole } from '@board-platform/contracts/auth/roles';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateInviteCodeRedemption } from '@/invite-codes/invite-code.service.js';

const now = new Date('2026-01-01T00:00:00.000Z');
type TInviteCodeFixture = Parameters<
  typeof validateInviteCodeRedemption
>[0]['inviteCode'];

function code(overrides: Partial<TInviteCodeFixture> = {}): TInviteCodeFixture {
  return {
    role: ERole.PLAYER,
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    maxUses: 2,
    disabledAt: null,
    ...overrides,
  };
}

describe('validateInviteCodeRedemption', () => {
  it('accepts a higher role and rejects equal or lower roles', () => {
    expect(() =>
      validateInviteCodeRedemption({
        inviteCode: code(),
        usedCount: 0,
        alreadyRedeemed: false,
        currentRole: ERole.GUEST,
        now,
      }),
    ).not.toThrow();

    expect(() =>
      validateInviteCodeRedemption({
        inviteCode: code(),
        usedCount: 0,
        alreadyRedeemed: false,
        currentRole: ERole.PLAYER,
        now,
      }),
    ).toThrow('Invite code does not grant a higher role');
  });

  it('keeps expiry and capacity failures as stable HTTP errors', () => {
    expect(() =>
      validateInviteCodeRedemption({
        inviteCode: code({ expiresAt: now }),
        usedCount: 0,
        alreadyRedeemed: false,
        currentRole: ERole.GUEST,
        now,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateInviteCodeRedemption({
        inviteCode: code({ maxUses: 1 }),
        usedCount: 1,
        alreadyRedeemed: false,
        currentRole: ERole.GUEST,
        now,
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects retired Navigator invite roles', () => {
    expect(() =>
      validateInviteCodeRedemption({
        inviteCode: code({ role: ERole.NAVIGATOR }),
        usedCount: 0,
        alreadyRedeemed: false,
        currentRole: ERole.GUEST,
        now,
      }),
    ).toThrow('Invite code role is no longer valid');
  });
});
