import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  assertGameServiceDescription,
  type GameServiceDescription,
  type JsonValue,
} from '@board-game/contracts';
import type {
  GameServerDefinition,
  GameServerManifest,
} from '@board-game/server';
import {
  type GameManifestTarget,
  resolvePackageExportTarget,
  verifyGameManifest,
} from '@board-game/tooling/game-manifest';
import {
  createDevelopmentHost,
  type DevelopmentHost,
  type DevelopmentScenario,
} from '@board-platform/dev-host';

export type DevelopmentDefinition = GameServerDefinition<
  unknown,
  JsonValue,
  JsonValue,
  JsonValue,
  unknown,
  JsonValue,
  JsonValue,
  JsonValue,
  GameServerManifest,
  unknown
>;

export interface DevelopmentStartOptions {
  readonly gameDirectory: string;
  readonly workspaceRoot: string;
  readonly releaseId?: string;
  readonly seed?: string;
  readonly port?: number;
  readonly profile?: 'memory' | 'postgres';
  readonly databaseUrl?: string;
  readonly scene?: string;
}

export interface LoadedDevelopmentGame {
  readonly target: GameManifestTarget;
  readonly definition: DevelopmentDefinition;
  readonly description: GameServiceDescription;
  readonly clientModuleUrl: string;
  readonly clientEntry: string;
  readonly nativeClientAvailable: boolean;
  readonly scenarios: readonly DevelopmentScenario[];
}

