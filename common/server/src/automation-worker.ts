import { parentPort, Worker, workerData } from 'node:worker_threads';
import {
  contractError,
  isJsonValue,
  type JsonValue,
} from '@board-game/contracts';
import {
  AUTOMATION_DECISION_RESULT_KIND,
  type AutomationDecisionInput,
  type AutomationDecisionResult,
  type AutomationPolicy,
  defineAutomationPolicy,
  isAutomationDecisionResult,
  parseAutomationDecisionResult,
} from '@board-game/sdk';

export interface WorkerAutomationPolicyOptions<Command extends JsonValue>
  extends Omit<AutomationPolicy<Command>, 'decide'> {
  /** A server-only compiled module that calls serveAutomationPolicy. */
  readonly workerUrl: URL;
}

/** One isolated, terminable computation; no game state or host objects cross it. */
export function createWorkerAutomationPolicy<Command extends JsonValue>(
  options: WorkerAutomationPolicyOptions<Command>,
): AutomationPolicy<Command> {
  const { workerUrl, ...metadata } = options;
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:')
    throw contractError('INVALID_REQUEST', 'server.automation.workerUrl');
  return defineAutomationPolicy({
    ...metadata,
    decide: (input, signal) =>
      new Promise<Command | AutomationDecisionResult<Command>>(
        (resolve, reject) => {
          if (signal.aborted) {
            reject(
              contractError('NOT_READY', 'server.automation.aborted', true),
            );
            return;
          }
          const worker = new Worker(workerUrl, {
            workerData: structuredClone(input),
            env: {},
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
          });
          let settled = false;
          const finish = (
            error?: Error,
            result?: Command | AutomationDecisionResult<Command>,
          ) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            void worker.terminate();
            if (error) reject(error);
            else resolve(result as Command | AutomationDecisionResult<Command>);
          };
          const abort = () =>
            finish(
              contractError('NOT_READY', 'server.automation.aborted', true),
            );
          const timer = setTimeout(
            () =>
              finish(
                contractError('NOT_READY', 'server.automation.timeout', true),
              ),
            metadata.timeoutMs,
          );
          signal.addEventListener('abort', abort, { once: true });
          worker.once('message', (message: unknown) => {
            const payload =
              message && typeof message === 'object' && !Array.isArray(message)
                ? (message as Record<string, unknown>)
                : undefined;
            if (
              !payload ||
              payload.ok !== true ||
              !isJsonValue(payload.command) ||
              (payload.diagnostics !== undefined &&
                payload.kind !== AUTOMATION_DECISION_RESULT_KIND) ||
              (payload.diagnostics !== undefined &&
                !isJsonValue(payload.diagnostics))
            ) {
              finish(
                contractError(
                  'INVALID_REQUEST',
                  'server.automation.workerResult',
                ),
              );
              return;
            }
            finish(
              undefined,
              payload.kind === AUTOMATION_DECISION_RESULT_KIND
                ? {
                    kind: AUTOMATION_DECISION_RESULT_KIND,
                    command: payload.command as Command,
                    ...(payload.diagnostics === undefined
                      ? {}
                      : { diagnostics: payload.diagnostics as JsonValue }),
                  }
                : (payload.command as Command),
            );
          });
          worker.once('error', () =>
            finish(
              contractError(
                'NOT_READY',
                'server.automation.workerFailed',
                true,
              ),
            ),
          );
          worker.once('exit', () => {
            if (!settled)
              finish(
                contractError(
                  'NOT_READY',
                  'server.automation.workerExited',
                  true,
                ),
              );
          });
        },
      ),
  });
}

/** Entrypoint for a game-owned worker; exports no server lifecycle to the game engine. */
export function serveAutomationPolicy<Command extends JsonValue>(
  decide: (
    input: AutomationDecisionInput,
  ) =>
    | Command
    | AutomationDecisionResult<Command>
    | Promise<Command | AutomationDecisionResult<Command>>,
): void {
  if (!parentPort)
    throw contractError('INVALID_REQUEST', 'server.automation.workerRequired');
  const port = parentPort;
  Promise.resolve()
    .then(() => decide(workerData as AutomationDecisionInput))
    .then((result) => {
      const parsed = parseAutomationDecisionResult(result);
      const command = parsed.command;
      const diagnostics = parsed.diagnostics;
      if (!isJsonValue(command)) throw new Error('Invalid command');
      if (diagnostics !== undefined && !isJsonValue(diagnostics))
        throw new Error('Invalid diagnostics');
      port.postMessage({
        ok: true,
        command,
        ...(isAutomationDecisionResult(result)
          ? { kind: AUTOMATION_DECISION_RESULT_KIND }
          : {}),
        ...(diagnostics === undefined ? {} : { diagnostics }),
      });
    })
    .catch(() => port.postMessage({ ok: false }));
}
