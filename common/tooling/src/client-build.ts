import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertClientRuntimeManifest,
  type ClientRuntimeManifest,
  REACT_CLIENT_RUNTIME_ABI,
} from '@board-game/contracts';
import {
  type GameManifestTarget,
  resolvePackageExportTarget,
  verifyGameManifest,
} from './game-manifest.js';
import { digestArtifact } from './release.js';

export interface ClientBuildRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ClientArtifactBuildOptions {
  readonly gameDirectory: string;
  readonly workspaceRoot: string;
  /** Parent directory under which `<game>/<release>/<client-hash>/` is created. */
  readonly outputDirectory: string;
  readonly releaseId: string;
  /** Overrides the id discovered from the public client export. */
  readonly gameId?: string;
  /** Build the declared client package before invoking Vite. Defaults to true. */
  readonly buildClient?: boolean;
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<void>;
}

export interface ClientArtifactBuildResult {
  readonly gameId: string;
  readonly releaseId: string;
  readonly artifactRoot: string;
  readonly artifactRootUrlPath: string;
  readonly clientDirectory: string;
  readonly publicAssetsDirectory: string;
  readonly manifestPath: string;
  readonly clientDigest: string;
  readonly publicAssetsDigest: string;
  readonly runtime: ClientRuntimeManifest;
  readonly publicAssets: readonly string[];
  readonly commands: readonly ClientBuildRun[];
}

/** Digest the client artifact with the same canonical path ordering as releases. */
export async function digestClientArtifactDirectory(
  directory: string,
): Promise<string> {
  return digestArtifact(directory);
}

interface VitePluginLike {
  readonly name: string;
  readonly enforce?: 'pre' | 'post';
  resolveId?: (source: string) => string | null | undefined;
  load?: (
    id: string,
  ) =>
    | string
    | { code: string; syntheticNamedExports?: boolean | string }
    | null
    | undefined;
  transform?: (
    code: string,
    id: string,
  ) => string | { code: string } | null | undefined;
  generateBundle?: (
    options: unknown,
    bundle: Record<string, ViteBundleItem>,
  ) => void | Promise<void>;
}

interface ViteBundleItem {
  readonly type: 'asset' | 'chunk';
  readonly fileName: string;
  source?: string | Uint8Array;
}

interface ViteBuildConfig {
  readonly root: string;
  readonly configFile: false;
  readonly publicDir: false;
  readonly base: string;
  readonly define: Readonly<Record<string, string>>;
  readonly resolve: {
    readonly alias: readonly {
      readonly find: RegExp | string;
      readonly replacement: string;
    }[];
  };
  readonly plugins: readonly VitePluginLike[];
  readonly build: {
    readonly outDir: string;
    readonly emptyOutDir: boolean;
    readonly sourcemap: false;
    readonly cssCodeSplit: true;
    readonly rollupOptions: {
      readonly input: string;
      readonly preserveEntrySignatures: 'strict';
      readonly output: {
        readonly entryFileNames: string;
        readonly chunkFileNames: string;
        readonly assetFileNames: string;
      };
    };
  };
}

const SHARED_RUNTIME_SYMBOL = 'board-game.client-runtime.v1';
const SHARED_MODULE_PREFIX = '\0bgp-shared:';
const ASSET_RUNTIME_ID = '\0bgp-client-asset-runtime';
const REQUIRED_SHARED_PACKAGES = [
  '@board-game/client',
  '@board-game/components',
  '@board-platform/client',
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-i18next',
  'i18next',
  '@tanstack/react-query',
  '@tanstack/react-router',
] as const;
const SHARED_PACKAGE_BASES = new Set(
  REQUIRED_SHARED_PACKAGES.map(packageBaseSpecifier),
);

function packageBaseSpecifier(specifier: string): string {
  if (specifier.startsWith('@'))
    return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0] ?? specifier;
}

function isWithin(child: string, parent: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === '' ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== '..')
  );
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value))
    throw new Error(`${label} must be a release identifier`);
  return value;
}

async function filesUnder(directory: string): Promise<readonly string[]> {
  return (await allFilesUnder(directory)).filter((file) =>
    /\.(?:js|mjs|cjs|ts|tsx)$/u.test(file),
  );
}

async function allFilesUnder(directory: string): Promise<readonly string[]> {
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'coverage') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(directory);
  return output.sort();
}

