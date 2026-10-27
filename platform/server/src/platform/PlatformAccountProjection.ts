import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  assertJsonPayloadSize,
  assertSessionRoute,
  canonicalStableStringify,
  contractError,
  type SessionRoute,
} from '@board-game/contracts';
import {
  Body,
  Controller,
  Header,
  Inject,
  Injectable,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import { Public } from '@/auth/public.decorator.js';
import { resolveUserRole } from '@/auth/roleResolver.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from './PlatformErrorFilter.js';

export const PLATFORM_ACCOUNT_PROJECTION_SCHEMA_VERSION = 1 as const;

export interface PlatformAccountProjection {
  readonly schemaVersion: typeof PLATFORM_ACCOUNT_PROJECTION_SCHEMA_VERSION;
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly principalId: string;
  readonly status: 'active' | 'suspended';
  readonly role: string;
  readonly authRevision: number;
  readonly expiresAt: number;
  readonly sourceDigest: string;
}

interface AccountProjectionRequest {
  readonly route: SessionRoute;
  readonly principalId: string;
}

const ACCOUNT_PROJECTION_TTL_MS = 30_000;

/**
 * The platform-owned account projection boundary. It exposes no user row or
 * game-specific entitlement and only accepts a service credential resolved
 * for the exact approved release binding in the supplied session route.
 */
@Injectable()
export class PlatformAccountProjectionService {
  constructor(private readonly runtime: PlatformApplicationRuntime) {}

  async read(
    headers: IncomingHttpHeaders,
    value: unknown,
  ): Promise<PlatformAccountProjection> {
    const request = parseRequest(value);
    const token = bearerToken(headers);
    if (!token)
      throw contractError(
        'UNAUTHENTICATED',
        'platform.account_projection.credential_required',
      );
    const platformId = this.runtime.options.platformId;
    const registry = this.runtime.releaseRegistry;
    const remoteRuntime = this.runtime.options.remoteRuntime;
    if (!platformId || !registry || !remoteRuntime)
      throw contractError(
        'NOT_READY',
        'platform.account_projection.registry_unavailable',
      );
    const release = await registry.getRelease(
      platformId,
      request.route.gameId,
      request.route.releaseId,
    );
    const binding = await registry.getBinding(
      platformId,
      request.route.backendBindingId,
    );
    if (!release || !binding)
      throw contractError(
        'NOT_FOUND',
        'platform.account_projection.route_unavailable',
      );
    if (
      binding.gameId !== request.route.gameId ||
      binding.releaseId !== request.route.releaseId ||
      binding.storageBindingId !== request.route.storageBindingId ||
      binding.ownershipEpoch !== request.route.ownershipEpoch ||
      !release.approvedModes.includes(request.route.modeId) ||
      !release.service.modes.some((mode) => mode.id === request.route.modeId) ||
      !['ready', 'draining', 'retained'].includes(binding.status)
    )
      throw contractError(
        'FORBIDDEN',
        'platform.account_projection.route_not_approved',
      );
    const admission = await this.runtime.admissionStore.getAdmission(
      request.route.sessionId,
    );
    if (
      !admission ||
      canonicalStableStringify(admission.route) !==
        canonicalStableStringify(request.route) ||
      !admission.participants.some(
        (participant) => participant.principalId === request.principalId,
      )
    )
      throw contractError(
        'FORBIDDEN',
        'platform.account_projection.participant_not_authorized',
      );
    let credential: Awaited<ReturnType<typeof remoteRuntime.resolveCredential>>;
    try {
      credential = await remoteRuntime.resolveCredential(release, binding);
    } catch {
      throw contractError(
        'NOT_READY',
        'platform.account_projection.credential_unavailable',
      );
    }
    if (
      typeof credential.serviceToken !== 'string' ||
      !sameSecret(token, credential.serviceToken)
    )
      throw contractError(
        'UNAUTHENTICATED',
        'platform.account_projection.credential_invalid',
      );
    const account = await this.runtime
      .accountIdentity()
      .account(request.principalId);
    if (!account)
      throw contractError(
        'NOT_FOUND',
        'platform.account_projection.account_unavailable',
      );
    const now = Date.now();
    let role: string;
    try {
      role = resolveUserRole(account, new Date(now));
    } catch {
      throw contractError(
        'FORBIDDEN',
        'platform.account_projection.account_invalid',
      );
    }
    const navigatorExpiry = account.navigatorExpiresAt
      ? new Date(account.navigatorExpiresAt).getTime()
      : undefined;
    const expiresAt =
      navigatorExpiry !== undefined &&
      Number.isFinite(navigatorExpiry) &&
      navigatorExpiry > now
        ? Math.min(now + ACCOUNT_PROJECTION_TTL_MS, navigatorExpiry)
        : now + ACCOUNT_PROJECTION_TTL_MS;
    const projection = {
      schemaVersion: PLATFORM_ACCOUNT_PROJECTION_SCHEMA_VERSION,
      gameId: request.route.gameId,
      releaseId: request.route.releaseId,
      backendBindingId: request.route.backendBindingId,
      storageBindingId: request.route.storageBindingId,
      ownershipEpoch: request.route.ownershipEpoch,
      principalId: request.principalId,
      status:
        account.accountStatus === 'active'
          ? ('active' as const)
          : ('suspended' as const),
      role,
      // Both counters advance for their respective authorization mutations.
      // Their sum is monotonic even when the other counter is already larger,
      // and does not let a millisecond timestamp hide a same-tick change.
      authRevision: Math.max(
        1,
        account.sessionVersion + account.permissionVersion,
      ),
      expiresAt,
    };
    return {
      ...projection,
      sourceDigest: createHash('sha256')
        .update(canonicalStableStringify(projection))
        .digest('hex'),
    };
  }
}

@Controller('platform/runtime')
@UseFilters(PlatformErrorFilter)
export class PlatformAccountProjectionController {
  constructor(
    @Inject(PlatformAccountProjectionService)
    private readonly projection: PlatformAccountProjectionService,
  ) {}

  @Post('account-projection')
  @Public()
  @Header('Cache-Control', 'no-store')
  read(
    @Req() request: { headers: IncomingHttpHeaders },
    @Body() body: unknown,
  ) {
    return this.projection.read(request.headers, body);
  }
}

function parseRequest(value: unknown): AccountProjectionRequest {
  assertJsonPayloadSize(value, 64 * 1024);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw contractError('INVALID_REQUEST', 'platform.request.invalid');
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !['route', 'principalId'].includes(key),
    ) ||
    Object.keys(candidate).length !== 2 ||
    typeof candidate.principalId !== 'string' ||
    candidate.principalId.length < 1 ||
    candidate.principalId.length > 256
  )
    throw contractError('INVALID_REQUEST', 'platform.request.invalid');
  assertSessionRoute(candidate.route);
  return {
    route: candidate.route,
    principalId: candidate.principalId,
  };
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (typeof value !== 'string') return undefined;
  const [kind, token, ...extra] = value.trim().split(/\s+/);
  return kind === 'Bearer' && token && extra.length === 0 ? token : undefined;
}

function sameSecret(left: string, right: string): boolean {
  const first = createHash('sha256').update(left).digest();
  const second = createHash('sha256').update(right).digest();
  return timingSafeEqual(first, second);
}
