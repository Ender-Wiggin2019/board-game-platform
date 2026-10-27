import { contractError, type JsonValue } from '@board-game/contracts';
import type {
  GameFactConsumer,
  GameRecoveryHook,
  GameViewPresenter,
} from '@board-game/server';
import {
  type GameReplayQueries,
  type GameResultPresenter,
  type GameServerDefinition,
  type GameServerManifest,
  installGameServer,
} from '@board-game/server';
import type {
  GameRegistration,
  InstalledGame,
  PlatformApplicationRuntime,
} from './PlatformApplicationRuntime.js';
import type { PlatformGameServices } from './PlatformGameServices.js';

/** Platform fields are supplied by the game server composition root. */
export type PlatformGameServerManifest = GameServerManifest &
  Omit<GameRegistration, 'resourceStore' | 'automation'>;

export interface PlatformGameServerContext {
  readonly platform: PlatformApplicationRuntime;
  readonly services?: PlatformGameServices;
  readonly installed: InstalledGame;
}

export interface PlatformGameServerInstallOptions {
  readonly platform: PlatformApplicationRuntime;
  readonly services?: PlatformGameServices;
}

export function installPlatformGameServer<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
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
    PlatformGameServerManifest,
    PlatformGameServerContext
  >,
  options: PlatformGameServerInstallOptions,
) {
  const { platform, services } = options;
  return installGameServer(definition, {
    installHost: (manifest, module, resourceStore, automation) => {
      const {
        gameId: _gameId,
        releaseId: _releaseId,
        ...registration
      } = manifest;
      return platform.registerGame({
        ...registration,
        module,
        ...(resourceStore ? { resourceStore } : {}),
        ...(automation ? { automation } : {}),
      });
    },
    submitCommand: async (reference, sessionId, input) => {
      const descriptor = await platform.sessions.descriptor(
        reference,
        sessionId,
      );
      if (descriptor.route.gameId !== definition.manifest.gameId)
        throw contractError(
          'FORBIDDEN',
          'platform.command_service.game_mismatch',
        );
      if (descriptor.route.releaseId !== definition.manifest.releaseId)
        throw contractError(
          'NOT_READY',
          'platform.command_service.release_unavailable',
          true,
        );
      return platform.views.command(reference, sessionId, input);
    },
    registerCommandServices: (gameId, releaseId, commandServices) =>
      platform.registerCommandServices(gameId, releaseId, commandServices),
    registerReplay: (gameId, releaseId, presenter: GameResultPresenter) =>
      platform.results.register(gameId, releaseId, presenter),
    registerReplayQueries: (gameId, releaseId, queries: GameReplayQueries) =>
      platform.results.registerReplayQueries(gameId, releaseId, queries),
    registerSettlement: (gameId, releaseId, read) =>
      platform.results.registerSettlement(gameId, releaseId, read),
    registerView: (gameId, releaseId, presenter: GameViewPresenter) =>
      platform.views.register(gameId, releaseId, presenter),
    registerFactConsumer: (gameId, consumer: GameFactConsumer) =>
      platform.registerFactConsumer(consumer.key, consumer.consume, gameId),
    registerRecoveryHook: (gameId, hook: GameRecoveryHook) =>
      platform.registerRecoveryHook(hook.key, hook.recover, gameId),
    rollback: (installed) => platform.abortGameRegistration(installed),
    createPlatformContext: (installed, _commandServices) => ({
      platform,
      services,
      installed,
    }),
  });
}
