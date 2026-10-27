import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const GAME_MANIFEST_SCHEMA_VERSION = 1 as const;
export const GAME_MANIFEST_FILENAME = 'game.json';

export type GameManifestStatus = 'ready' | 'scaffold';

export interface GameManifestEntry {
  readonly package: string;
  readonly export: string;
}

export interface GameManifest {
  readonly schemaVersion: typeof GAME_MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly client: GameManifestEntry;
  readonly server: GameManifestEntry;
  readonly status: GameManifestStatus;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface GameManifestTarget {
  readonly manifestPath: string;
  readonly gameDirectory: string;
  readonly manifest: GameManifest;
  readonly clientPackage: WorkspacePackage;
  readonly serverPackage: WorkspacePackage;
}

export interface GameWorkspaceResolution {
  readonly workspaceRoot: string;
  readonly gameDirectory: string;
  readonly manifestPath: string;
}

const GAME_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WORKSPACE_GROUPS = ['common', 'platform', 'apps', 'tests'] as const;
const PACKAGE_SCAN_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unsupported field ${unknown[0]}`);
  for (const key of expected) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertExport(value: unknown, label: string): string {
  const exportName = text(value, label);
  if (
    (exportName !== '.' && !exportName.startsWith('./')) ||
    exportName === './' ||
    exportName
      .split('/')
      .some((part, index) =>
        index === 0
          ? part !== '.'
          : part.length === 0 || part === '.' || part === '..',
      )
  )
    throw new Error(`${label} must be a package export path`);
  return exportName;
}

function parseManifest(value: unknown): GameManifest {
  const candidate = record(value, 'game manifest');
  exactKeys(
    candidate,
    ['schemaVersion', 'id', 'title', 'client', 'server', 'status'],
    'game manifest',
  );
  if (candidate.schemaVersion !== GAME_MANIFEST_SCHEMA_VERSION)
    throw new Error(
      `game manifest.schemaVersion must be ${GAME_MANIFEST_SCHEMA_VERSION}`,
    );
  const id = text(candidate.id, 'game manifest.id');
  if (!GAME_ID_PATTERN.test(id))
    throw new Error(`game manifest.id is invalid: ${id}`);
  const title = text(candidate.title, 'game manifest.title');
  if (candidate.status !== 'ready' && candidate.status !== 'scaffold')
    throw new Error('game manifest.status must be ready or scaffold');

  const client = parseEntry(candidate.client, 'game manifest.client');
  const server = parseEntry(candidate.server, 'game manifest.server');
  return {
    schemaVersion: GAME_MANIFEST_SCHEMA_VERSION,
    id,
    title,
    client,
    server,
    status: candidate.status,
  };
}

function parseEntry(value: unknown, label: string): GameManifestEntry {
  const candidate = record(value, label);
  exactKeys(candidate, ['package', 'export'], label);
  return {
    package: text(candidate.package, `${label}.package`),
    export: assertExport(candidate.export, `${label}.export`),
  };
}

export function isValidGameId(value: string): boolean {
  return GAME_ID_PATTERN.test(value);
}

export function assertGameManifest(
  value: unknown,
): asserts value is GameManifest {
  parseManifest(value);
}

export async function readGameManifest(path: string): Promise<GameManifest> {
  const source = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid game manifest JSON at ${path}: ${
        error instanceof Error ? error.message : 'parse failed'
      }`,
    );
  }
  try {
    return parseManifest(parsed);
  } catch (error) {
    throw new Error(
      `Invalid game manifest at ${path}: ${
        error instanceof Error ? error.message : 'invalid manifest'
      }`,
    );
  }
}

function isWithin(child: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
  );
}

