#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClientArtifact } from '@board-game/tooling/client-build';
import { initializeGameProject } from '@board-game/tooling/game-init';
import { resolveGameWorkspace } from '@board-game/tooling/game-manifest';
import {
  exportGamePackage,
  type GamePackageMode,
  verifyGamePackage,
} from '@board-game/tooling/game-package';
import { verifyGame } from '@board-game/tooling/game-verify';
import { type InitProfile, initializeProject } from '@board-game/tooling/init';
import { runPerformanceVerification } from '@board-game/tooling/performance';
import {
  type ArtifactSources,
  packRelease,
  readReleaseManifest,
  verifyPackedRelease,
} from '@board-game/tooling/release';
import { createComposePlanFromFiles, writeComposePlan } from './compose.js';
import { resolveWorkspacePath } from './config.js';
import { startDevelopmentGame } from './dev.js';
import { startNativeDevelopmentClient } from './native-client.js';
import {
  createReleaseOperations,
  HttpPlatformOperationsClient,
  HttpReleaseArtifactPublisher,
  type RegisterStagedReleasePayload,
  type ReleaseOperationResult,
} from './release-operations.js';
import { verifyDevelopmentBrowser } from './verify-browser.js';

const usage = `bgp doctor [--workspace <directory>]
bgp verify contracts|privacy|recovery|hosts|all [--workspace <directory>]
bgp verify performance [--workspace <directory>]
bgp dev [<game-directory>] [--profile memory|postgres] [--database-url <url>] [--release <release-id>] [--seed <seed>] [--scene <id>] [--port <port>] [--once] [--workspace <directory>]
bgp init <new-directory> --profile native-module|legacy-service|integrated-game [--workspace <directory>]
bgp game init <new-directory> [--workspace <directory>]
bgp game build [<game-directory>] [--workspace <directory>]
bgp game client-build <game-directory> <output-directory> --release <release-id> [--game-id <game-id>] [--no-build] [--workspace <directory>]
bgp platform init [<directory>] [--empty] [--workspace <directory>]
bgp platform deployment plan <game-id> [--config <path>] [--lock <path>] [--compose-file <path>] [--output <path>] [--workspace <directory>]
bgp platform game deploy <game-id> [--platform-id <id>] [--dry-run] [--json] [--workspace <directory>]
bgp platform game register <payload.json> --platform-url <url> --platform-token-ref env:<NAME> [--platform-id <id>] [--dry-run] [--json] [--workspace <directory>]
bgp platform game ready|activate|drain <backend-binding-id> --platform-url <url> --platform-token-ref env:<NAME> [--platform-id <id>] [--dry-run] [--json] [--workspace <directory>]
bgp platform game switch|rollback <game-id> <mode-id> <target-backend-binding-id> --expected-revision <n> [--channel <name>] --platform-url <api-base-url> --platform-token-ref env:<NAME> [--platform-id <id>] [--dry-run] [--json] [--workspace <directory>]
bgp game verify [<game-directory>] [--check] [--workspace <directory>]
bgp game export <game-directory> <output-directory> --mode source|dist [--workspace <directory>]
bgp game verify-export <package-directory> [--offline] [--store-dir <directory>] [--package-overrides <json>] [--workspace <directory>]
bgp pack <manifest.json> <artifact-sources.json> <new-output-directory> [--workspace <directory>]
bgp release validate <packed-release-directory> [--workspace <directory>]
bgp release publish <packed-release-directory> --platform-id <id> --store-url <url> --token-ref env:<NAME> [--dry-run] [--json] [--workspace <directory>]

All paths are resolved from --workspace, or from process.cwd when omitted.
Dry-run commands never perform network, upload, registry, or Docker side effects.`;

const PLATFORM_TEMPLATE_FILES = [
  'platform.config.json',
  'games.lock.json',
  'compose.yaml',
  'compose.platform.yaml',
  'runtime/example-v1.json',
  '.env.example',
  'README.md',
] as const;

interface ParsedArguments {
  readonly workspaceRoot: string;
  readonly args: readonly string[];
}

function parseArguments(args: readonly string[]): ParsedArguments {
  let workspaceRoot = process.cwd();
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--workspace') {
      const value = args[index + 1];
      if (!value) throw new Error('The --workspace option requires a path');
      workspaceRoot = resolve(value);
      index += 1;
    } else if (argument?.startsWith('--workspace=')) {
      const value = argument.slice('--workspace='.length);
      if (!value) throw new Error('The --workspace option requires a path');
      workspaceRoot = resolve(value);
    } else {
      remaining.push(argument as string);
    }
  }
  return { workspaceRoot, args: remaining };
}

