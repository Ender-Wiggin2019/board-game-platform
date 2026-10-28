import {
  assertJsonPayloadSize,
  contractError,
  type GameCatalogEntry,
  isJsonValue,
} from '@board-game/contracts';
import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import type { IPrincipal } from '@/auth/jwt-auth.guard.js';
import { resolveUserRole } from '@/auth/roleResolver.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { GameCapabilityService } from './capabilities/index.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from './PlatformErrorFilter.js';
import {
  type PlatformCatalogEntry,
  PlatformReleaseAdministration,
} from './PlatformReleaseAdministration.js';
import {
  assertPlatformFeature,
  PLATFORM_CONFIGURATION,
  type PlatformPublicConfiguration,
} from './platform-configuration.js';

type Request = { user: IPrincipal };
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  )
    throw contractError('INVALID_REQUEST', 'platform.request.identifier');
  return value;
}

@Controller('platform/games')
@UseFilters(PlatformErrorFilter)
export class PlatformCapabilitiesController {
  constructor(
    @Inject(PlatformApplicationRuntime)
    private readonly platform: PlatformApplicationRuntime,
    @Inject(GameCapabilityService)
    private readonly capabilities: GameCapabilityService,
    @Optional()
    @Inject(PlatformReleaseAdministration)
    private readonly releases?: PlatformReleaseAdministration,
    @Optional()
    @Inject(PLATFORM_CONFIGURATION)
    private readonly configuration?: PlatformPublicConfiguration,
  ) {}

  private async principal(request: Request) {
    if (!request.user?.sub || !request.user.sid)
      throw contractError('UNAUTHENTICATED', 'platform.identity.required');
    return this.platform.accountIdentity().resolve({
      principalId: request.user.sub,
      authSessionId: request.user.sid,
    });
  }

  private release(gameId: string): string {
    return this.platform.game(identifier(gameId)).releaseId;
  }

