import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeProject } from '../src/init.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('project initialization', () => {
  it('creates a compilable native module starter without installing anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-init-'));
    roots.push(root);
    const result = await initializeProject(
      join(root, 'Native Example'),
      'native-module',
    );
    expect(result.files).toEqual([
      'package.json',
      'tsconfig.json',
      'README.md',
      'src/index.ts',
    ]);
    const source = await readFile(
      join(result.directory, 'src/index.ts'),
      'utf8',
    );
    expect(source).toContain('defineGame');
    expect(source).toContain("gameId: 'native-example'");
    expect(
      await readFile(join(result.directory, 'package.json'), 'utf8'),
    ).toContain('"@board-game/sdk"');
  });

  it('creates an explicit legacy contract starter instead of claiming runtime support', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-init-'));
    roots.push(root);
    const result = await initializeProject(
      join(root, 'legacy'),
      'legacy-service',
    );
    const source = await readFile(
      join(result.directory, 'src/legacy-adapter.ts'),
      'utf8',
    );
    expect(source).toContain("profile: 'legacy-service-v1'");
    expect(source).toContain('no runtime transport');
    expect(source).not.toContain('GameHost');
  });

  it('never overwrites an existing destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-init-'));
    roots.push(root);
    const output = join(root, 'existing');
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'keep');
    await expect(initializeProject(output, 'native-module')).rejects.toThrow(
      'Destination already exists',
    );
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('creates an independent four-leaf integrated game scaffold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bgp-init-'));
    roots.push(root);
    const result = await initializeProject(
      join(root, 'games', 'tiny-game'),
      'integrated-game',
    );
    expect(result.profile).toBe('integrated-game');
    expect(result.files).toContain('game.json');
    for (const role of ['common', 'engine', 'client', 'server']) {
      expect(result.files).toContain(`${role}/package.json`);
      expect(result.files).toContain(`${role}/tsconfig.json`);
      expect(result.files).toContain(`${role}/tsconfig.build.json`);
      expect(result.files).toContain(`${role}/src/index.ts`);
      expect(result.files).toContain(`${role}/__tests__/index.test.ts`);
      const packageJson = JSON.parse(
        await readFile(join(result.directory, role, 'package.json'), 'utf8'),
      ) as { exports?: Record<string, unknown> };
      expect(packageJson.exports).toHaveProperty('.');
    }
    const gameManifest = JSON.parse(
      await readFile(join(result.directory, 'game.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(gameManifest).toMatchObject({
      id: 'tiny-game',
      status: 'scaffold',
    });
    expect(gameManifest).not.toHaveProperty('common');
    expect(gameManifest).not.toHaveProperty('engine');
    expect(
      await readFile(join(result.directory, 'client/src/index.ts'), 'utf8'),
    ).toContain('defineGameComponent');
    expect(
      await readFile(join(result.directory, 'server/src/index.ts'), 'utf8'),
    ).toContain('defineGameServer');
  });
});