function pathFromWorkspace(workspaceRoot: string, path: string): string {
  return resolve(workspaceRoot, path);
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((complete, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      ...(env ? { env } : {}),
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? complete()
        : reject(new Error(`Command exited with status ${code}`)),
    );
  });
}

function print(value: unknown): void {
  process.stdout.write(
    `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`,
  );
}

function positionalArguments(
  args: readonly string[],
  flags: ReadonlySet<string>,
): readonly string[] {
  const positional: string[] = [];
  for (const argument of args) {
    if (flags.has(argument)) continue;
    if (argument.startsWith('-')) throw new Error(usage);
    positional.push(argument);
  }
  return positional;
}

async function runGameVerify(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  const metadataOnly = args.includes('--check');
  const positional = positionalArguments(args, new Set(['--check']));
  if (positional.length > 1) throw new Error(usage);
  const workspace = await resolveGameWorkspace(positional[0], workspaceRoot);
  const result = await verifyGame(workspace.gameDirectory, {
    workspaceRoot: workspace.workspaceRoot,
    metadataOnly,
  });
  print({
    verified: true,
    gameId: result.game.manifest.id,
    status: result.game.manifest.status,
    metadataOnly: result.metadataOnly,
    commands: result.commands.map(({ operation, args: commandArgs }) => ({
      operation,
      args: commandArgs,
    })),
  });
}

async function runGameBuild(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  const positional = positionalArguments(args, new Set());
  if (positional.length > 1) throw new Error(usage);
  const workspace = await resolveGameWorkspace(positional[0], workspaceRoot);
  const result = await verifyGame(workspace.gameDirectory, {
    workspaceRoot: workspace.workspaceRoot,
    operations: ['build'],
  });
  print({
    built: true,
    gameId: result.game.manifest.id,
    commands: result.commands.map(({ operation, args: commandArgs }) => ({
      operation,
      args: commandArgs,
    })),
  });
}

async function runGameClientBuild(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  let gameArgument: string | undefined;
  let outputArgument: string | undefined;
  let releaseId: string | undefined;
  let gameId: string | undefined;
  let buildClient = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--release') {
      if (releaseId || !args[index + 1]) throw new Error(usage);
      releaseId = args[++index] as string;
    } else if (argument === '--game-id') {
      if (gameId || !args[index + 1]) throw new Error(usage);
      gameId = args[++index] as string;
    } else if (argument === '--no-build') {
      if (!buildClient) throw new Error(usage);
      buildClient = false;
    } else if (argument.startsWith('-')) {
      throw new Error(usage);
    } else if (!gameArgument) {
      gameArgument = argument;
    } else if (!outputArgument) {
      outputArgument = argument;
    } else {
      throw new Error(usage);
    }
  }
  if (!gameArgument || !outputArgument || !releaseId) throw new Error(usage);
  const workspace = await resolveGameWorkspace(gameArgument, workspaceRoot);
  const result = await buildClientArtifact({
    gameDirectory: workspace.gameDirectory,
    workspaceRoot: workspace.workspaceRoot,
    outputDirectory: pathFromWorkspace(workspace.workspaceRoot, outputArgument),
    releaseId,
    ...(gameId ? { gameId } : {}),
    buildClient,
  });
  print({
    built: true,
    gameId: result.gameId,
    releaseId: result.releaseId,
    artifactRoot: result.artifactRoot,
    artifactRootUrlPath: result.artifactRootUrlPath,
    clientDigest: result.clientDigest,
    publicAssetsDigest: result.publicAssetsDigest,
    runtime: result.runtime,
    publicAssets: result.publicAssets,
    commands: result.commands.map(({ command, args: commandArgs, cwd }) => ({
      command,
      args: commandArgs,
      cwd,
    })),
  });
}

async function runGameInit(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  let directory: string | undefined;
  let profile: InitProfile | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile') {
      if (profile || !args[index + 1]) throw new Error(usage);
      profile = args[++index] as InitProfile;
    } else if (argument.startsWith('-')) {
      throw new Error(usage);
    } else if (directory) {
      throw new Error(usage);
    } else {
      directory = argument;
    }
  }
  if (!directory) throw new Error(usage);
  if (profile) {
    const result = await initializeProject(
      pathFromWorkspace(workspaceRoot, directory),
      profile,
    );
    print({ initialized: true, ...result });
    return;
  }
  const result = await initializeGameProject(
    pathFromWorkspace(workspaceRoot, directory),
  );
  const skillPath = resolve(
    result.directory,
    '.agents/skills/game-developer/SKILL.md',
  );
  await mkdir(dirname(skillPath), { recursive: true });
  await copyFile(gameDeveloperSkillFile(), skillPath);
  print({
    initialized: true,
    ...result,
    files: [...result.files, '.agents/skills/game-developer/SKILL.md'],
  });
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error('The --port option must be an integer');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
    throw new Error('The --port option must be between 0 and 65535');
  return port;
}

