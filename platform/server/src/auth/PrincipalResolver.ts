import { type ERole } from '@board-platform/contracts/auth/roles';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { UserRepository } from '@/persistence/repository/UserRepository.js';
import { findActiveSession } from './active-session.js';
import {
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_ISSUER,
  getJwtVerifyOptions,
} from './jwtConfig.js';
import { InvalidPersistedRoleError, resolveUserRole } from './roleResolver.js';

/** Claims accepted from a signed bearer token before DB authority is applied. */
export interface IJwtPayload {
  sub: string;
  email: string;
  role?: unknown;
  sid?: string;
  sessionVersion?: number;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
}

/** Request/socket identity after current account state has been resolved. */
export interface IPrincipal extends IJwtPayload {
  sid: string;
  role: ERole;
  sessionVersion: number;
  exp: number;
}

export class PrincipalResolver {
  private readonly userRepo: UserRepository;
  private readonly db: NodePgDatabase;

  public constructor(
    private readonly jwtService: JwtService,
    db: NodePgDatabase,
  ) {
    this.db = db;
    this.userRepo = new UserRepository(db);
  }

  public async resolveToken(token: string): Promise<IPrincipal> {
    let payload: IJwtPayload;
    try {
      payload = this.jwtService.verify<IJwtPayload>(
        token,
        getJwtVerifyOptions(),
      );
      this.assertClaims(payload);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.userRepo.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const expectedSessionVersion = user.sessionVersion;
    if (
      !Number.isSafeInteger(expectedSessionVersion) ||
      expectedSessionVersion < 0
    ) {
      throw new UnauthorizedException('Account has an invalid session version');
    }
    if (payload.sessionVersion !== expectedSessionVersion) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    if (user.accountStatus !== 'active') {
      throw new UnauthorizedException('Account is not active');
    }
    if (!payload.sid) {
      throw new UnauthorizedException('Token is missing a session id');
    }
    const session = await findActiveSession(this.db, payload.sid, user.id);
    if (!session) {
      throw new UnauthorizedException('Session is revoked or expired');
    }

    let role: ERole;
    try {
      role = resolveUserRole(user);
    } catch (error) {
      if (error instanceof InvalidPersistedRoleError) {
        throw new UnauthorizedException('Account has an invalid role');
      }
      throw error;
    }

    return {
      ...payload,
      sub: user.id,
      email: user.email,
      sid: session.id,
      role,
      sessionVersion: expectedSessionVersion,
      exp: payload.exp as number,
    };
  }

  private assertClaims(payload: IJwtPayload): void {
    if (
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.length === 0 ||
      typeof payload.sid !== 'string' ||
      payload.sid.length === 0 ||
      payload.iss !== DEFAULT_JWT_ISSUER ||
      !hasExpectedAudience(payload.aud) ||
      !Number.isSafeInteger(payload.sessionVersion) ||
      (payload.sessionVersion as number) < 0 ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.exp as number) <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException('Invalid token claims');
    }
  }
}

function hasExpectedAudience(audience: IJwtPayload['aud']): boolean {
  return Array.isArray(audience)
    ? audience.includes(DEFAULT_JWT_AUDIENCE)
    : audience === DEFAULT_JWT_AUDIENCE;
}
