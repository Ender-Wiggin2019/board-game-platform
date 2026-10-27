import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  discoverGamePackages,
  discoverWorkspacePackages,
  type GameManifest,
  type GameManifestTarget,
  verifyGameManifest,
  type WorkspacePackage,
} from './game-manifest.js';

export type GamePackageMode = 'source' | 'dist';

export interface GamePackageRun {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface GamePackageExportOptions {
  readonly gameDirectory: string;
  readonly workspaceRoot: string;
  readonly outputDirectory: string;
  readonly mode: GamePackageMode;
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<void>;
}

export interface GamePackageEntry {
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly files: readonly string[];
  readonly digest: string;
}

export interface GamePackageExportResult {
  readonly gameId: string;
  readonly mode: GamePackageMode;
  readonly outputDirectory: string;
  readonly packages: readonly GamePackageEntry[];
  readonly commands: readonly GamePackageRun[];
}

export interface GamePackageVerifyOptions {
  readonly packageDirectory: string;
  readonly mode?: GamePackageMode;
  readonly offline?: boolean;
  readonly storeDirectory?: string;
  /** Exact package tarballs used by a local verifier before registry publication. */
  readonly packageOverrides?: Readonly<Record<string, string>>;
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<void>;
}

export interface GamePackageVerifyResult {
  readonly gameId: string;
  readonly mode: GamePackageMode;
  readonly packageDirectory: string;
  readonly commands: readonly GamePackageRun[];
}

interface PackageRecord {
  readonly package: WorkspacePackage;
  readonly sourcePath: string;
  readonly gamePackage: boolean;
}

interface PackageOutput {
  readonly record: PackageRecord;
  readonly outputPath: string;
  readonly files: readonly string[];
  readonly digest: string;
}

interface ExportMetadata {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly title: string;
  readonly mode: GamePackageMode;
  readonly manifest: string;
  readonly source: {
    readonly workspaceRoot: string;
    readonly gameDirectory: string;
  };
  readonly packages: readonly GamePackageEntry[];
}

const PACKAGE_MANIFEST = 'package.json';
const EXPORT_MANIFEST = 'game-package.json';
const SAFE_DIST_DIRECTORIES = ['dist', 'build', 'public'] as const;
const PACKAGE_PROVENANCE_FILES = new Set(['README.md', 'NOTICE', 'NOTICE.md']);
const GAME_UPSTREAM_METADATA_FILES = [
  'upstream.json',
  'upstream.lock.json',
] as const;
const WORKSPACE_DEPENDENCY_GROUPS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const SOURCE_DEPENDENCY_GROUPS = [
  ...WORKSPACE_DEPENDENCY_GROUPS,
  'devDependencies',
] as const;
const SOURCE_SKIP_NAMES = new Set([
  '.git',
  '.turbo',
  'node_modules',
  'coverage',
  'dist',
]);
const SOURCE_SKIP_FILES = new Set(['.env', '.env.local', '.DS_Store']);
const PORTABLE_SCRIPT_NAMES = new Set(['build', 'typecheck', 'test']);
const PACKAGE_MANAGER_COMMAND_NAMES = new Set([
  'add',
  'audit',
  'bin',
  'config',
  'create',
  'dlx',
  'env',
  'exec',
  'export',
  'import',
  'init',
  'install',
  'link',
  'list',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'root',
  'run',
  'run-script',
  'store',
  'uninstall',
  'unlink',
  'update',
  'version',
  'view',
  'why',
  'which',
]);
const PACKAGE_MANAGER_SCRIPT_PATTERN =
  /\b(?:pnpm|npm)\s+(?:(?:run|run-script)\s+)?([A-Za-z0-9][A-Za-z0-9:_-]*)/gu;

function isWithin(child: string, parent: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return (
    childRelative === '' ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== '..')
  );
}

function packagePath(name: string): string {
  return name.replace(/^@/u, '').replaceAll('/', '-');
}

function packageDependencyMap(
  manifest: Readonly<Record<string, unknown>>,
  group: string,
): Record<string, string> {
  const value = manifest[group];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, string>) };
}

function isOptionalPeerDependency(
  manifest: Readonly<Record<string, unknown>>,
  group: string,
  name: string,
): boolean {
  if (group !== 'peerDependencies') return false;
  const metadata = manifest.peerDependenciesMeta;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return false;
  const entry = (metadata as Record<string, unknown>)[name];
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).optional === true,
  );
}

function isOptionalWorkspaceDependency(
  manifest: Readonly<Record<string, unknown>>,
  group: string,
  name: string,
): boolean {
  return (
    isOptionalPeerDependency(manifest, group, name) ||
    (group === 'devDependencies' &&
      isOptionalPeerDependency(manifest, 'peerDependencies', name))
  );
}

function dependencySpecIsWorkspace(spec: string): boolean {
  return spec.startsWith('workspace:');
}

function packageVersion(item: WorkspacePackage): string {
  const version = item.manifest.version;
  if (typeof version !== 'string' || version.trim().length === 0)
    throw new Error(`Package ${item.name} must declare a version for export`);
  return version;
}

function parsePackageManifest(
  source: string,
  path: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid package JSON at ${path}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`Package JSON must be an object at ${path}`);
  return parsed as Record<string, unknown>;
}

async function readPackageManifest(
  directory: string,
): Promise<WorkspacePackage> {
  const path = join(directory, PACKAGE_MANIFEST);
  const manifest = parsePackageManifest(await readFile(path, 'utf8'), path);
  const name = manifest.name;
  if (typeof name !== 'string' || name.length === 0)
    throw new Error(`Package at ${directory} must declare a name`);
  return { name, directory: resolve(directory), manifest };
}

