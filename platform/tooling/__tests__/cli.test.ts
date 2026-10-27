import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function independentGame() {
  const root = await mkdtemp(join(tmpdir(), 'bgp-platform-cli-'));
  roots.push(root);
  const client = join(root, 'frontend', 'ui');
  const server = join(root, 'backend', 'runtime');
  for (const directory of [client, server]) {
    await mkdir(join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'dist', 'index.js'), 'export {}\n');
  }
  await writeFile(
    join(client, 'package.json'),
    JSON.stringify({
      name: '@board-games/cli-example-client',
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(server, 'package.json'),
    JSON.stringify({
      name: '@board-games/cli-example-server',
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(root, 'game.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'cli-example',
      title: 'CLI Example',
      client: {
        package: '@board-games/cli-example-client',
        export: '.',
      },
      server: {
        package: '@board-games/cli-example-server',
        export: '.',
      },
      status: 'ready',
    }),
  );
  return root;
}

describe('platform CLI workspace resolution', () => {
  it('verifies an independent root game with --workspace', async () => {
    const root = await independentGame();
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(['game', 'verify', '.', '--check', '--workspace', root]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(output)).toMatchObject({
      verified: true,
      gameId: 'cli-example',
      metadataOnly: true,
    });
    expect(await readFile(join(root, 'game.json'), 'utf8')).toContain(
      'cli-example',
    );
  });

  it('initializes an independent platform and emits a machine-readable plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-platform-init-'));
    roots.push(root);
    const initializedOutput = captureOutput();
    try {
      await runCli(['platform', 'init', 'config', '--workspace', root]);
    } finally {
      initializedOutput.restore();
    }
    expect(JSON.parse(initializedOutput.value())).toMatchObject({
      initialized: true,
      directory: join(root, 'config'),
    });
    const plannedOutput = captureOutput();
    try {
      await runCli([
        'platform',
        'deployment',
        'plan',
        'example',
        '--workspace',
        join(root, 'config'),
      ]);
    } finally {
      plannedOutput.restore();
    }
    expect(JSON.parse(plannedOutput.value())).toMatchObject({
      planned: true,
      dryRun: true,
      target: { gameId: 'example', releaseId: 'example-v1' },
      command: expect.arrayContaining(['up', '--no-deps']),
    });
    const composeOutput = join(root, 'config', 'generated-compose.yaml');
    const outputPlan = captureOutput();
    try {
      await runCli([
        'platform',
        'deployment',
        'plan',
        'example',
        '--workspace',
        join(root, 'config'),
        '--output',
        composeOutput,
      ]);
    } finally {
      outputPlan.restore();
    }
    expect(await readFile(composeOutput, 'utf8')).toContain(
      'bgp-game-example-example-v1',
    );
  });

  it('initializes a zero-game platform with its own migration and web services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-empty-platform-init-'));
    roots.push(root);
    const output = captureOutput();
    try {
      await runCli(['platform', 'init', '.', '--empty', '--workspace', root]);
    } finally {
      output.restore();
    }
    expect(
      JSON.parse(await readFile(join(root, 'platform.config.json'), 'utf8'))
        .games,
    ).toEqual({});
    expect(
      JSON.parse(await readFile(join(root, 'games.lock.json'), 'utf8')).games,
    ).toEqual({});
    const compose = await readFile(join(root, 'compose.yaml'), 'utf8');
    expect(compose).toContain('dist/migrate.js');
    expect(compose).toContain('PLATFORM_CLIENT_IMAGE');
    expect(compose).not.toContain('bgp-game-');
  });

  it('installs the portable developer skill with a game starter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-game-init-cli-'));
    roots.push(root);
    const output = captureOutput();
    try {
      await runCli(['game', 'init', 'game', '--workspace', root]);
    } finally {
      output.restore();
    }
    expect(JSON.parse(output.value())).toMatchObject({
      initialized: true,
      files: expect.arrayContaining(['.agents/skills/game-developer/SKILL.md']),
    });
    const skill = await readFile(
      join(root, 'game', '.agents', 'skills', 'game-developer', 'SKILL.md'),
      'utf8',
    );
    expect(skill).not.toContain('/Users/');
    expect(skill).toContain('bgp dev');
  });

  it('writes the exact versioned plan before invoking Compose and safely retries it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-compose-cli-'));
    roots.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('-f') + 1];