async function runDevelopment(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  let gameArgument: string | undefined;
  let port: number | undefined;
  let seed: string | undefined;
  let releaseId: string | undefined;
  let profile: 'memory' | 'postgres' = 'memory';
  let databaseUrl: string | undefined;
  let scene: string | undefined;
  let once = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--port') {
      if (port !== undefined || !args[index + 1]) throw new Error(usage);
      port = parsePort(args[++index] as string);
    } else if (argument === '--seed') {
      if (seed !== undefined || !args[index + 1]) throw new Error(usage);
      seed = args[++index] as string;
      if (!seed.trim()) throw new Error('The --seed option must not be empty');
    } else if (argument === '--release') {
      if (releaseId || !args[index + 1]) throw new Error(usage);
      releaseId = args[++index] as string;
      if (!releaseId.trim())
        throw new Error('The --release option must not be empty');
    } else if (argument === '--profile') {
      if (args[index + 1] !== 'memory' && args[index + 1] !== 'postgres')
        throw new Error('The --profile option must be memory or postgres');
      profile = args[++index] as 'memory' | 'postgres';
    } else if (argument === '--database-url') {
      if (databaseUrl || !args[index + 1]) throw new Error(usage);
      databaseUrl = args[++index] as string;
      if (!databaseUrl.trim())
        throw new Error('The --database-url option must not be empty');
    } else if (argument === '--scene') {
      if (scene || !args[index + 1]) throw new Error(usage);
      scene = args[++index] as string;
      if (!scene.trim())
        throw new Error('The --scene option must not be empty');
    } else if (argument === '--once') {
      if (once) throw new Error(usage);
      once = true;
    } else if (argument.startsWith('-')) {
      throw new Error(usage);
    } else if (gameArgument) {
      throw new Error(usage);
    } else {
      gameArgument = argument;
    }
  }
  const workspace = await resolveGameWorkspace(gameArgument, workspaceRoot);
  const started = await startDevelopmentGame({
    gameDirectory: workspace.gameDirectory,
    workspaceRoot: workspace.workspaceRoot,
    ...(port !== undefined ? { port } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(releaseId !== undefined ? { releaseId } : {}),
    profile,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(scene !== undefined ? { scene } : {}),
  });
  let nativeClient:
    | Awaited<ReturnType<typeof startNativeDevelopmentClient>>
    | undefined;
  try {
    if (started.nativeClientAvailable)
      nativeClient = await startNativeDevelopmentClient({
        gameClientEntry: started.clientEntry,
        gameDirectory: workspace.gameDirectory,
        hostURL: started.baseURL,
      });
  } catch (error) {
    await started.host.close();
    throw error;
  }
  print({
    started: true,
    mode: 'development',
    profile,
    ...(scene !== undefined ? { scene } : {}),
    ...(databaseUrl !== undefined ? { databaseUrlConfigured: true } : {}),
    baseURL: started.baseURL,
    gameId: started.description.gameId,
    releaseId: started.description.releaseId,
    clientModuleUrl: started.clientModuleUrl,
    ...(nativeClient ? { clientURL: nativeClient.baseURL } : {}),
    nativeClient: Boolean(nativeClient),
    accounts: started.host.accounts,
    description: started.description,
  });
  if (once) {
    await nativeClient?.close();
    await started.host.close();
    return;
  }
  await new Promise<void>((resolveShutdown, rejectShutdown) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void Promise.all([
        started.host.close(),
        nativeClient?.close() ?? Promise.resolve(),
      ])
        .then(() => resolveShutdown())
        .catch(rejectShutdown);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

async function runGameExport(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  if (args.length !== 4 || args[2] !== '--mode') throw new Error(usage);
  const workspace = await resolveGameWorkspace(args[0], workspaceRoot);
  const mode = args[3] as GamePackageMode;
  if (mode !== 'source' && mode !== 'dist') throw new Error(usage);
  const result = await exportGamePackage({
    gameDirectory: workspace.gameDirectory,
    workspaceRoot: workspace.workspaceRoot,
    outputDirectory: pathFromWorkspace(workspace.workspaceRoot, args[1]),
    mode,
  });
  print({
    exported: true,
    gameId: result.gameId,
    mode: result.mode,
    outputDirectory: result.outputDirectory,
    packages: result.packages,
    commands: result.commands.map(({ command, args: commandArgs, cwd }) => ({
      command,
      args: commandArgs,
      cwd,
    })),
  });
}

async function runGameVerifyExport(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  let offline = false;
  let storeDirectory: string | undefined;
  let packageOverridesFile: string | undefined;
  let packageOverridesInline: string | undefined;
  let packageArgument: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--offline') {
      if (offline) throw new Error(usage);
      offline = true;
    } else if (argument === '--store-dir') {
      if (storeDirectory || !args[index + 1]) throw new Error(usage);
      storeDirectory = pathFromWorkspace(
        workspaceRoot,
        args[++index] as string,
      );
    } else if (argument === '--package-overrides') {
      if (packageOverridesFile || packageOverridesInline || !args[index + 1])
        throw new Error(usage);
      const value = args[++index] as string;
      if (value.trimStart().startsWith('{')) packageOverridesInline = value;
      else packageOverridesFile = pathFromWorkspace(workspaceRoot, value);
    } else if (argument?.startsWith('-')) {
      throw new Error(usage);
    } else if (packageArgument) {
      throw new Error(usage);
    } else {
      packageArgument = argument;
    }
  }
  if (!packageArgument) throw new Error(usage);
  let packageOverrides: Readonly<Record<string, string>> | undefined;
  if (packageOverridesFile || packageOverridesInline) {
    const source = JSON.parse(
      packageOverridesInline ??
        (await readFile(packageOverridesFile as string, 'utf8')),
    ) as unknown;
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw new Error('Package overrides must be a JSON object');
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(source)) {
      if (typeof value !== 'string' || value.trim().length === 0)
        throw new Error(`Package override ${name} must be a non-empty path`);
      if (value.startsWith('file:')) {
        const path = value.slice('file:'.length);
        values[name] =
          `file:${resolve(packageOverridesFile ? dirname(packageOverridesFile) : workspaceRoot, path)}`;
      } else if (value.startsWith('/') || value.startsWith('.')) {
        values[name] =
          `file:${resolve(packageOverridesFile ? dirname(packageOverridesFile) : workspaceRoot, value)}`;
      } else {
        values[name] = value;
      }
    }
    packageOverrides = values;
  }
  const result = await verifyGamePackage({
    packageDirectory: pathFromWorkspace(workspaceRoot, packageArgument),
    offline,
    ...(storeDirectory ? { storeDirectory } : {}),
    ...(packageOverrides ? { packageOverrides } : {}),
  });
  const packageDirectory = result.packageDirectory;
  let browser: unknown = {
    browserVerified: false,
    skipped: 'client export does not expose a native entry',
  };
  let started: Awaited<ReturnType<typeof startDevelopmentGame>> | undefined;
  let nativeClient:
    | Awaited<ReturnType<typeof startNativeDevelopmentClient>>
    | undefined;
  try {
    started = await startDevelopmentGame({
      gameDirectory: packageDirectory,
      workspaceRoot: packageDirectory,
      profile: 'memory',
    });
    if (started.nativeClientAvailable) {
      nativeClient = await startNativeDevelopmentClient({
        gameClientEntry: started.clientEntry,
        gameDirectory: packageDirectory,
        hostURL: started.baseURL,
      });
      browser = await verifyDevelopmentBrowser({
        baseURL: nativeClient.baseURL,
        gameId: started.definition.manifest.gameId,
      });
    }
  } finally {
    await nativeClient?.close();
    await started?.host.close();
  }
  print({
    verified: true,
    gameId: result.gameId,
    mode: result.mode,
    packageDirectory: result.packageDirectory,
    browser,
    commands: result.commands.map(({ command, args: commandArgs, cwd }) => ({
      command,
      args: commandArgs,
      cwd,
    })),
  });
}