async function readPackage(
  directory: string,
): Promise<WorkspacePackage | null> {
  const packagePath = join(directory, 'package.json');
  try {
    const source = await readFile(packagePath, 'utf8');
    const manifest = record(JSON.parse(source), `${packagePath}`);
    const name = manifest.name;
    if (typeof name !== 'string' || name.length === 0) return null;
    return { name, directory: resolve(directory), manifest };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError)
      throw new Error(`Invalid package JSON at ${packagePath}`);
    throw error;
  }
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function packageDirectories(directory: string): Promise<string[]> {
  const packages: string[] = [];
  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (PACKAGE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(join(current, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name === PACKAGE_MANIFEST)
        packages.push(current);
    }
  }
  await visit(resolve(directory));
  return packages;
}

const PACKAGE_MANIFEST = 'package.json';

async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isLegacyGameDirectory(
  directory: string,
  workspaceRoot: string,
): boolean {
  return dirname(directory) === join(resolve(workspaceRoot), 'games');
}

/** Resolve a game root from the current directory or an explicit workspace. */
export async function resolveGameWorkspace(
  gameArgument?: string,
  workspaceRoot = process.cwd(),
): Promise<GameWorkspaceResolution> {
  const requestedRoot = resolve(workspaceRoot);
  const argument = gameArgument?.trim();
  let gameDirectory: string;

  if (!argument || argument === '.') {
    gameDirectory = requestedRoot;
  } else if (
    !argument.includes('/') &&
    !argument.includes('\\') &&
    !argument.startsWith('.')
  ) {
    const shorthand = join(requestedRoot, 'games', argument);
    gameDirectory = (await hasFile(join(shorthand, GAME_MANIFEST_FILENAME)))
      ? shorthand
      : resolve(requestedRoot, argument);
  } else {
    gameDirectory = resolve(requestedRoot, argument);
  }

  if (gameDirectory.endsWith(`${sep}${GAME_MANIFEST_FILENAME}`))
    gameDirectory = dirname(gameDirectory);
  const manifestPath = join(gameDirectory, GAME_MANIFEST_FILENAME);
  if (!(await hasFile(manifestPath)))
    throw new Error(`Game manifest not found: ${manifestPath}`);

  const gameRoot = resolve(gameDirectory);
  const workspace =
    gameRoot === requestedRoot || isWithin(gameRoot, requestedRoot)
      ? requestedRoot
      : gameRoot;
  return {
    workspaceRoot: workspace,
    gameDirectory: gameRoot,
    manifestPath,
  };
}

/** Reads package manifests from a repository workspace or independent game root. */
export async function discoverWorkspacePackages(
  workspaceRoot: string,
): Promise<readonly WorkspacePackage[]> {
  const root = resolve(workspaceRoot);
  const directories: string[] = [];
  if (await hasFile(join(root, GAME_MANIFEST_FILENAME)))
    directories.push(...(await packageDirectories(root)));
  for (const group of WORKSPACE_GROUPS)
    directories.push(...(await childDirectories(join(root, group))));
  for (const game of await childDirectories(join(root, 'games')))
    directories.push(...(await packageDirectories(game)));

  return readPackages([...new Set(directories)]);
}

/** Read all package manifests belonging to one independently maintained game. */
export async function discoverGamePackages(
  gameDirectory: string,
): Promise<readonly WorkspacePackage[]> {
  return readPackages(await packageDirectories(gameDirectory));
}

async function readPackages(
  directories: readonly string[],
): Promise<readonly WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  const names = new Set<string>();
  for (const directory of directories) {
    const workspacePackage = await readPackage(directory);
    if (!workspacePackage) continue;
    if (names.has(workspacePackage.name))
      throw new Error(
        `Duplicate workspace package name: ${workspacePackage.name}`,
      );
    names.add(workspacePackage.name);
    packages.push(workspacePackage);
  }
  return packages;
}

function installedPackageDirectory(root: string, packageName: string): string {
  const parts = packageName.split('/');
  return join(root, 'node_modules', ...parts);
}

async function discoverInstalledGamePackages(
  root: string,
  manifest: GameManifest,
): Promise<readonly WorkspacePackage[]> {
  const packages: WorkspacePackage[] = [];
  for (const packageName of [
    manifest.client.package,
    manifest.server.package,
  ]) {
    const packageValue = await readPackage(
      installedPackageDirectory(root, packageName),
    );
    if (packageValue) packages.push(packageValue);
  }
  return packages;
}