function assertExportDestination(
  workspaceRoot: string,
  gameDirectory: string,
  outputDirectory: string,
): string {
  const output = resolve(outputDirectory);
  if (output === resolve('/') || output === resolve('.'))
    throw new Error(`Unsafe game package output directory: ${output}`);
  if (isWithin(output, workspaceRoot))
    throw new Error('Game package output must be outside the source workspace');
  if (isWithin(output, gameDirectory))
    throw new Error('Game package output must be outside the game source');
  return output;
}

async function assertOutputAbsent(output: string): Promise<void> {
  try {
    await lstat(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Game package output already exists: ${output}`);
}

function dependencyRecords(
  game: GameManifestTarget,
  entryPackages: readonly WorkspacePackage[],
  gamePackages: readonly WorkspacePackage[],
  workspacePackages: readonly WorkspacePackage[],
  workspaceRoot: string,
  gameDirectory: string,
  includePackageDevDependencies: boolean,
): readonly PackageRecord[] {
  const byName = new Map(workspacePackages.map((item) => [item.name, item]));
  const gameNames = new Set(gamePackages.map((item) => item.name));
  const gamesRoot = resolve(workspaceRoot, 'games');
  const commonRoot = resolve(workspaceRoot, 'common');
  const platformRoot = resolve(workspaceRoot, 'platform');
  const queue = [...entryPackages];
  const records = new Map<string, PackageRecord>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || records.has(item.name)) continue;
    const gamePackage =
      gameNames.has(item.name) && isWithin(item.directory, gameDirectory);
    if (
      !gamePackage &&
      !isWithin(item.directory, commonRoot) &&
      !isWithin(item.directory, platformRoot)
    )
      throw new Error(
        `Game ${game.manifest.id} depends on unsupported workspace package ${item.name}`,
      );
    records.set(item.name, {
      package: item,
      sourcePath: item.directory,
      gamePackage,
    });
    // Source game packages retain devDependencies; vendored common/platform
    // packages are packed with their devDependencies removed.
    const dependencyGroups =
      includePackageDevDependencies && gamePackage
        ? SOURCE_DEPENDENCY_GROUPS
        : WORKSPACE_DEPENDENCY_GROUPS;
    for (const group of dependencyGroups) {
      const dependencies = packageDependencyMap(item.manifest, group);
      for (const [name, spec] of Object.entries(dependencies)) {
        if (isOptionalWorkspaceDependency(item.manifest, group, name)) continue;
        if (!dependencySpecIsWorkspace(spec)) continue;
        const dependency = byName.get(name);
        if (!dependency)
          throw new Error(
            `Workspace dependency ${name} of ${item.name} is not installed`,
          );
        if (!gameNames.has(name) && isWithin(dependency.directory, gamesRoot)) {
          throw new Error(
            `Game ${game.manifest.id} cannot depend on another game package ${name}`,
          );
        }
        queue.push(dependency);
      }
    }
  }
  return [...records.values()].sort((left, right) =>
    left.package.name.localeCompare(right.package.name),
  );
}

function rewriteWorkspaceDependencies(
  source: Readonly<Record<string, unknown>>,
  records: ReadonlyMap<string, PackageRecord>,
  preserveGameWorkspace: boolean,
  includePackageDevDependencies: boolean,
): Record<string, unknown> {
  const rewritten = { ...source };
  const dependencyGroups = includePackageDevDependencies
    ? SOURCE_DEPENDENCY_GROUPS
    : WORKSPACE_DEPENDENCY_GROUPS;
  for (const group of dependencyGroups) {
    const dependencies = packageDependencyMap(source, group);
    const result: Record<string, string> = {};
    for (const [name, spec] of Object.entries(dependencies)) {
      if (isOptionalWorkspaceDependency(source, group, name)) continue;
      const record = records.get(name);
      if (record && dependencySpecIsWorkspace(spec))
        result[name] =
          preserveGameWorkspace && record.gamePackage
            ? 'workspace:*'
            : packageVersion(record.package);
      else result[name] = spec;
    }
    if (Object.keys(result).length > 0) rewritten[group] = result;
    else delete rewritten[group];
  }
  const peerMetadata = source.peerDependenciesMeta;
  const peerDependencies = packageDependencyMap(rewritten, 'peerDependencies');
  if (
    peerMetadata &&
    typeof peerMetadata === 'object' &&
    !Array.isArray(peerMetadata)
  ) {
    const retainedMetadata = Object.fromEntries(
      Object.entries(peerMetadata).filter(([name]) =>
        Object.hasOwn(peerDependencies, name),
      ),
    );
    if (Object.keys(retainedMetadata).length > 0)
      rewritten.peerDependenciesMeta = retainedMetadata;
    else delete rewritten.peerDependenciesMeta;
  }
  return rewritten;
}

async function installedPackageVersion(
  packageDirectory: string,
  dependencyName: string,
  requestedSpec?: string,
): Promise<string | undefined> {
  const dependency = await installedPackage(packageDirectory, dependencyName);
  if (!dependency) return undefined;
  const version = packageVersion(dependency);
  return requestedSpec?.startsWith('npm:')
    ? `npm:${dependency.name}@${version}`
    : version;
}

async function installedPackage(
  packageDirectory: string,
  dependencyName: string,
): Promise<WorkspacePackage | undefined> {
  let cursor = await realpath(packageDirectory);
  while (true) {
    const dependencyDirectory = cursor.endsWith(`${sep}node_modules`)
      ? join(cursor, ...dependencyName.split('/'))
      : join(cursor, 'node_modules', ...dependencyName.split('/'));
    try {
      return {
        ...(await readPackageManifest(dependencyDirectory)),
        directory: resolve(dependencyDirectory),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

interface CollectedDependencyVersions {
  readonly versions: ReadonlyMap<string, string>;
  readonly identities: ReadonlySet<string>;
}

async function collectDependencyVersions(
  records: readonly PackageRecord[],
  clientPackage: WorkspacePackage,
  includePackageDevDependencies: boolean,
): Promise<CollectedDependencyVersions> {
  const localNames = new Set(records.map((record) => record.package.name));
  const versions = new Map<string, string>();
  const identities = new Set<string>();
  const conflicts = new Set<string>();
  const recordVersion = (
    name: string,
    requestedSpec: string,
    dependency: WorkspacePackage,
  ): void => {
    const version = requestedSpec.startsWith('npm:')
      ? `npm:${dependency.name}@${packageVersion(dependency)}`
      : packageVersion(dependency);
    identities.add(packageIdentity(name, version));
    const previous = versions.get(name);
    if (previous && previous !== version) {
      conflicts.add(name);
      versions.delete(name);
    } else if (!conflicts.has(name)) {
      versions.set(name, version);
    }
  };
  const queue: WorkspacePackage[] = records.map((record) => record.package);
  if (includePackageDevDependencies) {
    for (const record of records) {
      const value = record.package.manifest.devDependencies;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [name, requestedSpec] of Object.entries(value)) {
        if (typeof requestedSpec !== 'string') continue;
        const dependency = await installedPackage(record.sourcePath, name);
        if (!dependency || localNames.has(name)) continue;
        recordVersion(name, requestedSpec, dependency);
        queue.push(dependency);
      }
    }
  }
  const clientDev = clientPackage.manifest.devDependencies;
  if (clientDev && typeof clientDev === 'object' && !Array.isArray(clientDev)) {
    for (const name of ['vite', 'typescript', '@types/node']) {
      const requestedSpec = (clientDev as Record<string, unknown>)[name];
      if (typeof requestedSpec !== 'string') continue;
      const dependency = await installedPackage(clientPackage.directory, name);
      if (dependency) {
        const version = requestedSpec.startsWith('npm:')
          ? `npm:${dependency.name}@${packageVersion(dependency)}`
          : packageVersion(dependency);
        identities.add(packageIdentity(name, version));
        queue.push(dependency);
      }
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || visited.has(item.directory)) continue;
    visited.add(item.directory);
    for (const group of WORKSPACE_DEPENDENCY_GROUPS) {
      for (const [name, requestedSpec] of Object.entries(
        packageDependencyMap(item.manifest, group),
      )) {
        if (isOptionalWorkspaceDependency(item.manifest, group, name)) continue;
        const dependency = await installedPackage(item.directory, name);
        if (!dependency || localNames.has(name)) continue;
        recordVersion(name, requestedSpec, dependency);
        queue.push(dependency);
      }
    }
  }
  return { versions, identities };
}

interface PatchedDependencyFile {
  readonly path: string;
  readonly sourcePath: string;
}

function packageIdentity(name: string, version: string): string {
  return version.startsWith('npm:')
    ? version.slice('npm:'.length)
    : `${name}@${version}`;
}

function patchedDependencyIsUsed(
  selector: string,
  dependencyIdentities: ReadonlySet<string>,
): boolean {
  return dependencyIdentities.has(selector);
}

async function workspaceRelativePath(
  workspaceRoot: string,
  path: string,
  label: string,
): Promise<{ readonly path: string; readonly absolutePath: string }> {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\'))
    throw new Error(`${label} must be a relative workspace path: ${path}`);
  const absolutePath = resolve(workspaceRoot, path);
  if (!isWithin(absolutePath, workspaceRoot))
    throw new Error(`${label} must stay within the workspace: ${path}`);
  const realWorkspaceRoot = await realpath(workspaceRoot);
  let realAbsolutePath: string;
  try {
    realAbsolutePath = await realpath(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${label} must be a regular file: ${path}`, {
        cause: error,
      });
    throw error;
  }
  if (!isWithin(realAbsolutePath, realWorkspaceRoot))
    throw new Error(`${label} must stay within the workspace: ${path}`);
  return {
    path: relative(workspaceRoot, absolutePath).replaceAll(sep, '/'),
    absolutePath,
  };
}

