import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type GameManifestTarget,
  resolvePackageExportTarget,
  verifyGameManifest,
} from './game-manifest.js';

export type GameVerificationOperation = 'build' | 'typecheck' | 'test';

export interface GameVerificationCommand {
  readonly command: 'corepack';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly operation: GameVerificationOperation;
}

export interface GameVerificationResult {
  readonly game: GameManifestTarget;
  readonly metadataOnly: boolean;
  readonly commands: readonly GameVerificationCommand[];
}

export interface VerifyGameOptions {
  readonly workspaceRoot: string;
  readonly metadataOnly?: boolean;
  readonly operations?: readonly GameVerificationOperation[];
  readonly run?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<void>;
}

function defaultRun(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((complete, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) complete();
      else reject(new Error(`Game verification exited with status ${code}`));
    });
  });
}

function filtersFor(target: GameManifestTarget): readonly string[] {
  return [`${target.clientPackage.name}...`, `${target.serverPackage.name}...`];
}

export function gameVerificationCommands(
  target: GameManifestTarget,
  workspaceRoot: string,
): readonly GameVerificationCommand[] {
  const filters = filtersFor(target);
  const operations: readonly GameVerificationOperation[] = [
    'build',
    'typecheck',
    'test',
  ];
  return operations.map((operation) => ({
    command: 'corepack',
    args: [
      'pnpm',
      ...filters.flatMap((filter) => ['--filter', filter]),
      '-r',
      operation,
    ],
    cwd: resolve(workspaceRoot),
    operation,
  }));
}

/**
 * Verifies one game's public manifest and, unless --check was requested, only
 * that game's dependency closure through the workspace package manager.
 */
export async function verifyGame(
  gameDirectory: string,
  options: VerifyGameOptions,
): Promise<GameVerificationResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const game = await verifyGameManifest(gameDirectory, workspaceRoot);
  const allCommands = gameVerificationCommands(game, workspaceRoot);
  const commands = options.operations
    ? allCommands.filter((command) =>
        options.operations?.includes(command.operation),
      )
    : allCommands;
  if (options.metadataOnly) return { game, metadataOnly: true, commands: [] };
  const run = options.run ?? defaultRun;
  for (const command of commands) {
    await run(command.command, command.args, command.cwd);
    if (command.operation === 'build') await verifyBuiltGameEntries(game);
  }
  return { game, metadataOnly: false, commands };
}

/** Confirm declared runtime entry files exist after build; do not import them. */
async function verifyBuiltGameEntries(game: GameManifestTarget): Promise<void> {
  for (const role of ['client', 'server'] as const) {
    const entry = game.manifest[role];
    const packageDirectory = game[`${role}Package`];
    const output = resolvePackageExportTarget(packageDirectory, entry.export);
    try {
      const outputStat = await stat(output);
      if (!outputStat.isFile()) throw new Error('is not a file');
    } catch (error) {
      throw new Error(
        `Game ${game.manifest.id} ${role} build output is missing for export ${entry.export}: ${output}`,
        { cause: error },
      );
    }
  }
}
