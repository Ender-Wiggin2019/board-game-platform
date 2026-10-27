import { createPublicKey } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  assertGameRuntimeConfiguration,
  type GameRuntimeConfiguration,
  type GameServiceDescription,
  type JsonValue,
} from '@board-game/contracts';
import {
  HttpFactIngressClient,
  MemoryInboxStore,
  PostgresInboxStore,
} from '@board-game/core';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import { Pool } from 'pg';
import {
  MemoryAuthorizationVersionStore,
  PostgresAuthorizationVersionStore,
} from './player-credentials.js';
import {
  installGameServerLifecycle,
  runGameServer,
} from './production-bootstrap.js';
import type { GameServerRunner, GameServerRunnerOptions } from './runner.js';
import type { GameServerManifest } from './types.js';

export type GameProcessRunnerOptions = Omit<
  GameServerRunnerOptions<
    unknown,
    JsonValue,
    JsonValue,
    JsonValue,
    unknown,
    JsonValue,
    JsonValue,
    JsonValue,
    GameServerManifest,
    unknown
  >,
  'definition'
>;
export type GameProcessIdentity = Pick<
  GameServiceDescription,
  | 'gameId'
  | 'releaseId'
  | 'platformId'
  | 'backendBindingId'
  | 'storageBindingId'
  | 'ownershipEpoch'
>;

export interface GameProcessResources {
  readonly configuration: GameRuntimeConfiguration;
  readonly pool?: Pool;
  readonly storage: StorageDriver;
}

export interface GameProcessOptions<Command extends JsonValue> {
  readonly configurationPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly describe: (identity: GameProcessIdentity) => GameServiceDescription;
  readonly createRunner: (
    options: GameProcessRunnerOptions,
    resources: GameProcessResources,
  ) => GameServerRunner<Command>;
  /** Game-owned additional schema migrations; never receives a platform pool. */
  readonly prepare?: (resources: GameProcessResources) => Promise<void>;
  readonly maintenanceIntervalMs?: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`GAME_PROCESS_ENV_REQUIRED:${key}`);
  return value;
}

function integer(
  value: string,
  key: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`GAME_PROCESS_ENV_INVALID:${key}`);
  return parsed;
}

