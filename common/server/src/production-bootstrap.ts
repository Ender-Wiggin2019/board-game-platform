import { setTimeout as delay } from 'node:timers/promises';
import type { JsonValue } from '@board-game/contracts';
import type { GameServerRunner } from './runner.js';

export const DEFAULT_GAME_SERVER_MAINTENANCE_INTERVAL_MS = 1_000;
export const MIN_GAME_SERVER_MAINTENANCE_INTERVAL_MS = 10;
export const MAX_GAME_SERVER_MAINTENANCE_INTERVAL_MS = 60_000;

export interface GameServerLifecycleOptions {
  readonly prepare?: () => Promise<void>;
  readonly cleanup?: () => Promise<void>;
  readonly intervalMs?: number;
  /** Safe operational status only; command payloads and error messages are excluded. */
  readonly onMaintenanceStatus?: (status: GameServerMaintenanceStatus) => void;
}

export interface GameServerMaintenanceStatus {
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly status: 'pass-succeeded' | 'pass-failed';
  readonly failedOutbox: number;
  readonly failedConsumers: number;
  readonly failedRecoveryHooks: number;
  readonly pendingResources: number;
  readonly affectedSessions: readonly string[];
  readonly errorCode?: 'MAINTENANCE_PASS_FAILED';
}

interface InstalledLifecycle {
  readonly prepare: () => Promise<void>;
  readonly startMaintenance: () => Promise<void>;
}

const lifecycleByRunner = new WeakMap<object, InstalledLifecycle>();

function assertInterval(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_GAME_SERVER_MAINTENANCE_INTERVAL_MS ||
    value > MAX_GAME_SERVER_MAINTENANCE_INTERVAL_MS
  )
    throw new Error('GAME_SERVER_MAINTENANCE_INTERVAL_INVALID');
}

/**
 * Attach the common production maintenance/recovery lifecycle to a game
 * runner. Environment parsing, database construction and game policy remain
 * in the game's composition root.
 */
export function installGameServerLifecycle<
  Command extends JsonValue,
  Runner extends GameServerRunner<Command>,
>(runner: Runner, options: GameServerLifecycleOptions = {}): Runner {
  const intervalMs =
    options.intervalMs ?? DEFAULT_GAME_SERVER_MAINTENANCE_INTERVAL_MS;
  assertInterval(intervalMs);
  const baseClose = runner.close.bind(runner);
  const prepare = options.prepare ?? (async () => undefined);
  let maintenance: Promise<void> | undefined;
  let stopMaintenance: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let previousStatus = '';
  const reportStatus = (
    details: Omit<
      GameServerMaintenanceStatus,
      'gameId' | 'releaseId' | 'backendBindingId' | 'status'
    >,
  ) => {
    const degraded =
      details.errorCode !== undefined ||
      details.failedOutbox > 0 ||
      details.failedConsumers > 0 ||
      details.failedRecoveryHooks > 0 ||
      details.pendingResources > 0;
    const status: GameServerMaintenanceStatus = {
      gameId: runner.description.gameId,
      releaseId: runner.description.releaseId,
      backendBindingId: runner.description.backendBindingId,
      status: degraded ? 'pass-failed' : 'pass-succeeded',
      ...details,
    };
    const serialized = JSON.stringify(status);
    if (serialized === previousStatus || (!previousStatus && !degraded)) return;
    previousStatus = serialized;
    try {
      if (options.onMaintenanceStatus) options.onMaintenanceStatus(status);
      else
        console.warn(JSON.stringify({ event: 'game-maintenance', ...status }));
    } catch {
      // An operational reporter cannot interrupt durable maintenance work.
    }
  };

  const startMaintenance = async (): Promise<void> => {
    if (maintenance) return;
    const controller = new AbortController();
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    stopMaintenance = async () => {
      controller.abort();
      await stopped;
    };
    maintenance = (async () => {
      try {
        while (!controller.signal.aborted) {
          await delay(intervalMs, undefined, {
            signal: controller.signal,
          }).catch((error: unknown) => {
            if (!controller.signal.aborted) throw error;
          });
          if (controller.signal.aborted) break;
          try {
            // Recovery and automation claim durable work on the same session;
            // keep the passes sequential to avoid racing a deadline/outbox.
            const report = await runner.recoverOnce();
            await runner.recoverAutomationOnce();
            reportStatus({
              failedOutbox: report.outbox?.failed ?? 0,
              failedConsumers: report.facts.reduce(
                (sum, consumer) => sum + consumer.failed,
                0,
              ),
              failedRecoveryHooks: report.recovery.filter((hook) => hook.failed)
                .length,
              pendingResources: report.resources.filter(
                (resource) =>
                  resource.status === 'deferred' ||
                  resource.status === 'conflict',
              ).length,
              affectedSessions: [
                ...new Set(
                  report.outbox?.failures.map((failure) => failure.sessionId) ??
                    [],
                ),
              ].slice(0, 20),
            });
          } catch {
            // Durable work remains pending and is retried on the next pass.
            reportStatus({
              failedOutbox: 0,
              failedConsumers: 0,
              failedRecoveryHooks: 0,
              pendingResources: 0,
              affectedSessions: [],
              errorCode: 'MAINTENANCE_PASS_FAILED',
            });
          }
        }
      } finally {
        resolveStop();
      }
    })();
    await Promise.resolve();
  };

  Object.defineProperty(runner, 'close', {
    configurable: true,
    value: async (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        try {
          await stopMaintenance?.();
          await baseClose();
        } finally {
          await options.cleanup?.();
        }
      })();
      return closePromise;
    },
  });
  lifecycleByRunner.set(runner, { prepare, startMaintenance });
  return runner;
}

/** Start a runner, perform one durable recovery pass, then begin maintenance. */
export async function runGameServer<Command extends JsonValue>(
  runner: GameServerRunner<Command>,
): Promise<GameServerRunner<Command>> {
  const lifecycle =
    lifecycleByRunner.get(runner) ??
    ({
      prepare: async () => undefined,
      startMaintenance: async () => undefined,
    } satisfies InstalledLifecycle);
  try {
    await lifecycle.prepare();
    await runner.start();
    await runner.recoverOnce();
    await runner.recoverAutomationOnce();
    await lifecycle.startMaintenance();
    return runner;
  } catch (error) {
    await runner.close().catch(() => undefined);
    throw error;
  }
}
