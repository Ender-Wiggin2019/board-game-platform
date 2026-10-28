import {
  assertSchemaDescriptor,
  contractError,
  type DeveloperCommand,
  type SchemaDescriptor,
} from '@board-game/contracts';
import type { Transition } from './types.js';

const MAX_COMMANDS = 64;
const MAX_LABEL_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 2_000;

export interface DeveloperExecuteContext {
  readonly issuerPrincipalId: string;
  readonly logicalTime: number;
  readonly modeId: string;
}

/** Return false or a bounded reason when the console is disabled for one mode. */
export type DeveloperModeEligibility =
  | boolean
  | { readonly enabled: boolean; readonly reason?: string };

export interface DeveloperConsoleCommandDescriptor<S, Event> {
  readonly name: string;
  readonly label: string;
  readonly description?: string;
  readonly inputSchema: SchemaDescriptor;
  readonly execute: (
    state: Readonly<S>,
    command: DeveloperCommand,
    context: DeveloperExecuteContext,
  ) => Transition<S, Event>;
}

export interface DeveloperConsolePlugin<S, Event> {
  readonly commands: readonly DeveloperConsoleCommandDescriptor<S, Event>[];
  readonly isModeEnabled?: (modeId: string) => DeveloperModeEligibility;
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(value)
  );
}

function validText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !/\p{Cc}/u.test(value)
  );
}

function validateCommandDescriptor<S, Event>(
  descriptor: DeveloperConsoleCommandDescriptor<S, Event>,
): void {
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    !validName(descriptor.name) ||
    !validText(descriptor.label, MAX_LABEL_LENGTH) ||
    (descriptor.description !== undefined &&
      !validText(descriptor.description, MAX_DESCRIPTION_LENGTH)) ||
    typeof descriptor.execute !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'gameSdk.developerConsole.invalidCommand',
    );
  assertSchemaDescriptor(descriptor.inputSchema);
}

function validatePlugin<S, Event>(
  plugin: DeveloperConsolePlugin<S, Event>,
): void {
  if (
    !plugin ||
    typeof plugin !== 'object' ||
    !Array.isArray(plugin.commands) ||
    plugin.commands.length > MAX_COMMANDS ||
    (plugin.isModeEnabled !== undefined &&
      typeof plugin.isModeEnabled !== 'function')
  )
    throw contractError(
      'INVALID_REQUEST',
      'gameSdk.developerConsole.invalidPlugin',
    );
  const names = new Set<string>();
  for (const command of plugin.commands) {
    validateCommandDescriptor(command);
    if (names.has(command.name))
      throw contractError(
        'CONFLICT',
        'gameSdk.developerConsole.duplicateCommand',
        false,
        { name: command.name },
      );
    names.add(command.name);
  }
}

export function defineDeveloperConsole<S, Event>(
  plugin: DeveloperConsolePlugin<S, Event>,
): Readonly<DeveloperConsolePlugin<S, Event>> {
  validatePlugin(plugin);
  return Object.freeze({
    ...plugin,
    commands: Object.freeze(
      plugin.commands.map((command) => Object.freeze({ ...command })),
    ),
  });
}
