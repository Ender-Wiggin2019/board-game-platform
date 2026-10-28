import { contractError, type JsonValue } from '@board-game/contracts';
import { defineAutomationPolicy, type GameModule } from '@board-game/sdk';
import { GameCommandServiceRegistry } from './command-services.js';
import type {
  GameCommandServiceDescriptor,
  GameFactConsumer,
  GameRecoveryHook,
  GameResultPresenter,
  GameServerDefinition,
  GameServerInstallContext,
  InstalledGameServer,
} from './types.js';

function identifier(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw contractError('INVALID_REQUEST', `server.definition.${key}`);
}

function uniqueKeys(
  items: readonly { readonly key: string }[] | undefined,
  kind: string,
): void {
  if (!items) return;
  if (!Array.isArray(items))
    throw contractError('INVALID_REQUEST', `server.definition.${kind}`);
  const keys = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object')
      throw contractError('INVALID_REQUEST', `server.definition.${kind}`);
    identifier(item.key, `${kind}.key`);
    if (keys.has(item.key))
      throw contractError('CONFLICT', `server.definition.${kind}.duplicate`);
    keys.add(item.key);
  }
}

export function defineGameServer<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends { readonly gameId: string; readonly releaseId: string },
  PlatformContext,
>(
  definition: GameServerDefinition<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  >,
): GameServerDefinition<
  S,
  Setup,
  Command,
  View,
  Event,
  Query,
  Answer,
  SystemCommand,
  Manifest,
  PlatformContext
> {
  if (!definition || typeof definition !== 'object')
    throw contractError('INVALID_REQUEST', 'server.definition.required');
  const { module, manifest, services } = definition;
  if (!module || typeof module !== 'object')
    throw contractError('INVALID_REQUEST', 'server.definition.module');
  if (typeof module.turn !== 'function')
    throw contractError('INVALID_REQUEST', 'server.definition.turnRequired');
  if (!manifest || typeof manifest !== 'object')
    throw contractError('INVALID_REQUEST', 'server.definition.manifest');
  identifier(module.gameId, 'module.gameId');
  identifier(module.releaseId, 'module.releaseId');
  identifier(manifest.gameId, 'manifest.gameId');
  identifier(manifest.releaseId, 'manifest.releaseId');
  if (
    module.gameId !== manifest.gameId ||
    module.releaseId !== manifest.releaseId
  )
    throw contractError('CONFLICT', 'server.definition.release_mismatch');
  if (!services || typeof services !== 'object')
    throw contractError('INVALID_REQUEST', 'server.definition.services');
  if (
    services.storage !== undefined &&
    (!services.storage || typeof services.storage !== 'object')
  )
    throw contractError('INVALID_REQUEST', 'server.definition.storage');
  if (
    services.replay !== undefined &&
    (!services.replay ||
      typeof services.replay !== 'object' ||
      Array.isArray(services.replay))
  )
    throw contractError('INVALID_REQUEST', 'server.definition.replay');
  if (
    services.view !== undefined &&
    (!services.view ||
      typeof services.view !== 'object' ||
      Array.isArray(services.view))
  )
    throw contractError('INVALID_REQUEST', 'server.definition.view');
  if (
    services.statistics !== undefined &&
    (!services.statistics ||
      typeof services.statistics !== 'object' ||
      Array.isArray(services.statistics) ||
      typeof services.statistics.query !== 'function')
  )
    throw contractError('INVALID_REQUEST', 'server.definition.statistics');
  uniqueKeys(services.commands, 'command');
  if (services.replay && !services.replay.presenter && !services.replay.queries)
    throw contractError('INVALID_REQUEST', 'server.definition.replay');
  if (
    services.platform !== undefined &&
    typeof services.platform !== 'function'
  )
    throw contractError('INVALID_REQUEST', 'server.definition.platform');
  uniqueKeys(services.facts, 'fact');
  uniqueKeys(services.recovery, 'recovery');
  if (services.automation !== undefined) {
    if (!Array.isArray(services.automation) || !module.turn)
      throw contractError('INVALID_REQUEST', 'server.automation.turnRequired');
    const ids = new Set<string>();
    for (const policy of services.automation) {
      defineAutomationPolicy(policy);
      if (ids.has(policy.id))
        throw contractError('CONFLICT', 'server.automation.duplicate');
      ids.add(policy.id);
    }
  }

  const commands = services.commands
    ? Object.freeze([...services.commands])
    : undefined;
  const facts = services.facts ? Object.freeze([...services.facts]) : undefined;
  const recovery = services.recovery
    ? Object.freeze([...services.recovery])
    : undefined;
  const frozenServices = Object.freeze({
    ...services,
    ...(commands ? { commands } : {}),
    ...(facts ? { facts } : {}),
    ...(recovery ? { recovery } : {}),
    ...(services.automation
      ? {
          automation: Object.freeze(
            services.automation.map((policy) =>
              defineAutomationPolicy<Command>(policy),
            ),
          ),
        }
      : {}),
  });
  return Object.freeze({
    manifest: Object.freeze({ ...manifest }),
    module,
    services: frozenServices,
  });
}

