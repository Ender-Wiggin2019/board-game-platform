import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  getOptionsToken,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

interface IThrottleRequest {
  headers?: { authorization?: string };
  ip?: string;
  user?: { sub?: unknown };
}

export function resolveThrottleTracker(
  request: IThrottleRequest,
  verifiedUserId?: string,
): string {
  const userId = verifiedUserId ?? request.user?.sub;
  return typeof userId === 'string' && userId.length > 0
    ? `user:${userId}`
    : `ip:${request.ip ?? 'unknown'}`;
}

/** The browser suite uses an isolated loopback database and many registrations. */
export function isIsolatedE2eThrottleBypass(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (
    env.SETI_E2E_UNTHROTTLED !== '1' ||
    !['development', 'test'].includes(env.NODE_ENV ?? '')
  ) {
    return false;
  }
  const isIsolatedName = (name: string) =>
    /(?:^|[_-])(?:e2e|test)(?:$|[_-])/u.test(name);
  const isLoopback = (host: string) =>
    ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
  if (!env.DATABASE_URL) {
    // The local E2E runner uses PGDATABASE with node-postgres defaults.
    if (env.PGSERVICE || !env.PGDATABASE) return false;
    return (
      isLoopback(env.PGHOST ?? 'localhost') &&
      isLoopback(env.PGHOSTADDR ?? 'localhost') &&
      isIsolatedName(env.PGDATABASE)
    );
  }
  try {
    const databaseUrl = new URL(env.DATABASE_URL);
    return (
      isLoopback(databaseUrl.hostname) &&
      isIsolatedName(decodeURIComponent(databaseUrl.pathname.slice(1)))
    );
  } catch {
    return false;
  }
}

@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  public constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(ThrottlerStorage) storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(JwtService) private readonly jwtService: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  public override canActivate(context: ExecutionContext): Promise<boolean> {
    if (isIsolatedE2eThrottleBypass()) return Promise.resolve(true);
    return super.canActivate(context);
  }

  protected override getTracker(request: IThrottleRequest): Promise<string> {
    return Promise.resolve(
      resolveThrottleTracker(request, this.verifyUserId(request)),
    );
  }

  private verifyUserId(request: IThrottleRequest): string | undefined {
    if (typeof request.user?.sub === 'string') {
      return request.user.sub;
    }
    const [scheme, token] =
      request.headers?.authorization?.trim().split(/\s+/) ?? [];
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return undefined;
    }
    try {
      const payload = this.jwtService.verify<{ sub?: unknown }>(token);
      return typeof payload.sub === 'string' ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  }
}
