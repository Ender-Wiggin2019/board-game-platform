import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportGamePackage, verifyGamePackage } from '../src/game-package.js';

const roots: string[] = [];

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveProcess()
        : reject(new Error(`${command} exited with status ${code}`)),
    );
  });
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    readonly missingClientExport?: boolean;
    readonly unsafeClientFiles?: boolean;
    readonly gameNotice?: boolean;
    readonly gameReadme?: boolean;
    readonly upstreamMetadata?: boolean;
    readonly clientNotice?: boolean;
    readonly clientLicense?: boolean;
    readonly clientDevDependency?: boolean;
    readonly optionalPlatformPeer?: boolean;
    readonly serverWorkspaceDevDependency?: boolean;
    readonly collidingDependencies?: boolean;
    readonly helperScripts?: boolean;
    readonly clientExport?: string;
    readonly serverExport?: string;
    readonly manifestServerExport?: string;
    readonly standaloneServerBuild?: boolean;
    readonly patchedDependency?: boolean;
    readonly invalidPatchPath?: boolean;
    readonly symlinkPatchPath?: boolean;
    readonly multiVersionDependency?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'bgp-game-package-'));
  roots.push(root);
  const game = join(root, 'games', 'example');
  for (const directory of [
    join(root, 'common', 'sdk', 'dist'),
    ...(options.serverWorkspaceDevDependency
      ? [join(root, 'common', 'test-helper', 'dist')]
      : []),
    ...(options.collidingDependencies
      ? [
          join(root, 'common', 'fixture-a', 'dist'),
          join(root, 'common', 'fixture-b', 'dist'),
        ]
      : []),
    join(root, 'platform', 'contracts', 'dist'),
    ...(options.optionalPlatformPeer
      ? [join(root, 'platform', 'server', 'dist')]
      : []),
    join(game, 'client', 'src'),
    join(game, 'client', 'dist'),
    join(game, 'server', 'src'),
    join(game, 'server', 'dist'),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'tsconfig.base.json'), '{}\n');
  if (options.clientDevDependency) {
    await mkdir(join(root, 'node_modules', 'fixture-tool'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules', 'fixture-tool', 'package.json'),
      JSON.stringify({ name: 'fixture-tool', version: '9.8.7' }),
    );
  }
  await writeFile(
    join(root, 'common', 'sdk', 'dist', 'index.js'),
    'export {}\n',
  );
  await writeFile(
    join(root, 'platform', 'contracts', 'dist', 'index.js'),
    'export {}\n',
  );
  await writeFile(
    join(game, 'client', 'src', 'index.ts'),
    'export const client = true;\n',
  );
  await writeFile(
    join(game, 'client', 'dist', 'index.js'),
    'export const client = true;\n',
  );
  await writeFile(
    join(game, 'server', 'src', 'index.ts'),
    'export const server = true;\n',
  );
  await writeFile(
    join(game, 'server', 'dist', 'index.js'),
    'export const server = true;\n',
  );
  if (options.clientExport)
    await writeFile(
      join(game, 'client', 'dist', 'remote.js'),
      'export const clientRemote = true;\n',
    );
  if (options.serverExport)
    await writeFile(
      join(game, 'server', 'dist', 'remote.js'),
      'export const serverRemote = true;\n',
    );
  await writeFile(
    join(root, 'common', 'sdk', 'package.json'),
    JSON.stringify({
      name: '@board-game/sdk',
      version: '1.2.3',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
    }),
  );
  if (options.serverWorkspaceDevDependency) {
    await writeFile(
      join(root, 'common', 'test-helper', 'dist', 'index.js'),
      'export {}\n',
    );
    await writeFile(
      join(root, 'common', 'test-helper', 'package.json'),
      JSON.stringify({
        name: '@board-game/test-helper',
        version: '2.3.4',
        exports: { '.': './dist/index.js' },
        files: ['dist'],
      }),
    );
  }
  if (options.collidingDependencies) {
    for (const [directory, name] of [
      ['fixture-a', '@fixture/foo-bar'],
      ['fixture-b', '@fixture-foo/bar'],
    ]) {
      await writeFile(
        join(root, 'common', directory, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          exports: { '.': './dist/index.js' },
          files: ['dist'],
        }),
      );
      await writeFile(
        join(root, 'common', directory, 'dist', 'index.js'),
        'export {}\n',
      );
    }
  }
  await writeFile(
    join(root, 'platform', 'contracts', 'package.json'),
    JSON.stringify({
      name: '@board-platform/contracts',
      version: '4.5.6',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
    }),
  );
  if (options.optionalPlatformPeer)
    await writeFile(
      join(root, 'platform', 'server', 'package.json'),
      JSON.stringify({
        name: '@board-platform/server',
        version: '7.8.9',
        exports: { '.': './dist/index.js' },
        files: ['dist'],
      }),
    );
  await writeFile(
    join(game, 'client', 'package.json'),
    JSON.stringify({
      name: '@board-games/example-client',
      version: '0.1.0',
      private: true,
      files: options.unsafeClientFiles ? ['dist/../src'] : ['dist'],
      exports: {
        '.': './dist/index.js',
        ...(options.clientExport
          ? { [options.clientExport]: './dist/remote.js' }
          : {}),
      },
      dependencies: { '@board-game/sdk': 'workspace:*' },
      ...(options.collidingDependencies
        ? {
            dependencies: {
              '@board-game/sdk': 'workspace:*',
              '@fixture/foo-bar': 'workspace:*',
              '@fixture-foo/bar': 'workspace:*',
            },
          }
        : {}),
      ...(options.clientDevDependency
        ? { devDependencies: { 'fixture-tool': '^1.0.0' } }
        : {}),
      scripts: options.helperScripts
        ? {
            prebuild: 'pnpm sync-assets',
            build: 'pnpm run compile:js && npm run copy-assets',
            'compile:js': 'pnpm run copy-assets',
            'copy-assets': 'node scripts/copy-assets.mjs',
            'sync-assets': 'node scripts/sync-assets.mjs',
            migrate: 'node ../../../apps/server/x.js',
          }
        : {
            build: 'tsc -p tsconfig.build.json',
            migrate: 'node ../../../apps/server/x.js',
          },
    }),
  );
  if (options.patchedDependency) {
    const clientPackagePath = join(game, 'client', 'package.json');
    const clientPackage = JSON.parse(
      await readFile(clientPackagePath, 'utf8'),
    ) as { dependencies: Record<string, string> };
    clientPackage.dependencies['react-resizable-panels'] = '4.12.3';
    await writeFile(clientPackagePath, JSON.stringify(clientPackage));
    await mkdir(join(root, 'node_modules', 'react-resizable-panels'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules', 'react-resizable-panels', 'package.json'),
      JSON.stringify({ name: 'react-resizable-panels', version: '4.12.3' }),
    );
    const patchPath = options.invalidPatchPath
      ? '../outside.patch'
      : options.symlinkPatchPath
        ? 'patches/escaped.patch'
        : 'patches/react-resizable-panels@4.12.3.patch';
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-root',
        pnpm: {
          patchedDependencies: {
            'react-resizable-panels@4.12.3': patchPath,
            'unused-package@1.0.0': 'patches/unused-package@1.0.0.patch',
          },
        },
      }),
    );
    if (!options.invalidPatchPath && options.symlinkPatchPath) {
      const outside = await mkdtemp(join(tmpdir(), 'bgp-patch-outside-'));
      roots.push(outside);
      await writeFile(join(outside, 'escaped.patch'), 'escaped patch\n');
      await symlink(outside, join(root, 'patches'), 'dir');
    } else if (!options.invalidPatchPath) {
      await mkdir(join(root, 'patches'), { recursive: true });
      await writeFile(
        join(root, 'patches', 'react-resizable-panels@4.12.3.patch'),
        'selected patch\n',
      );
      await writeFile(
        join(root, 'patches', 'unused-package@1.0.0.patch'),
        'unrelated patch\n',
      );
    }
  }
  if (options.multiVersionDependency) {
    const clientPackagePath = join(game, 'client', 'package.json');
    const clientPackage = JSON.parse(
      await readFile(clientPackagePath, 'utf8'),
    ) as { dependencies: Record<string, string> };
    clientPackage.dependencies['multi-version-package'] = '1.0.0';
    await writeFile(clientPackagePath, JSON.stringify(clientPackage));
    await mkdir(join(root, 'node_modules', 'multi-version-package'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'node_modules', 'multi-version-package', 'package.json'),
      JSON.stringify({ name: 'multi-version-package', version: '1.0.0' }),
    );
    const sdkPackagePath = join(root, 'common', 'sdk', 'package.json');
    const sdkPackage = JSON.parse(
      await readFile(sdkPackagePath, 'utf8'),
    ) as Record<string, unknown>;
    sdkPackage.dependencies = { 'multi-version-package': '2.0.0' };
    await writeFile(sdkPackagePath, JSON.stringify(sdkPackage));
    await mkdir(
      join(root, 'common', 'sdk', 'node_modules', 'multi-version-package'),
      { recursive: true },
    );
    await writeFile(
      join(
        root,
        'common',
        'sdk',
        'node_modules',
        'multi-version-package',
        'package.json',
      ),
      JSON.stringify({ name: 'multi-version-package', version: '2.0.0' }),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture-root',
        pnpm: {
          patchedDependencies: {
            'multi-version-package@2.0.0':
              'patches/multi-version-package@2.0.0.patch',
          },
        },
      }),
    );
    await mkdir(join(root, 'patches'), { recursive: true });
    await writeFile(
      join(root, 'patches', 'multi-version-package@2.0.0.patch'),
      'version two patch\n',
    );
  }
  if (options.clientNotice)
    await writeFile(
      join(game, 'client', 'NOTICE.md'),
      'Client package provenance\n',
    );
  if (options.clientLicense)
    await writeFile(
      join(game, 'client', 'LICENSE-custom.txt'),
      'Client package license\n',
    );
  await writeFile(
    join(game, 'server', 'package.json'),
    JSON.stringify({
      name: '@board-games/example-server',
      version: '0.1.0',
      private: true,
      files: ['dist'],
      exports: {
        '.': './dist/index.js',
        ...(options.serverExport
          ? { [options.serverExport]: './dist/remote.js' }
          : {}),
      },
      dependencies: { '@board-platform/contracts': 'workspace:*' },
      ...(options.optionalPlatformPeer
        ? {
            peerDependencies: { '@board-platform/server': 'workspace:*' },
            peerDependenciesMeta: {
              '@board-platform/server': { optional: true },
            },
          }
        : {}),
      ...(options.optionalPlatformPeer || options.serverWorkspaceDevDependency
        ? {
            devDependencies: {
              ...(options.optionalPlatformPeer
                ? { '@board-platform/server': 'workspace:*' }
                : {}),
              ...(options.serverWorkspaceDevDependency
                ? {
                    '@board-game/sdk': 'workspace:*',
                    '@board-game/test-helper': 'workspace:*',
                  }
                : {}),
            },
          }
        : {}),
      scripts: options.standaloneServerBuild
        ? {
            build: 'tsc -p tsconfig.build.json',
            'build:remote': 'tsc -p tsconfig.standalone.build.json',
            typecheck: 'tsc -p tsconfig.json --noEmit',
          }
        : { build: 'tsc -p tsconfig.build.json' },
    }),
  );
  if (options.standaloneServerBuild)
    await writeFile(
      join(game, 'server', 'tsconfig.standalone.build.json'),
      '{}\n',
    );
  await writeFile(
    join(game, 'game.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'example',
      title: 'Example',
      client: {
        package: '@board-games/example-client',
        export: options.missingClientExport
          ? './missing'
          : (options.clientExport ?? '.'),
      },
      server: {
        package: '@board-games/example-server',
        export: options.manifestServerExport ?? options.serverExport ?? '.',
      },
      status: 'ready',
    }),
  );
  if (options.gameNotice)
    await writeFile(join(game, 'NOTICE.md'), 'Game source provenance\n');
  if (options.gameReadme)
    await writeFile(join(game, 'README.md'), '# Example game\n');
  if (options.upstreamMetadata) {
    await writeFile(
      join(game, 'upstream.json'),
      '{"schemaVersion":1,"gameId":"example"}\n',
    );
    await writeFile(
      join(game, 'upstream.lock.json'),
      '{"schemaVersion":1,"gameId":"example","ref":"baseline"}\n',
    );
  }
  const output = join(
    root,
    '..',
    `bgp-game-package-output-${process.pid}-${roots.length}`,
  );
  roots.push(output);
  return { root, game, output };
}

