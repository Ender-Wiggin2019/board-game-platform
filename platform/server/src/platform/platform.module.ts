import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { Pool } from 'pg';
import { PlatformAdministrationModule } from '../administration/administration.module.js';
import { getJwtModuleOptions } from '../auth/jwtConfig.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DRIZZLE_POOL } from '../persistence/drizzle.module.js';
import {
  PlatformDailyChallengeAdminController,
  PlatformDailyChallengeController,
} from './daily-challenge/controller.js';
import {
  PlatformFeedbackController,
  PlatformFeedbackService,
  PostgresPlatformFeedbackStore,
} from './feedback/index.js';
import { GameAccessController } from './game-access/controller.js';
import {
  PlatformAccountProjectionController,
  PlatformAccountProjectionService,
} from './PlatformAccountProjection.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformReleaseController } from './PlatformReleaseController.js';
import { PlatformSessionDiagnostics } from './PlatformSessionDiagnostics.js';
import { PlatformController } from './platform.controller.js';
import { PlatformGateway } from './platform.gateway.js';
import { PlatformCapabilitiesController } from './platform-capabilities.controller.js';
import { assertPlatformSchemaReady } from './schema.js';

/** Recovery begins only after every installed game's module has initialized. */
@Injectable()
export class PlatformRecovery
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PlatformRecovery.name);
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> | undefined;
  private pendingAutomation: Promise<void> | undefined;
  private shuttingDown = false;
  constructor(
    @Inject(PlatformApplicationRuntime)
    private readonly runtime: PlatformApplicationRuntime,
    @Inject(DRIZZLE_POOL) private readonly pool: Pool,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertPlatformSchemaReady(this.pool, {
      embeddedGames: this.runtime.embeddedGamesEnabled,
    });
    await this.tick();
    void this.tickAutomation();
    this.timer = setInterval(() => {
      void this.tick();
      void this.tickAutomation();
    }, 5_000);
    this.timer.unref();
  }

  private tick(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.runtime
      .recoverOnce()
      .then(
        ({
          starts,
          delivery,
          consumers,
          completions = [],
          timers,
          resources,
          maintenance,
        }) => {
          const retryableTimers = timers.filter(
            (item) =>
              item.status === 'skipped' ||
              (item.status === 'rejected' &&
                item.receipt?.error?.retryable === true),
          );
          const terminalTimerFailures = timers.filter(
            (item) =>
              item.status === 'rejected' &&
              item.receipt?.error?.retryable !== true,
          );
          const failures =
            starts.filter((item) => !item.recovered).length +
            delivery.failed +
            consumers.reduce((total, report) => total + report.failed, 0) +
            completions.filter((item) => item.failed).length +
            retryableTimers.length +
            resources.filter((item) => item.status === 'conflict').length +
            maintenance.filter((item) => item.failed).length;
          if (terminalTimerFailures.length)
            this.logger.error(
              `${terminalTimerFailures.length} terminal timer commands rejected`,
            );
          if (failures)
            this.logger.warn(
              `${failures} durable platform operations await retry`,
            );
        },
      )
      .catch(() => {
        this.logger.error(
          'Platform recovery failed; durable work remains pending',
        );
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private tickAutomation(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.pendingAutomation) return this.pendingAutomation;
    this.pendingAutomation = this.runtime
      .recoverAutomationOnce()
      .then((results) => {
        const failures = results.filter(
          (item) =>
            item.status === 'rejected' &&
            item.receipt?.error?.retryable !== true,
        );
        if (failures.length)
          this.logger.error(
            `${failures.length} terminal automation failures require attention`,
          );
        if (
          results.some(
            (item) =>
              item.status === 'skipped' ||
              (item.status === 'rejected' && item.receipt?.error?.retryable),
          )
        )
          this.logger.warn('Some durable automation work awaits retry');
      })
      .catch(() => {
        this.logger.error(
          'Automation recovery failed; durable work remains pending',
        );
      })
      .finally(() => {
        this.pendingAutomation = undefined;
      });
    return this.pendingAutomation;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([this.pending, this.pendingAutomation]);
    await this.runtime.drain();
  }
}

@Module({
  imports: [
    JwtModule.register(getJwtModuleOptions()),
    PlatformAdministrationModule,
    NotificationsModule,
  ],
  controllers: [
    PlatformController,
    PlatformAccountProjectionController,
    PlatformReleaseController,
    PlatformCapabilitiesController,
    PlatformDailyChallengeController,
    PlatformDailyChallengeAdminController,
    GameAccessController,
    PlatformFeedbackController,
  ],
  providers: [
    PlatformAccountProjectionService,
    PlatformRecovery,
    PlatformGateway,
    PlatformSessionDiagnostics,
    {
      provide: PlatformFeedbackService,
      inject: [
        DRIZZLE_POOL,
        PlatformApplicationRuntime,
        PlatformSessionDiagnostics,
      ],
      useFactory: (
        pool: Pool,
        runtime: PlatformApplicationRuntime,
        diagnostics: PlatformSessionDiagnostics,
      ) =>
        new PlatformFeedbackService(
          new PostgresPlatformFeedbackStore(pool),
          runtime,
          diagnostics,
        ),
    },
  ],
  exports: [PlatformGateway],
})
export class PlatformServerModule {}
