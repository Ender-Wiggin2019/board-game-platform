import { contractError } from '@board-game/contracts';
import type {
  IPlatformDailyChallengeLeaderboardResponse,
  IPlatformDailyChallengeSettings,
  IPlatformDailyChallengeSettingsPatch,
  IPlatformDailyChallengeStartResponse,
  IPlatformDailyChallengeTodayResponse,
} from '@board-platform/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import type { IPrincipal } from '@/auth/jwt-auth.guard.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PlatformApplicationRuntime } from '../PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from '../PlatformErrorFilter.js';
import { PlatformGameServices } from '../PlatformGameServices.js';
import { validateDailyChallengeDate } from './service.js';

type Request = { user?: IPrincipal };

async function principal(
  platform: PlatformApplicationRuntime,
  request: Request,
): Promise<{ readonly principalId: string }> {
  if (!request.user?.sub || !request.user.sid)
    throw contractError('UNAUTHENTICATED', 'platform.identity.required');
  const resolved = await platform.accountIdentity().resolve({
    principalId: request.user.sub,
    authSessionId: request.user.sid,
  });
  return { principalId: resolved.principalId };
}

/** Account-facing daily challenge entry points for an installed game. */
@Controller('platform/games/:gameId/daily-challenges')
@UseFilters(PlatformErrorFilter)
@UseGuards(RolesGuard)
@Capabilities(ECapability.GAME_PLAY)
export class PlatformDailyChallengeController {
  public constructor(
    @Inject(PlatformGameServices)
    private readonly services: PlatformGameServices,
    @Inject(PlatformApplicationRuntime)
    private readonly platform: PlatformApplicationRuntime,
  ) {}

  @Get('today')
  @Header('Cache-Control', 'no-store')
  public async today(
    @Param('gameId') gameId: string,
    @Req() request: Request,
  ): Promise<IPlatformDailyChallengeTodayResponse> {
    const identity = await principal(this.platform, request);
    return this.services.dailyChallenges.getToday(gameId, identity.principalId);
  }

  @Post('start')
  @Header('Cache-Control', 'no-store')
  public async start(
    @Param('gameId') gameId: string,
    @Req() request: Request,
    @Body() body?: { readonly requestId?: string },
  ): Promise<IPlatformDailyChallengeStartResponse> {
    const identity = await principal(this.platform, request);
    if (
      body !== undefined &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'requestId'))
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.request_id');
    return this.services.dailyChallenges.start(
      gameId,
      identity.principalId,
      new Date(),
      body?.requestId,
    );
  }

  @Get('attempts')
  @Header('Cache-Control', 'no-store')
  public async attempts(
    @Param('gameId') gameId: string,
    @Req() request: Request,
    @Query('date') date?: string,
  ) {
    const identity = await principal(this.platform, request);
    if (date !== undefined) validateDailyChallengeDate(date);
    return this.services.dailyChallenges.getAttempts(
      gameId,
      identity.principalId,
      date,
    );
  }

  @Patch('attempts/:sessionId/publication')
  @Header('Cache-Control', 'no-store')
  public async publication(
    @Param('gameId') gameId: string,
    @Param('sessionId') sessionId: string,
    @Req() request: Request,
    @Body() body: { readonly publicationState: 'public' | 'anonymous' },
  ) {
    const identity = await principal(this.platform, request);
    return this.services.dailyChallenges.updatePublication(
      gameId,
      identity.principalId,
      sessionId,
      body,
    );
  }

  @Get('leaderboards')
  @Header('Cache-Control', 'no-store')
  public async leaderboards(
    @Param('gameId') gameId: string,
    @Req() request: Request,
    @Query('date') date?: string,
  ) {
    const identity = await principal(this.platform, request);
    if (date !== undefined) validateDailyChallengeDate(date);
    return this.services.dailyChallenges.getLeaderboards(
      gameId,
      identity.principalId,
      date,
    );
  }

  @Get('leaderboard')
  @Header('Cache-Control', 'no-store')
  public leaderboard(
    @Param('gameId') gameId: string,
    @Query('date') date?: string,
  ): Promise<IPlatformDailyChallengeLeaderboardResponse> {
    if (date !== undefined) validateDailyChallengeDate(date);
    return this.services.dailyChallenges.leaderboard(gameId, new Date(), date);
  }
}

/** Game-owned settings remain under the game workspace, not platform admin. */
@Controller('platform/games/:gameId/admin/daily-challenges')
@UseFilters(PlatformErrorFilter)
@UseGuards(RolesGuard)
export class PlatformDailyChallengeAdminController {
  public constructor(
    @Inject(PlatformGameServices)
    private readonly services: PlatformGameServices,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  public settings(
    @Param('gameId') gameId: string,
  ): Promise<IPlatformDailyChallengeSettings> {
    return this.services.dailyChallenges.getSettings(gameId);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  public updateSettings(
    @Param('gameId') gameId: string,
    @Body() body: IPlatformDailyChallengeSettingsPatch,
  ): Promise<IPlatformDailyChallengeSettings> {
    return this.services.dailyChallenges.updateSettings(gameId, body);
  }
}