async function copyTree(source: string, destination: string): Promise<void> {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error(
      `Client public asset directory must be a real directory: ${source}`,
    );
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const entryStat = await lstat(sourcePath);
    if (entryStat.isSymbolicLink())
      throw new Error(
        `Client public assets cannot contain symlinks: ${sourcePath}`,
      );
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) {
      try {
        await stat(destinationPath);
        throw new Error(
          `Duplicate public asset path: ${relative(destination, destinationPath)}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const bytes = await readFile(sourcePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, bytes, { flag: 'wx' });
    } else throw new Error(`Unsupported public asset: ${sourcePath}`);
  }
}

function artifactRootUrlPath(
  gameId: string,
  releaseId: string,
  clientDigest: string,
): string {
  return `/${encodeURIComponent(gameId)}/${encodeURIComponent(releaseId)}/${clientDigest.slice(7)}/`;
}

function packageRootFromFile(file: string): string | undefined {
  let current = dirname(file);
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    current = dirname(current);
  }
  return undefined;
}

function packageBoundary(directory: string): string | undefined {
  let current = resolve(directory);
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    current = dirname(current);
  }
  return undefined;
}

function resolvePackageVersion(
  packageDirectory: string,
  specifier: string,
): string | undefined {
  const base = packageBaseSpecifier(specifier);
  try {
    const resolver = createRequire(join(packageDirectory, 'package.json'));
    let root: string | undefined;
    try {
      root = packageRootFromFile(resolver.resolve(base));
    } catch {
      const linked = resolve(
        packageDirectory,
        'node_modules',
        ...base.split('/'),
      );
      if (existsSync(join(linked, 'package.json'))) root = linked;
    }
    if (!root) {
      // Context packages such as i18next may be nested below a shared
      // package (react-i18next) instead of linked at the game package root.
      for (const parent of ['react-i18next']) {
        try {
          const parentEntry = resolver.resolve(parent);
          const parentRoot = packageRootFromFile(parentEntry);
          if (!parentRoot) continue;
          root = packageRootFromFile(
            createRequire(join(parentRoot, 'package.json')).resolve(base),
          );
          if (root) break;
        } catch {
          // The optional context package is not installed for this client.
        }
      }
    }
    if (!root) return undefined;
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : undefined;
  } catch {
    return undefined;
  }
}

async function discoverSharedSpecifiers(
  clientDirectory: string,
): Promise<
  readonly { readonly specifier: string; readonly version: string }[]
> {
  const specifiers = new Set<string>();
  const compiledDirectory = join(clientDirectory, 'dist');
  const sourceDirectory = existsSync(compiledDirectory)
    ? compiledDirectory
    : clientDirectory;
  for (const file of await filesUnder(sourceDirectory)) {
    const source = await readFile(file, 'utf8');
    const pattern = /(?:from\s*|import\s*\(|require\s*\()(['"])([^'"\n]+)\1/gu;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2];
      if (
        specifier &&
        SHARED_PACKAGE_BASES.has(packageBaseSpecifier(specifier))
      )
        specifiers.add(specifier);
    }
  }
  for (const required of REQUIRED_SHARED_PACKAGES) {
    if (resolvePackageVersion(clientDirectory, required))
      specifiers.add(required);
  }
  const shared = [...specifiers]
    .map((specifier) => {
      const version = resolvePackageVersion(clientDirectory, specifier);
      return version ? { specifier, version } : undefined;
    })
    .filter(
      (
        item,
      ): item is { readonly specifier: string; readonly version: string } =>
        item !== undefined,
    )
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
  if (shared.length === 0)
    throw new Error(
      `No shared browser runtime modules could be resolved from ${clientDirectory}`,
    );
  return shared;
}

function sharedFacade(specifier: string): {
  code: string;
  syntheticNamedExports: '__shared';
} {
  const key = JSON.stringify(specifier);
  return {
    code: `const runtime = globalThis[Symbol.for(${JSON.stringify(SHARED_RUNTIME_SYMBOL)})];\nconst record = runtime?.modules?.[${key}];\nif (!record) throw new Error(${JSON.stringify(`Missing shared client runtime module: ${specifier}`)});\nconst __shared = record.module;\nexport { __shared };\nexport default __shared?.default ?? __shared;\n`,
    syntheticNamedExports: '__shared',
  };
}

export function assetRuntimeModule(gameId: string, releaseId: string): string {
  return `const runtime = globalThis[Symbol.for(${JSON.stringify(SHARED_RUNTIME_SYMBOL)})];
export function assetUrl(path) {
  if (!runtime || typeof runtime.assetUrl !== 'function')
    throw new Error('Shared client runtime is not installed');
  const normalized = String(path).replace(/^\\/+/, '');
  const suffixStart = normalized.search(/[?#]/u);
  const pathname = suffixStart < 0 ? normalized : normalized.slice(0, suffixStart);
  const suffix = suffixStart < 0 ? '' : normalized.slice(suffixStart);
  if (!pathname || /[\\u0000-\\u001f\\u007f]/u.test(suffix))
    throw new Error('Invalid client asset URL');
  const resolved = runtime.assetUrl(${JSON.stringify(gameId)}, ${JSON.stringify(releaseId)}, 'public/' + pathname);
  if (!suffix) return resolved;
  const resolvedUrl = new URL(resolved);
  const withSuffix = new URL(suffix, resolvedUrl);
  if (withSuffix.origin !== resolvedUrl.origin || withSuffix.pathname !== resolvedUrl.pathname)
    throw new Error('Invalid client asset URL');
  return withSuffix.href;
}
`;
}

interface EcmaScriptNode {
  readonly type: string;
  readonly start?: number;
  readonly end?: number;
  readonly [key: string]: unknown;
}

interface EcmaScriptParseContext {
  parse(source: string, options?: unknown): EcmaScriptNode;
}

function normalizedAssetRoots(
  assetRoots: readonly string[],
): readonly string[] {
  return assetRoots
    .map((root) => root.replace(/^\/+|\/+$/gu, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function normalizedAssetPath(
  value: string,
  assetRoots: readonly string[],
): string | undefined {
  if (!value.startsWith('/')) return undefined;
  const normalized = value.replace(/^\/+/, '');
  return assetRoots.some(
    (root) =>
      normalized.startsWith(`${root}/`) && normalized.length > root.length + 1,
  )
    ? normalized
    : undefined;
}

function isAssetTemplate(
  node: EcmaScriptNode,
  source: string,
  assetRoots: readonly string[],
): boolean {
  const quasis = node.quasis;
  if (!Array.isArray(quasis) || quasis.length === 0) return false;
  const first = quasis[0] as EcmaScriptNode | undefined;
  const raw = first?.value;
  const prefix =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { readonly raw?: unknown }).raw
      : undefined;
  if (typeof prefix !== 'string') return false;
  const normalized = prefix.replace(/^\/+/, '');
  return (
    assetRoots.some(
      (root) =>
        normalized.startsWith(`${root}/`) &&
        (normalized.length > root.length + 1 || quasis.length > 1),
    ) && source.slice(node.start ?? 0, node.end ?? 0).startsWith('`')
  );
}

function excludedAssetNode(
  parent: EcmaScriptNode | undefined,
  parentKey: string | undefined,
): boolean {
  if (!parent) return false;
  if (
    (parent.type === 'Property' || parent.type === 'PropertyDefinition') &&
    parentKey === 'key' &&
    parent.computed !== true
  )
    return true;
  if (
    (parent.type === 'ImportDeclaration' ||
      parent.type === 'ExportNamedDeclaration' ||
      parent.type === 'ExportAllDeclaration' ||
      parent.type === 'ImportExpression') &&
    parentKey === 'source'
  )
    return true;
  if (parent.type === 'MemberExpression' && parentKey === 'property')
    return true;
  return false;
}

function assetReplacements(
  source: string,
  ast: EcmaScriptNode,
  assetRoots: readonly string[],
): readonly {
  readonly start: number;
  readonly end: number;
  readonly code: string;
}[] {
  const replacements: {
    start: number;
    end: number;
    code: string;
  }[] = [];
  const visit = (
    value: unknown,
    parent?: EcmaScriptNode,
    parentKey?: string,
  ): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, parent, parentKey);
      return;
    }
    const node = value as EcmaScriptNode;
    if (
      (node.type === 'Literal' || node.type === 'StringLiteral') &&
      typeof node.value === 'string' &&
      !excludedAssetNode(parent, parentKey)
    ) {
      const path = normalizedAssetPath(node.value, assetRoots);
      if (path && node.start !== undefined && node.end !== undefined)
        replacements.push({
          start: node.start,
          end: node.end,
          code: `__bgpAssetUrl(${JSON.stringify(path)})`,
        });
    } else if (
      node.type === 'TemplateLiteral' &&
      !excludedAssetNode(parent, parentKey) &&
      isAssetTemplate(node, source, assetRoots) &&
      node.start !== undefined &&
      node.end !== undefined
    ) {
      replacements.push({
        start: node.start,
        end: node.end,
        code: `__bgpAssetUrl(${source.slice(node.start, node.end)})`,
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc')
        continue;
      visit(child, node, key);
    }
  };
  visit(ast);
  return replacements.sort((left, right) => right.start - left.start);
}

function rewriteAssetPaths(
  source: string,
  assetRoots: readonly string[],
  context: EcmaScriptParseContext,
): string | undefined {
  let ast: EcmaScriptNode;
  try {
    ast = context.parse(source, { allowReturnOutsideFunction: true });
  } catch {
    // The artifact build consumes compiled JavaScript. TypeScript and JSX are
    // deliberately left for the game's own compiler instead of using a second parser.
    return undefined;
  }
  const replacements = assetReplacements(source, ast, assetRoots);
  if (replacements.length === 0) return undefined;
  let code = source;
  for (const replacement of replacements)
    code = `${code.slice(0, replacement.start)}${replacement.code}${code.slice(replacement.end)}`;
  return code;
}

/**
 * Asset literals are rewritten only in the game-owned client package.
 * Shared rule/content packages must retain their canonical root-relative paths
 * through validation; presentation code resolves them at the client boundary.
 */
export function isClientOwnedAssetModule(
  id: string,
  clientDirectory: string,
): boolean {
  const sourceId = id.split('?', 1)[0] ?? id;
  if (sourceId.startsWith('\0')) return false;
  const sourcePaths = [resolve(sourceId)];
  const packagePaths = [resolve(clientDirectory)];
  try {
    sourcePaths.push(realpathSync(sourceId));
    packagePaths.push(realpathSync(clientDirectory));
  } catch {
    // A Vite virtual/proxy id or a unit-test path need not exist on disk.
  }
  return packagePaths.some((packagePath) =>
    sourcePaths.some((sourcePath) => {
      if (!isWithin(sourcePath, packagePath)) return false;
      const relativeId = relative(packagePath, sourcePath);
      return !relativeId.split(sep).includes('node_modules');
    }),
  );
}

function createClientBuildPlugin(
  gameId: string,
  releaseId: string,
  sharedSpecifiers: readonly string[],
  assetRoots: readonly string[],
  cssScope: string,
  clientDirectory: string,
): VitePluginLike {
  const shared = new Set(sharedSpecifiers);
  const roots = normalizedAssetRoots(assetRoots);
  return {
    name: 'board-game-client-artifact',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'virtual:board-game-client-asset-runtime')
        return ASSET_RUNTIME_ID;
      if (shared.has(source)) return `${SHARED_MODULE_PREFIX}${source}`;
      return undefined;
    },
    load(id) {
      if (id === ASSET_RUNTIME_ID) return assetRuntimeModule(gameId, releaseId);
      if (id.startsWith(SHARED_MODULE_PREFIX))
        return sharedFacade(id.slice(SHARED_MODULE_PREFIX.length));
      return undefined;
    },
    transform(this: EcmaScriptParseContext, source, id) {
      if (
        id.startsWith('\0') ||
        !/\.(?:js|mjs|cjs)$/u.test(id.split('?')[0] ?? id)
      )
        return undefined;
      let code = source;
      let changed = false;
      if (code.includes('import.meta.env.BASE_URL')) {
        const withoutBase = code.replace(
          /const baseUrl = import\.meta\.env\.BASE_URL\.endsWith\('\/'\)\s*\?\s*import\.meta\.env\.BASE_URL\.slice\(0, -1\)\s*:\s*import\.meta\.env\.BASE_URL;?/su,
          "const baseUrl = '';",
        );
        const withRuntime = withoutBase.replace(
          /return `\$\{baseUrl\}\$\{asset\.url\}`;/gu,
          'return __bgpAssetUrl(asset.url);',
        );
        if (withRuntime !== code) {
          code = withRuntime;
          changed = true;
        }
      }
      if (
        !id.includes('assets.generated.') &&
        isClientOwnedAssetModule(id, clientDirectory)
      ) {
        const withRuntimePaths = rewriteAssetPaths(code, roots, this);
        if (withRuntimePaths !== undefined) {
          code = withRuntimePaths;
          changed = true;
        }
      }
      if (!changed) return undefined;
      return {
        code: `import { assetUrl as __bgpAssetUrl } from 'virtual:board-game-client-asset-runtime';\n${code}`,
      };
    },
    async generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== 'asset' || !item.fileName.endsWith('.css')) continue;
        const source =
          typeof item.source === 'string'
            ? item.source
            : Buffer.from(item.source ?? new Uint8Array()).toString('utf8');
        item.source = scopeClientCss(
          rewriteClientCssAssetUrls(source, roots, item.fileName),
          cssScope,
          item.fileName,
        );
      }
    },
  };
}

