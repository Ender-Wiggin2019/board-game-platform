import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverGameManifests,
  readGameManifest,
  resolveGameWorkspace,
  verifyGameManifest,
} from '../src/game-manifest.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    readonly clientDirectory?: string;
    readonly clientExports?: Record<string, unknown>;
    readonly manifest?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'bgp-game-manifest-'));
  roots.push(root);
  const game = join(root, 'games', 'example');
  const client = options.clientDirectory
    ? isAbsolute(options.clientDirectory)
      ? options.clientDirectory
      : join(root, options.clientDirectory)
    : join(game, 'client');
  const server = join(game, 'server');
  await mkdir(client, { recursive: true });
  await mkdir(server, { recursive: true });
  await writeFile(
    join(client, 'package.json'),
    JSON.stringify({
      name: '@board-games/example-client',
      exports: options.clientExports ?? { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(server, 'package.json'),
    JSON.stringify({
      name: '@board-games/example-server',
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(game, 'game.json'),
    JSON.stringify(
      options.manifest ?? {
        schemaVersion: 1,
        id: 'example',
        title: 'Example',
        client: { package: '@board-games/example-client', export: '.' },
        server: { package: '@board-games/example-server', export: '.' },
        status: 'scaffold',
      },
    ),
  );
  return { root, game, client };
}

describe('game manifest registry', () => {
  it('discovers public client and server entries without internal roles', async () => {
    const { root } = await fixture();
    const [target] = await discoverGameManifests(root);
    expect(target?.manifest).toMatchObject({
      id: 'example',
      status: 'scaffold',
    });
    expect(target?.clientPackage.name).toBe('@board-games/example-client');
    expect(target?.serverPackage.name).toBe('@board-games/example-server');
  });

  it('rejects game metadata that exposes internal package roles', async () => {
    const { root, game } = await fixture({
      manifest: {
        schemaVersion: 1,
        id: 'example',
        title: 'Example',
        client: { package: '@board-games/example-client', export: '.' },
        server: { package: '@board-games/example-server', export: '.' },
        common: { package: '@board-games/example-common', export: '.' },
        status: 'scaffold',
      },
    });
    await expect(readGameManifest(join(game, 'game.json'))).rejects.toThrow(
      'unsupported field common',
    );
    await expect(discoverGameManifests(root)).rejects.toThrow('common');
  });

  it('rejects invalid ids, packages outside the game path, and missing exports', async () => {
    const invalid = await fixture({
      manifest: {
        schemaVersion: 1,
        id: '../example',
        title: 'Example',
        client: { package: '@board-games/example-client', export: '.' },
        server: { package: '@board-games/example-server', export: '.' },
        status: 'scaffold',
      },
    });
    await expect(discoverGameManifests(invalid.root)).rejects.toThrow(
      'manifest.id is invalid',
    );

    const outside = await fixture({ clientDirectory: 'common/example-client' });
    await expect(discoverGameManifests(outside.root)).rejects.toThrow(
      'outside its game path',
    );

    const missingExport = await fixture({ clientExports: {} });
    await expect(discoverGameManifests(missingExport.root)).rejects.toThrow(
      'missing export',
    );
  });

  it('rejects malformed export conditions and targets outside a package', async () => {
    const invalidNames = await fixture({
      manifest: {
        schemaVersion: 1,
        id: 'example',
        title: 'Example',
        client: { package: '@board-games/example-client', export: '.bad' },
        server: { package: '@board-games/example-server', export: '.' },
        status: 'scaffold',
      },
    });
    await expect(
      readGameManifest(join(invalidNames.game, 'game.json')),
    ).rejects.toThrow('package export path');

    for (const exports of [
      { '.': null },
      { '.': false },
      { '.': '' },
      { '.': './' },
      { '.': '../outside.js' },
      { '.': './nested\\..\\outside.js' },
      { '.': { types: './dist/index.d.ts' } },
      { '.': { import: null, types: false } },
    ]) {
      const invalidTarget = await fixture({ clientExports: exports });
      await expect(discoverGameManifests(invalidTarget.root)).rejects.toThrow(
        'invalid',
      );
    }
  });

  it('rejects duplicate public game ids', async () => {
    const { root } = await fixture();
    const duplicate = join(root, 'games', 'other');
    await mkdir(duplicate, { recursive: true });
    await writeFile(
      join(duplicate, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'example',
        title: 'Duplicate',
        client: { package: '@board-games/example-client', export: '.' },
        server: { package: '@board-games/example-server', export: '.' },
        status: 'scaffold',
      }),
    );
    await expect(discoverGameManifests(root)).rejects.toThrow(
      'Duplicate game manifest id',
    );
  });

  it('verifies only direct games roots', async () => {
    const { root, game } = await fixture();
    await expect(verifyGameManifest(join(root, 'games'), root)).rejects.toThrow(
      'direct child',
    );
    await expect(verifyGameManifest(game, root)).resolves.toMatchObject({
      manifest: { id: 'example' },
    });
  });

  it('verifies one game independently of another unfinished game', async () => {
    const { root, game } = await fixture();
    const unfinished = join(root, 'games', 'unfinished');
    await mkdir(join(unfinished, 'client'), { recursive: true });
    await writeFile(join(unfinished, 'game.json'), '{ invalid JSON');
    await writeFile(
      join(unfinished, 'client', 'package.json'),
      '{ invalid JSON',
    );

    await expect(verifyGameManifest(game, root)).resolves.toMatchObject({
      manifest: { id: 'example' },
    });
    await expect(discoverGameManifests(root)).rejects.toThrow('Invalid');
  });

  it('rejects a package manifest at the game root', async () => {
    const { root, game } = await fixture();
    await writeFile(join(game, 'package.json'), '{}');
    await expect(discoverGameManifests(root)).rejects.toThrow(
      'Game root must not contain package.json',
    );
  });

  it('rejects a game directory without a public manifest', async () => {
    const { root } = await fixture();
    await mkdir(join(root, 'games', 'missing-manifest'), { recursive: true });
    await expect(discoverGameManifests(root)).rejects.toThrow(
      'missing game.json',
    );
  });

  it('discovers a root game manifest with arbitrary nested workspace packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-independent-game-'));
    roots.push(root);
    const client = join(root, 'packages', 'ui', 'client');
    const server = join(root, 'runtime', 'server');
    await mkdir(client, { recursive: true });
    await mkdir(server, { recursive: true });
    await writeFile(
      join(client, 'package.json'),
      JSON.stringify({
        name: '@board-games/independent-client',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(server, 'package.json'),
      JSON.stringify({
        name: '@board-games/independent-server',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(root, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'independent',
        title: 'Independent',
        client: {
          package: '@board-games/independent-client',
          export: '.',
        },
        server: {
          package: '@board-games/independent-server',
          export: '.',
        },
        status: 'scaffold',
      }),
    );

    const [target] = await discoverGameManifests(root);
    expect(target?.gameDirectory).toBe(root);
    expect(target?.clientPackage.directory).toBe(client);
    expect(target?.serverPackage.directory).toBe(server);
    await expect(verifyGameManifest(root, root)).resolves.toMatchObject({
      manifest: { id: 'independent' },
    });
    await expect(resolveGameWorkspace('.', root)).resolves.toEqual({
      workspaceRoot: root,
      gameDirectory: root,
      manifestPath: join(root, 'game.json'),
    });
  });

  it('resolves installed client and server packages for a dist export root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-installed-game-'));
    roots.push(root);
    for (const role of ['client', 'server'] as const) {
      const directory = join(
        root,
        'node_modules',
        '@board-games',
        `installed-${role}`,
      );
      await mkdir(join(directory, 'dist'), { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: `@board-games/installed-${role}`,
          exports: { './remote': './dist/remote.js' },
        }),
      );
      await writeFile(join(directory, 'dist', 'remote.js'), 'export {}\n');
    }
    await writeFile(
      join(root, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'installed',
        title: 'Installed',
        client: {
          package: '@board-games/installed-client',
          export: './remote',
        },
        server: {
          package: '@board-games/installed-server',
          export: './remote',
        },
        status: 'ready',
      }),
    );

    await expect(verifyGameManifest(root, root)).resolves.toMatchObject({
      clientPackage: {
        directory: join(
          root,
          'node_modules',
          '@board-games',
          'installed-client',
        ),
      },
      serverPackage: {
        directory: join(
          root,
          'node_modules',
          '@board-games',
          'installed-server',
        ),
      },
    });
  });

  it('allows an independently maintained game package root below an explicit workspace', async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'bgp-independent-workspace-'),
    );
    roots.push(workspace);
    const game = join(workspace, 'counter-game');
    const client = join(game, 'client');
    const server = join(game, 'server');
    await mkdir(client, { recursive: true });
    await mkdir(server, { recursive: true });
    await writeFile(
      join(game, 'package.json'),
      JSON.stringify({ name: 'counter-game' }),
    );
    await writeFile(
      join(client, 'package.json'),
      JSON.stringify({
        name: '@board-games/counter-game-client',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(server, 'package.json'),
      JSON.stringify({
        name: '@board-games/counter-game-server',
        exports: { '.': './dist/index.js' },
      }),
    );
    await writeFile(
      join(game, 'game.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'counter-game',
        title: 'Counter Game',
        client: { package: '@board-games/counter-game-client', export: '.' },
        server: { package: '@board-games/counter-game-server', export: '.' },
        status: 'scaffold',
      }),
    );

    await expect(
      resolveGameWorkspace('counter-game', workspace),
    ).resolves.toEqual({
      workspaceRoot: workspace,
      gameDirectory: game,
      manifestPath: join(game, 'game.json'),
    });
    await expect(verifyGameManifest(game, workspace)).resolves.toMatchObject({
      manifest: { id: 'counter-game' },
    });
  });
});