function requireFunction(value: unknown, key: string): void {
  if (typeof value !== 'function')
    throw contractError('INVALID_REQUEST', `server.install.${key}`);
}

function validatePresenter(presenter: GameResultPresenter, key: string): void {
  for (const method of [
    'getCompletion',
    'getEndRecord',
    'getSettlement',
    'getReplayManifest',
    'getReplayFrames',
  ] as const)
    requireFunction(presenter[method], `${key}.${method}`);
}

function preflightInstall<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends { readonly gameId: string; readonly releaseId: string },
  PlatformContext,
  Module,
  Installed,
>(
  definition: GameServerDefinition<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  > & { readonly module: Module },
  context: GameServerInstallContext<
    Manifest,
    Module,
    Installed,
    PlatformContext,
    Command
  >,
): void {
  requireFunction(context.installHost, 'install_host');
  requireFunction(context.submitCommand, 'submit_command');
  requireFunction(context.registerCommandServices, 'register_command_services');
  requireFunction(context.registerView, 'register_view');
  requireFunction(context.registerFactConsumer, 'register_fact_consumer');
  requireFunction(context.registerRecoveryHook, 'register_recovery_hook');
  requireFunction(context.createPlatformContext, 'create_platform_context');

  const resourceStore = definition.services.storage?.resourceStore;
  if (resourceStore) {
    requireFunction(resourceStore.reserve, 'storage.resource_store.reserve');
    requireFunction(
      resourceStore.getReservation,
      'storage.resource_store.get_reservation',
    );
    if (resourceStore.getReservationsForCommand !== undefined)
      requireFunction(
        resourceStore.getReservationsForCommand,
        'storage.resource_store.get_reservations_for_command',
      );
    requireFunction(resourceStore.confirm, 'storage.resource_store.confirm');
    requireFunction(resourceStore.release, 'storage.resource_store.release');
    requireFunction(
      resourceStore.listPending,
      'storage.resource_store.list_pending',
    );
  }

  const replay = definition.services.replay;
  if (replay?.presenter) {
    validatePresenter(replay.presenter, 'replay.presenter');
    if (typeof context.registerReplay !== 'function')
      throw contractError('INVALID_REQUEST', 'server.install.register_replay');
  }
  if (replay?.queries) {
    requireFunction(replay.queries.manifest, 'replay.queries.manifest');
    requireFunction(replay.queries.frames, 'replay.queries.frames');
    if (typeof context.registerReplayQueries !== 'function')
      throw contractError(
        'INVALID_REQUEST',
        'server.install.register_replay_queries',
      );
  }
  if (replay?.settlement) {
    requireFunction(replay.settlement, 'replay.settlement');
    if (typeof context.registerSettlement !== 'function')
      throw contractError(
        'INVALID_REQUEST',
        'server.install.register_settlement',
      );
  }
  if (definition.services.view) {
    const presenter = definition.services.view.presenter;
    if (!presenter || typeof presenter !== 'object')
      throw contractError('INVALID_REQUEST', 'server.install.view.presenter');
    for (const method of ['view', 'resume', 'command'] as const)
      requireFunction(presenter[method], `view.presenter.${method}`);
  }
  for (const consumer of definition.services.facts ?? [])
    requireFunction(consumer.consume, 'fact.consume');
  for (const hook of definition.services.recovery ?? [])
    requireFunction(hook.recover, 'recovery.recover');
}

