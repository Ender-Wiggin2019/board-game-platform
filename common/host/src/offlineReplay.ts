import { createHash } from 'node:crypto';
import {
  type Actor,
  assertJsonPayloadSize,
  assertMatchesSchema,
  canonicalStableStringify,
  contractError,
  DEFAULT_JSON_LIMITS,
  isJsonValue,
  type JsonValue,
  toErrorEnvelope,
} from '@board-game/contracts';
import {
  type AutomationDecisionInput,
  type AutomationPolicy,
  defineAutomationPolicy,
  type GameModule,
  parseAutomationDecisionResult,
} from '@board-game/sdk';
import {
  type AutomationTrace,
  assertAutomationTrace,
  type PrivateCommandTraceKind,
} from '@board-game/storage';

/** Hard upper bound for policy work in an offline replay process. */
export const OFFLINE_REPLAY_MAX_POLICY_TIMEOUT_MS = 30_000;

/** Keep a malformed or hostile trace file from becoming an unbounded input. */
export const OFFLINE_REPLAY_MAX_TRACE_BYTES = 4 * 1024 * 1024;

export interface BoundedAutomationDecisionOptions {
  /** Optional stricter cap used by offline replay. */
  readonly maxTimeoutMs?: number;
  /** Injected Host clock used for duration metrics. */
  readonly now?: () => number;
}

export interface BoundedAutomationDecision<Command extends JsonValue> {
  readonly command: Command;
  readonly diagnostics?: JsonValue;
  readonly durationMs: number;
}

export interface OfflineAutomationReplayRequest<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue = JsonValue,
> {
  /** The registered game module whose rules and codec should be evaluated. */
  readonly module: GameModule<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  >;
  /** A trusted operator export; it is validated and never executed as code. */
  readonly trace: AutomationTrace;
  /** Optional current policy used to compare a new AI decision with the trace. */
  readonly currentPolicy?: AutomationPolicy<Command>;
  /** Host callers may supply their injected clock for compatible duration metrics. */
  readonly now?: () => number;
}