async function independentTarballFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bgp-independent-tarball-'));
  roots.push(root);
  const client = join(root, 'packages', 'frontend', 'client');
  const server = join(root, 'services', 'backend', 'server');
  for (const directory of [client, server])
    await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(
    join(client, 'package.json'),
    JSON.stringify({
      name: '@board-games/independent-client',
      version: '0.1.0',
      private: true,
      files: ['dist'],
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(server, 'package.json'),
    JSON.stringify({
      name: '@board-games/independent-server',
      version: '0.1.0',
      private: true,
      files: ['dist'],
      exports: { '.': './dist/index.js' },
    }),
  );
  await writeFile(
    join(client, 'dist', 'index.js'),
    'export const client = "independent";\n',
  );
  await writeFile(
    join(server, 'dist', 'index.js'),
    'export const server = "independent";\n',
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
      status: 'ready',
    }),
  );
  const output = join(
    root,
    '..',
    `bgp-independent-tarball-output-${process.pid}-${roots.length}`,
  );
  roots.push(output);
  return { root, output };
}

function fakePackRunner(
  inspect?: (value: {
    readonly cwd: string;
    readonly manifest: Record<string, unknown>;
  }) => void,
) {
  return async (
    _command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<void> => {
    const destination = args[args.indexOf('--pack-destination') + 1];
    const manifest = JSON.parse(
      await readFile(join(cwd, 'package.json'), 'utf8'),
    ) as Record<string, unknown> & { name: string; version: string };
    inspect?.({ cwd, manifest });
    await mkdir(destination, { recursive: true });
    await writeFile(
      join(
        destination,
        `${manifest.name.replaceAll('/', '-')}-${manifest.version}.tgz`,
      ),
      'fake-package-tarball',
    );
  };
}

describe('independent game package exports', () => {
  it('exports a source workspace with only game source and packed SDK/platform dist', async () => {
    const { root, game, output } = await fixture({
      gameNotice: true,
      gameReadme: true,
      clientDevDependency: true,
      upstreamMetadata: true,
    });
    await writeFile(
      join(game, 'client', 'tsconfig.tsbuildinfo'),
      'local build cache',
    );
    const result = await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    expect(result.gameId).toBe('example');
    expect((await readdir(join(output, 'games', 'example'))).sort()).toEqual([
      'NOTICE.md',
      'README.md',
      'client',
      'game.json',
      'server',
      'upstream.json',
      'upstream.lock.json',
    ]);
    expect(
      await readFile(join(output, 'games', 'example', 'NOTICE.md'), 'utf8'),
    ).toContain('source provenance');
    expect(await readFile(join(output, 'README.md'), 'utf8')).toContain(
      'Example game',
    );
    expect(await readFile(join(output, 'NOTICE.md'), 'utf8')).toContain(
      'source provenance',
    );
    expect(
      await readFile(
        join(output, 'games', 'example', 'client', 'src', 'index.ts'),
        'utf8',
      ),
    ).toContain('client');
    await expect(
      readFile(join(output, 'games', 'example', 'client', 'dist', 'index.js')),
    ).rejects.toThrow();
    await expect(
      readFile(
        join(output, 'games', 'example', 'client', 'tsconfig.tsbuildinfo'),
      ),
    ).rejects.toThrow();
    await expect(readdir(join(output, 'platform'))).rejects.toThrow();
    const clientPackage = JSON.parse(
      await readFile(
        join(output, 'games', 'example', 'client', 'package.json'),
        'utf8',
      ),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(clientPackage.dependencies['@board-game/sdk']).toBe('1.2.3');
    expect(clientPackage.devDependencies['fixture-tool']).toBe('9.8.7');
    expect(clientPackage.scripts.migrate).toBeUndefined();
    expect(clientPackage.scripts.build).toBe('tsc -p tsconfig.build.json');
    const rootPackage = JSON.parse(
      await readFile(join(output, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
      scripts: Record<string, string>;
    };
    expect(rootPackage.dependencies['@board-games/example-client']).toBe(
      'workspace:*',
    );
    expect(rootPackage.dependencies['@board-games/example-server']).toBe(
      'workspace:*',
    );
    expect(rootPackage.scripts).toEqual({
      build:
        'pnpm --filter @board-games/example-client... --filter @board-games/example-server... -r build',
      typecheck:
        'pnpm --filter @board-games/example-client... --filter @board-games/example-server... -r typecheck',
      test: 'pnpm --filter @board-games/example-client... --filter @board-games/example-server... -r test',
    });
    expect(rootPackage.pnpm.overrides['fixture-tool']).toBe('9.8.7');
    const metadata = JSON.parse(
      await readFile(join(output, 'game-package.json'), 'utf8'),
    ) as {
      source: { gameDirectory: string };
      packages: { sourcePath: string }[];
    };
    expect(metadata.source.gameDirectory).toBe('games/example');
    expect(metadata.packages.map((entry) => entry.sourcePath)).toContain(
      'common/sdk',
    );
    expect(metadata.packages.map((entry) => entry.sourcePath)).toContain(
      'platform/contracts',
    );
  });

  it('exports a dist collection as tarballs with no source package directories', async () => {
    const { root, game, output } = await fixture();
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
      run: fakePackRunner(),
    });
    expect(await readdir(join(output, 'packages'))).toHaveLength(4);
    await expect(readdir(join(output, 'games'))).rejects.toThrow();
    const rootPackage = JSON.parse(
      await readFile(join(output, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(rootPackage.dependencies['@board-games/example-client']).toMatch(
      /^file:packages\//u,
    );
    expect(rootPackage.pnpm.overrides['@board-platform/contracts']).toMatch(
      /^file:packages\//u,
    );
  });

  it.each(['source', 'dist'] as const)(
    'carries only patched dependencies used by the %s export graph',
    async (mode) => {
      const { root, game, output } = await fixture({
        patchedDependency: true,
      });
      await exportGamePackage({
        gameDirectory: game,
        workspaceRoot: root,
        outputDirectory: output,
        mode,
        run: fakePackRunner(),
      });

      const rootPackage = JSON.parse(
        await readFile(join(output, 'package.json'), 'utf8'),
      ) as {
        pnpm: {
          overrides: Record<string, string>;
          patchedDependencies?: Record<string, string>;
        };
      };
      expect(rootPackage.pnpm.overrides['react-resizable-panels']).toBe(
        '4.12.3',
      );
      expect(rootPackage.pnpm.patchedDependencies).toEqual({
        'react-resizable-panels@4.12.3':
          'patches/react-resizable-panels@4.12.3.patch',
      });
      expect(
        await readFile(
          join(output, 'patches', 'react-resizable-panels@4.12.3.patch'),
          'utf8',
        ),
      ).toBe('selected patch\n');
      await expect(
        readFile(join(output, 'patches', 'unused-package@1.0.0.patch'), 'utf8'),
      ).rejects.toThrow();
    },
  );

  it('rejects patched dependency paths outside the workspace and cleans up', async () => {
    const { root, game, output } = await fixture({
      patchedDependency: true,
      invalidPatchPath: true,
    });
    await expect(
      exportGamePackage({
        gameDirectory: game,
        workspaceRoot: root,
        outputDirectory: output,
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('must stay within the workspace');
    await expect(readFile(join(output, 'package.json'))).rejects.toThrow();
  });

  it('rejects patched dependency paths escaping through a parent symlink', async () => {
    const { root, game, output } = await fixture({
      patchedDependency: true,
      symlinkPatchPath: true,
    });
    await expect(
      exportGamePackage({
        gameDirectory: game,
        workspaceRoot: root,
        outputDirectory: output,
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('must stay within the workspace');
    await expect(readFile(join(output, 'package.json'))).rejects.toThrow();
  });

  it('selects a patch for an exact identity when another version also exists', async () => {
    const { root, game, output } = await fixture({
      multiVersionDependency: true,
    });
    const inspected: Record<string, unknown>[] = [];
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(({ manifest }) => {
        if (manifest.name === '@board-game/sdk') inspected.push(manifest);
      }),
    });

    const rootPackage = JSON.parse(
      await readFile(join(output, 'package.json'), 'utf8'),
    ) as {
      pnpm: {
        overrides: Record<string, string>;
        patchedDependencies?: Record<string, string>;
      };
    };
    expect(rootPackage.pnpm.patchedDependencies).toEqual({
      'multi-version-package@2.0.0':
        'patches/multi-version-package@2.0.0.patch',
    });
    expect(rootPackage.pnpm.overrides['multi-version-package']).toBeUndefined();
    expect(inspected).toHaveLength(1);
    expect(
      (inspected[0]?.dependencies as Record<string, string>)[
        'multi-version-package'
      ],
    ).toBe('2.0.0');
    expect(
      JSON.parse(
        await readFile(
          join(output, 'games', 'example', 'client', 'package.json'),
          'utf8',
        ),
      ).dependencies['multi-version-package'],
    ).toBe('1.0.0');
  });

  it('does not vendor an optional platform peer into an independent export', async () => {
    const { root, game, output } = await fixture({
      optionalPlatformPeer: true,
    });
    const result = await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    expect(result.packages.map((entry) => entry.sourcePath)).not.toContain(
      'platform/server',
    );
    const serverPackage = JSON.parse(
      await readFile(
        join(output, 'games', 'example', 'server', 'package.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(serverPackage.peerDependencies).toBeUndefined();
    expect(serverPackage.peerDependenciesMeta).toBeUndefined();
    expect(
      (serverPackage.devDependencies as Record<string, unknown> | undefined)?.[
        '@board-platform/server'
      ],
    ).toBeUndefined();
  });

  it('vendors source-only workspace devDependencies', async () => {
    const { root, game, output } = await fixture({
      serverWorkspaceDevDependency: true,
    });
    const result = await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    const serverPackage = JSON.parse(
      await readFile(
        join(output, 'games', 'example', 'server', 'package.json'),
        'utf8',
      ),
    ) as {
      devDependencies: Record<string, string>;
    };
    const rootPackage = JSON.parse(
      await readFile(join(output, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };

    expect(serverPackage.devDependencies['@board-game/test-helper']).toBe(
      '2.3.4',
    );
    expect(serverPackage.devDependencies['@board-game/sdk']).toBe('1.2.3');
    expect(rootPackage.dependencies['@board-game/test-helper']).toMatch(
      /^file:vendor\/board-game-test-helper\//u,
    );
    expect(rootPackage.pnpm.overrides['@board-game/test-helper']).toMatch(
      /^file:vendor\/board-game-test-helper\//u,
    );
    expect(result.packages.map((entry) => entry.sourcePath)).toContain(
      'common/test-helper',
    );
  });

  it('does not add workspace devDependencies to dist exports', async () => {
    const { root, game, output } = await fixture({
      serverWorkspaceDevDependency: true,
    });
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
      run: fakePackRunner(),
    });
    const rootPackage = JSON.parse(
      await readFile(join(output, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };

    expect(await readdir(join(output, 'packages'))).toHaveLength(4);
    expect(rootPackage.dependencies['@board-game/test-helper']).toBeUndefined();
  });

  it('retains transitive package-manager helpers and lifecycle scripts only', async () => {
    const { root, game, output } = await fixture({ helperScripts: true });
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    const clientPackage = JSON.parse(
      await readFile(
        join(output, 'games', 'example', 'client', 'package.json'),
        'utf8',
      ),
    ) as { scripts: Record<string, string> };
    expect(clientPackage.scripts).toEqual({
      prebuild: 'pnpm sync-assets',
      build: 'pnpm run compile:js && npm run copy-assets',
      'compile:js': 'pnpm run copy-assets',
      'copy-assets': 'node scripts/copy-assets.mjs',
      'sync-assets': 'node scripts/sync-assets.mjs',
    });
    expect(clientPackage.scripts.migrate).toBeUndefined();
  });

  it('retains explicit package provenance files in dist staging', async () => {
    const { root, game, output } = await fixture({
      clientNotice: true,
      clientLicense: true,
    });
    const inspected: Record<string, unknown>[] = [];
    const result = await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
      run: fakePackRunner(({ manifest }) => {
        if (manifest.name === '@board-games/example-client')
          inspected.push(manifest);
      }),
    });
    const client = result.packages.find(
      (entry) => entry.name === '@board-games/example-client',
    );
    expect(client?.files).toEqual(['dist', 'LICENSE-custom.txt', 'NOTICE.md']);
    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.files).toEqual([
      'dist',
      'LICENSE-custom.txt',
      'NOTICE.md',
    ]);
  });

  it('deduplicates copied public assets when dist/public is the built runtime path', async () => {
    const { root, game, output } = await fixture();
    await mkdir(join(game, 'client', 'dist', 'public', 'assets'), {
      recursive: true,
    });
    await mkdir(join(game, 'client', 'public', 'assets'), { recursive: true });
    await writeFile(
      join(game, 'client', 'dist', 'public', 'assets', 'runtime.txt'),
      'runtime',
    );
    await writeFile(
      join(game, 'client', 'public', 'assets', 'source.txt'),
      'source',
    );
    await writeFile(
      join(game, 'client', 'package.json'),
      JSON.stringify({
        name: '@board-games/example-client',
        version: '0.1.0',
        private: true,
        files: ['dist', 'public'],
        exports: {
          '.': './dist/index.js',
          './assets/*': './public/assets/*',
        },
        dependencies: { '@board-game/sdk': 'workspace:*' },
        scripts: { build: 'tsc -p tsconfig.build.json' },
      }),
    );

    const inspected: Record<string, unknown>[] = [];
    const result = await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
      run: fakePackRunner(({ manifest }) => {
        if (manifest.name === '@board-games/example-client')
          inspected.push(manifest);
      }),
    });

    expect(
      result.packages.find(
        (entry) => entry.name === '@board-games/example-client',
      )?.files,
    ).toEqual(['dist']);
    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.exports).toEqual({
      '.': './dist/index.js',
      './assets/*': './dist/public/assets/*',
    });
  });

  it('plans isolated install, browser bundle, server typecheck, and import checks', async () => {
    const { root, game, output } = await fixture();
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    const calls: { command: string; args: readonly string[]; cwd: string }[] =
      [];
    await verifyGamePackage({
      packageDirectory: output,
      run: async (command, args, cwd) => {
        calls.push({ command, args, cwd });
      },
    });
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['pnpm', 'install', '--ignore-scripts'],
      ['pnpm', '--filter', '@board-games/example-client...'],
      ['pnpm', '--filter', '@board-games/example-client...'],
      ['pnpm', 'exec', 'vite'],
      ['pnpm', 'exec', 'tsc'],
      [
        '--input-type=module',
        '-e',
        'await import("@board-games/example-server");',
      ],
    ]);
  });

  it('verifies the formal client and server package exports', async () => {
    const { root, game, output } = await fixture({
      clientExport: './remote',
      serverExport: './remote',
    });
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
      run: fakePackRunner(),
    });
    const generated = new Map<string, string>();
    await verifyGamePackage({
      packageDirectory: output,
      run: async (command, args, cwd) => {
        if (args.includes('vite'))
          generated.set(
            'client',
            await readFile(
              join(cwd, '.bgp-verify', 'browser-entry.js'),
              'utf8',
            ),
          );
        if (args.includes('tsc'))
          generated.set(
            'typecheck',
            await readFile(
              join(cwd, '.bgp-verify', 'server-import.ts'),
              'utf8',
            ),
          );
        if (command === process.execPath)
          generated.set(
            'import',
            await readFile(
              join(cwd, '.bgp-verify', 'server-import.mjs'),
              'utf8',
            ),
          );
      },
    });
    expect(generated.get('client')).toContain(
      '"@board-games/example-client/remote"',
    );
    expect(generated.get('typecheck')).toContain(
      '"@board-games/example-server/remote"',
    );
    expect(generated.get('import')).toContain(
      '"@board-games/example-server/remote"',
    );
  });

  it('selects a remote server export and build for standalone source output', async () => {
    const { root, game, output } = await fixture({
      serverExport: './remote',
      manifestServerExport: '.',
      standaloneServerBuild: true,
    });
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    const manifest = JSON.parse(
      await readFile(join(output, 'game.json'), 'utf8'),
    ) as { server: { export: string } };
    expect(manifest.server.export).toBe('./remote');
    const serverPackage = JSON.parse(
      await readFile(
        join(output, 'games', 'example', 'server', 'package.json'),
        'utf8',
      ),
    ) as { scripts: Record<string, string> };
    expect(serverPackage.scripts.build).toBe(
      'tsc -p tsconfig.standalone.build.json',
    );
    expect(serverPackage.scripts.typecheck).toBe(
      'tsc -p tsconfig.standalone.build.json --noEmit',
    );
  });

  it('applies package overrides only during isolated installation', async () => {
    const { root, game, output } = await fixture();
    await exportGamePackage({
      gameDirectory: game,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    const packagePath = join(output, 'package.json');
    const original = await readFile(packagePath, 'utf8');
    let duringInstall: Record<string, unknown> | undefined;
    await verifyGamePackage({
      packageDirectory: output,
      packageOverrides: { 'fixture-tool': 'file:/tmp/fixture-tool.tgz' },
      run: async (_command, args, cwd) => {
        if (args[1] === 'install')
          duringInstall = JSON.parse(
            await readFile(join(cwd, 'package.json'), 'utf8'),
          ) as Record<string, unknown>;
      },
    });
    const duringPnpm = duringInstall?.pnpm as {
      overrides?: Record<string, unknown>;
    };
    expect(duringPnpm.overrides?.['fixture-tool']).toBe(
      'file:/tmp/fixture-tool.tgz',
    );
    expect(await readFile(packagePath, 'utf8')).toBe(original);
  });

  it('packs and installs an independent root game without parent paths', async () => {
    const { root, output } = await independentTarballFixture();
    await exportGamePackage({
      gameDirectory: root,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'dist',
    });

    const metadataPath = join(output, 'game-package.json');
    const metadataSource = await readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(metadataSource) as {
      source: { workspaceRoot: string; gameDirectory: string };
      packages: { sourcePath: string }[];
    };
    expect(metadata.source.workspaceRoot).toBe('.');
    expect(metadata.source.gameDirectory).toBe('.');
    expect(metadataSource).not.toContain(root);
    expect(
      metadata.packages.every((entry) => !entry.sourcePath.startsWith('/')),
    ).toBe(true);

    await runProcess(
      'corepack',
      ['pnpm', 'install', '--offline', '--ignore-scripts', '--lockfile=false'],
      output,
    );
    await runProcess(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const client = await import('@board-games/independent-client'); if (client.client !== 'independent') process.exit(1);`,
      ],
      output,
    );
  });

  it('exports an independent source workspace with nested package layout', async () => {
    const { root, output } = await independentTarballFixture();
    await exportGamePackage({
      gameDirectory: root,
      workspaceRoot: root,
      outputDirectory: output,
      mode: 'source',
      run: fakePackRunner(),
    });
    expect(
      await readFile(
        join(
          output,
          'games',
          'independent',
          'packages',
          'frontend',
          'client',
          'package.json',
        ),
        'utf8',
      ),
    ).toContain('@board-games/independent-client');
    expect(await readFile(join(output, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      'packages:\n  - games/independent/**\n',
    );
    const metadata = JSON.parse(
      await readFile(join(output, 'game-package.json'), 'utf8'),
    ) as { source: { workspaceRoot: string; gameDirectory: string } };
    expect(metadata.source).toEqual({ workspaceRoot: '.', gameDirectory: '.' });
  });

  it('rejects unsafe destinations and missing public exports before copying', async () => {
    const unsafe = await fixture();
    await expect(
      exportGamePackage({
        gameDirectory: unsafe.game,
        workspaceRoot: unsafe.root,
        outputDirectory: join(unsafe.root, 'outside'),
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('outside the source workspace');

    const missing = await fixture({ missingClientExport: true });
    await expect(
      exportGamePackage({
        gameDirectory: missing.game,
        workspaceRoot: missing.root,
        outputDirectory: missing.output,
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('missing export');

    const unsafeFiles = await fixture({ unsafeClientFiles: true });
    await expect(
      exportGamePackage({
        gameDirectory: unsafeFiles.game,
        workspaceRoot: unsafeFiles.root,
        outputDirectory: unsafeFiles.output,
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('Unsafe package files entry');

    const collision = await fixture({ collidingDependencies: true });
    await expect(
      exportGamePackage({
        gameDirectory: collision.game,
        workspaceRoot: collision.root,
        outputDirectory: collision.output,
        mode: 'dist',
        run: fakePackRunner(),
      }),
    ).rejects.toThrow('Package output path collision');
  });
});
