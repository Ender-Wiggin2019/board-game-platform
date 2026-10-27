import type {
  JsonValue,
  ModeDefinition,
  PlatformRoom,
} from '@board-game/contracts';

export function isJsonRecord(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function modeForRoom(
  catalog: readonly { mode: ModeDefinition }[] | undefined,
  room: PlatformRoom,
): ModeDefinition | undefined {
  return catalog?.find((entry) => entry.mode.id === room.modeId)?.mode;
}

export function setupWithOptions(
  setup: JsonValue,
  optionsPatch: Record<string, JsonValue>,
): JsonValue {
  const base = isJsonRecord(setup) ? setup : {};
  const options = isJsonRecord(base.options) ? base.options : {};
  return {
    ...base,
    options: {
      ...options,
      ...optionsPatch,
    },
  };
}
