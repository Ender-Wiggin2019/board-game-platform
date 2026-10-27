import {
  contractError,
  type JsonValue,
  type SessionRoute,
} from '@board-game/contracts';
import { defineGame, type GameModule } from '@board-game/sdk';

export type RuntimeModule = GameModule<
  Readonly<unknown>,
  JsonValue,
  JsonValue,
  JsonValue,
  unknown,
  JsonValue,
  JsonValue
>;

/** Only the composition root knows concrete games; Host addresses pinned releases. */
export class GameRegistry {
  private readonly modules = new Map<string, RuntimeModule>();

  register<
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
  ): this {
    const key = JSON.stringify([module.gameId, module.releaseId]);
    if (this.modules.has(key))
      throw contractError('CONFLICT', 'host.release.alreadyInstalled');
    // Type erasure stays inside the registry. Runtime schemas guard every entry.
    this.modules.set(key, defineGame(module) as unknown as RuntimeModule);
    return this;
  }

  /** Remove one exact pinned release during composition-root rollback. */
  unregister(gameId: string, releaseId: string): boolean {
    return this.modules.delete(JSON.stringify([gameId, releaseId]));
  }

  resolve(
    route: Pick<SessionRoute, 'gameId' | 'releaseId' | 'modeId'>,
  ): RuntimeModule {
    const module = this.modules.get(
      JSON.stringify([route.gameId, route.releaseId]),
    );
    if (!module || !module.modes.some((mode) => mode.id === route.modeId)) {
      throw contractError('NOT_FOUND', 'host.release.notInstalled');
    }
    return module;
  }

  installed(): readonly RuntimeModule[] {
    return [...this.modules.values()];
  }
}
