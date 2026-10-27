import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type GamesLock,
  type PlatformConfig,
  type PlatformGameConfig,
  readGameRuntimeConfig,
  readPlatformInstallation,
  resolveWorkspacePath,
  validateLocalReleaseReferences,
  validatePlatformInstallation,
} from './config.js';

const DEFAULT_GAME_RESOURCES = {
  cpus: '1.00',
  memory: '512M',
  pidsLimit: 256,
} as const;

export interface ComposeServicePlan {
  readonly name: string;
  readonly image: string;
  readonly gameId?: string;
  readonly releaseId?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly volumes?: readonly string[];
  readonly resources?: {
    readonly cpus: string;
    readonly memory: string;
    readonly pidsLimit: number;
  };
}

export interface ComposePlan {
  readonly schemaVersion: 1;
  readonly platformId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly deploymentKind: 'managed';
  readonly targetService: string;
  readonly services: readonly ComposeServicePlan[];
  readonly command: readonly string[];
  readonly composeYaml: string;
}

export interface ComposePlanOptions {
  readonly composeFile?: string;
}

export interface ComposePlanFileOptions extends ComposePlanOptions {
  readonly workspaceRoot: string;
  readonly configPath?: string;
  readonly lockPath?: string;
  readonly targetGameId: string;
}

function serviceSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'service'
  );
}

function serviceName(gameId: string, releaseId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([gameId, releaseId]))
    .digest('hex')
    .slice(0, 8);
  return `bgp-game-${serviceSlug(gameId)}-${serviceSlug(releaseId)}-${digest}`;
}

function composePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('..'))
    throw new Error('composeFile must be a workspace-relative path');
  return value;
}