async function runDoctor(workspaceRoot: string): Promise<void> {
  let packageManager: string | undefined;
  try {
    const project = JSON.parse(
      await readFile(resolve(workspaceRoot, 'package.json'), 'utf8'),
    ) as { packageManager?: string };
    packageManager = project.packageManager;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  print({
    node: process.versions.node,
    packageManager,
    protocolMajor: 1,
    workspace: `${resolve(workspaceRoot)}${resolve(workspaceRoot).endsWith('/') ? '' : '/'}`,
  });
  await run('corepack', ['pnpm', '--version'], resolve(workspaceRoot));
}

async function runPlatformVerify(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  if (args[0] === 'performance' && args.length === 1) {
    const report = await runPerformanceVerification();
    print(report);
    if (!report.passed) throw new Error('Performance budget exceeded');
    return;
  }
  if (
    args.length !== 1 ||
    !['contracts', 'privacy', 'recovery', 'hosts', 'all'].includes(
      args[0] as string,
    )
  )
    throw new Error(usage);
  const verification = args[0];
  if (verification === 'all' || verification === 'hosts') {
    await run('corepack', ['pnpm', 'verify:platform:postgres'], workspaceRoot);
    return;
  }
  await run(
    'corepack',
    ['pnpm', '--filter', '@board-platform/*', '-r', 'build'],
    workspaceRoot,
  );
  if (verification === 'contracts') {
    await run(
      'corepack',
      ['pnpm', '--filter', '@board-game/contracts', 'test'],
      workspaceRoot,
    );
    await run(
      'corepack',
      ['pnpm', '--filter', '@board-game/testing', 'test'],
      workspaceRoot,
    );
    return;
  }
  await run(
    'corepack',
    [
      'pnpm',
      '--filter',
      '@board-game/host',
      '--filter',
      '@board-game/storage',
      '--filter',
      '@board-game/core',
      '--filter',
      '@board-game/client',
      '-r',
      'test',
    ],
    workspaceRoot,
  );
}

function platformTemplateDirectory(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../templates/independent-platform',
  );
}

