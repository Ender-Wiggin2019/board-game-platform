import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import type { IJwtPayload } from '@/auth/jwt-auth.guard.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PushService } from './push.service.js';
import { isAllowedPushEndpoint, MAX_ENDPOINT_LENGTH } from './push-endpoint.js';

interface ISubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  mode?: unknown;
}

const MAX_P256DH_LENGTH = 256;
const MAX_AUTH_LENGTH = 128;
const WRITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
const TEST_THROTTLE = { default: { limit: 3, ttl: 60_000 } };

function readRequiredString(value: unknown, maxLength: number): string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
    ? value
    : '';
}

function readSubscriptionKey(
  value: unknown,
  maxLength: number,
  decodedLength: number,
): string {
  const key = readRequiredString(value, maxLength);
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return '';
  return Buffer.from(key, 'base64url').length === decodedLength ? key : '';
}

/**
 * Web Push subscription management.
 *
 * Available to accounts that can play games. Authorization uses the shared
 * capability map so the client and server agree on the PLAYER+ boundary.
 */
@Controller('push')
@UseGuards(RolesGuard)
@Capabilities(ECapability.GAME_PLAY)
export class PushController {
  public constructor(@Inject(PushService) private readonly push: PushService) {}

  /**
   * The client needs the VAPID public key to subscribe, and needs to know
   * whether the server can send at all so the UI can explain itself rather than
   * offering a toggle that silently does nothing.
   */
  @Get('config')
  async getConfig(@Req() req: { user: IJwtPayload }) {
    return {
      configured: this.push.isConfigured(),
      publicKey: this.push.getPublicKey(),
      deviceCount: await this.push.countForUser(req.user.sub),
    };
  }

  @Post('subscribe')
  @Throttle(WRITE_THROTTLE)
  async subscribe(
    @Req() req: { user: IJwtPayload; headers: Record<string, unknown> },
    @Body() body: ISubscribeBody | undefined,
  ) {
    const endpoint = isAllowedPushEndpoint(body?.endpoint) ? body.endpoint : '';
    const p256dh = readSubscriptionKey(
      body?.keys?.p256dh,
      MAX_P256DH_LENGTH,
      65,
    );
    const auth = readSubscriptionKey(body?.keys?.auth, MAX_AUTH_LENGTH, 16);
    const requestedMode = body?.mode;
    const mode =
      requestedMode === 'enable' || requestedMode === 'refresh'
        ? requestedMode
        : undefined;
    if (!endpoint || !p256dh || !auth || mode === undefined) {
      throw new BadRequestException('Invalid push subscription');
    }

    const userAgent = req.headers?.['user-agent'];
    await this.push.saveSubscription(
      req.user.sub,
      {
        endpoint,
        p256dh,
        auth,
        userAgent:
          typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
      },
      mode,
    );
    return { ok: true };
  }

  @Post('enable')
  @Throttle(WRITE_THROTTLE)
  async enable(@Req() req: { user: IJwtPayload }) {
    await this.push.enableForUser(req.user.sub);
    return { ok: true };
  }

  @Delete('subscribe')
  @Throttle(WRITE_THROTTLE)
  async unsubscribe(
    @Req() req: { user: IJwtPayload },
    @Body() body: { endpoint?: unknown } | undefined,
  ) {
    // No endpoint means "this account is opting out everywhere", which is what
    // turning the preference off should do.
    if (body?.endpoint !== undefined) {
      const endpoint = readRequiredString(body.endpoint, MAX_ENDPOINT_LENGTH);
      if (!endpoint) {
        throw new BadRequestException('Invalid push subscription');
      }
      await this.push.removeSubscription(req.user.sub, endpoint);
    } else {
      await this.push.removeAllForUser(req.user.sub);
    }
    return { ok: true };
  }

  /**
   * Send a notification to the caller's own devices. iOS fails silently in
   * enough ways (not installed to the Home Screen, permission granted to a
   * different origin, subscription expired) that a self-test is the only
   * practical way to tell a working setup from a broken one.
   */
  @Post('test')
  @Throttle(TEST_THROTTLE)
  async test(@Req() req: { user: IJwtPayload }) {
    const delivered = await this.push.sendToUser(req.user.sub, {
      title: 'Board Game Utopia',
      body: 'Push notifications are working.',
      url: '/',
      tag: 'platform-test',
    });
    return { delivered };
  }
}