async function collectPatchedDependencyFiles(
  workspaceRoot: string,
  dependencyIdentities: ReadonlySet<string>,
): Promise<ReadonlyMap<string, PatchedDependencyFile>> {
  const packagePath = join(workspaceRoot, PACKAGE_MANIFEST);
  let source: Record<string, unknown>;
  try {
    source = parsePackageManifest(
      await readFile(packagePath, 'utf8'),
      packagePath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const pnpm = source.pnpm;
  if (!pnpm || typeof pnpm !== 'object' || Array.isArray(pnpm))
    return new Map();
  const patched = (pnpm as Record<string, unknown>).patchedDependencies;
  if (patched === undefined) return new Map();
  if (!patched || typeof patched !== 'object' || Array.isArray(patched))
    throw new Error('pnpm.patchedDependencies must be an object');

  const selected = new Map<string, PatchedDependencyFile>();
  for (const [selector, value] of Object.entries(
    patched as Record<string, unknown>,
  )) {
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new Error(
        `pnpm.patchedDependencies entry ${selector} must name a patch file`,
      );
    const validated = await workspaceRelativePath(
      workspaceRoot,
      value,
      `Patch file for ${selector}`,
    );
    const sourceStat = await lstat(validated.absolutePath);
    if (!sourceStat.isFile())
      throw new Error(
        `Patch file for ${selector} must be a regular file: ${value}`,
      );
    if (!patchedDependencyIsUsed(selector, dependencyIdentities)) continue;
    selected.set(selector, {
      path: validated.path,
      sourcePath: validated.absolutePath,
    });
  }
  return selected;
}

async function copyPatchedDependencyFiles(
  root: string,
  patchedDependencies: ReadonlyMap<string, PatchedDependencyFile>,
): Promise<void> {
  for (const patch of patchedDependencies.values()) {
    const destination = join(root, patch.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(patch.sourcePath, destination);
  }
}

async function freezeDependencyVersions(
  packageDirectory: string,
  source: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const frozen = { ...source };
  for (const group of SOURCE_DEPENDENCY_GROUPS) {
    const dependencies = packageDependencyMap(frozen, group);
    if (Object.keys(dependencies).length === 0) continue;
    const result: Record<string, string> = {};
    for (const [name, spec] of Object.entries(dependencies)) {
      if (dependencySpecIsWorkspace(spec)) {
        result[name] = spec;
        continue;
      }
      result[name] =
        (await installedPackageVersion(packageDirectory, name, spec)) ?? spec;
    }
    frozen[group] = result;
  }
  return frozen;
}

function portableScripts(
  manifest: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const value = manifest.scripts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const scripts = value as Record<string, unknown>;
  const retained = new Set<string>();
  const pending = [...PORTABLE_SCRIPT_NAMES];
  while (pending.length > 0) {
    const name = pending.shift();
    if (!name || retained.has(name) || typeof scripts[name] !== 'string')
      continue;
    retained.add(name);
    for (const lifecycle of [`pre${name}`, `post${name}`]) {
      if (typeof scripts[lifecycle] === 'string') pending.push(lifecycle);
    }
    for (const match of (scripts[name] as string).matchAll(
      PACKAGE_MANAGER_SCRIPT_PATTERN,
    )) {
      const referenced = match[1];
      if (
        referenced &&
        !PACKAGE_MANAGER_COMMAND_NAMES.has(referenced) &&
        typeof scripts[referenced] === 'string'
      )
        pending.push(referenced);
    }
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, command]) => retained.has(name) && typeof command === 'string',
    ),
  ) as Record<string, string>;
}

