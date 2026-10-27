import { Module, OnModuleInit } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { InviteCodeModule } from '@/invite-codes/invite-code.module.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountExtensionsModule } from './account-extensions.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthConfigController } from './auth-config.controller.js';
import { EmailChangeService } from './email-change.service.js';
import { validateChallengeSecretConfiguration } from './email-proof.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { getJwtModuleOptions } from './jwtConfig.js';
import { PasswordRecoveryService } from './password-recovery.service.js';
import { SessionService } from './session.service.js';

/**
 * Platform account/session module. A composition root supplies the mail
 * outbox and registers an optional game AccountExtensions adapter through the
 * exported registry; no game module is imported here.
 */
@Module({
  imports: [
    AccountExtensionsModule,
    InviteCodeModule,
    JwtModule.register(getJwtModuleOptions()),
  ],
  controllers: [AuthController, AuthConfigController],
  providers: [
    AuthService,
    EmailChangeService,
    PasswordRecoveryService,
    SessionService,
    {
      provide: APP_GUARD,
      inject: [JwtService, Reflector, DRIZZLE_DB],
      useFactory: (
        jwtService: JwtService,
        reflector: Reflector,
        db: NodePgDatabase,
      ) => new JwtAuthGuard(jwtService, reflector, db),
    },
  ],
  exports: [
    AuthService,
    EmailChangeService,
    PasswordRecoveryService,
    SessionService,
    AccountExtensionsModule,
  ],
})
export class AuthModule implements OnModuleInit {
  onModuleInit(): void {
    validateChallengeSecretConfiguration();
  }
}
