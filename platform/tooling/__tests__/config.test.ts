import { describe, expect, it } from 'vitest';
import {
  parseGamesLock,
  parsePlatformConfig,
  validatePlatformInstallation,
} from '../src/config.js';

const sha = `sha256:${'a'.repeat(64)}`;
const image = `registry.example/example@${sha}`;
const archive = {
  format: 'node-tar',
  digest: sha,
  sourceSha: `sha1:${'b'.repeat(40)}`,
};

function runtime(
  environment: 'development' | 'production' = 'production',
  driver: 'memory' | 'postgres' = 'postgres',
) {
  return {
    schemaVersion: 1,
    gameId: 'example',
    releaseId: 'example-v1',
    environment,
    storage: {
      driver,
      ...(driver === 'postgres' ? { urlEnv: 'GAME_DATABASE_URL' } : {}),
      namespace: 'example',
    },
    replay: {
      enabled: true,
      source: 'game-storage',
      retentionPolicy: 'standard',
      archive: 'disabled',
    },
    platformConnection: {
      platformId: 'my-platform',
      apiUrlEnv: 'PLATFORM_API_URL',
      issuer: 'my-platform',
      verificationKeysRef: 'env:PLATFORM_VERIFICATION_KEYS',
      serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
      audience: 'example-v1',
      serviceTokenExpiresAtEnv: 'GAME_SERVICE_TOKEN_EXPIRES_AT_MS',
      factCredentialRef: 'env:GAME_FACT_CREDENTIAL',
      authorizationCredentialRef: 'env:GAME_AUTHORIZATION_CREDENTIAL',
    },
    binding: {
      backendBindingId: 'example-v1-backend',
      storageBindingId: 'example-v1-storage',
      ownershipEpoch: '1',
    },
    transport: {
      host: environment === 'development' ? '127.0.0.1' : '0.0.0.0',
      controlPort: 3000,
      playerPort: 3001,
      authorizationPort: 3002,
      allowedOrigins: [],
    },
  };
}

function rawConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    platform: {
      id: 'my-platform',
      image,
      databaseUrlEnv: 'PLATFORM_DATABASE_URL',
      features: { chat: true },
    },
    games: {
      example: {
        enabled: true,
        release: 'example-v1',
        manifestRef: 'releases/example-v1.json',
        runtime: runtime(),
        deployment: {
          kind: 'managed',
          adapter: 'compose',
          image,
          runtimeConfig: 'runtime/example-v1.json',
        },
        approvedCapabilities: ['rooms', 'replay', 'results'],
      },
    },
    ...overrides,
  };
}

function rawLock(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    platform: { id: 'my-platform', image },
    games: {
      example: {
        release: 'example-v1',
        manifestRef: 'releases/example-v1.json',
        image,
        sourceSha: sha,
        artifacts: { client: sha, server: sha, publicAssets: sha },
      },
    },
    ...overrides,
  };
}