async function copyFileTree(
  source: string,
  destination: string,
  skipNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink())
    throw new Error(`Symlinks are not allowed: ${source}`);
  if (!sourceStat.isDirectory())
    throw new Error(`Expected directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      skipNames.has(entry.name) ||
      SOURCE_SKIP_FILES.has(entry.name) ||
      entry.name.endsWith('.tsbuildinfo') ||
      entry.name.startsWith('.env.')
    )
      continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const entryStat = await lstat(from);
    if (entryStat.isSymbolicLink())
      throw new Error(`Symlinks are not allowed: ${from}`);
    if (entryStat.isDirectory()) await copyFileTree(from, to, skipNames);
    else if (entryStat.isFile()) await cp(from, to);
    else throw new Error(`Unsupported package file: ${from}`);
  }
}

async function copySafeTree(
  source: string,
  destination: string,
): Promise<void> {
  await copyFileTree(source, destination, new Set());
}

async function hashFiles(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(current: string, prefix: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not allowed: ${path}`);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) await visit(path, relativePath);
      else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update('\n');
        hash.update(await readFile(path));
      }
    }
  }
  await visit(directory, '');
  return `sha256:${hash.digest('hex')}`;
}

function distFiles(
  manifest: Readonly<Record<string, unknown>>,
): readonly string[] {
  const hasExplicitFiles = Object.hasOwn(manifest, 'files');
  if (hasExplicitFiles && !Array.isArray(manifest.files))
    throw new Error('Package files must be an array for dist export');
  const candidates = hasExplicitFiles
    ? (manifest.files as unknown[]).map((entry) => {
        if (typeof entry !== 'string' || entry.length === 0)
          throw new Error('Package files entries must be non-empty strings');
        const parts = entry.split('/');
        if (
          entry.startsWith('/') ||
          entry.includes('\\') ||
          parts.some(
            (part) => part.length === 0 || part === '.' || part === '..',
          )
        )
          throw new Error(`Unsafe package files entry: ${entry}`);
        return entry;
      })
    : [...SAFE_DIST_DIRECTORIES];
  const files = candidates.filter((entry) => {
    const first = entry.split('/')[0];
    if (
      !SAFE_DIST_DIRECTORIES.includes(
        first as (typeof SAFE_DIST_DIRECTORIES)[number],
      )
    )
      throw new Error(
        `Package files entry is not a distributable path: ${entry}`,
      );
    return true;
  });
  return [...new Set(files)];
}

async function packageProvenanceFiles(
  sourceDirectory: string,
): Promise<readonly string[]> {
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (PACKAGE_PROVENANCE_FILES.has(entry.name) ||
          entry.name.startsWith('LICENSE')),
    )
    .map((entry) => entry.name)
    .sort();
}

async function copyProvenanceFiles(
  sourceDirectory: string,
  destination: string,
): Promise<readonly string[]> {
  const files = await packageProvenanceFiles(sourceDirectory);
  for (const file of files) {
    await cp(join(sourceDirectory, file), join(destination, file));
  }
  return files;
}

async function copyGameUpstreamMetadata(
  sourceDirectory: string,
  destination: string,
): Promise<void> {
  for (const file of GAME_UPSTREAM_METADATA_FILES) {
    const source = join(sourceDirectory, file);
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isFile())
        throw new Error(
          `Game upstream metadata must be a regular file: ${source}`,
        );
      await cp(source, join(destination, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function rewriteBuiltPublicExports(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === './public') return './dist/public';
    if (value.startsWith('./public/'))
      return `./dist/public/${value.slice('./public/'.length)}`;
    return value;
  }
  if (Array.isArray(value)) return value.map(rewriteBuiltPublicExports);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteBuiltPublicExports(entry),
      ]),
    );
  }
  return value;
}

