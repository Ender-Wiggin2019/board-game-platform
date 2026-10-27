import {
  contractError,
  isJsonValue,
  type JsonValue,
} from '@board-game/contracts';
import type {
  CommandResponse,
  PlatformIdentityReference,
} from '@board-game/core';
import {
  type GameCommandOperation,
  type GameCommandServiceDescriptor,
  type GameCommandServiceRequest,
  type GameCommandSubmitter,
  type TypedGameCommandServiceDescriptor,
} from './types.js';

function assertKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    throw contractError('INVALID_REQUEST', 'server.command_service.key');
}

function assertOperation(
  value: unknown,
): asserts value is GameCommandOperation {
  if (value !== 'command' && value !== 'undo' && value !== 'rollback')
    throw contractError('INVALID_REQUEST', 'server.command_service.operation');
}

export function defineCommandService<
  Input extends JsonValue,
  Command extends JsonValue,
>(
  descriptor: TypedGameCommandServiceDescriptor<Input, Command>,
): GameCommandServiceDescriptor<Command> {
  if (!descriptor || typeof descriptor !== 'object')
    throw contractError('INVALID_REQUEST', 'server.command_service.required');
  assertKey(descriptor.key);
  assertOperation(descriptor.operation);
  if (typeof descriptor.parse !== 'function')
    throw contractError('INVALID_REQUEST', 'server.command_service.parse');
  if (typeof descriptor.toCommand !== 'function')
    throw contractError('INVALID_REQUEST', 'server.command_service.builder');
  return Object.freeze({
    key: descriptor.key,
    operation: descriptor.operation,
    parse: (input: unknown): JsonValue => {
      const parsed = descriptor.parse(input);
      if (!isJsonValue(parsed))
        throw contractError('INVALID_REQUEST', 'server.command_service.input');
      return parsed;
    },
    toCommand: (input: JsonValue): Command => {
      const command = descriptor.toCommand(input as Input);
      if (!isJsonValue(command))
        throw contractError(
          'INVALID_REQUEST',
          'server.command_service.command',
        );
      return command;
    },
  });
}

export interface GameCommandServiceCollection {
  readonly gameId: string;
  readonly releaseId: string;
  get(key: string): GameCommandServiceDescriptor;
  list(): readonly GameCommandServiceDescriptor[];
  invoke(
    reference: PlatformIdentityReference,
    sessionId: string,
    key: string,
    request: GameCommandServiceRequest,
  ): Promise<CommandResponse>;
}

export class GameCommandServiceRegistry<Command extends JsonValue>
  implements GameCommandServiceCollection
{
  private readonly descriptorsByKey = new Map<
    string,
    GameCommandServiceDescriptor<Command>
  >();

  constructor(
    readonly gameId: string,
    readonly releaseId: string,
    private readonly submit: GameCommandSubmitter<Command>,
  ) {
    assertKey(gameId);
    assertKey(releaseId);
    if (typeof submit !== 'function')
      throw contractError('INVALID_REQUEST', 'server.command_service.submit');
  }

  register(descriptor: GameCommandServiceDescriptor<Command>): void {
    if (!descriptor || typeof descriptor !== 'object')
      throw contractError('INVALID_REQUEST', 'server.command_service.required');
    assertKey(descriptor.key);
    assertOperation(descriptor.operation);
    if (
      typeof descriptor.parse !== 'function' ||
      typeof descriptor.toCommand !== 'function'
    )
      throw contractError('INVALID_REQUEST', 'server.command_service.invalid');
    if (this.descriptorsByKey.has(descriptor.key))
      throw contractError(
        'CONFLICT',
        'server.command_service.already_registered',
      );
    this.descriptorsByKey.set(descriptor.key, Object.freeze({ ...descriptor }));
  }

  get(key: string): GameCommandServiceDescriptor<Command> {
    const descriptor = this.descriptorsByKey.get(key);
    if (!descriptor)
      throw contractError('NOT_FOUND', 'server.command_service.unavailable');
    return descriptor;
  }

  list(): readonly GameCommandServiceDescriptor<Command>[] {
    return [...this.descriptorsByKey.values()];
  }

  /**
   * All authority checks and transaction/receipt behavior stay in submit.
   * This registry only turns a typed service input into a game command.
   */
  async invoke(
    reference: PlatformIdentityReference,
    sessionId: string,
    key: string,
    request: GameCommandServiceRequest,
  ): Promise<CommandResponse> {
    const descriptor = this.get(key);
    if (!request || typeof request !== 'object')
      throw contractError('INVALID_REQUEST', 'server.command_service.request');
    const parsed = descriptor.parse(request.input);
    if (!isJsonValue(parsed))
      throw contractError('INVALID_REQUEST', 'server.command_service.input');
    const command = descriptor.toCommand(parsed);
    if (!isJsonValue(command))
      throw contractError('INVALID_REQUEST', 'server.command_service.command');
    return this.submit(reference, sessionId, {
      commandId: request.commandId,
      precondition: request.precondition,
      command,
    });
  }
}
