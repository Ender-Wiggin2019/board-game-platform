import {
  can,
  type ECapability,
} from '@board-platform/contracts/auth/permissions';
import { type ERole, isRole } from '@board-platform/contracts/auth/roles';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { CAPABILITIES_KEY } from './capabilities.decorator.js';
import type { IPrincipal } from './PrincipalResolver.js';
import { ROLES_KEY } from './roles.decorator.js';

/**
 * Allows a request only if the authenticated user's role is in the route's
 * `@Roles(...)` list. Runs after the global `JwtAuthGuard`, which populates
 * `request.user`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(DRIZZLE_DB) _db: NodePgDatabase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ERole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredCapabilities = this.reflector.getAllAndOverride<
      ECapability[] | undefined
    >(CAPABILITIES_KEY, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<{ user?: IPrincipal }>();
    const principal = request.user;
    if (!principal?.sub || !isRole(principal.role)) {
      throw new UnauthorizedException({
        message: 'Authentication required',
        i18n: { key: 'auth_required' },
      });
    }
    const role = principal.role;

    if (!required || required.length === 0) {
      if (
        requiredCapabilities?.some((capability) => !can(role, capability)) ===
        true
      ) {
        throw new ForbiddenException('Insufficient capability');
      }
      return true;
    }
    if (!required.includes(role)) {
      throw new ForbiddenException('Insufficient role');
    }
    if (
      requiredCapabilities?.some((capability) => !can(role, capability)) ===
      true
    ) {
      throw new ForbiddenException('Insufficient capability');
    }
    return true;
  }
}