async function manifestDirectories(workspaceRoot: string): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const gamesRoot = join(root, 'games');
  const directories = await childDirectories(gamesRoot);
  const paths: string[] = [];
  for (const directory of directories) {
    const manifestPath = join(directory, GAME_MANIFEST_FILENAME);
    try {
      const manifestStat = await stat(manifestPath);
      if (!manifestStat.isFile())
        throw new Error(`Game manifest is not a regular file: ${manifestPath}`);
      paths.push(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `Game directory is missing ${GAME_MANIFEST_FILENAME}: ${directory}`,
        );
      throw error;
    }
  }
  return paths.sort();
}

export async function discoverGameManifests(
  workspaceRoot: string,
): Promise<readonly GameManifestTarget[]> {
  const root = resolve(workspaceRoot);
  if (await hasFile(join(root, GAME_MANIFEST_FILENAME))) {
    const manifest = await readGameManifest(join(root, GAME_MANIFEST_FILENAME));
    const discoveredPackages = await discoverGamePackages(root);
    const byName = new Map(discoveredPackages.map((item) => [item.name, item]));
    for (const item of await discoverInstalledGamePackages(root, manifest))
      if (!byName.has(item.name)) byName.set(item.name, item);
    return resolveGameTargets(
      [join(root, GAME_MANIFEST_FILENAME)],
      [...byName.values()],
      new Set([root]),
    );
  }
  return resolveGameTargets(
    await manifestDirectories(root),
    await discoverWorkspacePackages(root),
  );
}

