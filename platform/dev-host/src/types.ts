import type { GameServiceDescription, JsonValue } from '@board-game/contracts';
import type {
  AdmissionCoordinator,
  AdmissionStore,
  InboxStore,
  PlatformIdentityReference,
  SessionDirectoryStore,
  SessionGateway,
} from '@board-game/core';
import type {
  GameServerDefinition,
  GameServerManifest,
  GameServerRunner,
} from '@board-game/server';

export type DevelopmentAccountRole = 'player' | 'observer' | 'admin';

export interface DevelopmentAccount {
  readonly principalId: string;
  readonly role: DevelopmentAccountRole;
  readonly displayName: string;
}

export interface DevelopmentScenario<
  Command extends JsonValue = JsonValue,
  Setup extends JsonValue = JsonValue,
> {
  readonly id: string;
  readonly label?: string;
  readonly setup: Setup;
  readonly seed?: string;
  readonly commands?: readonly DevelopmentScenarioCommand<Command>[];
}

export interface DevelopmentScenarioCommand<
  Command extends JsonValue = JsonValue,
> {
  readonly principalId?: string;
  readonly seatId?: string;
  /** A normal game command or { key, input } for a declared service command. */
  readonly command:
    | Command
    | {
        readonly key: string;
        readonly input: JsonValue;
      };
}

export interface DevelopmentHostOptions<
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
  readonly definition: GameServerDefinition<
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
  >;
  readonly description: GameServiceDescription;
  readonly scenarios?: readonly DevelopmentScenario<Command, Setup>[];
  readonly seed?: string;
  readonly port?: number;
  readonly clientModuleUrl?: string;
  /** Explicitly reject accidental production use of this memory profile. */
  readonly mode?: 'development' | 'production';
  /** PostgreSQL is a separate profile and is intentionally not hidden here. */
  readonly storageProfile?: 'memory' | 'postgres';
  /** Required for the explicit PostgreSQL profile; never inferred from production config. */
  readonly databaseUrl?: string;
}

export interface DevelopmentHost<Command extends JsonValue = JsonValue> {
  readonly runner: GameServerRunner<Command>;
  readonly admission: AdmissionStore;
  readonly directory: SessionDirectoryStore;
  readonly inbox: InboxStore;
  readonly sessionGateway: SessionGateway;
  readonly coordinator: AdmissionCoordinator;
  readonly accounts: readonly DevelopmentAccount[];
  readonly metadata: {
    readonly mode: 'development';
    readonly host: '127.0.0.1';
    readonly storageProfile: 'memory' | 'postgres';
    readonly clientModuleUrl?: string;
  };
  readonly baseURL?: string;
  start(): Promise<string>;
  close(): Promise<void>;
}

export interface DevelopmentIdentity extends PlatformIdentityReference {
  readonly account: DevelopmentAccount;
}
