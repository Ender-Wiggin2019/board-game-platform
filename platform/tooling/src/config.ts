import { access, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  assertGameRuntimeConfiguration,
  type GameRuntimeConfiguration,
} from '@board-game/contracts';
import { readReleaseManifest } from '@board-game/tooling/release';

export const PLATFORM_CONFIG_SCHEMA_VERSION = 1 as const;
export const GAMES_LOCK_SCHEMA_VERSION = 1 as const;
export const GAME_RUNTIME_CONFIG_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_PLATFORM_FEATURES = ['chat', 'rankings'] as const;
export type SupportedPlatformFeature =
  (typeof SUPPORTED_PLATFORM_FEATURES)[number];
export type PlatformFeatures = Readonly<
  Record<SupportedPlatformFeature, boolean>
>;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/u;
const IMAGE_PATTERN = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/u;
const SHA_PATTERN = /^(?:sha1:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/u;
const SECRET_REF_PATTERN =
  /^(?:env:[A-Za-z][A-Za-z0-9_]*|secrets\/[A-Za-z0-9._/-]+)$/u;

export type RuntimeEnvironment = 'development' | 'production';
export type StorageDriver = 'memory' | 'postgres';

/** Compatibility name for the canonical common/contracts runtime model. */
export type GameRuntimeConfig = GameRuntimeConfiguration;

export interface ManagedDeployment {
  readonly kind: 'managed';
  readonly adapter: 'compose';
  readonly image: string;
  readonly runtimeConfig: string;
}

export interface ExternalDeployment {
  readonly kind: 'external';
  readonly controlEndpoint: string;
  readonly playerEndpoint: string;
  readonly authorizationEndpoint?: string;
  readonly serviceCredentialRef: string;
}

export interface PlatformGameConfig {
  readonly enabled: boolean;
  readonly release: string;
  readonly manifestRef: string;
  readonly runtime: GameRuntimeConfig;
  readonly deployment: ManagedDeployment | ExternalDeployment;
  readonly approvedCapabilities: readonly string[];
}

/** The operator chooses a verified image or a self-contained Node archive. */
export type DeploymentArtifact =
  | { readonly image: string; readonly archive?: never }
  | {
      readonly image?: never;
      readonly archive: {
        readonly format: 'node-tar';
        readonly digest: string;
        readonly sourceSha: string;
      };
    };

export interface PlatformConfig {
  readonly schemaVersion: typeof PLATFORM_CONFIG_SCHEMA_VERSION;
  readonly platform: DeploymentArtifact & {
    readonly id: string;
    readonly databaseUrlEnv: string;
    readonly brand?: { readonly name: string };
    readonly features: PlatformFeatures;
  };
  readonly games: Readonly<Record<string, PlatformGameConfig>>;
}

export type LockedGame = DeploymentArtifact & {
  readonly release: string;
  readonly manifestRef: string;
  readonly sourceSha: string;
  readonly artifacts: {
    readonly client: string;
    readonly server: string;
    readonly publicAssets: string;
  };
};

export interface GamesLock {
  readonly schemaVersion: typeof GAMES_LOCK_SCHEMA_VERSION;
  readonly platform: DeploymentArtifact & {
    readonly id: string;
  };
  readonly games: Readonly<Record<string, LockedGame>>;
}

export interface PlatformInstallation {
  readonly config: PlatformConfig;
  readonly lock: GamesLock;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function idValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!ID_PATTERN.test(result)) throw new Error(`${label} is not a valid id`);
  return result;
}

function envValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!ENV_PATTERN.test(result))
    throw new Error(`${label} must name an environment variable`);
  return result;
}

function imageValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!IMAGE_PATTERN.test(result))
    throw new Error(`${label} must include an exact sha256 image digest`);
  return result;
}

function shaValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!SHA_PATTERN.test(result))
    throw new Error(`${label} must be an exact SHA digest`);
  return result;
}

function deploymentArtifact(
  value: Record<string, unknown>,
  label: string,
): DeploymentArtifact {
  const hasImage = Object.hasOwn(value, 'image');
  const hasArchive = Object.hasOwn(value, 'archive');
  if (hasImage === hasArchive)
    throw new Error(`${label} requires exactly one image or archive`);
  if (hasImage) return { image: imageValue(value.image, `${label}.image`) };
  const archive = object(value.archive, `${label}.archive`);
  keys(archive, `${label}.archive`, ['format', 'digest', 'sourceSha']);
  if (archive.format !== 'node-tar')
    throw new Error(`${label}.archive.format must be node-tar`);
  const digest = shaValue(archive.digest, `${label}.archive.digest`);
  if (!digest.startsWith('sha256:'))
    throw new Error(`${label}.archive.digest must be sha256`);
  return {
    archive: {
      format: 'node-tar',
      digest,
      sourceSha: shaValue(archive.sourceSha, `${label}.archive.sourceSha`),
    },
  };
}

function relativePathValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (
    isAbsolute(result) ||
    result.includes('://') ||
    result.split(/[\\/]/u).some((part) => part === '..')
  )
    throw new Error(`${label} must be a relative workspace path`);
  return result;
}

function httpsEndpoint(value: unknown, label: string): string {
  const result = stringValue(value, label);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error(`${label} must be an HTTPS endpoint`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${label} must be an HTTPS endpoint without credentials or query secrets`,
    );
  return result;
}

function secretRef(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (!SECRET_REF_PATTERN.test(result))
    throw new Error(`${label} must be an env: or secrets/ reference`);
  if (
    result.startsWith('secrets/') &&
    result
      .slice('secrets/'.length)
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`${label} must not escape its secrets directory`);
  return result;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((entry, index) =>
    idValue(entry, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length)
    throw new Error(`${label} must not contain duplicates`);
  return result;
}

function platformFeatures(value: unknown, label: string): PlatformFeatures {
  const candidate = object(value, label);
  const supported = new Set<string>(SUPPORTED_PLATFORM_FEATURES);
  for (const [key, entry] of Object.entries(candidate)) {
    if (!supported.has(key))
      throw new Error(`${label}.${key} is not supported`);
    if (typeof entry !== 'boolean')
      throw new Error(`${label}.${key} must be a boolean`);
  }
  return {
    chat: candidate.chat === undefined ? true : (candidate.chat as boolean),
    rankings:
      candidate.rankings === undefined ? true : (candidate.rankings as boolean),
  };
}

function platformBrand(
  value: unknown,
  label: string,
): { readonly name: string } | undefined {
  if (value === undefined) return undefined;
  const candidate = object(value, label);
  keys(candidate, label, ['name']);
  const name = stringValue(candidate.name, `${label}.name`);
  if (name.length > 128) throw new Error(`${label}.name is too long`);
  return { name };
}

export function parseGameRuntimeConfig(
  value: unknown,
  label = 'runtime',
): GameRuntimeConfig {
  try {
    assertGameRuntimeConfiguration(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid value';
    throw new Error(`${label} is invalid: ${message}`, { cause: error });
  }
  const candidate = value;
  const transport = candidate.transport ?? {};
  return {
    ...candidate,
    storage: {
      ...candidate.storage,
      maxConnections: candidate.storage.maxConnections ?? 10,
    },
    platformConnection: {
      ...candidate.platformConnection,
      factCredentialRef:
        candidate.platformConnection.factCredentialRef ??
        candidate.platformConnection.serviceCredentialRef,
      authorizationCredentialRef:
        candidate.platformConnection.authorizationCredentialRef ??
        candidate.platformConnection.serviceCredentialRef,
    },
    transport: {
      host:
        transport.host ??
        (candidate.environment === 'development' ? '127.0.0.1' : '0.0.0.0'),
      controlPort: transport.controlPort ?? 3000,
      playerPort: transport.playerPort ?? 3001,
      authorizationPort: transport.authorizationPort ?? 3002,
      allowedOrigins: [...(transport.allowedOrigins ?? [])],
    },
  };
}

function parseDeployment(
  value: unknown,
  label: string,
): ManagedDeployment | ExternalDeployment {
  const candidate = object(value, label);
  if (candidate.kind === 'managed') {
    keys(candidate, label, ['kind', 'adapter', 'image', 'runtimeConfig']);
    if (candidate.adapter !== 'compose')
      throw new Error(`${label}.adapter must be compose`);
    return {
      kind: 'managed',
      adapter: 'compose',
      image: imageValue(candidate.image, `${label}.image`),
      runtimeConfig: relativePathValue(
        candidate.runtimeConfig,
        `${label}.runtimeConfig`,
      ),
    };
  }
  if (candidate.kind === 'external') {
    keys(
      candidate,
      label,
      ['kind', 'controlEndpoint', 'playerEndpoint', 'serviceCredentialRef'],
      ['authorizationEndpoint'],
    );
    return {
      kind: 'external',
      controlEndpoint: httpsEndpoint(
        candidate.controlEndpoint,
        `${label}.controlEndpoint`,
      ),
      playerEndpoint: httpsEndpoint(
        candidate.playerEndpoint,
        `${label}.playerEndpoint`,
      ),
      ...(candidate.authorizationEndpoint === undefined
        ? {}
        : {
            authorizationEndpoint: httpsEndpoint(
              candidate.authorizationEndpoint,
              `${label}.authorizationEndpoint`,
            ),
          }),
      serviceCredentialRef: secretRef(
        candidate.serviceCredentialRef,
        `${label}.serviceCredentialRef`,
      ),
    };
  }
  throw new Error(`${label}.kind must be managed or external`);
}

function parseGameConfig(
  value: unknown,
  label: string,
  gameId: string,
): PlatformGameConfig {
  const candidate = object(value, label);
  keys(candidate, label, [
    'enabled',
    'release',
    'manifestRef',
    'runtime',
    'deployment',
    'approvedCapabilities',
  ]);
  if (typeof candidate.enabled !== 'boolean')
    throw new Error(`${label}.enabled must be a boolean`);
  const release = idValue(candidate.release, `${label}.release`);
  const manifestRef = relativePathValue(
    candidate.manifestRef,
    `${label}.manifestRef`,
  );
  const runtime = parseGameRuntimeConfig(candidate.runtime, `${label}.runtime`);
  if (runtime.gameId !== gameId)
    throw new Error(`${label}.runtime.gameId must match the game key`);
  if (runtime.releaseId !== release)
    throw new Error(`${label}.runtime.releaseId must match release`);
  const deployment = parseDeployment(
    candidate.deployment,
    `${label}.deployment`,
  );
  const approvedCapabilities = stringList(
    candidate.approvedCapabilities,
    `${label}.approvedCapabilities`,
  );
  if (runtime.platformConnection.platformId === '')
    throw new Error(
      `${label}.runtime.platformConnection.platformId is required`,
    );
  return {
    enabled: candidate.enabled,
    release,
    manifestRef,
    runtime,
    deployment,
    approvedCapabilities,
  };
}

export function parsePlatformConfig(value: unknown): PlatformConfig {
  const candidate = object(value, 'platform config');
  keys(candidate, 'platform config', ['schemaVersion', 'platform', 'games']);
  if (candidate.schemaVersion !== PLATFORM_CONFIG_SCHEMA_VERSION)
    throw new Error(
      `platform config.schemaVersion must be ${PLATFORM_CONFIG_SCHEMA_VERSION}`,
    );
  const platform = object(candidate.platform, 'platform config.platform');
  keys(
    platform,
    'platform config.platform',
    ['id', 'databaseUrlEnv', 'features'],
    ['brand', 'image', 'archive'],
  );
  const id = idValue(platform.id, 'platform config.platform.id');
  const artifact = deploymentArtifact(platform, 'platform config.platform');
  const databaseUrlEnv = envValue(
    platform.databaseUrlEnv,
    'platform config.platform.databaseUrlEnv',
  );
  const features = platformFeatures(
    platform.features,
    'platform config.platform.features',
  );
  const brand = platformBrand(platform.brand, 'platform config.platform.brand');
  const gameValues = object(candidate.games, 'platform config.games');
  const games: Record<string, PlatformGameConfig> = {};
  for (const [gameId, game] of Object.entries(gameValues)) {
    idValue(gameId, `platform config.games.${gameId}`);
    games[gameId] = parseGameConfig(
      game,
      `platform config.games.${gameId}`,
      gameId,
    );
    if (games[gameId].runtime.platformConnection.platformId !== id)
      throw new Error(
        `platform config.games.${gameId}.runtime.platformConnection.platformId must match platform.id`,
      );
  }
  return {
    schemaVersion: PLATFORM_CONFIG_SCHEMA_VERSION,
    platform: {
      id,
      ...artifact,
      databaseUrlEnv,
      features,
      ...(brand === undefined ? {} : { brand }),
    },
    games,
  };
}

function parseLockedGame(value: unknown, label: string): LockedGame {
  const candidate = object(value, label);
  keys(
    candidate,
    label,
    ['release', 'manifestRef', 'sourceSha', 'artifacts'],
    ['image', 'archive'],
  );
  const artifact = deploymentArtifact(candidate, label);
  const sourceSha = shaValue(candidate.sourceSha, `${label}.sourceSha`);
  if (artifact.archive && artifact.archive.sourceSha !== sourceSha)
    throw new Error(`${label}.archive.sourceSha must match sourceSha`);
  const artifacts = object(candidate.artifacts, `${label}.artifacts`);
  keys(artifacts, `${label}.artifacts`, ['client', 'server', 'publicAssets']);
  return {
    release: idValue(candidate.release, `${label}.release`),
    manifestRef: relativePathValue(
      candidate.manifestRef,
      `${label}.manifestRef`,
    ),
    ...artifact,
    sourceSha,
    artifacts: {
      client: shaValue(artifacts.client, `${label}.artifacts.client`),
      server: shaValue(artifacts.server, `${label}.artifacts.server`),
      publicAssets: shaValue(
        artifacts.publicAssets,
        `${label}.artifacts.publicAssets`,
      ),
    },
  };
}

export function parseGamesLock(value: unknown): GamesLock {
  const candidate = object(value, 'games lock');
  keys(candidate, 'games lock', ['schemaVersion', 'platform', 'games']);
  if (candidate.schemaVersion !== GAMES_LOCK_SCHEMA_VERSION)
    throw new Error(
      `games lock.schemaVersion must be ${GAMES_LOCK_SCHEMA_VERSION}`,
    );
  const platform = object(candidate.platform, 'games lock.platform');
  keys(platform, 'games lock.platform', ['id'], ['image', 'archive']);
  const gameValues = object(candidate.games, 'games lock.games');
  const games: Record<string, LockedGame> = {};
  for (const [gameId, game] of Object.entries(gameValues)) {
    idValue(gameId, `games lock.games.${gameId}`);
    games[gameId] = parseLockedGame(game, `games lock.games.${gameId}`);
  }
  return {
    schemaVersion: GAMES_LOCK_SCHEMA_VERSION,
    platform: {
      id: idValue(platform.id, 'games lock.platform.id'),
      ...deploymentArtifact(platform, 'games lock.platform'),
    },
    games,
  };
}

export function validatePlatformInstallation(
  config: PlatformConfig,
  lock: GamesLock,
): void {
  if (config.platform.id !== lock.platform.id)
    throw new Error(
      'games lock.platform.id must match platform config.platform.id',
    );
  if (config.platform.image !== lock.platform.image)
    throw new Error(
      'games lock.platform.image must match platform config.platform.image',
    );
  if (
    config.platform.archive?.digest !== lock.platform.archive?.digest ||
    config.platform.archive?.sourceSha !== lock.platform.archive?.sourceSha
  )
    throw new Error(
      'games lock.platform.archive must match platform config.platform.archive',
    );
  const configIds = Object.keys(config.games);
  const lockIds = Object.keys(lock.games);
  if (
    configIds.length !== lockIds.length ||
    configIds.some((id) => !Object.hasOwn(lock.games, id))
  )
    throw new Error('games lock.games must match platform config.games');
  for (const gameId of configIds) {
    const game = config.games[gameId];
    const locked = lock.games[gameId];
    if (game.release !== locked.release)
      throw new Error(
        `games lock.games.${gameId}.release must match platform config`,
      );
    if (game.manifestRef !== locked.manifestRef)
      throw new Error(
        `games lock.games.${gameId}.manifestRef must match platform config`,
      );
    if (
      game.deployment.kind === 'managed' &&
      game.deployment.image !== locked.image
    )
      throw new Error(
        `games lock.games.${gameId}.image must match platform config`,
      );
  }
}

/** Reads the two strict JSON installation files without resolving any secrets. */
export async function readPlatformInstallation(
  configPath: string,
  lockPath: string,
): Promise<PlatformInstallation> {
  const [configValue, lockValue] = await Promise.all([
    readJson(configPath),
    readJson(lockPath),
  ]);
  const config = parsePlatformConfig(configValue);
  const lock = parseGamesLock(lockValue);
  validatePlatformInstallation(config, lock);
  return { config, lock };
}

/**
 * If a referenced manifest is present locally, validate it with the canonical
 * common/contracts validator and compare the immutable identity to the lock.
 * Missing release files are left to the release fetch/install step.
 */
export async function validateLocalReleaseReferences(
  installation: PlatformInstallation,
  workspaceRoot: string,
): Promise<void> {
  for (const [gameId, game] of Object.entries(installation.config.games)) {
    const manifestPath = resolve(workspaceRoot, game.manifestRef);
    try {
      await access(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const manifest = await readReleaseManifest(manifestPath);
    const locked = installation.lock.games[gameId];
    if (
      manifest.gameId !== gameId ||
      manifest.releaseId !== game.release ||
      manifest.releaseId !== locked.release ||
      manifest.artifacts.client.digest !== locked.artifacts.client ||
      manifest.artifacts.server.digest !== locked.artifacts.server ||
      manifest.artifacts.publicAssets.digest !== locked.artifacts.publicAssets
    )
      throw new Error(
        `release manifest identity does not match lock for ${gameId}`,
      );
  }
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${path} must contain valid JSON`);
  }
}

export async function readGameRuntimeConfig(
  path: string,
): Promise<GameRuntimeConfig> {
  return parseGameRuntimeConfig(await readJson(path));
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  path: string,
): string {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`)
  )
    throw new Error('Path must remain within workspace');
  return resolved;
}
