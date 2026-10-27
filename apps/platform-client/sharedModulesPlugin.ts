import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const packages = [
  'react',
  'react-dom',
  'react-i18next',
  'i18next',
  '@tanstack/react-query',
  '@tanstack/react-router',
  '@board-game/client',
  '@board-game/components',
  '@board-platform/client',
];

function packageRoot(specifier: string): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Missing package metadata: ${specifier}`);
    directory = parent;
  }
  return directory;
}

function javascriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? javascriptFiles(file)
      : entry.isFile() && file.endsWith('.js')
        ? [file]
        : [];
  });
}

/** Compile only platform/SDK public modules into the shell's lazy ABI catalog. */
export function sharedModulesPlugin(): Plugin {
  return {
    name: 'platform-shared-client-modules',
    resolveId(id) {
      return id === 'virtual:platform-shared-modules'
        ? '\0platform-shared-modules'
        : undefined;
    },
    load(id) {
      if (id !== '\0platform-shared-modules') return undefined;
      const entries: string[] = [];
      for (const name of packages) {
        const root = packageRoot(name);
        const metadata = JSON.parse(
          readFileSync(join(root, 'package.json'), 'utf8'),
        ) as { version: string };
        const specifiers = new Set([name]);
        if (name === 'react')
          for (const path of ['jsx-runtime', 'jsx-dev-runtime'])
            specifiers.add(`${name}/${path}`);
        if (name === 'react-dom') specifiers.add(`${name}/client`);
        if (name === '@board-platform/client') {
          for (const file of javascriptFiles(join(root, 'dist'))) {
            const path = relative(join(root, 'dist'), file).replaceAll(
              '\\',
              '/',
            );
            // CSS and other non-JS resources never enter javascriptFiles().
            // Keep application service-worker entrypoints out of the game ABI;
            // styles/*.js are public package exports and must remain shareable.
            if (!path.startsWith('pwa/') && path.endsWith('.js'))
              specifiers.add(`${name}/${path}`);
          }
        }
        for (const specifier of specifiers)
          entries.push(
            `${JSON.stringify(specifier)}: { version: ${JSON.stringify(metadata.version)}, load: () => import(${JSON.stringify(specifier)}) }`,
          );
      }
      return `export const catalog = {\n${entries.join(',\n')}\n};`;
    },
  };
}
