import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyGame } from '../src/game-verify.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bgp-game-verify-'));
  roots.push(root);
  const game = join(root, 'games', 'example');
  for (const role of ['client', 'server']) {
    const directory = join(game, role);
    await mkdir(directory, { recursive: true });
    await mkdir(join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'dist', 'index.js'), 'export {};\n');
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `@board-games/example-${role}`,
        exports: { '.': './dist/index.js' },
      }),
    );
  }
  await writeFile(
    join(game, 'game.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example',
      title: 'Example',
      client: { package: '@board-games/example-client', export: '.' },
      server: { package: '@board-games/example-server', export: '.' },
      status: 'ready',
    }),
  );
  return { root, game };
}

describe('bounded game verification', () => {
  it('supports metadata-only checks without invoking the package manager', async () => {
    const { root, game } = await fixture();
    const run = vi.fn(async () => undefined);
    const result = await verifyGame(game, {
      workspaceRoot: root,
      metadataOnly: true,
      run,
    });
    expect(result.metadataOnly).toBe(true);
    expect(result.commands).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs build, typecheck, and test for only the selected game closures', async () => {
    const { root, game } = await fixture();
    const calls: { command: string; args: readonly string[]; cwd: string }[] =
      [];
    const result = await verifyGame(game, {
      workspaceRoot: root,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });
    expect(result.commands.map((command) => command.operation)).toEqual([
      'build',
      'typecheck',
      'test',
    ]);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.command).toBe('corepack');
      expect(call.cwd).toBe(root);
      expect(call.args).toContain('--filter');
      expect(call.args).toContain('@board-games/example-client...');
      expect(call.args).toContain('@board-games/example-server...');
      expect(call.args).not.toContain('@board-games/brass-client...');
    }
  });

  it('rejects a build when a declared public entry is missing', async () => {
    const { root, game } = await fixture();
    await rm(join(game, 'client', 'dist', 'index.js'));
    await expect(
      verifyGame(game, {
        workspaceRoot: root,
        run: async () => undefined,
      }),
    ).rejects.toThrow('build output is missing');
  });

  it('can run only the requested offline build operation', async () => {
    const { root, game } = await fixture();
    const run = vi.fn(async () => undefined);
    const result = await verifyGame(game, {
      workspaceRoot: root,
      operations: ['build'],
      run,
    });
    expect(result.commands.map((command) => command.operation)).toEqual([
      'build',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