function envReference(name: string): string {
  return `\${${name}:?set ${name}}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderEnvironment(
  environment: Readonly<Record<string, string>>,
  indent: string,
): string[] {
  const entries = Object.entries(environment);
  if (entries.length === 0) return [];
  return [
    `${indent}environment:`,
    ...entries.map(([key, value]) => `${indent}  ${key}: ${yamlString(value)}`),
  ];
}

function renderVolumes(
  volumes: readonly string[] | undefined,
  indent: string,
): string[] {
  if (!volumes || volumes.length === 0) return [];
  return [
    `${indent}volumes:`,
    ...volumes.map((volume) => `${indent}  - ${yamlString(volume)}`),
  ];
}

function renderResources(
  resources: ComposeServicePlan['resources'],
  indent: string,
): string[] {
  if (!resources) return [];
  return [
    `${indent}deploy:`,
    `${indent}  resources:`,
    `${indent}    limits:`,
    `${indent}      cpus: ${yamlString(resources.cpus)}`,
    `${indent}      memory: ${yamlString(resources.memory)}`,
    `${indent}pids_limit: ${resources.pidsLimit}`,
  ];
}

export function renderComposeYaml(
  services: readonly ComposeServicePlan[],
): string {
  const lines = ['services:'];
  for (const service of services) {
    lines.push(`  ${service.name}:`);
    lines.push(`    image: ${yamlString(service.image)}`);
    lines.push(...renderEnvironment(service.environment, '    '));
    lines.push(...renderVolumes(service.volumes, '    '));
    lines.push(...renderResources(service.resources, '    '));
  }
  return `${lines.join('\n')}\n`;
}

function addEnvironmentReference(
  environment: Record<string, string>,
  name: string,
): void {
  const value = envReference(name);
  const existing = environment[name];
  if (existing && existing !== value)
    throw new Error(`Runtime environment reference conflicts with ${name}`);
  environment[name] = value;
}

function addRuntimeReference(
  environment: Record<string, string>,
  reference: string,
): void {
  if (!reference.startsWith('env:')) return;
  addEnvironmentReference(environment, reference.slice('env:'.length));
}

function runtimeSecretReferences(
  runtime: PlatformGameConfig['runtime'],
): readonly string[] {
  const references = runtimeCredentialReferences(runtime);
  return [...new Set(references)].filter((reference) =>
    reference.startsWith('secrets/'),
  );
}

function bindPath(path: string): string {
  return path.startsWith('.') || isAbsolute(path) ? path : `./${path}`;
}

function runtimeCredentialReferences(
  runtime: PlatformGameConfig['runtime'],
): readonly string[] {
  return [
    runtime.platformConnection.verificationKeysRef,
    runtime.platformConnection.serviceCredentialRef,
    runtime.platformConnection.factCredentialRef,
    runtime.platformConnection.authorizationCredentialRef,
  ].filter((reference): reference is string => typeof reference === 'string');
}

function secretMounts(
  runtime: PlatformGameConfig['runtime'],
  runtimeConfigPath: string,
): readonly string[] {
  const runtimeDirectory = dirname(runtimeConfigPath);
  return runtimeSecretReferences(runtime).map((reference) => {
    const hostPath = join(runtimeDirectory, reference);
    return `${bindPath(hostPath)}:/app/${reference}:ro`;
  });
}

function gameService(
  gameId: string,
  game: PlatformGameConfig,
  runtimeConfigPath = game.deployment.kind === 'managed'
    ? game.deployment.runtimeConfig
    : '',
): ComposeServicePlan | undefined {
  if (game.deployment.kind !== 'managed') return undefined;
  const runtime = game.runtime;
  const environment: Record<string, string> = {
    GAME_ID: gameId,
    RELEASE_ID: game.release,
    PLATFORM_ID: runtime.platformConnection.platformId,
    GAME_RUNTIME_CONFIG: '/app/game.runtime.json',
  };
  if (runtime.storage.urlEnv)
    addEnvironmentReference(environment, runtime.storage.urlEnv);
  addEnvironmentReference(environment, runtime.platformConnection.apiUrlEnv);
  if (runtime.platformConnection.serviceTokenExpiresAtEnv)
    addEnvironmentReference(
      environment,
      runtime.platformConnection.serviceTokenExpiresAtEnv,
    );
  for (const reference of runtimeCredentialReferences(runtime))
    addRuntimeReference(environment, reference);

  const service: ComposeServicePlan = {
    name: serviceName(gameId, game.release),
    image: game.deployment.image,
    gameId,
    releaseId: game.release,
    environment,
    volumes: [
      `${bindPath(runtimeConfigPath)}:/app/game.runtime.json:ro`,
      ...secretMounts(runtime, runtimeConfigPath),
    ],
    resources: DEFAULT_GAME_RESOURCES,
  };
  return service;
}

export function createComposePlan(
  config: PlatformConfig,
  lock: GamesLock,
  targetGameId: string,
  options: ComposePlanOptions = {},
): ComposePlan {
  validatePlatformInstallation(config, lock);
  const target = config.games[targetGameId];
  if (!target) throw new Error(`Unknown game: ${targetGameId}`);
  if (!target.enabled) throw new Error(`Game is disabled: ${targetGameId}`);
  if (target.deployment.kind !== 'managed')
    throw new Error(
      `External game deployments cannot be started by Compose: ${targetGameId}`,
    );
  const locked = lock.games[targetGameId];
  if (target.release !== locked.release)
    throw new Error(`Target release is not locked: ${targetGameId}`);

  const composeFile = composePath(
    options.composeFile ??
      `deployments/${serviceName(targetGameId, target.release)}.compose.yaml`,
  );
  const runtimeConfigPath = relative(
    dirname(composeFile),
    target.deployment.runtimeConfig,
  );
  const targetGameService = gameService(
    targetGameId,
    target,
    runtimeConfigPath || '.',
  );
  if (!targetGameService)
    throw new Error(`Managed game deployment is required: ${targetGameId}`);
  const services: ComposeServicePlan[] = [targetGameService];
  const targetService = targetGameService.name;
  const command = [
    'docker',
    'compose',
    '--project-name',
    `bgp-${serviceSlug(config.platform.id)}`,
    '-f',
    composeFile,
    'up',
    '--detach',
    '--no-deps',
    targetService,
  ] as const;
  return {
    schemaVersion: 1,
    platformId: config.platform.id,
    gameId: targetGameId,
    releaseId: target.release,
    deploymentKind: 'managed',
    targetService,
    services,
    command,
    composeYaml: renderComposeYaml(services),
  };
}

export function generateComposePlan(
  config: PlatformConfig,
  lock: GamesLock,
  targetGameId: string,
  options: ComposePlanOptions = {},
): ComposePlan {
  return createComposePlan(config, lock, targetGameId, options);
}

export async function createComposePlanFromFiles(
  options: ComposePlanFileOptions,
): Promise<ComposePlan> {
  const configPath = resolve(
    options.workspaceRoot,
    options.configPath ?? 'platform.config.json',
  );
  const lockPath = resolve(
    options.workspaceRoot,
    options.lockPath ?? 'games.lock.json',
  );
  const installation = await readPlatformInstallation(configPath, lockPath);
  await validateLocalReleaseReferences(installation, options.workspaceRoot);
  const target = installation.config.games[options.targetGameId];
  if (!target) throw new Error(`Unknown game: ${options.targetGameId}`);
  if (target.deployment.kind !== 'managed')
    throw new Error(
      `External game deployments cannot be started by Compose: ${options.targetGameId}`,
    );
  const runtimePath = resolveWorkspacePath(
    options.workspaceRoot,
    target.deployment.runtimeConfig,
  );
  const runtime = await readGameRuntimeConfig(runtimePath);
  if (canonicalJson(runtime) !== canonicalJson(target.runtime))
    throw new Error(
      `runtime config does not match platform config for ${options.targetGameId}`,
    );
  await validateRuntimeSecretFiles(runtime, runtimePath);
  return createComposePlan(
    installation.config,
    installation.lock,
    options.targetGameId,
    { composeFile: options.composeFile },
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function validateRuntimeSecretFiles(
  runtime: PlatformGameConfig['runtime'],
  runtimePath: string,
): Promise<void> {
  const runtimeRealPath = await realpath(runtimePath);
  const runtimeDirectory = dirname(runtimeRealPath);
  for (const reference of runtimeSecretReferences(runtime)) {
    const candidate = resolve(runtimeDirectory, reference);
    const candidateRelative = relative(runtimeDirectory, candidate);
    if (
      isAbsolute(candidateRelative) ||
      candidateRelative === '..' ||
      candidateRelative.startsWith(`..${sep}`)
    )
      throw new Error(
        `Secret reference escapes runtime config directory: ${reference}`,
      );
    const secretPath = await realpath(candidate);
    const secretRelative = relative(runtimeDirectory, secretPath);
    if (
      isAbsolute(secretRelative) ||
      secretRelative === '..' ||
      secretRelative.startsWith(`..${sep}`)
    )
      throw new Error(
        `Secret reference escapes runtime config directory: ${reference}`,
      );
    const info = await stat(secretPath);
    if (!info.isFile())
      throw new Error(`Secret reference is not a file: ${reference}`);
  }
}

export async function writeComposePlan(
  plan: ComposePlan,
  outputPath: string,
): Promise<string> {
  const absolute = resolve(outputPath);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, plan.composeYaml, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(absolute, 'utf8')) !== plan.composeYaml)
      throw new Error(
        `Refusing to overwrite a different Compose plan: ${absolute}`,
      );
  }
  return relative(process.cwd(), absolute) || '.';
}