async function resolveGameTargets(
  manifestPaths: readonly string[],
  packageList: readonly WorkspacePackage[],
  allowPackageAtGameRoots: ReadonlySet<string> = new Set(),
): Promise<readonly GameManifestTarget[]> {
  const packageByName = new Map(packageList.map((item) => [item.name, item]));
  const targets: GameManifestTarget[] = [];
  const ids = new Set<string>();
  for (const manifestPath of manifestPaths) {
    const gameDirectory = resolve(dirname(manifestPath));
    try {
      const rootPackage = await stat(join(gameDirectory, 'package.json'));
      if (rootPackage.isFile() && !allowPackageAtGameRoots.has(gameDirectory))
        throw new Error(
          `Game root must not contain package.json: ${gameDirectory}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const manifest = await readGameManifest(manifestPath);
    const directoryId = basename(gameDirectory);
    if (ids.has(manifest.id))
      throw new Error(`Duplicate game manifest id: ${manifest.id}`);
    if (
      !allowPackageAtGameRoots.has(gameDirectory) &&
      manifest.id !== directoryId
    )
      throw new Error(
        `Game manifest id ${manifest.id} does not match directory ${directoryId}`,
      );
    ids.add(manifest.id);
    const clientPackage = resolveEntryPackage(
      manifest,
      'client',
      gameDirectory,
      packageByName,
    );
    const serverPackage = resolveEntryPackage(
      manifest,
      'server',
      gameDirectory,
      packageByName,
    );
    targets.push({
      manifestPath,
      gameDirectory,
      manifest,
      clientPackage,
      serverPackage,
    });
  }
  return targets;
}

function resolveEntryPackage(
  manifest: GameManifest,
  role: 'client' | 'server',
  gameDirectory: string,
  packageByName: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage {
  const entry = manifest[role];
  const workspacePackage = packageByName.get(entry.package);
  if (!workspacePackage)
    throw new Error(
      `Game ${manifest.id} ${role} package is not in the workspace: ${entry.package}`,
    );
  if (!isWithin(workspacePackage.directory, gameDirectory))
    throw new Error(
      `Game ${manifest.id} ${role} package is outside its game path: ${entry.package}`,
    );
  const expectedPackage = `@board-games/${manifest.id}-${role}`;
  if (workspacePackage.name !== expectedPackage)
    throw new Error(
      `Game ${manifest.id} ${role} package must be ${expectedPackage}`,
    );
  try {
    resolvePackageExportTarget(workspacePackage, entry.export);
  } catch (error) {
    throw new Error(
      `Game ${manifest.id} ${role} package is missing export ${entry.export} or has an invalid target: ${
        error instanceof Error ? error.message : 'unresolvable target'
      }`,
    );
  }
  return workspacePackage;
}

/** Resolve one declared package export without importing its implementation. */
export function resolvePackageExportTarget(
  workspacePackage: WorkspacePackage,
  exportName: string,
): string {
  const normalizedExportName = assertExport(exportName, 'package export');
  const exportsValue = workspacePackage.manifest.exports;
  const exportValue = selectPackageExport(exportsValue, normalizedExportName);
  const target = resolveConditionalExportTarget(exportValue);
  if (!target)
    throw new Error(
      `package does not expose a resolvable export ${normalizedExportName}`,
    );
  if (
    !target.startsWith('./') ||
    target.length <= 2 ||
    target.includes('\\') ||
    target
      .split('/')
      .some((part, index) =>
        index === 0
          ? part !== '.'
          : part.length === 0 || part === '.' || part === '..',
      )
  )
    throw new Error(`export target must stay inside the package: ${target}`);
  const targetPath = resolve(workspacePackage.directory, target.slice(2));
  if (!isWithin(targetPath, workspacePackage.directory))
    throw new Error(`export target is outside the package: ${target}`);
  return targetPath;
}

function selectPackageExport(
  exportsValue: unknown,
  exportName: string,
): unknown {
  if (typeof exportsValue === 'string')
    return exportName === '.' ? exportsValue : undefined;
  if (
    !exportsValue ||
    typeof exportsValue !== 'object' ||
    Array.isArray(exportsValue)
  )
    return undefined;
  const exportsObject = exportsValue as Record<string, unknown>;
  if (Object.hasOwn(exportsObject, exportName))
    return exportsObject[exportName];
  if (
    exportName === '.' &&
    !Object.keys(exportsObject).some((key) => key.startsWith('.'))
  )
    return exportsObject;
  return undefined;
}

function resolveConditionalExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const conditions = value as Record<string, unknown>;
  for (const condition of ['import', 'node', 'default', 'require']) {
    if (!Object.hasOwn(conditions, condition)) continue;
    const target = resolveConditionalExportTarget(conditions[condition]);
    if (target) return target;
  }
  return undefined;
}

export async function verifyGameManifest(
  gameDirectory: string,
  workspaceRoot: string,
): Promise<GameManifestTarget> {
  const root = resolve(workspaceRoot);
  const directory = resolve(gameDirectory);
  if (directory === join(root, 'games'))
    throw new Error(
      `Game directory must be a direct child of ${join(root, 'games')}`,
    );
  if (
    directory !== root &&
    !isWithin(directory, root) &&
    !isLegacyGameDirectory(directory, root)
  )
    throw new Error(`Game directory must be inside workspace ${root}`);
  // A single-game check must not parse another game's unfinished manifest or
  // internal packages. Global discovery remains the whole-workspace gate.
  const manifestPath = join(directory, GAME_MANIFEST_FILENAME);
  const manifest = await readGameManifest(manifestPath);
  const discoveredPackages =
    directory === root || !isLegacyGameDirectory(directory, root)
      ? await discoverGamePackages(directory)
      : await readPackages(await packageDirectories(directory));
  let packages = discoveredPackages;
  if (directory === root) {
    const byName = new Map(packages.map((item) => [item.name, item]));
    for (const item of await discoverInstalledGamePackages(root, manifest))
      if (!byName.has(item.name)) byName.set(item.name, item);
    packages = [...byName.values()];
  }
  const [target] = await resolveGameTargets(
    [manifestPath],
    packages,
    new Set(
      directory === root || !isLegacyGameDirectory(directory, root)
        ? [directory]
        : [],
    ),
  );
  if (!target) throw new Error(`Game manifest not found: ${manifestPath}`);
  return target;
}
