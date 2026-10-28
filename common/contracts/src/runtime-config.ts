import { contractError } from './errors.js';
import {
  assertMatchesSchema,
  type JsonSchema,
  type SchemaDescriptor,
} from './schema.js';

/** Operator-owned process configuration. Credentials remain environment/file references. */
export interface GameRuntimeConfiguration {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly releaseId: string;
  readonly environment: 'development' | 'production';
  readonly binding?: {
    readonly backendBindingId: string;
    readonly storageBindingId: string;
    readonly ownershipEpoch: string;
  };
  readonly storage: {
    readonly driver: 'memory' | 'postgres';
    readonly urlEnv?: string;
    readonly namespace: string;
    readonly maxConnections?: number;
  };
  /** Optional game-owned statistics database; never a platform business DB. */
  readonly statisticsStorage?: {
    readonly driver: 'postgres';
    readonly urlEnv: string;
    readonly namespace: string;
    readonly maxConnections?: number;
  };
  readonly replay: {
    readonly enabled: boolean;
    readonly source: 'game-storage';
    readonly retentionPolicy: string;
    readonly archive: 'disabled' | 'object-storage';
  };
  readonly platformConnection: {
    readonly platformId: string;
    /** Base URL of the authenticated fact ingress, resolved from this environment key. */
    readonly apiUrlEnv: string;
    readonly issuer: string;
    readonly audience?: string;
    readonly verificationKeysRef: string;
    readonly serviceCredentialRef: string;
    readonly serviceTokenExpiresAtEnv?: string;
    readonly factCredentialRef?: string;
    readonly authorizationCredentialRef?: string;
  };
  readonly transport?: {
    readonly host?: string;
    readonly controlPort?: number;
    readonly playerPort?: number;
    readonly authorizationPort?: number;
    readonly allowedOrigins?: readonly string[];
  };
}

