import {
  assertModeDefinition,
  assertSchemaDescriptor,
  type JsonValue,
  PlatformError,
} from '@board-game/contracts';
import type { GameModule } from './types.js';

const FORBIDDEN_RUNTIME_KEYS = new Set([
  'app',
  'createServer',
  'httpServer',
  'listen',
  'listenAsync',
  'server',
  'startServer',
]);

function fail(messageKey: string, details?: JsonValue): never {
  throw new PlatformError({
    code: 'INVALID_REQUEST',
    messageKey,
    retryable: false,
    details,
  });
}

function requireFunction(value: unknown, field: string): void {
  if (typeof value !== 'function')
    fail('gameSdk.definition.expectedFunction', { field });
}

function requireIdentifier(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail('gameSdk.definition.expectedIdentifier', { field });
}

function deepFreeze<T>(value: T, seen: Set<object> = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateRules(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('gameSdk.definition.invalidRules');
  const rules = value as Record<string, unknown>;
  requireFunction(rules.create, 'rules.create');
  if (rules.activate !== undefined)
    requireFunction(rules.activate, 'rules.activate');
  requireFunction(rules.execute, 'rules.execute');
  requireFunction(rules.project, 'rules.project');
  requireFunction(rules.projectEvent, 'rules.projectEvent');
  requireFunction(rules.encode, 'rules.encode');
  requireFunction(rules.decode, 'rules.decode');
  if (rules.query !== undefined) requireFunction(rules.query, 'rules.query');
}

function cloneDefinition<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue = JsonValue,
>(
  module: GameModule<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  >,
): GameModule<S, Setup, Command, View, Event, Query, Answer, SystemCommand> {
  return {
    ...module,
    modes: [...module.modes],
    schemas: { ...module.schemas },
    rules: { ...module.rules },
  };
}

export function defineGame<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue = JsonValue,
>(
  module: GameModule<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  >,
): Readonly<
  GameModule<S, Setup, Command, View, Event, Query, Answer, SystemCommand>
> {
  if (!module || typeof module !== 'object' || Array.isArray(module))
    fail('gameSdk.definition.invalidModule');
  const candidate = module as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_RUNTIME_KEYS) {
    if (Object.hasOwn(candidate, key))
      fail('gameSdk.definition.serverLifecycleForbidden', { key });
  }

  requireIdentifier(module.gameId, 'gameId');
  requireIdentifier(module.releaseId, 'releaseId');
  if (
    !Number.isSafeInteger(module.stateSchemaVersion) ||
    module.stateSchemaVersion < 1
  ) {
    fail('gameSdk.definition.invalidStateSchemaVersion');
  }
  if (
    !Number.isSafeInteger(module.viewSchemaVersion) ||
    module.viewSchemaVersion < 1
  ) {
    fail('gameSdk.definition.invalidViewSchemaVersion');
  }
  if (!Array.isArray(module.modes) || module.modes.length === 0)
    fail('gameSdk.definition.modesRequired');
  const modeIds = new Set<string>();
  for (const mode of module.modes) {
    assertModeDefinition(mode);
    if (modeIds.has(mode.id))
      fail('gameSdk.definition.duplicateMode', { modeId: mode.id });
    modeIds.add(mode.id);
  }

  if (!module.schemas || typeof module.schemas !== 'object')
    fail('gameSdk.definition.schemasRequired');
  assertSchemaDescriptor(module.schemas.setup, 'schemas.setup');
  assertSchemaDescriptor(module.schemas.command, 'schemas.command');
  if (module.schemas.systemCommand !== undefined)
    assertSchemaDescriptor(
      module.schemas.systemCommand,
      'schemas.systemCommand',
    );
  if (module.schemas.query !== undefined)
    assertSchemaDescriptor(module.schemas.query, 'schemas.query');
  if (module.schemas.result !== undefined)
    assertSchemaDescriptor(module.schemas.result, 'schemas.result');
  validateRules(module.rules);
  requireFunction(module.summarize, 'summarize');
  requireFunction(module.collectFacts, 'collectFacts');
  requireFunction(module.completion, 'completion');
  if (module.turn !== undefined) requireFunction(module.turn, 'turn');
  if (module.projectAutomationView !== undefined)
    requireFunction(module.projectAutomationView, 'projectAutomationView');
  if (module.initialEvents !== undefined)
    requireFunction(module.initialEvents, 'initialEvents');
  if (
    module.result !== undefined ||
    module.modes.some((mode) => mode.platformRating)
  )
    requireFunction(module.result, 'result');
  if (module.inputOpportunity !== undefined)
    requireFunction(module.inputOpportunity, 'inputOpportunity');
  if (module.commandResourceRequirement !== undefined)
    requireFunction(
      module.commandResourceRequirement,
      'commandResourceRequirement',
    );
  if (module.executeSystem !== undefined) {
    requireFunction(module.executeSystem, 'executeSystem');
    if (module.schemas.systemCommand === undefined)
      fail('gameSdk.definition.systemCommandSchemaRequired');
  }
  if (module.systemSchedule !== undefined) {
    requireFunction(module.systemSchedule, 'systemSchedule');
    if (
      module.executeSystem === undefined ||
      module.schemas.systemCommand === undefined
    )
      fail('gameSdk.definition.systemScheduleExecutorRequired');
  }

  return deepFreeze(cloneDefinition(module));
}