fs.writeFileSync('invocation.json', JSON.stringify({ args, yaml: fs.readFileSync(file, 'utf8') }));
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    const output = captureOutput();
    try {
      await runCli(['platform', 'init', '.', '--workspace', root]);
      const args = [
        'platform',
        'game',
        'deploy',
        'example',
        '--platform-id',
        'my-platform',
        '--workspace',
        root,
        '--json',
      ];
      await runCli(args);
      const invocation = JSON.parse(
        await readFile(join(root, 'invocation.json'), 'utf8'),
      ) as { args: string[]; yaml: string };
      expect(invocation.args).toEqual(
        expect.arrayContaining(['up', '--detach', '--no-deps']),
      );
      expect(invocation.yaml).toContain('GAME_RUNTIME_CONFIG');
      expect(invocation.yaml).toContain(
        '../runtime/example-v1.json:/app/game.runtime.json:ro',
      );
      const composeFile = invocation.args[
        invocation.args.indexOf('-f') + 1
      ] as string;
      expect(composeFile).toMatch(
        /^deployments\/bgp-game-example-example-v1-[a-f0-9]{8}\.compose\.yaml$/u,
      );
      await runCli(args);
      expect(await readFile(join(root, composeFile), 'utf8')).toBe(
        invocation.yaml,
      );
      await writeFile(join(root, composeFile), 'services: {}\n');
      await expect(runCli(args)).rejects.toThrow(
        'Refusing to overwrite a different Compose plan',
      );
    } finally {
      output.restore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('executes register and activate against an ephemeral platform HTTP service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-platform-admin-cli-'));
    roots.push(root);
    const payloadPath = join(root, 'register.json');
    await writeFile(
      payloadPath,
      JSON.stringify({
        manifest: {},
        service: {},
        approvedFeatures: [],
        approvedModes: [],
        binding: {
          deployment: 'external',
          controlEndpoint: 'https://game.example.test/control',
          playerEndpoint: 'https://game.example.test/player',
          clientArtifactBaseUrl: 'https://game.example.test/client/',
          serviceCredentialRef: 'secrets/example-service',
        },
      }),
    );
    const requests: { path: string; body: unknown; operationId?: string }[] =
      [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const operationHeader = request.headers['x-bgp-operation-id'];
        requests.push({
          path: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          ...(typeof operationHeader === 'string'
            ? { operationId: operationHeader }
            : {}),
        });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ accepted: true, path: request.url }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const previous = process.env.BGP_TEST_PLATFORM_TOKEN;
    process.env.BGP_TEST_PLATFORM_TOKEN = 'admin-token';
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('no address');
      const baseArgs = [
        '--platform-id',
        'platform',
        '--platform-url',
        `http://127.0.0.1:${address.port}/api`,
        '--platform-token-ref',
        'env:BGP_TEST_PLATFORM_TOKEN',
        '--insecure-localhost',
        '--json',
        '--workspace',
        root,
      ];
      const registerOutput = captureOutput();
      try {
        await runCli([
          'platform',
          'game',
          'register',
          'register.json',
          ...baseArgs,
        ]);
      } finally {
        registerOutput.restore();
      }
      expect(JSON.parse(registerOutput.value())).toMatchObject({
        action: 'register',
        dryRun: false,
        result: { accepted: true },
      });
      const activateOutput = captureOutput();
      try {
        await runCli([
          'platform',
          'game',
          'activate',
          'binding-1',
          ...baseArgs,
        ]);
      } finally {
        activateOutput.restore();
      }
      expect(JSON.parse(activateOutput.value())).toMatchObject({
        action: 'activate',
        dryRun: false,
        result: { accepted: true },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        path: '/api/platform/admin/releases',
        body: { binding: { serviceCredentialRef: 'secrets/example-service' } },
      });
      expect(requests[1]).toMatchObject({
        path: '/api/platform/admin/releases/bindings/binding-1/activate',
        body: {},
      });
      expect(requests.every((request) => request.operationId)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BGP_TEST_PLATFORM_TOKEN;
      else process.env.BGP_TEST_PLATFORM_TOKEN = previous;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function captureOutput() {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    value: () => output,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}
