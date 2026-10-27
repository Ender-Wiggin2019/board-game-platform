import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStandaloneConfig } from '../src/config.js';

describe('empty standalone platform configuration', () => {
  it('accepts an empty installation and requires single-source credentials as a pair', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bgp-empty-config-'));
    const image = `test/platform@sha256:${'0'.repeat(64)}`;
    const platform = { id: 'empty-test', image };
    await writeFile(
      join(directory, 'platform.config.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform: {
          ...platform,
          databaseUrlEnv: 'PLATFORM_DATABASE_URL',
          features: {},
        },
        games: {},
      }),
    );
    await writeFile(
      join(directory, 'games.lock.json'),
      JSON.stringify({ schemaVersion: 1, platform, games: {} }),
    );
    const env = {
      NODE_ENV: 'production',
      PLATFORM_DATABASE_URL: 'postgresql://unused@127.0.0.1/unused',
      JWT_SECRET: 'test-only-key-with-more-than-thirty-two-characters',
      PLATFORM_PLAYER_PRIVATE_KEY: 'env:TEST_PRIVATE_KEY',
      PLATFORM_PLAYER_AUDIENCE: 'test-audience',
    };
    try {
      const config = await loadStandaloneConfig(env, directory);
      expect(config.installation.config.games).toEqual({});
      expect(config.factIngressCredentials).toBeUndefined();
      expect(config.serviceCredentialDirectory).toBeUndefined();
      const credentialDirectory = join(directory, 'credentials');
      const configuredDirectory = await loadStandaloneConfig(
        {
          ...env,
          PLATFORM_SERVICE_CREDENTIALS_DIR: credentialDirectory,
        },
        directory,
      );
      expect(configuredDirectory.serviceCredentialDirectory).toBe(
        credentialDirectory,
      );
      await expect(
        loadStandaloneConfig(
          {
            ...env,
            PLATFORM_SERVICE_CREDENTIALS_DIR: 'credentials',
          },
          directory,
        ),
      ).rejects.toThrow('must be absolute');
      await expect(
        loadStandaloneConfig(
          {
            ...env,
            PLATFORM_FACT_INGRESS_TOKEN:
              'test-only-token-with-thirty-two-characters',
          },
          directory,
        ),
      ).rejects.toThrow('required together');
      const configured = await loadStandaloneConfig(
        {
          ...env,
          PLATFORM_FACT_INGRESS_TOKEN:
            'test-only-token-with-thirty-two-characters',
          PLATFORM_FACT_SOURCE_GAME_ID: 'counter',
          PLATFORM_FACT_SOURCE_RELEASE_ID: 'v1',
          PLATFORM_FACT_SOURCE_BINDING_ID: 'counter-binding',
          PLATFORM_FACT_SOURCE_OWNERSHIP_EPOCH: '1',
          PLATFORM_FACT_INGRESS_PORT: '4010',
        },
        directory,
      );
      expect(configured.factIngressSource?.gameId).toBe('counter');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