/** Runs one policy with a terminating timeout and normalized decision result. */
export async function runBoundedAutomationDecision<Command extends JsonValue>(
  policy: Readonly<AutomationPolicy<Command>>,
  input: AutomationDecisionInput,
  options: BoundedAutomationDecisionOptions = {},
): Promise<BoundedAutomationDecision<Command>> {
  const timeoutMs = Math.min(
    policy.timeoutMs,
    options.maxTimeoutMs ?? policy.timeoutMs,
  );
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const decision = Promise.resolve().then(() =>
      policy.decide(structuredClone(input), controller.signal),
    );
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(contractError('CONFLICT', 'host.automation.timeout', true));
      }, timeoutMs);
    });
    const result = await Promise.race([decision, timeout]);
    const parsed = parseAutomationDecisionResult<Command>(result);
    if (!isJsonValue(parsed.command))
      throw contractError('INVALID_REQUEST', 'host.automation.command');
    assertJsonPayloadSize(parsed.command, DEFAULT_JSON_LIMITS.commandBytes);
    if (parsed.diagnostics !== undefined)
      assertJsonPayloadSize(
        parsed.diagnostics,
        128 * 1024,
        'automation diagnostics',
      );
    return {
      command: structuredClone(parsed.command) as Command,
      ...(parsed.diagnostics === undefined
        ? {}
        : { diagnostics: structuredClone(parsed.diagnostics) }),
      durationMs: Math.max(0, now() - startedAt),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Offline replay result. `command` and `newCommand` are the command evaluated
 * by the current policy (or the captured command when no policy is supplied).
 * `originalCommand` always refers to the command captured in the trace.
 */
export interface OfflineAutomationReplayResult {
  readonly traceKind: PrivateCommandTraceKind;
  readonly traceId: string;
  readonly decisionId: string;
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly originalPolicyId: string;
  readonly originalPolicyVersion?: string;
  readonly originalCommand?: JsonValue;
  readonly newCommand?: JsonValue;
  readonly command?: JsonValue;
  readonly diagnostics?: JsonValue;
  readonly originalDiagnostics?: JsonValue;
  readonly durationMs: number;
  readonly inputDigest: string;
  readonly legal: boolean;
  readonly error?: {
    readonly code: string;
    readonly messageKey: string;
  };
}

/**
 * Replays one exported trace without a Host, storage driver, database or
 * session head. Commands execute against a cloned checkpoint and AI policies
 * receive the actor/input captured in the trace, never a reconstructed head.
 */
export async function replayAutomationTraceOffline<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue = JsonValue,
>(
  input: OfflineAutomationReplayRequest<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  >,
): Promise<OfflineAutomationReplayResult> {
  assertOfflineTrace(input.trace);
  const trace = input.trace;
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  const originalCommand =
    trace.command === undefined ? undefined : structuredClone(trace.command);
  const originalDiagnostics =
    trace.diagnostics === undefined
      ? undefined
      : structuredClone(trace.diagnostics);
  const inputDigest = digest(trace.input);
  const policyOverride =
    trace.kind === 'automation' ? input.currentPolicy : undefined;
  const base = {
    traceKind: trace.kind,
    traceId: trace.traceId,
    decisionId: trace.decisionId,
    policyId: policyOverride?.id ?? trace.policyId,
    ...(policyOverride === undefined
      ? trace.policyVersion === undefined
        ? {}
        : { policyVersion: trace.policyVersion }
      : policyOverride.version === undefined
        ? {}
        : { policyVersion: policyOverride.version }),
    originalPolicyId: trace.policyId,
    ...(trace.policyVersion === undefined
      ? {}
      : { originalPolicyVersion: trace.policyVersion }),
    ...(originalCommand === undefined ? {} : { originalCommand }),
    ...(originalDiagnostics === undefined ? {} : { originalDiagnostics }),
    durationMs: 0,
    inputDigest,
  } satisfies Omit<OfflineAutomationReplayResult, 'legal' | 'error'>;

  try {
    let command = originalCommand;
    let diagnostics = originalDiagnostics;
    if (policyOverride !== undefined) {
      const policy = defineAutomationPolicy<Command>(policyOverride);
      const decision = await runBoundedAutomationDecision(
        policy,
        trace.input as unknown as AutomationDecisionInput,
        {
          maxTimeoutMs: OFFLINE_REPLAY_MAX_POLICY_TIMEOUT_MS,
          now,
        },
      );
      command = decision.command;
      diagnostics = decision.diagnostics;
    }
    if (command === undefined)
      throw contractError(
        'INVALID_REQUEST',
        'host.automation.offline_command_missing',
      );
    assertMatchesSchema(command, input.module.schemas.command);
    const actor = capturedActor(trace.input);
    const state = input.module.rules.decode(
      structuredClone(trace.state),
      trace.schemaVersion,
    );
    const transition = input.module.rules.execute(
      state,
      structuredClone(command) as Command,
      { actor: structuredClone(actor), logicalTime: trace.startedAt },
    );
    return {
      ...base,
      ...(command === undefined ? {} : { command: structuredClone(command) }),
      ...(command === undefined
        ? {}
        : { newCommand: structuredClone(command) }),
      ...(diagnostics === undefined
        ? {}
        : { diagnostics: structuredClone(diagnostics) }),
      durationMs: Math.max(0, now() - startedAt),
      legal: transition.ok,
      ...(transition.ok
        ? {}
        : {
            error: {
              code: 'INVALID_REQUEST',
              messageKey: safeMessageKey(transition.error.messageKey),
            },
          }),
    };
  } catch (error) {
    const envelope = toErrorEnvelope(error);
    return {
      ...base,
      durationMs: Math.max(0, now() - startedAt),
      legal: false,
      error: {
        code: envelope.code,
        messageKey: safeMessageKey(envelope.messageKey),
      },
    };
  }
}

function capturedActor(input: JsonValue): Actor {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw contractError('INVALID_REQUEST', 'host.automation.offline_input');
  const actor = (input as Record<string, JsonValue>).actor;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor))
    throw contractError('INVALID_REQUEST', 'host.automation.offline_actor');
  const actorObject = actor as Record<string, JsonValue>;
  if (
    typeof actorObject.principalId !== 'string' ||
    actorObject.principalId.length === 0 ||
    (actorObject.kind !== 'player' && actorObject.kind !== 'system') ||
    (actorObject.seatId !== undefined &&
      (typeof actorObject.seatId !== 'string' ||
        actorObject.seatId.length === 0))
  )
    throw contractError('INVALID_REQUEST', 'host.automation.offline_actor');
  return structuredClone(actorObject) as unknown as Actor;
}

function assertOfflineTrace(trace: AutomationTrace): void {
  assertJsonPayloadSize(
    trace,
    OFFLINE_REPLAY_MAX_TRACE_BYTES,
    'offline replay trace',
  );
  assertAutomationTrace(trace);
  capturedActor(trace.input);
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

function safeMessageKey(messageKey: string): string {
  return /^[a-z][A-Za-z0-9._:-]{0,255}$/.test(messageKey)
    ? messageKey
    : 'host.automation.failed';
}
