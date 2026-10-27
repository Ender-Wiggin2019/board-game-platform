#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The reusable tooling package owns no platform command implementation.
 *
 * This file remains as a monorepo-only compatibility entry for the historical
 * `node common/tooling/dist/cli.js ...` invocation. It forwards to the
 * platform CLI by executable path, so the common package still has no import or
 * package dependency on `@board-platform/*`. Standalone installs use the
 * `bgp` bin from `@board-platform/cli` instead.
 */

export type {
  GameManifestTarget,
  GameWorkspaceResolution,
  WorkspacePackage,
} from './game-manifest.js';
export {
  discoverGameManifests,
  discoverGamePackages,
  discoverWorkspacePackages,
  resolveGameWorkspace,
  verifyGameManifest,
} from './game-manifest.js';

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

function monorepoPlatformCli(): string {
  const cli = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../platform/tooling/dist/cli.js',
  );
  if (!existsSync(cli))
    throw new Error(
      'The legacy common tooling wrapper requires a built platform CLI; run `corepack pnpm --filter @board-platform/cli build` or use the installed `bgp` command',
    );
  return cli;
}

async function forwardLegacyCli(args: readonly string[]): Promise<void> {
  const child = spawn(process.execPath, [monorepoPlatformCli(), ...args], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  await new Promise<void>((complete, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) complete();
      else {
        process.exitCode = code ?? 1;
        complete();
      }
    });
  });
}

if (isCliEntryPoint())
  void forwardLegacyCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Tooling compatibility wrapper failed'}\n`,
    );
    process.exitCode = 1;
  });