  private async target(
    query: Record<string, unknown>,
    fallback: string,
  ): Promise<string> {
    if (Object.keys(query).some((key) => key !== 'principalId'))
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    if (query.principalId === undefined) return fallback;
    const principalId = identifier(query.principalId);
    await this.platform.accountIdentity().resolvePublicAccount(principalId);
    return principalId;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  catalog():
    | readonly GameCatalogEntry[]
    | Promise<readonly GameCatalogEntry[]> {
    const current = this.capabilities
      .list()
      .filter((entry) => this.isCurrentRelease(entry));
    if (
      !this.platform.releaseRegistry ||
      !this.platform.options.platformId ||
      !this.releases
    )
      return current;
    return this.registryCatalog(current);
  }

  private isCurrentRelease(entry: GameCatalogEntry): boolean {
    try {
      return (
        this.platform.releaseGame(entry.metadata.gameId, entry.releaseId)
          .releaseId === entry.releaseId
      );
    } catch {
      try {
        return (
          this.platform.game(entry.metadata.gameId).releaseId ===
          entry.releaseId
        );
      } catch {
        return false;
      }
    }
  }

  private async registryCatalog(
    current: readonly GameCatalogEntry[],
  ): Promise<readonly GameCatalogEntry[]> {
    const platformId = this.platform.options.platformId;
    const registry = this.platform.releaseRegistry;
    const releases = this.releases;
    if (!platformId || !registry || !releases) return current;
    const publicModes =
      (await releases.platformCatalog()) as readonly PlatformCatalogEntry[];
    const selectedReleases = new Set(
      publicModes.map((entry) => `${entry.gameId}\u0000${entry.releaseId}`),
    );
    const registeredReleases = await registry.listReleases(platformId);
    const registeredKeys = new Set(
      registeredReleases.map(
        (release) => `${release.gameId}\u0000${release.releaseId}`,
      ),
    );
    // Entries from the local capability registry are still public. Entries
    // backed by the platform release registry must be selected by the public
    // catalog; this prevents retained/installed remote releases from leaking
    // through after a channel switch or drain.
    const visibleCurrent = current.filter((entry) => {
      const key = `${entry.metadata.gameId}\u0000${entry.releaseId}`;
      return !registeredKeys.has(key) || selectedReleases.has(key);
    });
    if (selectedReleases.size === 0) return visibleCurrent;
    const existing = new Set(
      visibleCurrent.map(
        (entry) => `${entry.metadata.gameId}\u0000${entry.releaseId}`,
      ),
    );
    const remote = registeredReleases
      .filter((release) =>
        selectedReleases.has(`${release.gameId}\u0000${release.releaseId}`),
      )
      .filter(
        (release) =>
          !existing.has(`${release.gameId}\u0000${release.releaseId}`),
      )
      .map((release) => ({
        metadata: structuredClone(release.service.metadata),
        releaseId: release.releaseId,
        // Only explicitly approved, descriptor-backed features cross this
        // boundary; manifest declarations alone are never sufficient.
        capabilities:
          release.approvedFeatures?.includes('statistics') &&
          release.service.statistics !== undefined
            ? (['statistics'] as const)
            : [],
        policyVersions: [],
        assets: [],
      }));
    return [...visibleCurrent, ...remote];
  }

  @Get(':gameId/profile')
  @Header('Cache-Control', 'no-store')
  async profile(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    const principal = await this.principal(request);
    const principalId = await this.target(query, principal.principalId);
    const profile = await this.capabilities.getProfile(
      gameId,
      this.release(gameId),
      principalId,
    );
    if (principalId === principal.principalId) return profile;
    const { wallet: _privateWallet, ...publicProfile } = profile;
    return publicProfile;
  }

  @Get(':gameId/achievements')
  @Header('Cache-Control', 'no-store')
  async achievements(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    const principal = await this.principal(request);
    return this.capabilities.getAchievements(
      gameId,
      this.release(gameId),
      await this.target(query, principal.principalId),
    );
  }

  @Get(':gameId/wallet')
  @Header('Cache-Control', 'no-store')
  async wallet(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    if (Object.keys(query).length)
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    const principal = await this.principal(request);
    return this.capabilities.getWallet(
      gameId,
      this.release(gameId),
      principal.principalId,
    );
  }

  @Get(':gameId/rankings')
  @Header('Cache-Control', 'no-store')
  async rankings(@Req() request: Request, @Param('gameId') gameId: string) {
    assertPlatformFeature(this.configuration, 'rankings');
    const principal = await this.principal(request);
    return this.capabilities.getRankings(
      gameId,
      this.release(gameId),
      principal.principalId,
    );
  }

  @Get(':gameId/stats')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  @Header('Cache-Control', 'no-store')
  async statistics(@Req() request: Request, @Param('gameId') gameId: string) {
    const principal = await this.principal(request);
    return this.capabilities.getStatistics(
      gameId,
      this.release(gameId),
      principal.principalId,
    );
  }

  @Post(':gameId/statistics/:operation')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  @Header('Cache-Control', 'no-store')
  async nativeStatistics(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Param('operation') operation: string,
    @Body() query: unknown,
  ) {
    const game = identifier(gameId);
    const releaseId = this.release(game);
    const operationKey = identifier(operation);
    const descriptor = this.capabilities.statisticsOperation(
      game,
      releaseId,
      operationKey,
    );
    if (!descriptor)
      throw contractError(
        'NOT_READY',
        'platform.game.capability.statistics_unavailable',
      );
    if (
      !isJsonValue(query) ||
      query === null ||
      typeof query !== 'object' ||
      Array.isArray(query)
    )
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    if (
      [
        'accessContext',
        'route',
        'principalId',
        'scopes',
        'releaseId',
        'backendBindingId',
        'storageBindingId',
        'ownershipEpoch',
      ].some((key) => Object.hasOwn(query, key))
    )
      throw contractError(
        'FORBIDDEN',
        'platform.statistics.identity_forbidden',
      );
    assertJsonPayloadSize(query, 256 * 1024, 'statistics.query');
    const current = await this.principalWithStatisticsScopes(request);
    const installed = this.platform.releaseGame(game, releaseId);
    const response = await this.capabilities.queryStatistics(game, releaseId, {
      protocolVersion: 1,
      route: {
        gameId: game,
        releaseId,
        backendBindingId: installed.backendBindingId,
        storageBindingId: installed.storageBindingId,
        ownershipEpoch: installed.ownershipEpoch,
      },
      operation: descriptor.key,
      audience: descriptor.audience,
      accessContext: {
        principalId: current.identity.principalId,
        authEpoch: current.identity.authEpoch,
        scopes: current.scopes,
      },
      query,
    });
    return response.payload;
  }

  private async principalWithStatisticsScopes(request: Request) {
    if (!request.user?.sub || !request.user.sid)
      throw contractError('UNAUTHENTICATED', 'platform.identity.required');
    const current = await this.platform.accountIdentity().resolveCurrent({
      principalId: request.user.sub,
      authSessionId: request.user.sid,
    });
    const role = resolveUserRole(current.account);
    const scopes = ['statistics:read'];
    if (can(role, ECapability.NAVIGATOR_BENEFITS))
      scopes.push('statistics:personal-details', 'statistics:extended-range');
    return { ...current, scopes };
  }
}