function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  let comment = false;
  for (let index = open; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (comment) {
      if (current === '*' && next === '/') {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === '\\') index += 1;
      else if (current === quote) quote = undefined;
      continue;
    }
    if (current === '/' && next === '*') {
      comment = true;
      index += 1;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      continue;
    }
    if (current === '{') depth += 1;
    if (current === '}' && --depth === 0) return index;
  }
  return -1;
}

function unwrapSingleScope(source: string): string {
  const withoutLeadingWhitespace = source.replace(/^\s+/u, '');
  if (!withoutLeadingWhitespace.startsWith('@scope')) return source;
  const open = withoutLeadingWhitespace.indexOf('{');
  if (open < 0) return source;
  const close = findMatchingBrace(withoutLeadingWhitespace, open);
  if (close < 0 || withoutLeadingWhitespace.slice(close + 1).trim().length > 0)
    return source;
  return withoutLeadingWhitespace.slice(open + 1, close);
}

/** Rebase root-relative game CSS assets under the artifact's public directory. */
export function rewriteClientCssAssetUrls(
  source: string,
  assetRoots: readonly string[],
  fileName = 'client.css',
): string {
  const roots = normalizedAssetRoots(assetRoots);
  if (roots.length === 0) return source;
  return source.replace(
    /url\(\s*(["']?)(\/[^)"'\s]+)\1\s*\)/gu,
    (match, quote: string, path: string) => {
      const normalized = normalizedAssetPath(path, roots);
      if (!normalized) return match;
      return `url(${quote}../../public/${normalized}${quote})`;
    },
  );
}

/**
 * Qualifies game CSS with the immutable release root. Global selectors are
 * rejected because guessing how to rewrite them would make the remote game
 * capable of changing the platform shell.
 */
export function scopeClientCss(
  source: string,
  scope: string,
  fileName = 'client.css',
): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const globalSelector =
    /(?:^|[{},(])\s*(?:html|body)(?=\b|[.#:[\s,{)>+~]|$)|:global\(\s*(?:html|body|:root|\*)(?=\s*\))/mu.exec(
      withoutComments,
    );
  if (globalSelector)
    throw new Error(
      `CSS scope failed for ${fileName}: unknown global selector cannot be qualified (${globalSelector[0].trim()})`,
    );
  // A game-owned :root token list (for example its CSS variable theme) can
  // be explicitly moved to the release root. html/body and :global(...) stay
  // rejected because their semantics cannot be made local by qualification.
  const inner = unwrapSingleScope(source)
    .replaceAll(':root', `[data-game-release="${scope}"]`)
    .trim();
  return `@scope ([data-game-release="${scope}"]) {\n${inner}\n}\n`;
}

async function inferGameId(
  clientDirectory: string,
  fallback: string,
): Promise<string> {
  const preferred = [
    join(clientDirectory, 'dist'),
    join(clientDirectory, 'build'),
    join(clientDirectory, 'src'),
  ];
  for (const directory of preferred) {
    for (const file of await filesUnder(directory)) {
      const source = await readFile(file, 'utf8');
      const matches = [
        ...source.matchAll(/\b[A-Z][A-Z0-9_]*GAME_ID\s*=\s*['"]([^'"]+)['"]/gu),
        ...source.matchAll(/\bgameId\s*:\s*['"]([^'"]+)['"]/gu),
      ];
      for (const match of matches) {
        const candidate = match[1];
        if (candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(candidate))
          return candidate;
      }
    }
  }
  return fallback;
}

async function readClientAssets(
  target: GameManifestTarget,
  publicDirectory: string,
): Promise<{
  readonly roots: readonly string[];
  readonly files: readonly string[];
}> {
  let declaration: Record<string, unknown> | undefined;
  try {
    const assetsEntry = resolvePackageExportTarget(
      target.clientPackage,
      './assets',
    );
    const module = (await import(pathToFileURL(assetsEntry).href)) as Record<
      string,
      unknown
    >;
    const value = module.gameClientAssets;
    if (value && typeof value === 'object' && !Array.isArray(value))
      declaration = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && !error.message.includes('resolvable export'))
      throw error;
  }
  const candidates = declaration?.publicDirectories;
  const directories =
    Array.isArray(candidates) &&
    candidates.every((item) => typeof item === 'string')
      ? (candidates as string[])
      : [
          join(target.clientPackage.directory, 'dist', 'public'),
          join(target.clientPackage.directory, 'public'),
        ];
  const roots = declaration?.assetRoots;
  const assetRoots =
    Array.isArray(roots) && roots.every((item) => typeof item === 'string')
      ? (roots as string[])
      : [];
  const copiedFiles: string[] = [];
  for (const configured of directories) {
    const directory = resolve(target.clientPackage.directory, configured);
    if (
      !isWithin(directory, target.clientPackage.directory) &&
      !packageBoundary(directory)
    )
      throw new Error(
        `Client public asset directory must stay inside a declared package: ${directory}`,
      );
    try {
      await stat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    await copyTree(directory, publicDirectory);
    copiedFiles.push(
      ...(await allFilesUnder(publicDirectory)).map((file) =>
        relative(publicDirectory, file).replaceAll(sep, '/'),
      ),
    );
  }
  const files = [...new Set(copiedFiles)].sort();
  return { roots: assetRoots, files };
}

async function resolveVite(
  packageDirectory: string,
): Promise<(config: ViteBuildConfig) => Promise<void>> {
  let resolved: string;
  try {
    resolved = createRequire(join(packageDirectory, 'package.json')).resolve(
      'vite',
    );
  } catch (error) {
    throw new Error(
      `Client package ${packageDirectory} must provide Vite as a build dependency`,
      { cause: error },
    );
  }
  const module = (await import(pathToFileURL(resolved).href)) as {
    build?: (config: ViteBuildConfig) => Promise<void>;
  };
  if (typeof module.build !== 'function')
    throw new Error(`Vite at ${resolved} does not expose build()`);
  return module.build;
}

async function assertOutputParent(
  outputDirectory: string,
  workspaceRoot: string,
): Promise<string> {
  const output = resolve(outputDirectory);
  if (output === resolve('/') || isWithin(output, workspaceRoot))
    throw new Error(
      'Client artifact output must be outside the source workspace',
    );
  await mkdir(output, { recursive: true });
  return output;
}

export async function buildClientArtifact(
  options: ClientArtifactBuildOptions,
): Promise<ClientArtifactBuildResult> {
  const target = await verifyGameManifest(
    options.gameDirectory,
    options.workspaceRoot,
  );
  const releaseId = safeIdentifier(options.releaseId, 'releaseId');
  const clientEntry = resolvePackageExportTarget(
    target.clientPackage,
    target.manifest.client.export,
  );
  const clientDirectory = target.clientPackage.directory;
  const gameId = safeIdentifier(
    options.gameId ?? (await inferGameId(clientDirectory, target.manifest.id)),
    'gameId',
  );
  const outputParent = await assertOutputParent(
    options.outputDirectory,
    options.workspaceRoot,
  );
  const commands: ClientBuildRun[] = [];
  const run =
    options.run ??
    (async (command, args, cwd) => {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(command, [...args], {
          cwd,
          shell: false,
          stdio: 'inherit',
        });
        child.once('error', reject);
        child.once('exit', (code: number | null) =>
          code === 0
            ? resolvePromise()
            : reject(
                new Error(`Client build command exited with status ${code}`),
              ),
        );
      });
    });
  const stage = join(
    dirname(outputParent),
    `.${outputParent.split(sep).pop() ?? 'client-artifact'}.bgp-client-${process.pid}-${Date.now()}`,
  );
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    if (options.buildClient !== false) {
      const args = ['pnpm', 'run', 'build'];
      commands.push({ command: 'corepack', args, cwd: clientDirectory });
      await run('corepack', args, clientDirectory);
    }
    const shared = await discoverSharedSpecifiers(clientDirectory);
    const assets = await readClientAssets(target, join(stage, 'public'));
    const runtimeBase = {
      abiVersion: REACT_CLIENT_RUNTIME_ABI,
      format: 'esm' as const,
      entry: 'client/entry.js',
      exportName: 'gameClientRelease',
      shared,
    };
    const provisionalEntry = `virtual:board-game-client-entry`;
    const entryPlugin: VitePluginLike = {
      name: 'board-game-client-entry',
      resolveId(source) {
        return source === provisionalEntry ? '\0bgp-client-entry' : undefined;
      },
      load(id) {
        if (id !== '\0bgp-client-entry') return undefined;
        return `import * as gameModule from ${JSON.stringify(pathToFileURL(clientEntry).href)};\nconst definition = Object.values(gameModule).find((value) => value && typeof value === 'object' && typeof value.gameId === 'string' && value.setup && value.entry);\nif (!definition || definition.gameId !== ${JSON.stringify(gameId)}) throw new Error('Client public export did not provide the expected game definition');\nexport const gameClientRelease = Object.freeze({ gameId: ${JSON.stringify(gameId)}, releaseId: ${JSON.stringify(releaseId)}, abiVersion: ${JSON.stringify(REACT_CLIENT_RUNTIME_ABI)}, definition });\n`;
      },
    };
    const clientOutput = join(stage, 'client');
    const cssScope = `${gameId}/${releaseId}`;
    const build = await resolveVite(clientDirectory);
    const config: ViteBuildConfig = {
      root: clientDirectory,
      configFile: false,
      publicDir: false,
      base: './',
      define: {
        'import.meta.env.BGP_GAME_ID': JSON.stringify(gameId),
        'import.meta.env.BGP_GAME_RELEASE_ID': JSON.stringify(releaseId),
      },
      resolve: {
        alias: [
          {
            find: /^@\//u,
            replacement: `${dirname(clientEntry)}/`,
          },
        ],
      },
      plugins: [
        entryPlugin,
        createClientBuildPlugin(
          gameId,
          releaseId,
          shared.map((item) => item.specifier),
          assets.roots,
          cssScope,
          clientDirectory,
        ),
      ],
      build: {
        outDir: clientOutput,
        emptyOutDir: true,
        sourcemap: false,
        cssCodeSplit: true,
        rollupOptions: {
          input: provisionalEntry,
          preserveEntrySignatures: 'strict',
          output: {
            entryFileNames: 'entry.js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            assetFileNames: 'styles/[name]-[hash][extname]',
          },
        },
      },
    };
    await build(config);
    const styleFiles = (await allFilesUnder(clientOutput))
      .filter((file) => file.endsWith('.css'))
      .map((file) => relative(stage, file).replaceAll(sep, '/'))
      .sort();
    const runtime: ClientRuntimeManifest = {
      ...runtimeBase,
      styles: styleFiles,
    };
    assertClientRuntimeManifest(runtime);
    const clientDigest = await digestClientArtifactDirectory(clientOutput);
    const publicAssetsDigest = await digestClientArtifactDirectory(
      join(stage, 'public'),
    );
    const artifactRoot = join(
      outputParent,
      gameId,
      releaseId,
      clientDigest.slice(7),
    );
    try {
      await lstat(artifactRoot);
      throw new Error(`Client artifact output already exists: ${artifactRoot}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const manifest = {
      schemaVersion: 1,
      gameId,
      releaseId,
      artifactRoot: artifactRootUrlPath(gameId, releaseId, clientDigest),
      clientDigest,
      publicAssetsDigest,
      runtime,
      publicAssets: assets.files,
    };
    await writeFile(
      join(stage, 'client-artifact.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(dirname(artifactRoot), { recursive: true });
    await rename(stage, artifactRoot);
    return {
      gameId,
      releaseId,
      artifactRoot,
      artifactRootUrlPath: manifest.artifactRoot,
      clientDirectory: join(artifactRoot, 'client'),
      publicAssetsDirectory: join(artifactRoot, 'public'),
      manifestPath: join(artifactRoot, 'client-artifact.json'),
      clientDigest,
      publicAssetsDigest,
      runtime,
      publicAssets: assets.files,
      commands,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