export interface StartedDevelopmentGame extends LoadedDevelopmentGame {
  readonly host: DevelopmentHost<JsonValue>;
  readonly baseURL: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function invokeFactory(
  value: unknown,
  label: string,
  options?: Readonly<{ releaseId: string }>,
): unknown {
  if (typeof value !== 'function') return value;
  try {
    return options ? value(options) : value();
  } catch (error) {
    throw new Error(
      `The declared ${label} factory must be callable ${
        options ? 'with a releaseId option' : 'without arguments'
      }: ${error instanceof Error ? error.message : 'factory failed'}`,
      { cause: error },
    );
  }
}

function exportedDefinition(
  namespace: Record<string, unknown>,
  releaseId: string,
): unknown {
  for (const key of [
    'server',
    'definition',
    'gameServer',
    'gameServerDefinition',
  ]) {
    if (Object.hasOwn(namespace, key))
      return invokeFactory(namespace[key], `server ${key}`);
  }
  for (const key of [
    'createGameServer',
    'createServerDefinition',
    'createGameServerDefinition',
  ]) {
    const factory = namespace[key];
    if (typeof factory === 'function') return invokeFactory(factory, key);
  }
  for (const key of Object.keys(namespace).filter((candidate) =>
    /^create[A-Z].*RemoteServerDefinition$/u.test(candidate),
  )) {
    const factory = namespace[key];
    if (typeof factory === 'function')
      return invokeFactory(factory, key, { releaseId });
  }
  const defaultExport = namespace.default;
  if (defaultExport !== undefined)
    return invokeFactory(defaultExport, 'default server');
  throw new Error(
    'The declared server export must expose server/definition or a supported server definition factory',
  );
}

function definitionValue(value: unknown): DevelopmentDefinition {
  const candidate = record(value, 'server definition');
  const manifest = record(candidate.manifest, 'server definition.manifest');
  const module = record(candidate.module, 'server definition.module');
  if (
    typeof manifest.gameId !== 'string' ||
    typeof manifest.releaseId !== 'string' ||
    typeof module.gameId !== 'string' ||
    typeof module.releaseId !== 'string' ||
    manifest.gameId !== module.gameId ||
    manifest.releaseId !== module.releaseId
  )
    throw new Error(
      'Server definition manifest and module identities must match',
    );
  return value as DevelopmentDefinition;
}

function generatedDescription(
  target: GameManifestTarget,
  definition: DevelopmentDefinition,
): GameServiceDescription {
  const module = definition.module;
  const services = definition.services;
  const replayQueries = services.replay?.queries;
  const replay = replayQueries
    ? (() => {
        const manifestQuery = replayQueries.manifest(200);
        const frameQuery = replayQueries.frames(0, 1);
        const frameRecord = record(frameQuery, 'replay frame query');
        if (typeof frameRecord.type !== 'string')
          throw new Error('Replay frame query must expose a string type');
        return {
          manifestQuery,
          framesQueryType: frameRecord.type,
        };
      })()
    : undefined;
  const commands = services.commands?.map((command) => ({
    key: command.key,
    operation: command.operation,
    inputSchema: {
      name: `${definition.manifest.gameId}.${command.key}.input`,
      version: 1,
      schema: { type: 'any' as const },
    },
  }));
  const description: GameServiceDescription = {
    schemaVersion: 1,
    platformId: 'development',
    gameId: definition.manifest.gameId,
    releaseId: definition.manifest.releaseId,
    backendBindingId: `dev-host:${definition.manifest.gameId}:${definition.manifest.releaseId}`,
    storageBindingId: `memory:${definition.manifest.gameId}:${definition.manifest.releaseId}`,
    ownershipEpoch: 'development-v1',
    metadata: {
      gameId: definition.manifest.gameId,
      name: target.manifest.title,
      description: `Development runtime for ${target.manifest.title}`,
      themeId: definition.manifest.gameId,
    },
    modes: module.modes,
    setupSchema: module.schemas.setup,
    ...(replay ? { replay } : {}),
    ...(commands && commands.length > 0 ? { commands } : {}),
  };
  assertGameServiceDescription(description);
  return description;
}

function importedDescription(
  namespace: Record<string, unknown>,
): GameServiceDescription | undefined {
  const value = namespace.description ?? namespace.serviceDescription;
  if (value === undefined) return undefined;
  const description = typeof value === 'function' ? value() : value;
  assertGameServiceDescription(description);
  return description;
}

function importedScenarios(
  namespace: Record<string, unknown>,
): readonly DevelopmentScenario[] {
  const value = namespace.developmentScenarios ?? namespace.scenarios;
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error('Development scenarios must be an array');
  return value as readonly DevelopmentScenario[];
}

function hasNativeClientExportSource(source: string): boolean {
  return /\b(?:gameClientRelease|[A-Za-z][A-Za-z0-9]*GameClient)\b/u.test(
    source,
  );
}

export async function loadDevelopmentGame(
  gameDirectory: string,
  workspaceRoot: string,
  releaseId = '',
): Promise<LoadedDevelopmentGame> {
  const target = await verifyGameManifest(gameDirectory, workspaceRoot);
  const serverEntry = resolvePackageExportTarget(
    target.serverPackage,
    target.manifest.server.export,
  );
  const clientEntry = resolvePackageExportTarget(
    target.clientPackage,
    target.manifest.client.export,
  );
  try {
    await stat(serverEntry);
    await stat(clientEntry);
  } catch (error) {
    throw new Error(
      `Build the declared client/server exports before dev: ${
        error instanceof Error ? error.message : 'entry is missing'
      }`,
      { cause: error },
    );
  }
  const namespace = (await import(pathToFileURL(serverEntry).href)) as Record<
    string,
    unknown
  >;
  const definition = definitionValue(
    exportedDefinition(
      namespace,
      releaseId || `${target.manifest.id}-development`,
    ),
  );
  let nativeClientAvailable = false;
  try {
    const clientNamespace = (await import(
      pathToFileURL(clientEntry).href
    )) as Record<string, unknown>;
    nativeClientAvailable = Object.values(clientNamespace).some(
      (value) =>
        Boolean(value) &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as { gameId?: unknown }).gameId === 'string' &&
        Boolean((value as { entry?: unknown }).entry),
    );
  } catch {
    // Some published game clients contain extensionless internal ESM imports.
    // Node cannot evaluate those entries directly, while Vite can resolve them
    // in the browser. Preserve native detection for those packages by checking
    // the public entry's exported registration name.
    try {
      nativeClientAvailable = hasNativeClientExportSource(
        await readFile(clientEntry, 'utf8'),
      );
    } catch {
      nativeClientAvailable = false;
    }
  }
  const description =
    importedDescription(namespace) ?? generatedDescription(target, definition);
  if (
    description.gameId !== definition.manifest.gameId ||
    description.releaseId !== definition.manifest.releaseId
  )
    throw new Error(
      'Development description identity does not match server definition',
    );
  return {
    target,
    definition,
    description,
    clientModuleUrl: pathToFileURL(clientEntry).href,
    clientEntry,
    nativeClientAvailable,
    scenarios: importedScenarios(namespace),
  };
}

export async function startDevelopmentGame(
  options: DevelopmentStartOptions,
): Promise<StartedDevelopmentGame> {
  const loaded = await loadDevelopmentGame(
    options.gameDirectory,
    options.workspaceRoot,
    options.releaseId,
  );
  const profile = options.profile ?? 'memory';
  if (
    options.scene !== undefined &&
    !loaded.scenarios.some((scenario) => scenario.id === options.scene)
  )
    throw new Error(`Development scene not found: ${options.scene}`);
  const host = createDevelopmentHost({
    definition: loaded.definition,
    description: loaded.description,
    scenarios: loaded.scenarios,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    clientModuleUrl: loaded.clientModuleUrl,
    mode: 'development',
    storageProfile: profile,
    ...(options.databaseUrl !== undefined
      ? { databaseUrl: options.databaseUrl }
      : {}),
  });
  try {
    const baseURL = await host.start();
    return { ...loaded, host, baseURL };
  } catch (error) {
    await host.close();
    throw error;
  }
}
