import type { IRedeemInviteCodeRequest } from '@board-platform/contracts/types/protocol/inviteCodes';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { getRuntimeConfig, isAllowedOrigin } from '@/config/runtimeConfig.js';
import { InviteCodeService } from '@/invite-codes/invite-code.service.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto } from './dto/ChangePasswordDto.js';
import { ConfirmEmailChangeDto } from './dto/ConfirmEmailChangeDto.js';
import { LoginDto } from './dto/LoginDto.js';
import { LogoutAllDto } from './dto/LogoutAllDto.js';
import { PasswordForgotDto } from './dto/PasswordForgotDto.js';
import { PasswordResetDto } from './dto/PasswordResetDto.js';
import { RegisterDto } from './dto/RegisterDto.js';
import { StartEmailChangeDto } from './dto/StartEmailChangeDto.js';
import { UpdateProfileDto } from './dto/UpdateProfileDto.js';
import { EmailChangeService } from './email-change.service.js';
import type { IJwtPayload } from './jwt-auth.guard.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import { Public } from './public.decorator.js';
import { SessionService } from './session.service.js';
import {
  clearSessionCookies,
  type ICookieResponse,
  REFRESH_COOKIE_NAME,
  writeSessionResponse,
} from './session-response.js';

const PREFERENCES_WRITE_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(InviteCodeService)
    private readonly inviteCodeService: InviteCodeService,
    @Inject(PasswordRecoveryService)
    private readonly passwordRecoveryService: PasswordRecoveryService,
    @Inject(EmailChangeService)
    private readonly emailChangeService: EmailChangeService,
    @Inject(SessionService)
    private readonly sessionService: SessionService,
  ) {}

  @Public()
  @Get('username-availability')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async usernameAvailability(@Query('name') name?: string) {
    return this.authService.usernameAvailability(name ?? '');
  }

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(
    @Body() dto: RegisterDto,
    @Req() req:
      | {
          cookies?: Record<string, string | undefined>;
          headers?: Record<string, string | undefined>;
        }
      | undefined,
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'cookie'>,
  ) {
    this.assertAllowedOrigin(req?.headers?.origin);
    const result = await this.authService.register({
      email: dto.email,
      name: dto.name,
      password: dto.password,
      passwordConfirm: dto.passwordConfirm,
      consentVersion: dto.consentVersion,
      language: dto.language,
    });
    return writeSessionResponse(response, result, () => result.user);
  }

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: { headers?: Record<string, string | undefined> } | undefined,
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'cookie'>,
  ) {
    this.assertAllowedOrigin(req?.headers?.origin);
    const result = await this.authService.login(dto.email, dto.password);
    return writeSessionResponse(response, result, () => result.user);
  }

  @Public()
  @Post('password/forgot')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async forgotPassword(@Body() dto: PasswordForgotDto) {
    return this.passwordRecoveryService.request(dto.email);
  }

  @Public()
  @Post('password/reset')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async resetPassword(@Body() dto: PasswordResetDto) {
    return this.passwordRecoveryService.reset(
      dto.token,
      dto.password,
      dto.passwordConfirm,
    );
  }

  @Post('me/email/start')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async startEmailChange(
    @Req() req: { user: IJwtPayload },
    @Body() dto: StartEmailChangeDto,
  ) {
    return this.emailChangeService.start(
      req.user.sub,
      dto.email,
      dto.currentPassword,
    );
  }

  @Post('me/email/confirm')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmEmailChange(
    @Req() req: { user: IJwtPayload },
    @Body() dto: ConfirmEmailChangeDto,
  ) {
    return this.emailChangeService.confirm(
      req.user.sub,
      dto.challengeId,
      dto.code,
    );
  }

  @Post('refresh')
  @Public()
  async refresh(
    @Req() req: {
      cookies?: Record<string, string | undefined>;
      headers?: Record<string, string | undefined>;
    },
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'cookie'>,
  ) {
    this.assertAllowedOrigin(req.headers?.origin);
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] ?? '';
    const csrfToken = req.headers?.['x-csrf-token'];
    const rotated = await this.sessionService.rotateRefreshToken(
      refreshToken,
      csrfToken,
    );
    return writeSessionResponse(response, rotated.tokens, () =>
      this.authService.getProfile(rotated.userId),
    );
  }

  @Post('logout')
  async logout(
    @Req() req: { user: IJwtPayload },
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'clearCookie'>,
  ) {
    if (req.user.sid) {
      await this.sessionService.revokeSession(req.user.sid);
      await this.authService.onSessionRevoked(req.user.sub);
    }
    clearSessionCookies(response);
    return { ok: true };
  }

  @Post('logout-all')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async logoutAll(
    @Req() req: {
      user: IJwtPayload;
      cookies?: Record<string, string | undefined>;
      headers?: Record<string, string | undefined>;
    },
    @Body() dto: LogoutAllDto,
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'clearCookie'>,
  ) {
    this.assertAllowedOrigin(req.headers?.origin);
    const csrfToken = req.headers?.['x-csrf-token'];
    const csrfCookie = req.cookies?.['__Host-seti-csrf'];
    if (!csrfToken || csrfToken !== csrfCookie) {
      throw new ForbiddenException({ code: 'CSRF_INVALID' });
    }
    await this.sessionService.assertCsrfToken(req.user.sid, csrfToken);
    await this.authService.assertCurrentPassword(
      req.user.sub,
      dto.currentPassword,
    );
    await this.sessionService.revokeAllSessions(req.user.sub);
    await this.authService.onLogoutAll(req.user.sub);
    clearSessionCookies(response);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: { user: IJwtPayload }) {
    return this.authService.getProfile(req.user.sub);
  }

  @Put('me')
  async updateMe(
    @Req() req: { user: IJwtPayload },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(req.user.sub, {
      name: dto.name,
      email: dto.email,
    });
  }

  @Post('me/password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(
    @Req() req: { user: IJwtPayload },
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Pick<ICookieResponse, 'cookie'>,
  ) {
    const result = await this.authService.changePassword(
      req.user.sub,
      dto.currentPassword,
      dto.newPassword,
      dto.passwordConfirm,
    );
    return writeSessionResponse(response, result, () => result.user);
  }

  @Patch('me/preferences')
  @Throttle(PREFERENCES_WRITE_THROTTLE)
  async updatePreferences(
    @Req() req: { user: IJwtPayload },
    @Body() dto: unknown,
  ) {
    return this.authService.updatePreferences(req.user.sub, dto);
  }

  @Post('me/invite-code')
  async redeemInviteCode(
    @Req() req: { user: IJwtPayload },
    @Body() body: Partial<IRedeemInviteCodeRequest> | undefined,
  ) {
    await this.inviteCodeService.redeemInviteCode(req.user.sub, body?.code);
    return this.authService.getProfile(req.user.sub);
  }

  private assertAllowedOrigin(origin: string | undefined): void {
    if (!isAllowedOrigin(origin, getRuntimeConfig())) {
      throw new ForbiddenException({ code: 'ORIGIN_NOT_ALLOWED' });
    }
  }
}
