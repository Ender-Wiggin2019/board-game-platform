import { ERole } from '@board-platform/contracts/auth/roles';
import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JWT_AUDIENCE, DEFAULT_JWT_ISSUER } from '@/auth/jwtConfig.js';
import { PrincipalResolver } from '@/auth/PrincipalResolver.js';
import { UserRepository } from '@/persistence/repository/UserRepository.js';

const exp = Math.floor(Date.now() / 1000) + 3600;
const VALID_TOKEN_CLAIMS = {
  iss: DEFAULT_JWT_ISSUER,
  aud: DEFAULT_JWT_AUDIENCE,
};

function resolver(
  payload: Record<string, unknown>,
  userOverrides: Record<string, unknown> = {},
) {
  const verify = vi.fn().mockReturnValue({
    ...VALID_TOKEN_CLAIMS,
    sid: 'session-1',
    ...payload,
  });
  const user = {
    id: 'user-1',
    email: 'current@example.com',
    role: ERole.PLAYER,
    sessionVersion: 3,
    accountStatus: 'active',
    emailVerifiedAt: new Date(),
    ...userOverrides,
  };
  vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue(
    user as never,
  );
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
  };
  const db = { select: vi.fn().mockReturnValue(query) };
  return {
    resolver: new PrincipalResolver({ verify } as never, db as never),
    verify,
  };
}

describe('PrincipalResolver', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses current DB identity and role while preserving the token expiry', async () => {
    const { resolver: instance, verify } = resolver({
      sub: 'user-1',
      email: 'stale@example.com',
      role: ERole.SUPERADMIN,
      sessionVersion: 3,
      exp,
    });

    await expect(instance.resolveToken('token')).resolves.toMatchObject({
      sub: 'user-1',
      email: 'current@example.com',
      role: ERole.PLAYER,
      sessionVersion: 3,
      exp,
    });
    expect(verify).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ algorithms: ['HS256'] }),
    );
  });

  it('recomputes an expired Navigator grant instead of trusting the JWT role', async () => {
    const { resolver: instance } = resolver(
      {
        sub: 'user-1',
        email: 'stale@example.com',
        role: ERole.NAVIGATOR,
        sessionVersion: 3,
        exp,
      },
      {
        role: ERole.PLAYER,
        navigatorGrantedAt: new Date('2020-01-01T11:00:00.000Z'),
        navigatorExpiresAt: new Date('2020-01-01T11:30:00.000Z'),
      },
    );

    await expect(instance.resolveToken('token')).resolves.toMatchObject({
      role: ERole.PLAYER,
    });
  });

  it('pins issuer and audience in production verification', async () => {
    const verify = vi.fn().mockReturnValue({
      ...VALID_TOKEN_CLAIMS,
      sid: 'session-1',
      sub: 'user-1',
      email: 'u@example.com',
      sessionVersion: 3,
      exp,
    });
    vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue({
      id: 'user-1',
      email: 'current@example.com',
      role: ERole.PLAYER,
      sessionVersion: 3,
      accountStatus: 'active',
      emailVerifiedAt: new Date(),
    } as never);
    const query = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
    };
    const db = { select: vi.fn().mockReturnValue(query) };
    const instance = new PrincipalResolver({ verify } as never, db as never);

    await instance.resolveToken('token');

    expect(verify).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        algorithms: ['HS256'],
        issuer: DEFAULT_JWT_ISSUER,
        audience: DEFAULT_JWT_AUDIENCE,
      }),
    );
  });

  it.each([
    ['sessionVersion', { sub: 'user-1', email: 'u@example.com', exp }],
    ['exp', { sub: 'user-1', email: 'u@example.com', sessionVersion: 3 }],
  ])('rejects tokens missing %s', async (_claim, payload) => {
    const { resolver: instance } = resolver(payload);
    await expect(instance.resolveToken('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['issuer', { iss: 'other-server' }],
    ['audience', { aud: 'other-client' }],
  ])('rejects tokens with an invalid %s claim', async (_claim, claims) => {
    const { resolver: instance } = resolver({
      sub: 'user-1',
      email: 'u@example.com',
      sessionVersion: 3,
      exp,
      ...claims,
    });

    await expect(instance.resolveToken('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an unknown persisted role instead of falling back to guest', async () => {
    vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue({
      id: 'user-1',
      email: 'current@example.com',
      role: 'legacy-role',
      sessionVersion: 3,
      accountStatus: 'active',
      emailVerifiedAt: new Date(),
    } as never);
    const instance = new PrincipalResolver(
      {
        verify: vi.fn().mockReturnValue({
          ...VALID_TOKEN_CLAIMS,
          sid: 'session-1',
          sub: 'user-1',
          email: 'u@example.com',
          sessionVersion: 3,
          emailVerifiedAt: new Date(),
          exp,
        }),
      } as never,
      {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        }),
      } as never,
    );

    await expect(instance.resolveToken('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an account with a missing persisted session version', async () => {
    vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue({
      id: 'user-1',
      email: 'current@example.com',
      role: ERole.PLAYER,
      sessionVersion: undefined,
      accountStatus: 'active',
      emailVerifiedAt: new Date(),
    } as never);
    const instance = new PrincipalResolver(
      {
        verify: vi.fn().mockReturnValue({
          ...VALID_TOKEN_CLAIMS,
          sid: 'session-1',
          sub: 'user-1',
          email: 'u@example.com',
          sessionVersion: 0,
          exp,
        }),
      } as never,
      {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([{ id: 'session-1' }]),
        }),
      } as never,
    );

    await expect(instance.resolveToken('token')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an account with a missing account status', async () => {
    const { resolver: instance } = resolver(
      {
        sub: 'user-1',
        email: 'u@example.com',
        sessionVersion: 3,
        exp,
      },
      { accountStatus: undefined },
    );

    await expect(instance.resolveToken('token')).rejects.toThrow(
      'Account is not active',
    );
  });

  it.each([undefined, null])(
    'allows an active account with an unverified email timestamp of %s',
    async (emailVerifiedAt) => {
      const { resolver: instance } = resolver(
        {
          sub: 'user-1',
          email: 'u@example.com',
          sessionVersion: 3,
          exp,
        },
        { emailVerifiedAt },
      );

      await expect(instance.resolveToken('token')).resolves.toMatchObject({
        sub: 'user-1',
        email: 'current@example.com',
        role: ERole.PLAYER,
      });
    },
  );
});