const identifier: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
};
const environmentKey: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Z][A-Z0-9_]*$',
};
const reference: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: '^(env:[A-Za-z][A-Za-z0-9_]*|secrets/[A-Za-z0-9._/-]+)$',
};
const port: JsonSchema = { type: 'integer', minimum: 0, maximum: 65535 };
const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const GAME_RUNTIME_CONFIGURATION_SCHEMA: SchemaDescriptor = {
  name: 'game.runtime-configuration',
  version: 1,
  maxBytes: 64 * 1024,
  schema: object(
    {
      schemaVersion: { type: 'integer', minimum: 1, maximum: 1 },
      gameId: identifier,
      releaseId: identifier,
      environment: { type: 'string', enum: ['development', 'production'] },
      binding: object({
        backendBindingId: identifier,
        storageBindingId: identifier,
        ownershipEpoch: identifier,
      }),
      storage: object(
        {
          driver: { type: 'string', enum: ['memory', 'postgres'] },
          urlEnv: environmentKey,
          namespace: {
            type: 'string',
            pattern: '^[A-Za-z_][A-Za-z0-9_]{0,39}$',
          },
          maxConnections: { type: 'integer', minimum: 1, maximum: 100 },
        },
        ['driver', 'namespace'],
      ),
      statisticsStorage: object(
        {
          driver: { type: 'string', enum: ['postgres'] },
          urlEnv: environmentKey,
          namespace: {
            type: 'string',
            pattern: '^[A-Za-z_][A-Za-z0-9_]{0,39}$',
          },
          maxConnections: { type: 'integer', minimum: 1, maximum: 100 },
        },
        ['driver', 'urlEnv', 'namespace'],
      ),
      replay: object({
        enabled: { type: 'boolean' },
        source: { type: 'string', enum: ['game-storage'] },
        retentionPolicy: identifier,
        archive: { type: 'string', enum: ['disabled', 'object-storage'] },
      }),
      platformConnection: object(
        {
          platformId: identifier,
          apiUrlEnv: environmentKey,
          issuer: identifier,
          audience: identifier,
          verificationKeysRef: reference,
          serviceCredentialRef: reference,
          serviceTokenExpiresAtEnv: environmentKey,
          factCredentialRef: reference,
          authorizationCredentialRef: reference,
        },
        [
          'platformId',
          'apiUrlEnv',
          'issuer',
          'verificationKeysRef',
          'serviceCredentialRef',
        ],
      ),
      transport: object(
        {
          host: { type: 'string', minLength: 1, maxLength: 256 },
          controlPort: port,
          playerPort: port,
          authorizationPort: port,
          allowedOrigins: {
            type: 'array',
            maxItems: 32,
            items: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        [],
      ),
    },
    [
      'schemaVersion',
      'gameId',
      'releaseId',
      'environment',
      'storage',
      'replay',
      'platformConnection',
    ],
  ),
};

export function assertGameRuntimeConfiguration(
  value: unknown,
): asserts value is GameRuntimeConfiguration {
  assertMatchesSchema(value, GAME_RUNTIME_CONFIGURATION_SCHEMA);
  const configuration = value as unknown as GameRuntimeConfiguration;
  if (configuration.replay.archive !== 'disabled')
    throw contractError('NOT_READY', 'runtime.config.archive_adapter_required');
  if (
    (configuration.storage.driver === 'postgres') !==
    (configuration.storage.urlEnv !== undefined)
  )
    throw contractError(
      'INVALID_REQUEST',
      'runtime.config.storage_url_reference',
    );
  if (
    configuration.statisticsStorage !== undefined &&
    configuration.statisticsStorage.namespace ===
      configuration.storage.namespace
  )
    throw contractError(
      'INVALID_REQUEST',
      'runtime.config.statistics_namespace_conflict',
    );
  if (
    configuration.platformConnection.issuer !==
    configuration.platformConnection.platformId
  )
    throw contractError('INVALID_REQUEST', 'runtime.config.issuer_mismatch');
  if (
    configuration.environment === 'production' &&
    (configuration.storage.driver !== 'postgres' ||
      !configuration.binding ||
      !configuration.platformConnection.audience ||
      !configuration.platformConnection.serviceTokenExpiresAtEnv)
  )
    throw contractError(
      'INVALID_REQUEST',
      'runtime.config.production_incomplete',
    );
  for (const ref of [
    configuration.platformConnection.verificationKeysRef,
    configuration.platformConnection.serviceCredentialRef,
    configuration.platformConnection.factCredentialRef,
    configuration.platformConnection.authorizationCredentialRef,
  ]) {
    if (
      ref?.startsWith('secrets/') &&
      ref
        .split('/')
        .some((part) => part === '.' || part === '..' || part === '')
    )
      throw contractError(
        'INVALID_REQUEST',
        'runtime.config.secret_path_invalid',
      );
  }
  const selectedPorts = [
    configuration.transport?.controlPort ?? 3000,
    configuration.transport?.playerPort ?? 3001,
    configuration.transport?.authorizationPort ?? 3002,
  ].filter((item) => item !== 0);
  if (new Set(selectedPorts).size !== selectedPorts.length)
    throw contractError('INVALID_REQUEST', 'runtime.config.port_conflict');
  if (
    configuration.environment === 'development' &&
    configuration.transport?.host &&
    !['127.0.0.1', 'localhost', '::1'].includes(configuration.transport.host)
  )
    throw contractError(
      'INVALID_REQUEST',
      'runtime.config.development_loopback_required',
    );
  const origins = configuration.transport?.allowedOrigins ?? [];
  if (new Set(origins).size !== origins.length)
    throw contractError('INVALID_REQUEST', 'runtime.config.origin_invalid');
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw contractError('INVALID_REQUEST', 'runtime.config.origin_invalid');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      throw contractError('INVALID_REQUEST', 'runtime.config.origin_invalid');
  }
}
