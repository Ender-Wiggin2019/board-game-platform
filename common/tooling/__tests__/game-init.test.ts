import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeGameProject } from '../src/game-init.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('initializeGameProject', () => {
  it('creates a portable counter starter with public package boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-game-init-'));
    roots.push(root);
    const directory = join(root, 'counter-game');
    const result = await initializeGameProject(directory);

    expect(result.directory).toBe(resolve(directory));
    expect(result.gameId).toBe('counter-game');
    expect(result.files).toContain('game.json');
    expect(
      JSON.parse(await readFile(join(directory, 'game.json'), 'utf8')),
    ).toMatchObject({
      id: 'counter-game',
      client: { package: '@board-games/counter-game-client', export: '.' },
      server: { package: '@board-games/counter-game-server', export: '.' },
    });
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toContain(
      '"dev": "bgp dev"',
    );
    expect(
      await readFile(join(directory, 'server/src/index.ts'), 'utf8'),
    ).not.toContain('/Users/');
    expect(
      await readFile(join(directory, 'server/src/index.ts'), 'utf8'),
    ).not.toContain('platform/dev-host');
    const engineSource = await readFile(
      join(directory, 'engine/src/index.ts'),
      'utf8',
    );
    expect(engineSource).toContain('maxPlayers: 2');
    expect(engineSource).toContain('readonly playerIds: readonly string[]');
    expect(engineSource).toContain(
      "kind: state.playerIds.length === 1 ? 'solo' : 'cooperative'",
    );
    const readme = await readFile(join(directory, 'README.md'), 'utf8');
    expect(readme).toContain('fixed player accounts');
    expect(readme).toContain('turns alternate between joined players');
    expect(await stat(join(directory, 'fixtures/scenarios.json'))).toBeTruthy();
    expect(await stat(join(directory, 'test/counter.test.mjs'))).toBeTruthy();
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining([
        'common',
        'engine',
        'server',
        'client',
        'fixtures',
        'test',
      ]),
    );
  });

  it('does not overwrite an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-game-init-existing-'));
    roots.push(root);
    const directory = join(root, 'counter-game');
    await initializeGameProject(directory);
    await expect(initializeGameProject(directory)).rejects.toThrow(
      'Destination already exists',
    );
  });
});