/** Read explicit config, then apply the documented process-level environment overrides. */
export async function readGameProcessConfiguration(
  options: { readonly path?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{
  readonly configuration: GameRuntimeConfiguration;
  readonly directory: string;
}> {
  const env = options.env ?? process.env;
  const path = resolve(options.path ?? required(env, 'GAME_RUNTIME_CONFIG'));
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024)
    throw new Error('GAME_PROCESS_CONFIG_TOO_LARGE');
  const value: unknown = JSON.parse(text);
  assertGameRuntimeConfiguration(value);
  const configuration: GameRuntimeConfiguration = {
    ...value,
    ...(env.GAME_RELEASE_ID ? { releaseId: env.GAME_RELEASE_ID } : {}),
    ...(env.GAME_BACKEND_BINDING_ID ||
    env.GAME_STORAGE_BINDING_ID ||
    env.GAME_OWNERSHIP_EPOCH
      ? {
          binding: {
            backendBindingId:
              env.GAME_BACKEND_BINDING_ID ??
              value.binding?.backendBindingId ??
              '',
            storageBindingId:
              env.GAME_STORAGE_BINDING_ID ??
              value.binding?.storageBindingId ??
              '',
            ownershipEpoch:
              env.GAME_OWNERSHIP_EPOCH ?? value.binding?.ownershipEpoch ?? '',
          },
        }
      : {}),
    storage: {
      ...value.storage,
      ...(env.GAME_DATABASE_URL ? { urlEnv: 'GAME_DATABASE_URL' } : {}),
      ...(env.GAME_STORAGE_NAMESPACE
        ? { namespace: env.GAME_STORAGE_NAMESPACE }
        : {}),
      ...(env.GAME_MAX_CONNECTIONS
        ? {
            maxConnections: integer(
              env.GAME_MAX_CONNECTIONS,
              'GAME_MAX_CONNECTIONS',
              1,
              100,
            ),
          }
        : {}),
    },
    transport: {
      ...value.transport,
      ...(env.GAME_HOST ? { host: env.GAME_HOST } : {}),
      ...(env.GAME_PORT
        ? { controlPort: integer(env.GAME_PORT, 'GAME_PORT', 0, 65535) }
        : {}),
      ...(env.PLAYER_PORT
        ? { playerPort: integer(env.PLAYER_PORT, 'PLAYER_PORT', 0, 65535) }
        : {}),
      ...(env.AUTHORIZATION_PORT
        ? {
            authorizationPort: integer(
              env.AUTHORIZATION_PORT,
              'AUTHORIZATION_PORT',
              0,
              65535,
            ),
          }
        : {}),
    },
  };
  assertGameRuntimeConfiguration(configuration);
  if (
    env.NODE_ENV === 'production' &&
    configuration.environment !== 'production'
  )
    throw new Error('GAME_PROCESS_DEVELOPMENT_CONFIG_IN_PRODUCTION');
  return { configuration, directory: dirname(path) };
}

/** Files are restricted to the config's secrets directory, including symlink resolution. */
export async function resolveGameProcessSecret(
  reference: string,
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (reference.startsWith('env:')) return required(env, reference.slice(4));
  if (
    !reference.startsWith('secrets/') ||
    reference.split('/').some((part) => part === '.' || part === '..' || !part)
  )
    throw new Error('GAME_PROCESS_SECRET_REFERENCE_INVALID');
  const root = await realpath(resolve(directory, 'secrets'));
  const file = await realpath(resolve(directory, reference));
  const relation = relative(root, file);
  if (!relation || relation.startsWith('..') || isAbsolute(relation))
    throw new Error('GAME_PROCESS_SECRET_REFERENCE_INVALID');
  const value = (await readFile(file, 'utf8')).trim();
  if (!value || Buffer.byteLength(value) > 16 * 1024)
    throw new Error('GAME_PROCESS_SECRET_INVALID');
  return value;
}

const serviceScopes = [
  'session:create',
  'session:view',
  'session:command',
  'session:control',
  'session:control:cancel',
  'session:system',
  'session:spectate',
] as const;

/** Construct one independently deployable game process using common durable adapters. */
export async function createConfiguredGameProcess<Command extends JsonValue>(
  options: GameProcessOptions<Command>,
): Promise<{
  readonly runner: GameServerRunner<Command>;
  readonly resources: GameProcessResources;
  readonly migrate: () => Promise<void>;
}> {
  const env = options.env ?? process.env;
  const { configuration, directory } = await readGameProcessConfiguration({
    path: options.configurationPath,
    env,
  });
  if (configuration.replay.archive !== 'disabled')
    throw new Error('GAME_PROCESS_ARCHIVE_ADAPTER_REQUIRED');
  const connection = configuration.platformConnection;
  const secret = (reference: string) =>
    resolveGameProcessSecret(reference, directory, env);
  const [serviceToken, publicKeyValue, factToken, authorizationToken] =
    await Promise.all([
      secret(connection.serviceCredentialRef),
      secret(connection.verificationKeysRef),
      secret(connection.factCredentialRef ?? connection.serviceCredentialRef),
      secret(
        connection.authorizationCredentialRef ??
          connection.serviceCredentialRef,
      ),
    ]);
  const tokenExpiresAt = connection.serviceTokenExpiresAtEnv
    ? integer(
        required(env, connection.serviceTokenExpiresAtEnv),
        connection.serviceTokenExpiresAtEnv,
        Date.now() + 1,
      )
    : Date.now() + 60 * 60 * 1000;
  const publicKey = createPublicKey(publicKeyValue);
  const pins = configuration.binding ?? {
    backendBindingId: `${configuration.gameId}-development`,
    storageBindingId: `${configuration.gameId}-development-storage`,
    ownershipEpoch: 'development',
  };
  const identity: GameProcessIdentity = {
    gameId: configuration.gameId,
    releaseId: configuration.releaseId,
    platformId: connection.platformId,
    ...pins,
  };
  const description = options.describe(identity);
  if (!configuration.replay.enabled && description.replay)
    throw new Error('GAME_PROCESS_REPLAY_DISABLE_ADAPTER_REQUIRED');
  for (const field of [
    'gameId',
    'releaseId',
    'platformId',
    'backendBindingId',
    'storageBindingId',
    'ownershipEpoch',
  ] as const)
    if (description[field] !== identity[field])
      throw new Error(`GAME_PROCESS_DESCRIPTION_MISMATCH:${field}`);
  const factReceiver = new HttpFactIngressClient({
    baseUrl: required(env, connection.apiUrlEnv),
    token: factToken,
    platformId: connection.platformId,
    allowInsecureLocalhost: env.GAME_ALLOW_INSECURE_LOCALHOST === 'true',
  });
  const pool =
    configuration.storage.driver === 'postgres'
      ? new Pool({
          connectionString: required(
            env,
            configuration.storage.urlEnv as string,
          ),
          max: configuration.storage.maxConnections ?? 10,
        })
      : undefined;
  const storage = pool
    ? new PostgresStorageDriver({
        pool,
        schema: configuration.storage.namespace,
      })
    : new MemoryStorageDriver();
  const inbox = pool
    ? new PostgresInboxStore({
        pool,
        schema: `${configuration.storage.namespace}_inbox`,
      })
    : new MemoryInboxStore();
  const authorizationStore = pool
    ? new PostgresAuthorizationVersionStore({
        pool,
        schema: `${configuration.storage.namespace}_authorization`,
      })
    : new MemoryAuthorizationVersionStore();
  const resources: GameProcessResources = {
    configuration,
    storage,
    ...(pool ? { pool } : {}),
  };
  const host =
    configuration.transport?.host ??
    (configuration.environment === 'production' ? '0.0.0.0' : '127.0.0.1');
  const migrate = async () => {
    if (storage instanceof PostgresStorageDriver) await storage.migrate();
    if (inbox instanceof PostgresInboxStore) await inbox.migrate();
    if (authorizationStore instanceof PostgresAuthorizationVersionStore)
      await authorizationStore.migrate();
    await options.prepare?.(resources);
  };
  try {
    const runner = options.createRunner(
      {
        mode: configuration.environment,
        storage,
        description,
        inbox,
        factReceiver,
        authorize: async () => undefined,
        systemAccess: async () => ({
          principalId: `${connection.platformId}:service`,
          authEpoch: pins.ownershipEpoch,
          scopes: serviceScopes,
        }),
        transport: {
          host,
          port: configuration.transport?.controlPort ?? 3000,
          serviceToken,
          tokenExpiresAt,
          allowedScopes: serviceScopes,
        },
        playerTransport: {
          host,
          port: configuration.transport?.playerPort ?? 3001,
          publicKey,
          platformId: connection.platformId,
          audience: connection.audience ?? connection.platformId,
          authorizationStore,
          ...(configuration.transport?.allowedOrigins
            ? { allowedOrigins: configuration.transport.allowedOrigins }
            : {}),
        },
        authorizationTransport: {
          host,
          port: configuration.transport?.authorizationPort ?? 3002,
          credentials: [
            { token: authorizationToken, platformId: connection.platformId },
          ],
        },
      },
      resources,
    );
    installGameServerLifecycle(runner, {
      prepare: migrate,
      cleanup: async () => {
        await pool?.end();
      },
      intervalMs: options.maintenanceIntervalMs,
    });
    return { runner, resources, migrate };
  } catch (error) {
    await pool?.end();
    throw error;
  }
}

/** CLI entrypoints may run migrations as a separate job before starting a listener. */
export async function runConfiguredGameProcess<Command extends JsonValue>(
  options: GameProcessOptions<Command>,
  args = process.argv.slice(2),
): Promise<GameServerRunner<Command>> {
  if (args.some((argument) => argument !== '--migrate'))
    throw new Error('GAME_PROCESS_ARGUMENT_INVALID');
  const gameProcess = await createConfiguredGameProcess(options);
  if (args.includes('--migrate')) {
    try {
      await gameProcess.migrate();
    } finally {
      await gameProcess.runner.close();
    }
    return gameProcess.runner;
  }
  return runGameServer(gameProcess.runner);
}
