import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
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
    return {
      module: PlatformRuntimeModule,
      imports: [DrizzleModule],
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
        GameAccessService,
        GameCapabilityService,
        PLATFORM_CONFIGURATION,
      ],
    };
  }
}