export function installGameServer<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends { readonly gameId: string; readonly releaseId: string },
  PlatformContext,
  Module extends GameModule<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  > = GameModule<S, Setup, Command, View, Event, Query, Answer, SystemCommand>,
  Installed = unknown,
>(
  definition: GameServerDefinition<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  > & { readonly module: Module },
  context: GameServerInstallContext<
    Manifest,
    Module,
    Installed,
    PlatformContext,
    Command
  >,
): InstalledGameServer<typeof definition, Installed, Command> {
  preflightInstall(definition, context);

  // Build and validate the complete local registry before the Host can mutate
  // platform state. Every declared command is therefore known to be typed
  // before any game is installed.
  const commandServices = new GameCommandServiceRegistry<Command>(
    definition.manifest.gameId,
    definition.manifest.releaseId,
    context.submitCommand,
  );
  for (const descriptor of definition.services.commands ?? [])
    commandServices.register(descriptor);

  let installed: Installed | undefined;
  try {
    installed = context.installHost(
      definition.manifest,
      definition.module,
      definition.services.storage?.resourceStore,
      definition.services.automation,
    );
    context.registerCommandServices(
      definition.manifest.gameId,
      definition.manifest.releaseId,
      commandServices,
    );
    if (definition.services.replay) {
      if (definition.services.replay.presenter) {
        const registerReplay = context.registerReplay;
        if (!registerReplay)
          throw contractError(
            'INVALID_REQUEST',
            'server.install.register_replay',
          );
        registerReplay(
          definition.manifest.gameId,
          definition.manifest.releaseId,
          definition.services.replay.presenter,
        );
      }
      if (definition.services.replay.queries) {
        const registerReplayQueries = context.registerReplayQueries;
        if (!registerReplayQueries)
          throw contractError(
            'INVALID_REQUEST',
            'server.install.register_replay_queries',
          );
        registerReplayQueries(
          definition.manifest.gameId,
          definition.manifest.releaseId,
          definition.services.replay.queries,
        );
      }
      if (definition.services.replay.settlement) {
        const registerSettlement = context.registerSettlement;
        if (!registerSettlement)
          throw contractError(
            'INVALID_REQUEST',
            'server.install.register_settlement',
          );
        registerSettlement(
          definition.manifest.gameId,
          definition.manifest.releaseId,
          definition.services.replay.settlement,
        );
      }
    }
    if (definition.services.view)
      context.registerView(
        definition.manifest.gameId,
        definition.manifest.releaseId,
        definition.services.view.presenter,
      );
    for (const consumer of definition.services.facts ?? [])
      context.registerFactConsumer(definition.manifest.gameId, consumer);
    for (const hook of definition.services.recovery ?? [])
      context.registerRecoveryHook(definition.manifest.gameId, hook);
    definition.services.platform?.(
      context.createPlatformContext(installed, commandServices),
    );
    return { definition, installed, commandServices };
  } catch (error) {
    if (installed !== undefined) {
      try {
        context.rollback?.(installed);
      } catch {
        // Preserve the installation error. Platform rollback is best effort.
      }
    }
    throw error;
  }
}

export type {
  GameCommandServiceDescriptor,
  GameFactConsumer,
  GameRecoveryHook,
};
