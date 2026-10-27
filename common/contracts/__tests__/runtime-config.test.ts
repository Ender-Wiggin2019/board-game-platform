import { describe, expect, it } from 'vitest';
import {
  assertGameRuntimeConfiguration,
  type GameRuntimeConfiguration,
} from '../src/runtime-config.js';

const configuration: GameRuntimeConfiguration = {
  schemaVersion: 1,
  gameId: 'example',
  releaseId: 'v1',
  environment: 'production',
  binding: {
    backendBindingId: 'example-v1',
    storageBindingId: 'example-storage-v1',
    ownershipEpoch: '1',
  },
  storage: {
    driver: 'postgres',
    urlEnv: 'EXAMPLE_DATABASE_URL',
    namespace: 'example',
    maxConnections: 5,
  },
  replay: {
    enabled: true,
    source: 'game-storage',
    retentionPolicy: 'standard',
    archive: 'disabled',
  },
  platformConnection: {
    platformId: 'platform',
    issuer: 'platform',
    audience: 'players',
    apiUrlEnv: 'FACT_INGRESS_URL',
    verificationKeysRef: 'secrets/player-public.pem',
    serviceCredentialRef: 'env:GAME_SERVICE_TOKEN',
    serviceTokenExpiresAtEnv: 'GAME_SERVICE_TOKEN_EXPIRES_AT',
  },
};

describe('game runtime configuration', () => {
  it('keeps source credentials separate from immutable release data', () => {
    expect(() => assertGameRuntimeConfiguration(configuration)).not.toThrow();
    expect(() =>
      assertGameRuntimeConfiguration({ ...configuration, token: 'secret' }),
    ).toThrow();
    expect(() =>
      assertGameRuntimeConfiguration({
        ...configuration,
        platformConnection: {
          ...configuration.platformConnection,
          serviceCredentialRef: 'literal-service-credential',
        },
      }),
    ).toThrow();
  });
  it('rejects ephemeral production storage and incomplete authority or conflicting ports', () => {
    for (const candidate of [
      { ...configuration, binding: undefined },
      { ...configuration, storage: { driver: 'memory', namespace: 'example' } },
      {
        ...configuration,
        platformConnection: {
          ...configuration.platformConnection,
          issuer: 'different-platform',
        },
      },
      {
        ...configuration,
        platformConnection: {
          ...configuration.platformConnection,
          audience: undefined,
        },
      },
      { ...configuration, transport: { controlPort: 3001 } },
      {
        ...configuration,
        platformConnection: {
          ...configuration.platformConnection,
          verificationKeysRef: 'secrets/../private',
        },
      },
    ])
      expect(() => assertGameRuntimeConfiguration(candidate)).toThrow();
  });
  it('restricts development listeners and validates exact browser origins', () => {
    expect(() =>
      assertGameRuntimeConfiguration({
        ...configuration,
        environment: 'development',
        storage: { driver: 'memory', namespace: 'example' },
        transport: {
          host: '127.0.0.1',
          controlPort: 0,
          playerPort: 0,
          authorizationPort: 0,
          allowedOrigins: ['http://localhost:5173'],
        },
      }),
    ).not.toThrow();
    for (const transport of [
      { allowedOrigins: ['https://example.com/path'] },
      { allowedOrigins: ['*'] },
      { host: '0.0.0.0' },
    ])
      expect(() =>
        assertGameRuntimeConfiguration({
          ...configuration,
          environment: 'development',
          transport,
        }),
      ).toThrow();
  });
});
