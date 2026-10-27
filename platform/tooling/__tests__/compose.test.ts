import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createComposePlan,
  createComposePlanFromFiles,
} from '../src/compose.js';
import { parseGamesLock, parsePlatformConfig } from '../src/config.js';

const shaA = `sha256:${'a'.repeat(64)}`;
const shaB = `sha256:${'b'.repeat(64)}`;

function configFor(release: string, gameImage: string) {
  return parsePlatformConfig({
    schemaVersion: 1,
    platform: {
      id: 'my-platform',
      image: `registry.example/platform@${shaA}`,
      databaseUrlEnv: 'PLATFORM_DATABASE_URL',
      features: {},
    },
    games: {
      example: {
        enabled: true,
        release,
        manifestRef: `releases/${release}.json`,
        runtime: {
          schemaVersion: 1,
          gameId: 'example',
          releaseId: release,
          environment: 'production',
          storage: {
            driver: 'postgres',
            urlEnv: 'GAME_DATABASE_URL',
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
            host: '0.0.0.0',
            controlPort: 3000,
            playerPort: 3001,
            authorizationPort: 3002,
            allowedOrigins: [],
          },
        },
        deployment: {
          kind: 'managed',
          adapter: 'compose',
          image: gameImage,
          runtimeConfig: `runtime/${release}.json`,
        },
        approvedCapabilities: ['rooms'],
      },
    },
  });
}

function lockFor(release: string) {
  return parseGamesLock({
    schemaVersion: 1,
    platform: {
      id: 'my-platform',
      image: `registry.example/platform@${shaA}`,
    },
    games: {
      example: {
        release,
        manifestRef: `releases/${release}.json`,
        image: `registry.example/example@${release === 'example-v1' ? shaA : shaB}`,
        sourceSha: shaA,
        artifacts: { client: shaA, server: shaA, publicAssets: shaA },
      },
    },
  });
}

describe('Compose deployment plan', () => {
  it('plans one managed release with an exact target and no destructive operation', () => {
    const plan = createComposePlan(
      configFor('example-v1', `registry.example/example@${shaA}`),
      lockFor('example-v1'),
      'example',
    );
    expect(plan.targetService).toMatch(
      /^bgp-game-example-example-v1-[a-f0-9]{8}$/u,
    );
    expect(plan.services.map(({ name }) => name)).toEqual([plan.targetService]);
    expect(plan.command).toEqual([
      'docker',
      'compose',
      '--project-name',
      'bgp-my-platform',
      '-f',
      `deployments/${plan.targetService}.compose.yaml`,
      'up',
      '--detach',
      '--no-deps',
      plan.targetService,
    ]);
    expect(plan.command.join(' ')).not.toMatch(/down|prune/);
    expect(plan.composeYaml).toContain('GAME_DATABASE_URL');
    expect(plan.composeYaml).toContain('GAME_RUNTIME_CONFIG');
    expect(plan.composeYaml).toContain(
      '../runtime/example-v1.json:/app/game.runtime.json:ro',
    );
    expect(plan.composeYaml).toContain('pids_limit: 256');
    expect(plan.composeYaml).not.toContain('postgres://');
  });

  it('keeps v1 and v2 service names distinct while planning only the selected release', () => {
    const v1 = createComposePlan(
      configFor('example-v1', `registry.example/example@${shaA}`),
      lockFor('example-v1'),
      'example',
    );
    const v2 = createComposePlan(
      configFor('example-v2', `registry.example/example@${shaB}`),
      lockFor('example-v2'),
      'example',
    );
    expect(v1.targetService).not.toBe(v2.targetService);
    expect(v1.composeYaml).not.toContain('example-v2');
    expect(v2.composeYaml).not.toContain('example-v1');
  });

  it('reads and canonicalizes the mounted runtime config before planning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-compose-runtime-'));
    try {
      const config = configFor(
        'example-v1',
        `registry.example/example@${shaA}`,
      );
      const lock = lockFor('example-v1');
      await mkdir(join(root, 'runtime'), { recursive: true });
      await writeFile(
        join(root, 'platform.config.json'),
        JSON.stringify(config),
      );
      await writeFile(join(root, 'games.lock.json'), JSON.stringify(lock));
      await writeFile(
        join(root, 'runtime/example-v1.json'),
        JSON.stringify(config.games.example.runtime),
      );

      const plan = await createComposePlanFromFiles({
        workspaceRoot: root,
        targetGameId: 'example',
        composeFile: 'config/generated.yaml',
      });
      expect(plan.services[0]?.volumes).toContain(
        '../runtime/example-v1.json:/app/game.runtime.json:ro',
      );

      await writeFile(
        join(root, 'runtime/example-v1.json'),
        JSON.stringify({
          ...config.games.example.runtime,
          releaseId: 'example-v2',
        }),
      );
      await expect(
        createComposePlanFromFiles({
          workspaceRoot: root,
          targetGameId: 'example',
        }),
      ).rejects.toThrow(/runtime config does not match/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mounts existing file references beneath the runtime config directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-compose-secrets-'));
    try {
      const base = configFor('example-v1', `registry.example/example@${shaA}`);
      const config = parsePlatformConfig({
        ...base,
        games: {
          example: {
            ...base.games.example,
            runtime: {
              ...base.games.example.runtime,
              platformConnection: {
                ...base.games.example.runtime.platformConnection,
                serviceCredentialRef: 'secrets/game-service',
              },
            },
          },
        },
      });
      const lock = lockFor('example-v1');
      await mkdir(join(root, 'runtime/secrets'), { recursive: true });
      await writeFile(
        join(root, 'platform.config.json'),
        JSON.stringify(config),
      );
      await writeFile(join(root, 'games.lock.json'), JSON.stringify(lock));
      await writeFile(
        join(root, 'runtime/example-v1.json'),
        JSON.stringify(config.games.example.runtime),
      );
      await writeFile(join(root, 'runtime/secrets/game-service'), 'secret');

      const plan = await createComposePlanFromFiles({
        workspaceRoot: root,
        targetGameId: 'example',
      });
      expect(plan.services[0]?.volumes).toContain(
        '../runtime/secrets/game-service:/app/secrets/game-service:ro',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not emit a platform startup command for an external game', () => {
    const base = configFor('example-v1', `registry.example/example@${shaA}`);
    const config = parsePlatformConfig({
      ...base,
      games: {
        example: {
          ...base.games.example,
          deployment: {
            kind: 'external',
            controlEndpoint: 'https://example.test/control',
            playerEndpoint: 'https://example.test/player',
            serviceCredentialRef: 'env:GAME_SERVICE_CREDENTIAL',
          },
        },
      },
    });
    expect(() =>
      createComposePlan(config, lockFor('example-v1'), 'example'),
    ).toThrow(/cannot be started by Compose/);
  });
});
