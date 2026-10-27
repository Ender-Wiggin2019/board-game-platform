import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/auth/public.decorator.js';
import { platformNotificationTarget } from '@/notifications/notification-target.js';
import { MailSuppressionService } from './mail-suppression.service.js';
import { MailUnsubscribeTokenService } from './mail-unsubscribe.service.js';

const UNSUBSCRIBE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

interface IUnsubscribeBody {
  token?: unknown;
}

/** GET is a preview only; the state-changing action is POST. */
@Controller('mail')
export class MailUnsubscribeController {
  public constructor(
    @Inject(MailUnsubscribeTokenService)
    private readonly tokens: MailUnsubscribeTokenService,
    @Inject(MailSuppressionService)
    private readonly suppression: MailSuppressionService,
  ) {}

  @Public()
  @Get('unsubscribe')
  @Header('Cache-Control', 'no-store')
  @Throttle(UNSUBSCRIBE_THROTTLE)
  public preview(@Query('token') token?: string) {
    const claims = this.tokens.verifyTurnToken(token);
    if (!claims) throw new BadRequestException('Invalid unsubscribe token');
    return { ok: true, kind: 'turn_reminder' as const, scope: claims.scope };
  }

  @Public()
  @Post('unsubscribe')
  @Throttle(UNSUBSCRIBE_THROTTLE)
  public async unsubscribe(@Body() body: IUnsubscribeBody | undefined) {
    const claims = this.tokens.verifyTurnToken(body?.token);
    if (!claims) throw new BadRequestException('Invalid unsubscribe token');
    if (claims.scope === 'all') {
      await this.suppression.disableTurnReminders(claims.userId);
    } else if (claims.scope === 'game') {
      await this.suppression.muteGame(claims.userId, claims.gameId);
    } else if ('sessionId' in claims) {
      await this.suppression.muteTarget(
        claims.userId,
        platformNotificationTarget(claims.sessionId),
      );
    } else throw new BadRequestException('Invalid unsubscribe token');
    return { ok: true, kind: 'turn_reminder' as const, scope: claims.scope };
  }

  @Public()
  @Get('mute')
  @Header('Cache-Control', 'no-store')
  @Throttle(UNSUBSCRIBE_THROTTLE)
  public previewMute(@Query('token') token?: string) {
    const claims = this.tokens.verifyTurnToken(token);
    if (!claims || (claims.scope !== 'game' && claims.scope !== 'session')) {
      throw new BadRequestException('Invalid game mute token');
    }
    return { ok: true, kind: 'turn_reminder' as const, scope: claims.scope };
  }

  @Public()
  @Post('mute')
  @Throttle(UNSUBSCRIBE_THROTTLE)
  public async mute(@Body() body: IUnsubscribeBody | undefined) {
    const claims = this.tokens.verifyTurnToken(body?.token);
    if (!claims || (claims.scope !== 'game' && claims.scope !== 'session')) {
      throw new BadRequestException('Invalid game mute token');
    }
    if (claims.scope === 'game')
      await this.suppression.muteGame(claims.userId, claims.gameId);
    else {
      if (!('sessionId' in claims))
        throw new BadRequestException('Invalid game mute token');
      await this.suppression.muteTarget(
        claims.userId,
        platformNotificationTarget(claims.sessionId),
      );
    }
    return { ok: true, kind: 'turn_reminder' as const, scope: claims.scope };
  }
}
