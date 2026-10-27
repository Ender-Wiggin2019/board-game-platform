import type { JsonValue } from '@board-game/contracts';
import type { ChangeEvent } from 'react';

export interface GameSetupSelectChoice {
  readonly value: string;
  readonly labelKey: string;
}

export interface GameSetupBooleanOption {
  readonly type: 'boolean';
  readonly key: string;
  readonly labelKey: string;
  readonly defaultValue: boolean;
}

export interface GameSetupSelectOption {
  readonly type: 'select';
  readonly key: string;
  readonly labelKey: string;
  readonly defaultValue: string;
  readonly options: readonly GameSetupSelectChoice[];
}

export interface GameSetupIntegerOption {
  readonly type: 'integer';
  readonly key: string;
  readonly labelKey: string;
  readonly defaultValue: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export type GameSetupOption =
  | GameSetupBooleanOption
  | GameSetupSelectOption
  | GameSetupIntegerOption;

export interface GameSetupOptionsProps {
  /** Descriptions owned by the game registration. */
  readonly options: readonly GameSetupOption[];
  /** Optional localized accessible label for the fieldset. */
  readonly legendLabel?: string;
  /** Complete setup JSON. Declared option keys are updated at its root. */
  readonly setup: JsonValue;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: JsonValue) => void;
  /** Resolves game-owned locale keys. The key itself is used by default. */
  readonly translate?: (key: string) => string;
  readonly className?: string;
}

interface JsonRecord {
  readonly [key: string]: JsonValue;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionValues(setup: JsonValue): JsonRecord {
  return isJsonRecord(setup) ? setup : {};
}

function valueForOption(
  option: GameSetupOption,
  values: JsonRecord,
): boolean | number | string {
  const value = values[option.key];
  if (option.type === 'boolean') {
    return typeof value === 'boolean' ? value : option.defaultValue;
  }
  if (option.type === 'select') {
    return typeof value === 'string' &&
      option.options.some((candidate) => candidate.value === value)
      ? value
      : option.defaultValue;
  }
  return typeof value === 'number' && integerValueIsValid(option, value)
    ? value
    : option.defaultValue;
}

function integerValueIsValid(
  option: GameSetupIntegerOption,
  value: number,
): boolean {
  const step = option.step ?? 1;
  return (
    Number.isSafeInteger(value) &&
    Number.isSafeInteger(step) &&
    step > 0 &&
    (option.min === undefined || value >= option.min) &&
    (option.max === undefined || value <= option.max) &&
    (value - (option.min ?? 0)) % step === 0
  );
}

function updateSetup(
  setup: JsonValue,
  key: string,
  value: JsonValue,
): JsonValue {
  const base = isJsonRecord(setup) ? setup : {};
  return { ...base, [key]: value };
}

function fieldLabel(
  option: GameSetupOption,
  translate: (key: string) => string,
): string {
  return translate(option.labelKey) || option.labelKey;
}

function selectLabel(
  option: GameSetupSelectChoice,
  translate: (key: string) => string,
): string {
  return translate(option.labelKey) || option.labelKey;
}

function displayValue(
  option: GameSetupOption,
  value: boolean | number | string,
  translate: (key: string) => string,
): string {
  if (option.type === 'boolean') {
    const key = value ? 'common.enabled' : 'common.disabled';
    const translated = translate(key);
    return translated === key ? (value ? 'Enabled' : 'Disabled') : translated;
  }
  if (option.type === 'select') {
    const candidate = option.options.find((item) => item.value === value);
    return candidate ? selectLabel(candidate, translate) : String(value);
  }
  return String(value);
}

function optionId(key: string): string {
  return `game-setup-option-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function GameSetupOptions({
  options,
  legendLabel,
  setup,
  readOnly = false,
  disabled = false,
  onChange,
  translate = (key) => key,
  className,
}: GameSetupOptionsProps): React.JSX.Element | null {
  if (options.length === 0) return null;
  const resolved = optionValues(setup);
  const locked = readOnly || disabled;
  const update = (key: string, value: JsonValue): void => {
    if (locked) return;
    onChange(updateSetup(setup, key, value));
  };

  return (
    <fieldset
      className={className}
      disabled={disabled}
      aria-readonly={readOnly || undefined}
    >
      <legend className='sr-only'>
        {legendLabel ?? translate('common.game_setup_options')}
      </legend>
      <div className='game-setup-options'>
        {options.map((option) => {
          const id = optionId(option.key);
          const value = valueForOption(option, resolved);
          if (readOnly) {
            return (
              <div key={option.key} className='game-setup-option'>
                <span className='game-setup-option__label'>
                  {fieldLabel(option, translate)}
                </span>
                <span className='game-setup-option__value'>
                  {displayValue(option, value, translate)}
                </span>
              </div>
            );
          }

          return (
            <div key={option.key} className='game-setup-option'>
              <label htmlFor={id} className='game-setup-option__label'>
                {fieldLabel(option, translate)}
              </label>
              {option.type === 'boolean' ? (
                <input
                  id={id}
                  type='checkbox'
                  role='switch'
                  checked={value === true}
                  disabled={disabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    update(option.key, event.target.checked)
                  }
                />
              ) : option.type === 'select' ? (
                <select
                  id={id}
                  value={String(value)}
                  disabled={disabled}
                  onChange={(event) => update(option.key, event.target.value)}
                >
                  {option.options.map((candidate) => (
                    <option key={candidate.value} value={candidate.value}>
                      {selectLabel(candidate, translate)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type='number'
                  value={String(value)}
                  min={option.min}
                  max={option.max}
                  step={option.step ?? 1}
                  disabled={disabled}
                  onChange={(event) => {
                    if (event.target.value === '') return;
                    const next = Number(event.target.value);
                    if (integerValueIsValid(option, next))
                      update(option.key, next);
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