function gameDeveloperSkillFile(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../templates/game-developer/SKILL.md',
  );
}

async function runPlatformInit(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  const empty = args.includes('--empty');
  const positional = args.filter((argument) => argument !== '--empty');
  if (
    positional.length > 1 ||
    positional.some((argument) => argument.startsWith('-'))
  )
    throw new Error(usage);
  const directory = pathFromWorkspace(workspaceRoot, positional[0] ?? '.');
  const templateDirectory = platformTemplateDirectory();
  const files = PLATFORM_TEMPLATE_FILES.filter(
    (file) => !empty || !file.startsWith('runtime/'),
  );
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const destination = resolve(directory, file);
    try {
      await access(destination);
      throw new Error(`Refusing to overwrite existing file: ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    if (
      empty &&
      (file === 'platform.config.json' || file === 'games.lock.json')
    ) {
      const template = JSON.parse(
        await readFile(resolve(templateDirectory, file), 'utf8'),
      ) as Record<string, unknown>;
      await writeFile(
        destination,
        `${JSON.stringify({ ...template, games: {} }, null, 2)}\n`,
        { flag: 'wx' },
      );
    } else {
      await copyFile(
        resolve(
          templateDirectory,
          empty && file === 'compose.yaml' ? 'compose.platform.yaml' : file,
        ),
        destination,
      );
    }
  }
  print({
    initialized: true,
    directory,
    files: files.map((file) => resolve(directory, file)),
  });
}

async function runPlatformDeploymentPlan(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  let targetGameId: string | undefined;
  let configPath: string | undefined;
  let lockPath: string | undefined;
  let composeFile: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) throw new Error(usage);
    if (argument === '--config') {
      if (configPath || !args[index + 1]) throw new Error(usage);
      configPath = args[++index] as string;
    } else if (argument === '--lock') {
      if (lockPath || !args[index + 1]) throw new Error(usage);
      lockPath = args[++index] as string;
    } else if (argument === '--compose-file') {
      if (composeFile || !args[index + 1]) throw new Error(usage);
      composeFile = args[++index] as string;
    } else if (argument === '--output') {
      if (outputPath || !args[index + 1]) throw new Error(usage);
      outputPath = args[++index] as string;
    } else if (argument.startsWith('-')) {
      throw new Error(usage);
    } else if (targetGameId) {
      throw new Error(usage);
    } else {
      targetGameId = argument;
    }
  }
  if (!targetGameId) throw new Error(usage);
  const absoluteOutput = outputPath
    ? resolveWorkspacePath(workspaceRoot, outputPath)
    : undefined;
  const effectiveComposeFile =
    composeFile ??
    (absoluteOutput ? relative(workspaceRoot, absoluteOutput) : undefined);
  const plan = await createComposePlanFromFiles({
    workspaceRoot,
    targetGameId,
    ...(configPath ? { configPath } : {}),
    ...(lockPath ? { lockPath } : {}),
    ...(effectiveComposeFile ? { composeFile: effectiveComposeFile } : {}),
  });
  let writtenCompose: string | undefined;
  if (absoluteOutput)
    writtenCompose = await writeComposePlan(plan, absoluteOutput);
  print({
    planned: true,
    dryRun: true,
    target: { gameId: plan.gameId, releaseId: plan.releaseId },
    targetService: plan.targetService,
    services: plan.services,
    command: plan.command,
    composeYaml: plan.composeYaml,
    ...(writtenCompose ? { output: writtenCompose } : {}),
  });
}

interface OperationFlags {
  readonly positional: readonly string[];
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly insecureLocalhost: boolean;
  readonly platformId?: string;
  readonly platformUrl?: string;
  readonly platformTokenRef?: string;
  readonly storeUrl?: string;
  readonly tokenRef?: string;
  readonly operationId?: string;
  readonly configPath?: string;
  readonly lockPath?: string;
  readonly composeFile?: string;
  readonly expectedRevision?: number;
  readonly channel?: string;
}

function flagValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-'))
    throw new Error(`${name} requires a value`);
  return value;
}

function parseOperationFlags(args: readonly string[]): OperationFlags {
  const positional: string[] = [];
  let dryRun = false;
  let json = false;
  let insecureLocalhost = false;
  let platformId: string | undefined;
  let platformUrl: string | undefined;
  let platformTokenRef: string | undefined;
  let storeUrl: string | undefined;
  let tokenRef: string | undefined;
  let operationId: string | undefined;
  let configPath: string | undefined;
  let lockPath: string | undefined;
  let composeFile: string | undefined;
  let expectedRevision: number | undefined;
  let channel: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('duplicate --dry-run');
      dryRun = true;
    } else if (argument === '--json') {
      if (json) throw new Error('duplicate --json');
      json = true;
    } else if (argument === '--insecure-localhost') {
      if (insecureLocalhost) throw new Error('duplicate --insecure-localhost');
      insecureLocalhost = true;
    } else if (argument === '--platform-id') {
      if (platformId !== undefined) throw new Error('duplicate --platform-id');
      platformId = flagValue(args, index, '--platform-id');
      index += 1;
    } else if (argument === '--platform-url') {
      if (platformUrl !== undefined)
        throw new Error('duplicate --platform-url');
      platformUrl = flagValue(args, index, '--platform-url');
      index += 1;
    } else if (argument === '--platform-token-ref') {
      if (platformTokenRef !== undefined)
        throw new Error('duplicate --platform-token-ref');
      platformTokenRef = flagValue(args, index, '--platform-token-ref');
      index += 1;
    } else if (argument === '--store-url') {
      if (storeUrl !== undefined) throw new Error('duplicate --store-url');
      storeUrl = flagValue(args, index, '--store-url');
      index += 1;
    } else if (argument === '--token-ref') {
      if (tokenRef !== undefined) throw new Error('duplicate --token-ref');
      tokenRef = flagValue(args, index, '--token-ref');
      index += 1;
    } else if (argument === '--operation-id') {
      if (operationId !== undefined)
        throw new Error('duplicate --operation-id');
      operationId = flagValue(args, index, '--operation-id');
      index += 1;
    } else if (argument === '--config') {
      if (configPath !== undefined) throw new Error('duplicate --config');
      configPath = flagValue(args, index, '--config');
      index += 1;
    } else if (argument === '--lock') {
      if (lockPath !== undefined) throw new Error('duplicate --lock');
      lockPath = flagValue(args, index, '--lock');
      index += 1;
    } else if (argument === '--compose-file') {
      if (composeFile !== undefined)
        throw new Error('duplicate --compose-file');
      composeFile = flagValue(args, index, '--compose-file');
      index += 1;
    } else if (argument === '--expected-revision') {
      if (expectedRevision !== undefined)
        throw new Error('duplicate --expected-revision');
      const value = flagValue(args, index, '--expected-revision');
      if (!/^\d+$/u.test(value))
        throw new Error('--expected-revision must be a non-negative integer');
      expectedRevision = Number(value);
      if (!Number.isSafeInteger(expectedRevision))
        throw new Error('--expected-revision must be a non-negative integer');
      index += 1;
    } else if (argument === '--channel') {
      if (channel !== undefined) throw new Error('duplicate --channel');
      channel = flagValue(args, index, '--channel');
      index += 1;
    } else if (argument.startsWith('-')) {
      throw new Error(usage);
    } else {
      positional.push(argument);
    }
  }
  return {
    positional,
    dryRun,
    json,
    insecureLocalhost,
    ...(platformId === undefined ? {} : { platformId }),
    ...(platformUrl === undefined ? {} : { platformUrl }),
    ...(platformTokenRef === undefined ? {} : { platformTokenRef }),
    ...(storeUrl === undefined ? {} : { storeUrl }),
    ...(tokenRef === undefined ? {} : { tokenRef }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(lockPath === undefined ? {} : { lockPath }),
    ...(composeFile === undefined ? {} : { composeFile }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(channel === undefined ? {} : { channel }),
  };
}

function requiredOperationPlatformId(flags: OperationFlags): string {
  const value = flags.platformId ?? process.env.BGP_PLATFORM_ID?.trim();
  if (!value) throw new Error('--platform-id or BGP_PLATFORM_ID is required');
  return value;
}

function cliSecret(reference: string): string {
  if (
    !/^(?:env:[A-Za-z][A-Za-z0-9_]*|secrets\/[A-Za-z0-9._/-]+)$/u.test(
      reference,
    )
  )
    throw new Error('credential must be an env: or secrets/ reference');
  if (!reference.startsWith('env:'))
    throw new Error(
      'secrets/ references require an injected secret resolver; use env: for the CLI',
    );
  const name = reference.slice('env:'.length);
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Secret environment variable ${name} is missing`);
  return value;
}

function operationPlatformTransport(
  flags: OperationFlags,
): HttpPlatformOperationsClient | undefined {
  const baseUrl = flags.platformUrl ?? process.env.BGP_PLATFORM_URL?.trim();
  const tokenRef =
    flags.platformTokenRef ?? process.env.BGP_PLATFORM_TOKEN_REF?.trim();
  if (!baseUrl || !tokenRef) return undefined;
  return new HttpPlatformOperationsClient({
    baseUrl,
    token: () => cliSecret(tokenRef),
    allowInsecureLocalhost: flags.insecureLocalhost,
  });
}

function printOperation(result: ReleaseOperationResult, json: boolean): void {
  if (json) {
    print(result);
    return;
  }
  print(
    `${result.dryRun ? 'dry-run' : 'completed'} ${result.action} ${result.operationId}`,
  );
}

async function runPlatformGameOperation(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  const action = args[0];
  if (
    action !== 'deploy' &&
    action !== 'register' &&
    action !== 'ready' &&
    action !== 'activate' &&
    action !== 'switch' &&
    action !== 'rollback' &&
    action !== 'drain'
  )
    throw new Error(usage);
  const flags = parseOperationFlags(args.slice(1));
  const platformId = requiredOperationPlatformId(flags);
  const transport = operationPlatformTransport(flags);
  const executor =
    action === 'deploy' && !flags.dryRun
      ? {
          run: async ({
            plan,
          }: {
            readonly plan: Awaited<
              ReturnType<typeof createComposePlanFromFiles>
            >;
          }) => {
            const fileIndex = plan.command.indexOf('-f');
            const composeFile = plan.command[fileIndex + 1];
            if (fileIndex < 0 || !composeFile)
              throw new Error('Compose plan is missing its file path');
            await writeComposePlan(
              plan,
              resolveWorkspacePath(workspaceRoot, composeFile),
            );
            await run(
              plan.command[0] as string,
              plan.command.slice(1),
              workspaceRoot,
            );
            return { started: true, command: plan.command };
          },
        }
      : undefined;
  const operations = createReleaseOperations({
    platformId,
    ...(transport ? { transport } : {}),
    ...(executor ? { composeExecutor: executor } : {}),
  });
  let result: ReleaseOperationResult;
  if (action === 'deploy') {
    if (flags.positional.length !== 1) throw new Error(usage);
    result = await operations.deploy({
      targetGameId: flags.positional[0] as string,
      workspaceRoot,
      ...(flags.configPath ? { configPath: flags.configPath } : {}),
      ...(flags.lockPath ? { lockPath: flags.lockPath } : {}),
      ...(flags.composeFile ? { composeFile: flags.composeFile } : {}),
      ...(flags.dryRun ? { dryRun: true } : {}),
      ...(flags.operationId ? { operationId: flags.operationId } : {}),
    });
  } else if (action === 'register') {
    if (flags.positional.length !== 1) throw new Error(usage);
    const value: unknown = JSON.parse(
      await readFile(
        pathFromWorkspace(workspaceRoot, flags.positional[0] as string),
        'utf8',
      ),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('release registration payload must be a JSON object');
    const payload = value as RegisterStagedReleasePayload;
    result = await operations.register({
      ...payload,
      ...(flags.dryRun ? { dryRun: true } : {}),
      ...(flags.operationId ? { operationId: flags.operationId } : {}),
    });
  } else if (action === 'rollback' || action === 'switch') {
    if (flags.positional.length !== 3 || flags.expectedRevision === undefined)
      throw new Error(
        `${action} requires <game-id> <mode-id> <target-binding-id> and --expected-revision`,
      );
    result = await operations[
      action === 'switch' ? 'switchChannel' : 'rollback'
    ]({
      gameId: flags.positional[0] as string,
      modeId: flags.positional[1] as string,
      targetBackendBindingId: flags.positional[2] as string,
      expectedRevision: flags.expectedRevision,
      channel: flags.channel ?? 'stable',
      ...(flags.dryRun ? { dryRun: true } : {}),
      ...(flags.operationId ? { operationId: flags.operationId } : {}),
    });
  } else {
    if (flags.positional.length !== 1) throw new Error(usage);
    result = await operations[action]({
      backendBindingId: flags.positional[0] as string,
      ...(flags.dryRun ? { dryRun: true } : {}),
      ...(flags.operationId ? { operationId: flags.operationId } : {}),
    });
  }
  printOperation(result, flags.json);
}

async function runReleasePublishOperation(
  args: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  const flags = parseOperationFlags(args);
  if (flags.positional.length !== 1) throw new Error(usage);
  const storeUrl = flags.storeUrl ?? process.env.BGP_RELEASE_STORE_URL?.trim();
  const tokenRef =
    flags.tokenRef ?? process.env.BGP_RELEASE_STORE_TOKEN_REF?.trim();
  if (!storeUrl || !tokenRef)
    throw new Error(
      '--store-url and --token-ref (or BGP_RELEASE_STORE_*) are required',
    );
  const publisher = new HttpReleaseArtifactPublisher({
    baseUrl: storeUrl,
    tokenRef,
    resolveSecret: cliSecret,
    allowInsecureLocalhost: flags.insecureLocalhost,
  });
  const operations = createReleaseOperations({
    platformId: requiredOperationPlatformId(flags),
    publisher,
  });
  const result = await operations.publish({
    releaseDirectory: pathFromWorkspace(
      workspaceRoot,
      flags.positional[0] as string,
    ),
    ...(flags.dryRun ? { dryRun: true } : {}),
    ...(flags.operationId ? { operationId: flags.operationId } : {}),
  });
  printOperation(result, flags.json);
}

async function main(args: readonly string[]): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw new Error('Node.js 22 or newer is required');
  if (args.length === 0 || args[0] === '--help') {
    print(usage);
    return;
  }
  const parsed = parseArguments(args);
  const commandArgs = parsed.args;
  const workspaceRoot = parsed.workspaceRoot;

  if (commandArgs[0] === 'doctor' && commandArgs.length === 1) {
    await runDoctor(workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'verify') {
    await runPlatformVerify(commandArgs.slice(1), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'dev') {
    await runDevelopment(commandArgs.slice(1), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'platform' && commandArgs[1] === 'init') {
    await runPlatformInit(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (
    commandArgs[0] === 'platform' &&
    commandArgs[1] === 'deployment' &&
    commandArgs[2] === 'plan'
  ) {
    await runPlatformDeploymentPlan(commandArgs.slice(3), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'platform' && commandArgs[1] === 'game') {
    await runPlatformGameOperation(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'init') {
    if (commandArgs.length !== 4 || commandArgs[2] !== '--profile')
      throw new Error(usage);
    const result = await initializeProject(
      pathFromWorkspace(workspaceRoot, commandArgs[1] as string),
      commandArgs[3] as InitProfile,
    );
    print({ initialized: true, ...result });
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'init') {
    await runGameInit(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'build') {
    await runGameBuild(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'client-build') {
    await runGameClientBuild(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'verify') {
    await runGameVerify(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'export') {
    await runGameExport(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'game' && commandArgs[1] === 'verify-export') {
    await runGameVerifyExport(commandArgs.slice(2), workspaceRoot);
    return;
  }
  if (commandArgs[0] === 'pack' && commandArgs.length === 4) {
    const manifestPath = pathFromWorkspace(
      workspaceRoot,
      commandArgs[1] as string,
    );
    const sourceFile = pathFromWorkspace(
      workspaceRoot,
      commandArgs[2] as string,
    );
    const input: unknown = JSON.parse(await readFile(sourceFile, 'utf8'));
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.values(input).some((value) => typeof value !== 'string')
    )
      throw new Error('Artifact sources must be an object of directory paths');
    const sources = Object.fromEntries(
      Object.entries(input).map(([key, path]) => [
        key,
        resolve(dirname(sourceFile), path as string),
      ]),
    ) as unknown as ArtifactSources;
    const packed = await packRelease(
      await readReleaseManifest(manifestPath),
      sources,
      pathFromWorkspace(workspaceRoot, commandArgs[3] as string),
    );
    print({
      gameId: packed.gameId,
      releaseId: packed.releaseId,
      output: pathFromWorkspace(workspaceRoot, commandArgs[3] as string),
    });
    return;
  }
  if (
    commandArgs[0] === 'release' &&
    commandArgs[1] === 'validate' &&
    commandArgs.length === 3
  ) {
    const manifest = await verifyPackedRelease(
      pathFromWorkspace(workspaceRoot, commandArgs[2] as string),
    );
    print({
      valid: true,
      gameId: manifest.gameId,
      releaseId: manifest.releaseId,
    });
    return;
  }
  if (commandArgs[0] === 'release' && commandArgs[1] === 'publish') {
    await runReleasePublishOperation(commandArgs.slice(2), workspaceRoot);
    return;
  }
  throw new Error(usage);
}

export { main as runCli };

function isCliEntryPoint(): boolean {
  const argument = process.argv[1];
  if (!argument) return false;
  try {
    return (
      realpathSync(argument) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return resolve(argument) === resolve(fileURLToPath(import.meta.url));
  }
}

if (isCliEntryPoint())
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Platform tooling failed'}\n`,
    );
    process.exitCode = 1;
  });
