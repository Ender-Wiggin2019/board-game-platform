import {
  type Actor,
  type AutomationPreset,
  assertMatchesSchema,
  assertSchemaDescriptor,
  contractError,
  isJsonValue,
  type JsonValue,
  type SchemaDescriptor,
  type TurnView,
} from '@board-game/contracts';

/** No authoritative state, storage, credentials, or opponent-private data. */
export interface AutomationDecisionInput {
  readonly view: JsonValue;
  readonly actor: Actor;
  readonly turn: TurnView;
  readonly seed: string;
  readonly options: JsonValue;
}

/** Reserved discriminant for a decision plus private diagnostics. */
export const AUTOMATION_DECISION_RESULT_KIND = 'automation-decision' as const;

/**
 * Optional private evidence returned with a decision.  Hosts may persist this
 * for authorized diagnostics, but it is never part of a player-facing view.
 */
export interface AutomationDecisionResult<
  Command extends JsonValue = JsonValue,
> {
  readonly kind: typeof AUTOMATION_DECISION_RESULT_KIND;
  readonly command: Command;
  readonly diagnostics?: JsonValue;
}

export function isAutomationDecisionResult(
  value: unknown,
): value is AutomationDecisionResult {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'kind') &&
    (value as { kind?: unknown }).kind === AUTOMATION_DECISION_RESULT_KIND &&
    Object.hasOwn(value, 'command') &&
    isJsonValue((value as { command?: unknown }).command) &&
    (!Object.hasOwn(value, 'diagnostics') ||
      isJsonValue((value as { diagnostics?: unknown }).diagnostics))
  );
}

/**
 * Normalizes a policy result without guessing from command object shape.
 * The reserved discriminant is required whenever private diagnostics are
 * returned, so a legal command containing a `command` property stays a
 * command.
 */
export function parseAutomationDecisionResult<Command extends JsonValue>(
  value: unknown,
): { readonly command: Command; readonly diagnostics?: JsonValue } {
  if (isAutomationDecisionResult(value))
    return {
      command: value.command as Command,
      ...(value.diagnostics === undefined
        ? {}
        : { diagnostics: value.diagnostics }),
    };
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === AUTOMATION_DECISION_RESULT_KIND
  )
    throw contractError('INVALID_REQUEST', 'gameSdk.automation.invalidResult');
  return { command: value as Command };
}

/** Registered by a server for one exact game release. */
export interface AutomationPolicy<Command extends JsonValue = JsonValue> {
  readonly id: string;
  /** Release-owned policy implementation version used by daily/replay pins. */
  readonly version?: string;
  readonly kind: 'ai' | 'automa';
  readonly label: string;
  readonly optionsSchema?: SchemaDescriptor;
  readonly defaultOptions?: JsonValue;
  readonly presets?: readonly AutomationPreset[];
  /** Presentation pacing, measured from the last authoritative commit. */
  readonly delayMs?: number;
  /** Host bounds the request; CPU-heavy policies must use a terminating worker. */
  readonly timeoutMs: number;
  readonly decide: (
    input: AutomationDecisionInput,
    signal: AbortSignal,
  ) =>
    | Command
    | AutomationDecisionResult<Command>
    | Promise<Command | AutomationDecisionResult<Command>>;
}

export function defineAutomationPolicy<Command extends JsonValue>(
  policy: AutomationPolicy<Command>,
): Readonly<AutomationPolicy<Command>> {
  if (
    !policy ||
    typeof policy.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(policy.id) ||
    (policy.version !== undefined &&
      (typeof policy.version !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/.test(policy.version))) ||
    (policy.kind !== 'ai' && policy.kind !== 'automa') ||
    typeof policy.label !== 'string' ||
    !policy.label.trim() ||
    policy.label.length > 240 ||
    typeof policy.decide !== 'function' ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    policy.timeoutMs > 60_000 ||
    (policy.delayMs !== undefined &&
      (!Number.isSafeInteger(policy.delayMs) ||
        policy.delayMs < 0 ||
        policy.delayMs > 60_000))
  )
    throw contractError('INVALID_REQUEST', 'gameSdk.automation.invalidPolicy');
  if (policy.optionsSchema) {
    assertSchemaDescriptor(policy.optionsSchema);
    if (policy.defaultOptions !== undefined)
      assertMatchesSchema(policy.defaultOptions, policy.optionsSchema);
  }
  if (policy.presets !== undefined) {
    if (!Array.isArray(policy.presets) || policy.presets.length > 32)
      throw contractError(
        'INVALID_REQUEST',
        'gameSdk.automation.invalidPresets',
      );
    const ids = new Set<string>();
    for (const preset of policy.presets) {
      if (
        !preset ||
        typeof preset.id !== 'string' ||
        !preset.id ||
        preset.id.length > 128 ||
        ids.has(preset.id) ||
        typeof preset.label !== 'string' ||
        !preset.label.trim() ||
        preset.label.length > 240
      )
        throw contractError(
          'INVALID_REQUEST',
          'gameSdk.automation.invalidPresets',
        );
      ids.add(preset.id);
      automationOptions(policy, preset.options);
    }
  }
  return Object.freeze({ ...policy });
}

export function automationOptions(
  policy: Pick<AutomationPolicy, 'optionsSchema' | 'defaultOptions'>,
  options: JsonValue | undefined,
): JsonValue {
  const value = options ?? policy.defaultOptions ?? null;
  if (policy.optionsSchema) assertMatchesSchema(value, policy.optionsSchema);
  else if (options !== undefined)
    throw contractError(
      'INVALID_REQUEST',
      'gameSdk.automation.optionsUnsupported',
    );
  return structuredClone(value);
}
