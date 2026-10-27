import type { GameMetadata } from './catalog.js';
import {
  assertGameServiceDailyChallengeDescription,
  type GameServiceDailyChallengeDescription,
} from './daily.js';
import { contractError } from './errors.js';
import { assertJsonPayloadSize, isJsonValue, type JsonValue } from './json.js';
import type { RoomControllerCapabilities } from './platform.js';
import {
  assertMatchesSchema,
  assertSchemaDescriptor,
  type SchemaDescriptor,
} from './schema.js';
import type { AutomationPreset } from './turns.js';
import type { ModeDefinition } from './types.js';
import { assertModeDefinition } from './validation.js';

export const GAME_SERVICE_DESCRIPTION_VERSION = 1 as const;

export interface GameServiceReplayDescription {
  readonly manifestQuery: JsonValue;
  readonly framesQueryType: string;
}

export interface GameServiceCommandDescription {
  readonly key: string;
  readonly operation: 'command' | 'undo' | 'rollback';
  readonly inputSchema: SchemaDescriptor;
}

/** JSON-only capabilities advertised by one exact game service binding. */
export interface GameServiceDescription {
  readonly schemaVersion: typeof GAME_SERVICE_DESCRIPTION_VERSION;
  readonly platformId: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly metadata: GameMetadata;
  readonly modes: readonly ModeDefinition[];
  readonly setupSchema: SchemaDescriptor;
  readonly replay?: GameServiceReplayDescription;
  readonly commands?: readonly GameServiceCommandDescription[];
  readonly controllers?: RoomControllerCapabilities;
  readonly dailyChallenge?: GameServiceDailyChallengeDescription;
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_LABEL_LENGTH = 240;
const MAX_METADATA_DESCRIPTION_LENGTH = 4_096;
const MAX_DESCRIPTION_BYTES = 256 * 1024;
const MAX_POLICY_IDENTIFIER_LENGTH = 128;
const MAX_VERSION_LENGTH = 64;
const MAX_MODES = 64;
const MAX_COMMANDS = 64;
const MAX_CONTROLLERS = 64;
const MAX_PRESETS = 32;

const INVALID_DESCRIPTION = 'contracts.runtime.invalidDescription';

function invalid(path: string): never {
  throw contractError('INVALID_REQUEST', INVALID_DESCRIPTION, false, { path });
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Reflect.ownKeys(value).every(
    (key) => typeof key === 'string' && allowed.has(key),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!isObject(value)) invalid(path);
}

function assertKeys(
  value: object,
  keys: readonly string[],
  path: string,
): void {
  if (!hasOnlyKeys(value, keys)) invalid(path);
}

function assertIdentifier(
  value: unknown,
  path: string,
  maxLength = MAX_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    invalid(path);
}

function assertLabel(value: unknown, path: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_LABEL_LENGTH
  )
    invalid(path);
}

function assertSchemaDescriptorStrict(
  value: unknown,
  path: string,
): asserts value is SchemaDescriptor {
  assertObject(value, path);
  assertKeys(value, ['name', 'version', 'schema', 'maxBytes'], path);
  assertSchemaDescriptor(value as unknown as SchemaDescriptor, path);
  assertIdentifier(value.name, `${path}.name`);
}

function assertMetadata(
  value: unknown,
  gameId: string,
  path: string,
): asserts value is GameMetadata {
  assertObject(value, path);
  assertKeys(
    value,
    ['gameId', 'name', 'description', 'coverUrl', 'themeId'],
    path,
  );
  assertIdentifier(value.gameId, `${path}.gameId`);
  assertLabel(value.name, `${path}.name`);
  if (
    typeof value.description !== 'string' ||
    value.description.trim().length === 0 ||
    value.description.length > MAX_METADATA_DESCRIPTION_LENGTH
  )
    invalid(`${path}.description`);
  if (value.coverUrl !== undefined)
    assertIdentifier(value.coverUrl, `${path}.coverUrl`);
  assertIdentifier(value.themeId, `${path}.themeId`);
  if (value.gameId !== gameId) invalid(`${path}.gameId`);
}

function assertModes(
  value: unknown,
  path: string,
): asserts value is readonly ModeDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODES)
    invalid(path);
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const mode = value[index];
    const modePath = `${path}[${index}]`;
    assertObject(mode, modePath);
    assertKeys(
      mode,
      [
        'id',
        'entry',
        'minPlayers',
        'maxPlayers',
        'history',
        'platformRating',
        'concurrency',
      ],
      modePath,
    );
    assertModeDefinition(mode);
    assertIdentifier(mode.id, `${modePath}.id`);
    if (ids.has(mode.id)) invalid(`${path}.id`);
    ids.add(mode.id);
  }
}

function assertReplay(
  value: unknown,
  path: string,
): asserts value is GameServiceReplayDescription {
  assertObject(value, path);
  assertKeys(value, ['manifestQuery', 'framesQueryType'], path);
  if (!isJsonValue(value.manifestQuery)) invalid(`${path}.manifestQuery`);
  assertIdentifier(value.framesQueryType, `${path}.framesQueryType`);
}

