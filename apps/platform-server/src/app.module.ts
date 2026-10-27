import type { SessionRoute } from '@board-game/contracts';
import {
  HttpAuthorizationVersionClient,
  PostgresAuthorizationVersionStore,
} from '@board-game/server';
import { AuthModule } from '@board-platform/server/auth/auth.module.js';
import { UserAwareThrottlerGuard } from '@board-platform/server/auth/UserAwareThrottlerGuard.js';
import { MailModule } from '@board-platform/server/mail/mail.module.js';
import { NotificationsModule } from '@board-platform/server/notifications/notifications.module.js';
import { PlatformApplicationRuntime } from '@board-platform/server/platform/PlatformApplicationRuntime.js';
import { PlatformPlayerConnections } from '@board-platform/server/platform/PlatformPlayerConnections.js';
import { PlatformServerModule } from '@board-platform/server/platform/platform.module.js';
import { normalizePlatformConfiguration } from '@board-platform/server/platform/platform-configuration.js';
import {
  PlatformRuntimeModule,
  type PlatformRuntimeOptions,
} from '@board-platform/server/platform/platform-runtime.module.js';
import {
  type DynamicModule,
  Global,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountMailCompositionModule } from './account-mail.module.js';
import { loadStandaloneConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { PublicConfigurationController } from './public-configuration.controller.js';
import {
  createStandaloneRemoteRuntime,
  createStandaloneResources,
  resolveEnvironmentSecret,
  restoreStandaloneRuntime,
  STANDALONE_FACT_INGRESS,
  StandaloneFactIngressLifecycle,
  type StandalonePlatformDependencies,
  type StandalonePlatformResources,
  StandaloneReadiness,
  StandaloneResourceShutdown,
} from './standalone-runtime.js';

export interface StandalonePlatformModuleOptions
  extends StandalonePlatformDependencies {}

/** A game-independent Nest composition root for the platform service. */
@Global()
@Module({})
export class StandalonePlatformModule {}

export async function createStandalonePlatformModule(
  options: StandalonePlatformModuleOptions = {},
): Promise<DynamicModule> {
  const config = await loadStandaloneConfig();
  const resources = createStandaloneResources(config);
  const remoteRuntime = createStandaloneRemoteRuntime(
    config,
    resources,
    options,
  );
  const playerCredentialPrivateKey = config.playerCredentialPrivateKey;
  const playerCredentialAudience = config.playerCredentialAudience;
  const createPlayerConnections =
    playerCredentialPrivateKey && playerCredentialAudience
      ? (runtime: PlatformApplicationRuntime, pool: import('pg').Pool) => {
          const privateKey = playerCredentialPrivateKey.startsWith('env:')
            ? resolveEnvironmentSecret(playerCredentialPrivateKey)
            : playerCredentialPrivateKey;
          const audience = playerCredentialAudience.startsWith('env:')
            ? resolveEnvironmentSecret(playerCredentialAudience)
            : playerCredentialAudience;
          const authorizationStore = new PostgresAuthorizationVersionStore({
            pool,
          });
          const bindingFor = async (route: SessionRoute) => {
            const binding = await resources.releaseRegistry.getBinding(
              config.platformId,
              route.backendBindingId,
            );
            if (
              !binding ||
              binding.gameId !== route.gameId ||
              binding.releaseId !== route.releaseId ||
              binding.storageBindingId !== route.storageBindingId ||
              binding.ownershipEpoch !== route.ownershipEpoch
            )
              throw new Error('player route binding is unavailable');
            return binding;
          };
          return new PlatformPlayerConnections({
            platformId: config.platformId,
            audience,
            sessions: runtime.sessions,
            admission: runtime.admissionStore,
            identity: {
              resolve: (reference) => runtime.identity.resolve(reference),
              authorize: (identity, admission, operation) =>
                runtime
                  .releaseGame(
                    admission.route.gameId,
                    admission.route.releaseId,
                  )
                  .identity.authorize(identity, admission, operation),
              accessScopes: (identity, admission, operation) =>
                runtime
                  .releaseGame(
                    admission.route.gameId,
                    admission.route.releaseId,
                  )
                  .identity.accessScopes(identity, admission, operation),
            },
            authorizationStore,
            resolveAuthorizationSync: async (route) => {
              const binding = await bindingFor(route);
              const token = await (options.resolveServiceCredential?.(
                binding.serviceCredentialRef,
                binding,
              ) ?? resolveEnvironmentSecret(binding.serviceCredentialRef));
              return new HttpAuthorizationVersionClient({
                baseUrl:
                  binding.authorizationEndpoint ?? binding.controlEndpoint,
                token,
                platformId: config.platformId,
                allowInsecureLocalhost: config.allowInsecureLocalhost,
              });
            },
            resolvePlayerEndpoint: async (route) =>
              (await bindingFor(route)).playerEndpoint,
            privateKey,
            ...(config.playerApprovedGameScopes
              ? { approvedGameScopes: config.playerApprovedGameScopes }
              : {}),
            ...(config.playerCredentialTtlMs
              ? { ttlMs: config.playerCredentialTtlMs }
              : {}),
          });
        }
      : undefined;
  const runtimeOptions: PlatformRuntimeOptions = {
    platformId: config.platformId,
    allowEmbeddedGames: false,
    releaseRegistry: resources.releaseRegistry,
    desiredGameInstallations: Object.entries(
      config.installation.config.games,
    ).map(([gameId, game]) => ({
      gameId,
      releaseId: game.release,
      enabled: game.enabled,
      deployment: game.deployment.kind,
    })),
    remoteRuntime,
    allowInsecureLocalhost: config.allowInsecureLocalhost,
    configuration: normalizePlatformConfiguration({
      brand: config.installation.config.platform.brand,
      features: config.installation.config.platform.features,
    }),
    ...(options.playerConnections
      ? { playerConnections: options.playerConnections }
      : {}),
    ...(createPlayerConnections && !options.playerConnections
      ? { createPlayerConnections }
      : {}),
  };

  @Injectable()
  class RestoreService implements OnApplicationBootstrap {
    constructor(
      private readonly runtime: PlatformApplicationRuntime,
      private readonly readiness: StandaloneReadiness,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      await restoreStandaloneRuntime(this.runtime, this.readiness);
    }
  }

  return {
    module: StandalonePlatformModule,
    imports: [
      PlatformRuntimeModule.forRoot(runtimeOptions),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
      AccountMailCompositionModule,
      AuthModule,
      MailModule,
      NotificationsModule,
      PlatformServerModule,
    ],
    controllers: [HealthController, PublicConfigurationController],
    providers: [
      { provide: 'STANDALONE_PLATFORM_RESOURCES', useValue: resources },
      {
        provide: StandaloneReadiness,
        useFactory: () => new StandaloneReadiness(),
      },
      {
        provide: StandaloneResourceShutdown,
        inject: ['STANDALONE_PLATFORM_RESOURCES'],
        useFactory: (value: StandalonePlatformResources) =>
          new StandaloneResourceShutdown(value),
      },
      {
        provide: StandaloneFactIngressLifecycle,
        inject: [PlatformApplicationRuntime],
        useFactory: (runtime: PlatformApplicationRuntime) =>
          new StandaloneFactIngressLifecycle(
            runtime,
            config,
            options.resolveServiceCredential,
          ),
      },
      RestoreService,
      ...(options.factIngress
        ? [{ provide: STANDALONE_FACT_INGRESS, useValue: options.factIngress }]
        : []),
      { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    ],
  };
}
