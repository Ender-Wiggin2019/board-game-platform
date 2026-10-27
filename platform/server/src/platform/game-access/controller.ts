import { contractError } from '@board-game/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PlatformErrorFilter } from '../PlatformErrorFilter.js';
import {
  input,
  type PlatformRequest as Request,
  reference,
  text,
} from '../request.js';
import { GameAccessService } from './service.js';

@Controller('platform/game-access')
@UseFilters(PlatformErrorFilter)
export class GameAccessController {
  constructor(
    @Inject(GameAccessService)
    private readonly access: GameAccessService,
  ) {}

  @Get('catalog')
  catalog() {
    return this.access.catalog();
  }

  @Post(':gameId/codes')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  async createCode(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['entitlement', 'maxUses', 'expiresAt']);
    const expiresAt =
      value.expiresAt === undefined
        ? undefined
        : this.date(value.expiresAt, 'platform.game_access.expires_at');
    const identity = reference(request);
    return this.access.createCode({
      actorId: identity.principalId,
      gameId: text(gameId),
      entitlement: text(value.entitlement),
      ...(value.maxUses === undefined
        ? {}
        : { maxUses: value.maxUses as number }),
      ...(expiresAt ? { expiresAt } : {}),
    });
  }

  @Get(':gameId/codes')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  listCodes(@Param('gameId') gameId: string) {
    return this.access.listCodes(text(gameId));
  }

  @Post(':gameId/codes/:codeId/revoke')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  revokeCode(@Param('gameId') gameId: string, @Param('codeId') codeId: string) {
    return this.access.revokeCode(text(gameId), text(codeId));
  }

  @Post(':gameId/redeem')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  redeem(
    @Req() request: Request,
    @Param('gameId') gameId: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['code']);
    return this.access.redeem(
      text(gameId),
      reference(request).principalId,
      text(value.code),
    );
  }

  @Get(':gameId/grants')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  grants(@Req() request: Request, @Param('gameId') gameId: string) {
    return this.access.grants(text(gameId), reference(request).principalId);
  }

  private date(value: unknown, key: string): Date {
    if (typeof value !== 'string') throw contractError('INVALID_REQUEST', key);
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()))
      throw contractError('INVALID_REQUEST', key);
    return parsed;
  }
}