async function copyDistPackage(
  record: PackageRecord,
  destination: string,
  records: ReadonlyMap<string, PackageRecord>,
): Promise<readonly string[]> {
  const requestedFiles = distFiles(record.package.manifest);
  let hasBuiltPublic = false;
  if (
    requestedFiles.some(
      (entry) => entry === 'public' || entry.startsWith('public/'),
    )
  ) {
    try {
      hasBuiltPublic = (
        await stat(join(record.sourcePath, 'dist/public'))
      ).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const files = hasBuiltPublic
    ? requestedFiles.filter(
        (entry) => entry !== 'public' && !entry.startsWith('public/'),
      )
    : requestedFiles;
  const copied: string[] = [];
  const provenanceFiles = await packageProvenanceFiles(record.sourcePath);
  await mkdir(destination, { recursive: true });
  const manifest = await freezeDependencyVersions(
    record.sourcePath,
    rewriteWorkspaceDependencies(
      record.package.manifest,
      records,
      false,
      false,
    ),
  );
  if (hasBuiltPublic && manifest.exports !== undefined)
    manifest.exports = rewriteBuiltPublicExports(manifest.exports);
  manifest.private = true;
  delete manifest.scripts;
  delete manifest.devDependencies;
  for (const entry of [...new Set([...files, ...provenanceFiles])]) {
    const source = join(record.sourcePath, entry);
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isDirectory() && !sourceStat.isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const target = join(destination, entry);
    if (!isWithin(target, destination))
      throw new Error(`Unsafe package files entry: ${entry}`);
    const targetParent = dirname(target);
    await mkdir(targetParent, { recursive: true });
    const sourceStat = await lstat(source);
    if (sourceStat.isDirectory()) await copySafeTree(source, target);
    else if (sourceStat.isFile()) await cp(source, target);
    else throw new Error(`Unsupported package artifact: ${source}`);
    copied.push(entry);
  }
  if (copied.length === 0)
    throw new Error(
      `Package ${record.package.name} has no built export artifacts`,
    );
  manifest.files = copied;
  await writeFile(
    join(destination, PACKAGE_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return copied;
}

async function copySourcePackage(
  record: PackageRecord,
  destination: string,
  records: ReadonlyMap<string, PackageRecord>,
): Promise<readonly string[]> {
  await copyFileTree(record.sourcePath, destination, SOURCE_SKIP_NAMES);
  const packagePath = join(destination, PACKAGE_MANIFEST);
  const manifest = await freezeDependencyVersions(
    record.sourcePath,
    rewriteWorkspaceDependencies(record.package.manifest, records, true, true),
  );
  manifest.private = true;
  const scripts = portableScripts(record.package.manifest);
  const sourceScripts = record.package.manifest.scripts;
  let standaloneBuild = false;
  try {
    standaloneBuild = (
      await stat(join(record.sourcePath, 'tsconfig.standalone.build.json'))
    ).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (
    standaloneBuild &&
    sourceScripts &&
    typeof sourceScripts === 'object' &&
    !Array.isArray(sourceScripts) &&
    typeof (sourceScripts as Record<string, unknown>)['build:remote'] ===
      'string'
  ) {
    scripts.build = (sourceScripts as Record<string, string>)['build:remote'];
    scripts.typecheck = 'tsc -p tsconfig.standalone.build.json --noEmit';
  }
  manifest.scripts = scripts;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return ['src', 'package.json'];
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`Game package command exited with status ${code}`)),
    );
  });
}

async function packageWithPnpm(
  packageDirectory: string,
  destination: string,
  run: (command: string, args: readonly string[], cwd: string) => Promise<void>,
  commands: GamePackageRun[],
): Promise<string> {
  await mkdir(destination, { recursive: true });
  const args = [
    'pnpm',
    'pack',
    '--pack-destination',
    destination,
    '--reporter',
    'append-only',
  ];
  commands.push({ command: 'corepack', args, cwd: packageDirectory });
  await run('corepack', args, packageDirectory);
  const files = (await readdir(destination)).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (files.length !== 1)
    throw new Error(`Expected one package tarball for ${packageDirectory}`);
  return join(destination, files[0]);
}

function localTarballName(tarball: string, root: string): string {
  return relative(root, tarball).replaceAll(sep, '/');
}