describe('platform installation config', () => {
  it('pins a Node platform archive without inventing a container image', () => {
    const { image: _image, ...platform } = rawConfig().platform;
    const config = parsePlatformConfig({
      ...rawConfig(),
      platform: { ...platform, archive },
      games: {},
    });
    const lock = parseGamesLock({
      ...rawLock(),
      platform: { id: platform.id, archive },
      games: {},
    });
    expect(config.platform.archive).toEqual(archive);
    expect(config.platform.image).toBeUndefined();
    expect(() => validatePlatformInstallation(config, lock)).not.toThrow();
    for (const changed of [
      { ...archive, digest: `sha256:${'c'.repeat(64)}` },
      { ...archive, sourceSha: `sha1:${'c'.repeat(40)}` },
    ]) {
      const mismatch = parseGamesLock({
        ...rawLock(),
        platform: { id: platform.id, archive: changed },
        games: {},
      });
      expect(() => validatePlatformInstallation(config, mismatch)).toThrow(
        /archive must match/,
      );
    }
  });

  it('allows archive locks for external games while Compose requires an image', () => {
    const { image: _image, ...locked } = rawLock().games.example;
    const lock = parseGamesLock({
      ...rawLock(),
      games: { example: { ...locked, sourceSha: archive.sourceSha, archive } },
    });
    const config = parsePlatformConfig({
      ...rawConfig(),
      games: {
        example: {
          ...rawConfig().games.example,
          deployment: {
            kind: 'external',
            controlEndpoint: 'https://example.test/control',
            playerEndpoint: 'https://example.test/player',
            serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
          },
        },
      },
    });
    expect(() => validatePlatformInstallation(config, lock)).not.toThrow();
    expect(() =>
      validatePlatformInstallation(parsePlatformConfig(rawConfig()), lock),
    ).toThrow(/image must match/);
    expect(() =>
      parseGamesLock({
        ...rawLock(),
        games: { example: { ...locked, archive } },
      }),
    ).toThrow(/sourceSha must match/);
  });

  it.each([
    { image, archive },
    {},
    { archive: { ...archive, format: 'zip' } },
    { archive: { ...archive, digest: 'sha1:' + 'c'.repeat(40) } },
    { archive: { ...archive, sourceSha: 'main' } },
    { archive: { ...archive, url: '/unvalidated-path' } },
  ])('rejects ambiguous or mutable executable references: %j', (reference) => {
    const { image: _image, ...platform } = rawConfig().platform;
    expect(() =>
      parsePlatformConfig({
        ...rawConfig(),
        platform: { ...platform, ...reference },
      }),
    ).toThrow();
  });

  it('accepts production postgres and a development memory runtime', () => {
    const config = parsePlatformConfig(rawConfig());
    expect(config.games.example.runtime.storage.driver).toBe('postgres');
    expect(config.platform.features).toEqual({ chat: true, rankings: true });
    const devConfig = parsePlatformConfig({
      ...rawConfig(),
      games: {
        example: {
          ...rawConfig().games.example,
          runtime: runtime('development', 'memory'),
        },
      },
    });
    expect(devConfig.games.example.runtime.storage.driver).toBe('memory');
    expect(devConfig.games.example.runtime.transport).toMatchObject({
      host: '127.0.0.1',
      controlPort: 3000,
      playerPort: 3001,
      authorizationPort: 3002,
      allowedOrigins: [],
    });
  });

  it('parses the optional brand and supported feature flags', () => {
    const config = parsePlatformConfig({
      ...rawConfig(),
      platform: {
        ...rawConfig().platform,
        brand: { name: 'Orbit Table' },
        features: { chat: false, rankings: true },
      },
    });
    expect(config.platform.brand).toEqual({ name: 'Orbit Table' });
    expect(config.platform.features).toEqual({ chat: false, rankings: true });
  });

  it.each([
    [
      'rejects unknown keys',
      () => parsePlatformConfig({ ...rawConfig(), unexpected: true }),
    ],
    [
      'rejects production memory storage',
      () =>
        parsePlatformConfig({
          ...rawConfig(),
          games: {
            example: {
              ...rawConfig().games.example,
              runtime: runtime('production', 'memory'),
            },
          },
        }),
    ],
    [
      'rejects plaintext service credentials',
      () =>
        parsePlatformConfig({
          ...rawConfig(),
          games: {
            example: {
              ...rawConfig().games.example,
              deployment: {
                kind: 'external',
                controlEndpoint: 'https://example.test/control',
                playerEndpoint: 'https://example.test/play',
                serviceCredentialRef: 'password=do-not-store',
              },
            },
          },
        }),
    ],
    [
      'rejects an image without an exact digest',
      () =>
        parsePlatformConfig({
          ...rawConfig(),
          platform: {
            ...rawConfig().platform,
            image: 'registry.example/platform:latest',
          },
        }),
    ],
    [
      'rejects an unsupported platform feature',
      () =>
        parsePlatformConfig({
          ...rawConfig(),
          platform: {
            ...rawConfig().platform,
            features: { chat: true, experimental: true },
          },
        }),
    ],
    [
      'rejects an empty platform brand',
      () =>
        parsePlatformConfig({
          ...rawConfig(),
          platform: {
            ...rawConfig().platform,
            brand: { name: ' ' },
          },
        }),
    ],
  ])('%s', (_name, action) => {
    expect(action).toThrow();
  });

  it('requires lock entries to match configured release identities', () => {
    const config = parsePlatformConfig(rawConfig());
    const lock = parseGamesLock(rawLock());
    expect(() => validatePlatformInstallation(config, lock)).not.toThrow();
    const mismatched = parseGamesLock({
      ...rawLock(),
      games: {
        example: { ...rawLock().games.example, release: 'example-v2' },
      },
    });
    expect(() => validatePlatformInstallation(config, mismatched)).toThrow(
      /release must match/,
    );
  });

  it('accepts an external deployment without an optional authorization endpoint', () => {
    const config = parsePlatformConfig({
      ...rawConfig(),
      games: {
        example: {
          ...rawConfig().games.example,
          deployment: {
            kind: 'external',
            controlEndpoint: 'https://example.test/control',
            playerEndpoint: 'https://example.test/player',
            serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
          },
        },
      },
    });
    expect(config.games.example.deployment.kind).toBe('external');
  });

  it('allows HTTP only for loopback control and authorization endpoints', () => {
    const deployment = {
      kind: 'external',
      controlEndpoint: 'http://127.0.0.1:3310',
      authorizationEndpoint: 'http://[::1]:3312',
      playerEndpoint: 'https://example.test/player',
      serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
    };
    const configFor = (override: Partial<typeof deployment> = {}) => ({
      ...rawConfig(),
      games: {
        example: {
          ...rawConfig().games.example,
          deployment: { ...deployment, ...override },
        },
      },
    });
    expect(() => parsePlatformConfig(configFor())).not.toThrow();
    for (const override of [
      { controlEndpoint: 'http://example.test/control' },
      { authorizationEndpoint: 'http://192.168.1.1/auth' },
      { controlEndpoint: 'http://user:password@127.0.0.1:3310' },
      { controlEndpoint: 'http://127.0.0.1:3310?token=secret' },
      { playerEndpoint: 'http://127.0.0.1:3311' },
    ]) {
      expect(() => parsePlatformConfig(configFor(override))).toThrow();
    }
  });
});
