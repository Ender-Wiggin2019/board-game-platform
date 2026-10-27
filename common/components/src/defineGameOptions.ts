import type { JsonObject, JsonValue } from '@board-game/contracts';
import type { GameSetupOption } from './GameSetupOptions.js';

export interface DefinedGameOptions {
  readonly options: readonly GameSetupOption[];
  readonly defaults: JsonObject;
  readonly update: (
    values: JsonValue,
    key: string,
    value: JsonValue,
  ) => JsonObject;
  readonly validate: (values: JsonValue) => boolean;
}

interface JsonRecord {
  readonly [key: string]: JsonValue;
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueIsValid(option: GameSetupOption, value: JsonValue): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean';
  if (option.type === 'select') {
    return (
      typeof value === 'string' &&
      option.options.some((candidate) => candidate.value === value)
    );
  }
  const step = option.step ?? 1;
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(step) &&
    step > 0 &&
    (option.min === undefined || value >= option.min) &&
    (option.max === undefined || value <= option.max) &&
    (value - (option.min ?? 0)) % step === 0
  );
}

function validateOption(option: GameSetupOption): void {
  if (!option.key.trim()) throw new Error('Game setup option key is required');
  if (!option.labelKey.trim())
    throw new Error(`Game setup option label is required: ${option.key}`);
  if (
    option.type === 'integer' &&
    option.step !== undefined &&
    (!Number.isSafeInteger(option.step) || option.step <= 0)
  ) {
    throw new Error(
      `Invalid integer step for game setup option: ${option.key}`,
    );
  }
  if (!valueIsValid(option, option.defaultValue)) {
    throw new Error(
      `Invalid default value for game setup option: ${option.key}`,
    );
  }
  if (option.type === 'select') {
    const values = new Set<string>();
    for (const candidate of option.options) {
      if (!candidate.value || !candidate.labelKey.trim()) {
        throw new Error(
          `Invalid select value for game setup option: ${option.key}`,
        );
      }
      if (values.has(candidate.value)) {
        throw new Error(
          `Duplicate select value for game setup option: ${option.key}`,
        );
      }
      values.add(candidate.value);
    }
  }
  if (
    option.type === 'integer' &&
    option.min !== undefined &&
    option.max !== undefined &&
    option.min > option.max
  ) {
    throw new Error(
      `Invalid integer range for game setup option: ${option.key}`,
    );
  }
}

export function defineGameOptions<
  const Options extends readonly GameSetupOption[],
>(
  options: Options,
): Readonly<DefinedGameOptions & { readonly options: Options }> {
  const keys = new Set<string>();
  const defaults: Record<string, JsonValue> = {};
  for (const option of options) {
    validateOption(option);
    if (keys.has(option.key)) {
      throw new Error(`Duplicate game setup option: ${option.key}`);
    }
    keys.add(option.key);
    defaults[option.key] = option.defaultValue;
  }

  const definition: DefinedGameOptions & { readonly options: Options } = {
    options,
    defaults,
    update: (values, key, value) => {
      const option = options.find((candidate) => candidate.key === key);
      if (!option) throw new Error(`Unknown game setup option: ${key}`);
      if (!valueIsValid(option, value)) {
        throw new Error(`Invalid value for game setup option: ${key}`);
      }
      return { ...(isJsonRecord(values) ? values : {}), [key]: value };
    },
    validate: (values) => {
      if (!isJsonRecord(values)) return false;
      return options.every((option) => {
        const value = values[option.key];
        return value === undefined || valueIsValid(option, value);
      });
    },
  };
  return Object.freeze(definition);
}