function assertPreset(
  value: unknown,
  path: string,
): asserts value is AutomationPreset {
  assertObject(value, path);
  assertKeys(value, ['id', 'label', 'options'], path);
  assertIdentifier(value.id, `${path}.id`, MAX_POLICY_IDENTIFIER_LENGTH);
  assertLabel(value.label, `${path}.label`);
  if (!isJsonValue(value.options)) invalid(`${path}.options`);
}

function assertController(value: unknown, path: string): void {
  assertObject(value, path);
  assertKeys(
    value,
    [
      'id',
      'version',
      'kind',
      'label',
      'optionsSchema',
      'defaultOptions',
      'presets',
    ],
    path,
  );
  assertIdentifier(value.id, `${path}.id`, MAX_POLICY_IDENTIFIER_LENGTH);
  if (value.version !== undefined)
    assertIdentifier(value.version, `${path}.version`, MAX_VERSION_LENGTH);
  if (value.kind !== 'ai' && value.kind !== 'automa') invalid(`${path}.kind`);
  assertLabel(value.label, `${path}.label`);

  if (value.optionsSchema !== undefined)
    assertSchemaDescriptorStrict(value.optionsSchema, `${path}.optionsSchema`);
  if (value.defaultOptions !== undefined) {
    if (!isJsonValue(value.defaultOptions)) invalid(`${path}.defaultOptions`);
    if (value.optionsSchema !== undefined)
      assertMatchesSchema(value.defaultOptions, value.optionsSchema);
  }

  if (value.presets !== undefined) {
    if (!Array.isArray(value.presets) || value.presets.length > MAX_PRESETS)
      invalid(`${path}.presets`);
    const presetIds = new Set<string>();
    for (let index = 0; index < value.presets.length; index += 1) {
      const presetPath = `${path}.presets[${index}]`;
      assertPreset(value.presets[index], presetPath);
      const preset = value.presets[index];
      if (presetIds.has(preset.id)) invalid(`${path}.presets`);
      presetIds.add(preset.id);
      if (value.optionsSchema !== undefined)
        assertMatchesSchema(preset.options, value.optionsSchema);
      else invalid(`${path}.optionsSchema`);
    }
  }
}

function assertControllers(
  value: unknown,
  path: string,
): asserts value is RoomControllerCapabilities {
  assertObject(value, path);
  assertKeys(value, ['hotseat', 'automation'], path);
  if (typeof value.hotseat !== 'boolean') invalid(`${path}.hotseat`);
  if (
    !Array.isArray(value.automation) ||
    value.automation.length > MAX_CONTROLLERS
  )
    invalid(`${path}.automation`);
  const ids = new Set<string>();
  for (let index = 0; index < value.automation.length; index += 1) {
    const controllerPath = `${path}.automation[${index}]`;
    assertController(value.automation[index], controllerPath);
    const controller = value.automation[index];
    if (ids.has(controller.id)) invalid(`${path}.automation`);
    ids.add(controller.id);
  }
}

function assertCommands(
  value: unknown,
  path: string,
): asserts value is readonly GameServiceCommandDescription[] {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) invalid(path);
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const commandPath = `${path}[${index}]`;
    assertObject(value[index], commandPath);
    const command = value[index];
    assertKeys(command, ['key', 'operation', 'inputSchema'], commandPath);
    assertIdentifier(command.key, `${commandPath}.key`);
    if (
      command.operation !== 'command' &&
      command.operation !== 'undo' &&
      command.operation !== 'rollback'
    )
      invalid(`${commandPath}.operation`);
    assertSchemaDescriptorStrict(
      command.inputSchema,
      `${commandPath}.inputSchema`,
    );
    if (keys.has(command.key)) invalid(`${path}.key`);
    keys.add(command.key);
  }
}

export function assertGameServiceDescription(
  value: unknown,
): asserts value is GameServiceDescription {
  if (!isJsonValue(value)) invalid('$');
  assertJsonPayloadSize(value, MAX_DESCRIPTION_BYTES, 'gameServiceDescription');
  assertObject(value, '$');
  assertKeys(
    value,
    [
      'schemaVersion',
      'platformId',
      'gameId',
      'releaseId',
      'backendBindingId',
      'storageBindingId',
      'ownershipEpoch',
      'metadata',
      'modes',
      'setupSchema',
      'replay',
      'commands',
      'controllers',
      'dailyChallenge',
    ],
    '$',
  );
  if (value.schemaVersion !== GAME_SERVICE_DESCRIPTION_VERSION)
    invalid('$.schemaVersion');
  for (const key of [
    'platformId',
    'gameId',
    'releaseId',
    'backendBindingId',
    'storageBindingId',
    'ownershipEpoch',
  ] as const)
    assertIdentifier(value[key], `$.${key}`);
  const gameId = value.gameId;
  assertIdentifier(gameId, '$.gameId');
  assertMetadata(value.metadata, gameId, '$.metadata');
  assertModes(value.modes, '$.modes');
  assertSchemaDescriptorStrict(value.setupSchema, '$.setupSchema');
  if (value.replay !== undefined) assertReplay(value.replay, '$.replay');
  if (value.commands !== undefined)
    assertCommands(value.commands, '$.commands');
  if (value.controllers !== undefined)
    assertControllers(value.controllers, '$.controllers');
  if (value.dailyChallenge !== undefined)
    assertGameServiceDailyChallengeDescription(value.dailyChallenge);
}
