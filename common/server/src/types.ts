import type { CommandPrecondition, JsonValue } from '@board-game/contracts';
import type {
  CommandInput,
  CommandResponse,
  InboxEnvelope,
  PlatformIdentityReference,
  SessionGateway,
} from '@board-game/core';
import type { ResourceStore } from '@board-game/host';
import type { AutomationPolicy, GameModule } from '@board-game/sdk';
import type { GameCommandServiceRegistry } from './command-services.js';
import type { GameDailyChallengeService } from './daily-challenge.js';

export type { GameDailyChallengeService } from './daily-challenge.js';

export interface GameServerManifest {
  readonly gameId: string;
  readonly releaseId: string;
}

export type GameCommandOperation = 'command' | 'undo' | 'rollback';

/**
 * The public descriptor deliberately has an unknown input boundary. A game
 * owns parsing and validation, while the registry owns command submission.
 */
export interface GameCommandServiceDescriptor<
  Command extends JsonValue = JsonValue,
> {
  readonly key: string;
  readonly operation: GameCommandOperation;
  readonly parse: (input: unknown) => JsonValue;
  readonly toCommand: (input: JsonValue) => Command;
}

export interface TypedGameCommandServiceDescriptor<
  Input extends JsonValue,
  Command extends JsonValue,
> {
  readonly key: string;
  readonly operation: GameCommandOperation;
  readonly parse: (input: unknown) => Input;
  readonly toCommand: (input: Input) => Command;
}

export interface GameStorageService {
  /** Host remains the only component allowed to mutate this store. */
  readonly resourceStore?: ResourceStore;
}

export interface GameResultPresenter {
  getCompletion(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown>;
  getEndRecord(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown>;
  getSettlement(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown>;
  getReplayManifest(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown>;
  getReplayFrames(
    reference: PlatformIdentityReference,
    sessionId: string,
    from: number,
    limit: number,
  ): Promise<unknown>;
}

export type GameViewPresenter = Pick<
  SessionGateway,
  'view' | 'resume' | 'command'
>;

export interface GameReplayQueries {
  readonly manifest: (eventLimit: number) => JsonValue;
  readonly frames: (from: number, limit: number) => JsonValue;
}

export interface GameReplayService {
  readonly presenter?: GameResultPresenter;
  readonly queries?: GameReplayQueries;
  readonly settlement?: (
    sessionId: string,
    principalId: string,
  ) => Promise<JsonValue | null>;
}

export interface GameViewService {
  readonly presenter: GameViewPresenter;
}

export interface GameFactConsumer {
  readonly key: string;
  readonly consume: (envelope: InboxEnvelope) => Promise<void>;
}

export interface GameRecoveryHook {
  readonly key: string;
  readonly recover: () => Promise<void>;
}

export interface GameServerServices<
  Command extends JsonValue = JsonValue,
  PlatformContext = unknown,
> {
  readonly storage?: GameStorageService;
  readonly commands?: readonly GameCommandServiceDescriptor<Command>[];
  readonly replay?: GameReplayService;
  /** Optional game-owned daily challenge RPC implementation. */
  readonly dailyChallenge?: GameDailyChallengeService;
  readonly view?: GameViewService;
  readonly facts?: readonly GameFactConsumer[];
  readonly recovery?: readonly GameRecoveryHook[];
  /** Decisions are computed outside the Host transaction and committed by Host. */
  readonly automation?: readonly AutomationPolicy<Command>[];
  /** Game-specific capability registration runs after Host and routes exist. */
  readonly platform?: (context: PlatformContext) => void;
}

export interface GameServerDefinition<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends GameServerManifest,
  PlatformContext,
> {
  readonly manifest: Manifest;
  readonly module: GameModule<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand
  >;
  readonly services: GameServerServices<Command, PlatformContext>;
}

export interface GameCommandServiceRequest {
  readonly commandId: string;
  readonly precondition: CommandPrecondition;
  readonly input: unknown;
}

export type GameCommandSubmitter<Command extends JsonValue> = (
  reference: PlatformIdentityReference,
  sessionId: string,
  input: CommandInput<Command>,
) => Promise<CommandResponse>;

export interface GameServerHostInstaller<
  Manifest extends GameServerManifest,
  Module,
  Installed,
> {
  readonly installHost: (
    manifest: Manifest,
    module: Module,
    resourceStore?: ResourceStore,
    automation?: readonly AutomationPolicy[],
  ) => Installed;
}

export interface GameServerInstallContext<
  Manifest extends GameServerManifest,
  Module,
  Installed,
  PlatformContext,
  Command extends JsonValue,
> extends GameServerHostInstaller<Manifest, Module, Installed> {
  readonly submitCommand: GameCommandSubmitter<Command>;
  readonly registerCommandServices: (
    gameId: string,
    releaseId: string,
    services: GameCommandServiceRegistry<Command>,
  ) => void;
  readonly registerReplay?: (
    gameId: string,
    releaseId: string,
    presenter: GameResultPresenter,
  ) => void;
  readonly registerReplayQueries?: (
    gameId: string,
    releaseId: string,
    queries: GameReplayQueries,
  ) => void;
  readonly registerSettlement?: (
    gameId: string,
    releaseId: string,
    read: (sessionId: string, principalId: string) => Promise<JsonValue | null>,
  ) => void;
  readonly registerView: (
    gameId: string,
    releaseId: string,
    presenter: GameViewPresenter,
  ) => void;
  readonly registerFactConsumer: (
    gameId: string,
    consumer: GameFactConsumer,
  ) => void;
  readonly registerRecoveryHook: (
    gameId: string,
    hook: GameRecoveryHook,
  ) => void;
  /** Removes platform registrations made after installHost when installation fails. */
  readonly rollback?: (installed: Installed) => void;
  readonly createPlatformContext: (
    installed: Installed,
    commandServices: GameCommandServiceRegistry<Command>,
  ) => PlatformContext;
}

export interface InstalledGameServer<
  Definition,
  Installed,
  Command extends JsonValue,
> {
  readonly definition: Definition;
  readonly installed: Installed;
  readonly commandServices: GameCommandServiceRegistry<Command>;
}