async function writeRootPackage(
  root: string,
  target: GameManifestTarget,
  workspaceRoot: string,
  mode: GamePackageMode,
  localTarballs: ReadonlyMap<string, string>,
  clientPackage: WorkspacePackage,
  dependencyVersions: ReadonlyMap<string, string>,
  patchedDependencies: ReadonlyMap<string, PatchedDependencyFile>,
): Promise<void> {
  const dependencies: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  if (mode === 'source') {
    dependencies[target.manifest.client.package] = 'workspace:*';
    dependencies[target.manifest.server.package] = 'workspace:*';
  }
  for (const [name, version] of dependencyVersions) overrides[name] = version;
  for (const [name, path] of localTarballs) {
    const spec = `file:${path}`;
    dependencies[name] = spec;
    overrides[name] = spec;
  }
  const pnpm: Record<string, unknown> = { overrides };
  if (patchedDependencies.size > 0) {
    pnpm.patchedDependencies = Object.fromEntries(
      [...patchedDependencies].map(([selector, patch]) => [
        selector,
        patch.path,
      ]),
    );
  }
  const rootManifest: Record<string, unknown> = {
    name: `board-game-${target.manifest.id}-${mode}-workspace`,
    version: '0.0.0',
    private: true,
    type: 'module',
    packageManager: 'pnpm@10.0.0',
    engines: { node: '>=22' },
    dependencies,
    pnpm,
    ...(mode === 'source'
      ? {
          scripts: {
            build: `pnpm --filter @board-games/${target.manifest.id}-client... --filter @board-games/${target.manifest.id}-server... -r build`,
            typecheck: `pnpm --filter @board-games/${target.manifest.id}-client... --filter @board-games/${target.manifest.id}-server... -r typecheck`,
            test: `pnpm --filter @board-games/${target.manifest.id}-client... --filter @board-games/${target.manifest.id}-server... -r test`,
          },
        }
      : {}),
  };
  const clientRuntimeDependencies = [
    packageDependencyMap(clientPackage.manifest, 'dependencies'),
    packageDependencyMap(clientPackage.manifest, 'peerDependencies'),
    packageDependencyMap(clientPackage.manifest, 'devDependencies'),
  ];
  if (
    clientRuntimeDependencies.some((group) => Object.keys(group).length > 0)
  ) {
    const selected: Record<string, string> = {};
    for (const name of [
      'vite',
      'typescript',
      '@types/node',
      'react',
      'react-dom',
    ]) {
      const requested = clientRuntimeDependencies.find((group) =>
        Object.hasOwn(group, name),
      )?.[name];
      if (typeof requested === 'string')
        selected[name] =
          (await installedPackageVersion(clientPackage.directory, name)) ??
          requested;
    }
    if (Object.keys(selected).length > 0)
      rootManifest.devDependencies = selected;
  }
  await writeFile(
    join(root, PACKAGE_MANIFEST),
    `${JSON.stringify(rootManifest, null, 2)}\n`,
  );
  if (mode === 'source') {
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n  - games/${target.manifest.id}/**\n`,
    );
    const baseConfig = join(workspaceRoot, 'tsconfig.base.json');
    try {
      await cp(baseConfig, join(root, 'tsconfig.base.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function packageEntries(
  stageRoot: string,
  target: GameManifestTarget,
  records: readonly PackageRecord[],
  mode: GamePackageMode,
  run: (command: string, args: readonly string[], cwd: string) => Promise<void>,
  commands: GamePackageRun[],
): Promise<{
  readonly outputs: readonly PackageOutput[];
  readonly tarballs: ReadonlyMap<string, string>;
}> {
  const outputPathOwners = new Map<string, string>();
  for (const record of records) {
    const outputPath = packagePath(record.package.name);
    const previous = outputPathOwners.get(outputPath);
    if (previous && previous !== record.package.name)
      throw new Error(
        `Package output path collision: ${previous} and ${record.package.name} both map to ${outputPath}`,
      );
    outputPathOwners.set(outputPath, record.package.name);
  }
  const recordMap = new Map(
    records.map((record) => [record.package.name, record]),
  );
  const outputs: PackageOutput[] = [];
  const tarballs = new Map<string, string>();
  const tarballRoot = join(
    stageRoot,
    mode === 'source' ? 'vendor' : 'packages',
  );
  for (const record of records) {
    const packageStage = join(
      stageRoot,
      '.packages',
      packagePath(record.package.name),
    );
    if (mode === 'source') {
      if (record.gamePackage) {
        const outputPackage = join(
          stageRoot,
          'games',
          target.manifest.id,
          relative(target.gameDirectory, record.sourcePath),
        );
        const files = await copySourcePackage(record, outputPackage, recordMap);
        const digest = await hashFiles(outputPackage);
        outputs.push({ record, outputPath: outputPackage, files, digest });
        continue;
      }
    }
    const files = await copyDistPackage(record, packageStage, recordMap);
    const digest = await hashFiles(packageStage);
    const tarballDestination = join(
      tarballRoot,
      packagePath(record.package.name),
    );
    const tarball = await packageWithPnpm(
      packageStage,
      tarballDestination,
      run,
      commands,
    );
    const relativeTarball = localTarballName(tarball, stageRoot);
    tarballs.set(record.package.name, relativeTarball);
    outputs.push({ record, outputPath: tarball, files, digest });
  }
  return { outputs, tarballs };
}

function hasPackageSubpathExport(
  manifest: Readonly<Record<string, unknown>>,
  subpath: string,
): boolean {
  const exports = manifest.exports;
  return Boolean(
    exports &&
      typeof exports === 'object' &&
      !Array.isArray(exports) &&
      Object.hasOwn(exports, subpath),
  );
}

function selectRemoteManifestEntry(
  entry: GameManifest['client'],
  packageRecord: PackageRecord | undefined,
): GameManifest['client'] {
  if (
    entry.export !== '.' ||
    !packageRecord ||
    !hasPackageSubpathExport(packageRecord.package.manifest, './remote')
  )
    return entry;
  return { ...entry, export: './remote' };
}

function independentGameManifest(
  target: GameManifestTarget,
  records: readonly PackageRecord[],
): GameManifest {
  const byName = new Map(
    records.map((record) => [record.package.name, record]),
  );
  return {
    ...target.manifest,
    client: selectRemoteManifestEntry(
      target.manifest.client,
      byName.get(target.manifest.client.package),
    ),
    server: selectRemoteManifestEntry(
      target.manifest.server,
      byName.get(target.manifest.server.package),
    ),
  };
}

export async function exportGamePackage(
  options: GamePackageExportOptions,
): Promise<GamePackageExportResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const gameDirectory = resolve(options.gameDirectory);
  const output = assertExportDestination(
    workspaceRoot,
    gameDirectory,
    options.outputDirectory,
  );
  await assertOutputAbsent(output);
  const target = await verifyGameManifest(gameDirectory, workspaceRoot);
  const workspacePackages = await discoverWorkspacePackages(workspaceRoot);
  const gamePackages = await discoverGamePackages(gameDirectory);
  if (gamePackages.length === 0)
    throw new Error(`Game ${target.manifest.id} has no package directories`);
  const records = dependencyRecords(
    target,
    [target.clientPackage, target.serverPackage],
    gamePackages,
    workspacePackages,
    workspaceRoot,
    gameDirectory,
    options.mode === 'source',
  );
  const run = options.run ?? runCommand;
  const commands: GamePackageRun[] = [];
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const stageRoot = join(
    parent,
    `.${output.split(sep).pop()}.bgp-${process.pid}-${Date.now()}`,
  );
  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  try {
    const { outputs, tarballs } = await packageEntries(
      stageRoot,
      target,
      records,
      options.mode,
      run,
      commands,
    );
    await rm(join(stageRoot, '.packages'), { recursive: true, force: true });
    const clientRecord = records.find(
      (record) => record.package.name === target.clientPackage.name,
    );
    if (!clientRecord)
      throw new Error(`Missing client package ${target.clientPackage.name}`);
    const dependencyVersions = await collectDependencyVersions(
      records,
      clientRecord.package,
      options.mode === 'source',
    );
    const patchedDependencies = await collectPatchedDependencyFiles(
      workspaceRoot,
      dependencyVersions.identities,
    );
    await copyPatchedDependencyFiles(stageRoot, patchedDependencies);
    await writeRootPackage(
      stageRoot,
      target,
      workspaceRoot,
      options.mode,
      tarballs,
      clientRecord.package,
      dependencyVersions.versions,
      patchedDependencies,
    );
    const exportedManifest = independentGameManifest(target, records);
    if (options.mode === 'source') {
      const sourceGameRoot = join(stageRoot, 'games', target.manifest.id);
      await mkdir(sourceGameRoot, { recursive: true });
      await writeFile(
        join(sourceGameRoot, 'game.json'),
        `${JSON.stringify(exportedManifest, null, 2)}\n`,
      );
      await copyProvenanceFiles(target.gameDirectory, sourceGameRoot);
      await copyGameUpstreamMetadata(target.gameDirectory, sourceGameRoot);
      await writeFile(
        join(stageRoot, 'game.json'),
        `${JSON.stringify(exportedManifest, null, 2)}\n`,
      );
    } else {
      await writeFile(
        join(stageRoot, 'game.json'),
        `${JSON.stringify(exportedManifest, null, 2)}\n`,
      );
    }
    // The exported checkout is intended to become its own repository. Keep
    // game-level provenance at its root as well as beside games/<id>/game.json
    // so the standalone repository never depends on the host workspace README.
    await copyProvenanceFiles(target.gameDirectory, stageRoot);
    const packageEntriesForManifest: GamePackageEntry[] = outputs.map(
      (entry) => ({
        name: entry.record.package.name,
        version: packageVersion(entry.record.package),
        sourcePath: relative(workspaceRoot, entry.record.sourcePath),
        outputPath: relative(stageRoot, entry.outputPath).replaceAll(sep, '/'),
        files: entry.files,
        digest: entry.digest,
      }),
    );
    const metadata: ExportMetadata = {
      schemaVersion: 1,
      gameId: target.manifest.id,
      title: target.manifest.title,
      mode: options.mode,
      manifest: 'game.json',
      source: {
        // Keep provenance portable: this metadata describes the exported
        // checkout, not the absolute path of the source machine.
        workspaceRoot: '.',
        gameDirectory: relative(workspaceRoot, gameDirectory) || '.',
      },
      packages: packageEntriesForManifest,
    };
    await writeFile(
      join(stageRoot, EXPORT_MANIFEST),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
    await rename(stageRoot, output);
    return {
      gameId: target.manifest.id,
      mode: options.mode,
      outputDirectory: output,
      packages: packageEntriesForManifest,
      commands,
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readExportMetadata(directory: string): Promise<ExportMetadata> {
  const path = join(directory, EXPORT_MANIFEST);
  const metadata = JSON.parse(
    await readFile(path, 'utf8'),
  ) as Partial<ExportMetadata>;
  if (
    metadata.schemaVersion !== 1 ||
    typeof metadata.gameId !== 'string' ||
    (metadata.mode !== 'source' && metadata.mode !== 'dist') ||
    !Array.isArray(metadata.packages)
  )
    throw new Error(`Invalid ${EXPORT_MANIFEST}`);
  return metadata as ExportMetadata;
}

async function applyPackageOverrides(
  directory: string,
  overrides: Readonly<Record<string, string>> | undefined,
): Promise<() => Promise<void>> {
  if (!overrides || Object.keys(overrides).length === 0)
    return async () => {
      // There is no manifest mutation to restore.
    };
  const path = join(directory, PACKAGE_MANIFEST);
  const original = await readFile(path);
  const manifest = parsePackageManifest(original.toString('utf8'), path);
  const existingPnpm = manifest.pnpm;
  const pnpm =
    existingPnpm &&
    typeof existingPnpm === 'object' &&
    !Array.isArray(existingPnpm)
      ? { ...(existingPnpm as Record<string, unknown>) }
      : {};
  const existingOverrides = pnpm.overrides;
  const mergedOverrides =
    existingOverrides &&
    typeof existingOverrides === 'object' &&
    !Array.isArray(existingOverrides)
      ? { ...(existingOverrides as Record<string, unknown>) }
      : {};
  for (const [name, value] of Object.entries(overrides)) {
    if (!name.startsWith('@') && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name))
      throw new Error(`Invalid package override name: ${name}`);
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new Error(`Package override ${name} must be a non-empty string`);
    mergedOverrides[name] = value;
  }
  pnpm.overrides = mergedOverrides;
  manifest.pnpm = pnpm;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return async () => {
    await writeFile(path, original);
  };
}

async function writeVerificationFiles(
  directory: string,
  exports: {
    readonly client: string;
    readonly server: string;
  },
): Promise<{
  readonly config: string;
  readonly serverTypecheck: string;
  readonly serverImport: string;
}> {
  const verification = join(directory, '.bgp-verify');
  await mkdir(verification, { recursive: true });
  const browserEntry = join(verification, 'browser-entry.js');
  await writeFile(
    browserEntry,
    `import * as game from ${JSON.stringify(exports.client)};\nconsole.log(Object.keys(game));\n`,
  );
  const config = join(verification, 'vite.config.mjs');
  await writeFile(
    config,
    `import { defineConfig } from 'vite';\nexport default defineConfig({ build: { outDir: ${JSON.stringify(join(verification, 'browser-dist'))}, emptyOutDir: true, rollupOptions: { input: ${JSON.stringify(browserEntry)} } } });\n`,
  );
  const serverTypecheck = join(verification, 'server-import.ts');
  await writeFile(
    serverTypecheck,
    `import ${JSON.stringify(exports.server)};\n`,
  );
  const serverImport = join(verification, 'server-import.mjs');
  await writeFile(
    serverImport,
    `await import(${JSON.stringify(exports.server)});\n`,
  );
  return { config, serverTypecheck, serverImport };
}

function packageExportSpecifier(
  value: unknown,
  label: string,
  gameId: string,
  role: 'client' | 'server',
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Exported game manifest.${label} must be an object`);
  const entry = value as Record<string, unknown>;
  const packageName = entry.package;
  if (packageName !== `@board-games/${gameId}-${role}`)
    throw new Error(
      `Exported game manifest.${label}.package must be @board-games/${gameId}-${role}`,
    );
  const exportName = entry.export;
  if (typeof exportName !== 'string' || exportName.trim().length === 0)
    throw new Error(`Exported game manifest.${label}.export must be a string`);
  if (exportName === '.') return packageName;
  if (
    !exportName.startsWith('./') ||
    exportName.length <= 2 ||
    exportName.includes('\\') ||
    exportName
      .split('/')
      .some(
        (part, index) =>
          index > 0 && (part.length === 0 || part === '.' || part === '..'),
      )
  )
    throw new Error(
      `Exported game manifest.${label}.export must be a package export path`,
    );
  return `${packageName}/${exportName.slice(2)}`;
}

async function readVerificationExports(
  directory: string,
  gameId: string,
): Promise<{ readonly client: string; readonly server: string }> {
  const path = join(directory, 'game.json');
  const manifest = parsePackageManifest(await readFile(path, 'utf8'), path);
  if (manifest.id !== gameId)
    throw new Error(`Exported game manifest.id must be ${gameId}`);
  return {
    client: packageExportSpecifier(manifest.client, 'client', gameId, 'client'),
    server: packageExportSpecifier(manifest.server, 'server', gameId, 'server'),
  };
}

export async function verifyGamePackage(
  options: GamePackageVerifyOptions,
): Promise<GamePackageVerifyResult> {
  const directory = resolve(options.packageDirectory);
  const metadata = await readExportMetadata(directory);
  if (options.mode && options.mode !== metadata.mode)
    throw new Error(
      `Expected ${options.mode} export, received ${metadata.mode}`,
    );
  const run = options.run ?? runCommand;
  const commands: GamePackageRun[] = [];
  const installArgs = [
    'pnpm',
    'install',
    '--ignore-scripts',
    '--no-frozen-lockfile',
  ];
  if (options.storeDirectory)
    installArgs.push('--store-dir', resolve(options.storeDirectory));
  if (options.offline) installArgs.push('--offline');
  commands.push({ command: 'corepack', args: installArgs, cwd: directory });
  const restorePackageManifest = await applyPackageOverrides(
    directory,
    options.packageOverrides,
  );
  try {
    await run('corepack', installArgs, directory);
  } finally {
    await restorePackageManifest();
  }
  if (metadata.mode === 'source') {
    const filters = [
      `@board-games/${metadata.gameId}-client...`,
      `@board-games/${metadata.gameId}-server...`,
    ];
    for (const operation of ['build', 'typecheck'] as const) {
      const args = [
        'pnpm',
        ...filters.flatMap((filter) => ['--filter', filter]),
        '-r',
        operation,
      ];
      commands.push({ command: 'corepack', args, cwd: directory });
      await run('corepack', args, directory);
    }
  }
  const exports = await readVerificationExports(directory, metadata.gameId);
  const files = await writeVerificationFiles(directory, exports);
  const browserArgs = [
    'pnpm',
    'exec',
    'vite',
    'build',
    '--config',
    relative(directory, files.config),
  ];
  commands.push({ command: 'corepack', args: browserArgs, cwd: directory });
  await run('corepack', browserArgs, directory);
  const typecheckArgs = [
    'pnpm',
    'exec',
    'tsc',
    '--noEmit',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--skipLibCheck',
    relative(directory, files.serverTypecheck),
  ];
  commands.push({ command: 'corepack', args: typecheckArgs, cwd: directory });
  await run('corepack', typecheckArgs, directory);
  const importArgs = [
    '--input-type=module',
    '-e',
    `await import(${JSON.stringify(exports.server)});`,
  ];
  commands.push({
    command: process.execPath,
    args: importArgs,
    cwd: directory,
  });
  await run(process.execPath, importArgs, directory);
  await rm(join(directory, '.bgp-verify'), { recursive: true, force: true });
  return {
    gameId: metadata.gameId,
    mode: metadata.mode,
    packageDirectory: directory,
    commands,
  };
}

export { EXPORT_MANIFEST };
