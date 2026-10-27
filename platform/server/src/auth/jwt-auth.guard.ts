import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { OPTIONAL_AUTH_KEY } from './optional-auth.decorator.js';
import { PrincipalResolver } from './PrincipalResolver.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

export type { IJwtPayload, IPrincipal } from './PrincipalResolver.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly principalResolver: PrincipalResolver;
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_DB) db: NodePgDatabase,
  ) {
    this.principalResolver = new PrincipalResolver(jwtService, db);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const isOptional = this.reflector.getAllAndOverride<boolean>(
      OPTIONAL_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token && isOptional) return true;
    if (!token) {
      throw new UnauthorizedException({
        message: 'Missing authorization token',
        i18n: { key: 'missing_token' },
      });
    }

    try {
      request.user = await this.principalResolver.resolveToken(token);
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid or expired token',
        i18n: { key: 'invalid_or_expired_token' },
      });
    }

    return true;
  }

  private extractTokenFromHeader(
    request: Record<string, unknown>,
  ): string | undefined {
    const headers = request.headers as Record<string, string> | undefined;
    const authorization = headers?.authorization;
    if (!authorization) {
      return undefined;
    }
    const [type, token] = authorization.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
