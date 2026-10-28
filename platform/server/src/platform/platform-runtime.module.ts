import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { AccountExtensionsRegistry } from '../auth/account-extensions.js';
import { AccountExtensionsModule } from '../auth/account-extensions.module.js';
import {
  DRIZZLE_DB,
  DRIZZLE_POOL,
  DrizzleModule,
} from '../persistence/drizzle.module.js';
import { GameCapabilityService } from './capabilities/index.js';
import {
  GameAccessService,
  PostgresGameAccessStore,
} from './game-access/index.js';
import type { RemoteRuntimeOptions } from './PlatformApplicationRuntime.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformGameServices } from './PlatformGameServices.js';
import {
  PLATFORM_PLAYER_AUTHORIZATION_EXTENSION_ID,
  PlatformPlayerAuthorizationLifecycle,
} from './PlatformPlayerAuthorizationLifecycle.js';
import { PlatformPlayerConnections } from './PlatformPlayerConnections.js';
import { PlatformReleaseAdministration } from './PlatformReleaseAdministration.js';
import {
  normalizePlatformConfiguration,
  PLATFORM_CONFIGURATION,
  type PlatformPublicConfigurationInput,
} from './platform-configuration.js';
import type {
  DesiredGameInstallation,
  ReleaseRegistryStore,
} from './releases/types.js';

export interface PlatformRuntimeOptions {
  readonly platformId?: string;
  /** Explicit product compatibility policy for callers that omit a game id. */
  readonly defaultGameId?: string;
  readonly allowEmbeddedGames?: boolean;
  readonly releaseRegistry?: ReleaseRegistryStore;
  readonly desiredGameInstallations?: readonly DesiredGameInstallation[];
  readonly remoteRuntime?: RemoteRuntimeOptions;
  readonly allowInsecureLocalhost?: boolean;
  /** Optional app-composed player connection authority. */
  readonly playerConnections?: PlatformPlayerConnections;
  /** Builds the player authority after the runtime owns sessions and identity. */
  readonly createPlayerConnections?: (
    runtime: PlatformApplicationRuntime,
    pool: Pool,
  ) => PlatformPlayerConnections;
  readonly configuration?: PlatformPublicConfigurationInput;
}

/** Games register against this shared runtime; importing it installs no game. */
@Global()
@Module({})
export class PlatformRuntimeModule {
  static forRoot(options: PlatformRuntimeOptions = {}): DynamicModule {
    const optionalProviders = options.playerConnections
      ? [
          {
            provide: PlatformPlayerConnections,
            useValue: options.playerConnections,
          },
        ]
      : options.createPlayerConnections
        ? [
            {
              provide: PlatformPlayerConnections,
              inject: [PlatformApplicationRuntime, DRIZZLE_POOL],
              useFactory: (runtime: PlatformApplicationRuntime, pool: Pool) =>
                options.createPlayerConnections?.(runtime, pool),
            },
          ]
        : [];
    const playerAuthorizationLifecycleProviders =
      options.playerConnections || options.createPlayerConnections
        ? [
            {
              provide: PlatformPlayerAuthorizationLifecycle,
              inject: [PlatformPlayerConnections, AccountExtensionsRegistry],
              useFactory: (
                connections: PlatformPlayerConnections,
                extensions: AccountExtensionsRegistry,
              ) => {
                const lifecycle = new PlatformPlayerAuthorizationLifecycle(
                  connections,
                );
                extensions.register(
                  PLATFORM_PLAYER_AUTHORIZATION_EXTENSION_ID,
                  lifecycle.extensions(),
                );
                return lifecycle;
              },
            },
          ]
        : [];
    return {
      module: PlatformRuntimeModule,
      imports: [DrizzleModule, AccountExtensionsModule],
      providers: [
        {
          provide: PLATFORM_CONFIGURATION,
          useValue: normalizePlatformConfiguration(options.configuration),
        },
        {
          provide: GameAccessService,
          inject: [DRIZZLE_POOL],
          useFactory: (pool: Pool) =>
            new GameAccessService(new PostgresGameAccessStore(pool)),
        },
        {
          provide: PlatformApplicationRuntime,
          inject: [DRIZZLE_DB, DRIZZLE_POOL, GameAccessService],
          useFactory: (
            db: NodePgDatabase,
            pool: Pool,
            gameAccess: GameAccessService,
          ) =>
            new PlatformApplicationRuntime({
              db,
              pool,
              gameAccess,
              ...options,
            }),
        },
        {
          provide: PlatformGameServices,
          inject: [PlatformApplicationRuntime],
          useFactory: (platform: PlatformApplicationRuntime) =>
            new PlatformGameServices(platform),
        },
        {
          provide: PlatformReleaseAdministration,
          inject: [PlatformApplicationRuntime],
          useFactory: (platform: PlatformApplicationRuntime) =>
            new PlatformReleaseAdministration(platform),
        },
        ...optionalProviders,
        ...playerAuthorizationLifecycleProviders,
        {
          provide: GameCapabilityService,
          inject: [PlatformGameServices],
          useFactory: (games: PlatformGameServices) => games.capabilities,
        },
      ],
      exports: [
        PlatformApplicationRuntime,
        PlatformGameServices,
        PlatformReleaseAdministration,
        ...(options.playerConnections || options.createPlayerConnections
          ? [PlatformPlayerConnections]
          : []),
        ...(options.playerConnections || options.createPlayerConnections
          ? [PlatformPlayerAuthorizationLifecycle]
          : []),
        GameAccessService,
        GameCapabilityService,
        PLATFORM_CONFIGURATION,
      ],
    };
  }
}
