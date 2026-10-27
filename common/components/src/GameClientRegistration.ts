import type { GameEntryRuntime } from '@board-game/client';
import type {
  JsonObject,
  JsonValue,
  ModeDefinition,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import type { ComponentType, ReactNode } from 'react';
import type { GameSeatHandoffLabels } from './GameSeatHandoff.js';
import type { GameSetupOption } from './GameSetupOptions.js';

export type LazyComponent<Props> = () => Promise<{
  readonly default: ComponentType<Props>;
}>;

export interface GamePlayerColorPickerProps {
  readonly selected?: string;
  readonly disabled?: boolean;
  readonly disabledColors?: readonly string[];
  readonly onSelect: (color: string) => void;
}

export interface GameSetupEditorProps {
  readonly setup: JsonValue;
  readonly mode: ModeDefinition;
  readonly readOnly: boolean;
  readonly disabled?: boolean;
  readonly onChange: (setup: JsonValue) => void;
}

export interface GameLiveEntryProps {
  readonly route: SessionRoute;
  readonly status: SessionStatus;
  readonly spectate: boolean;
  readonly controlledPlayerId?: string;
  readonly runtime: GameEntryRuntime;
  readonly seatHandoffLabels?: Partial<GameSeatHandoffLabels>;
  readonly children?: ReactNode;
}

export interface GameReplayEntryProps {
  readonly route: SessionRoute;
  readonly runtime: GameEntryRuntime;
  readonly seatHandoffLabels?: Partial<GameSeatHandoffLabels>;
}

export interface GameEndEntryProps {
  readonly route: SessionRoute;
  readonly runtime: GameEntryRuntime;
  readonly seatHandoffLabels?: Partial<GameSeatHandoffLabels>;
}

/** JSON locale catalogs owned by a game client, keyed by language and namespace. */
export type GameClientLocales = Readonly<
  Record<string, Readonly<Record<string, JsonObject>>>
>;

export interface GameClientDefinition {
  readonly gameId: string;
  /** Present for independently loaded clients; its resources and locales share this pin. */
  readonly releaseId?: string;
  readonly metadata: {
    readonly nameKey: string;
    readonly descriptionKey?: string;
    readonly cover?: string;
  };
  readonly locales?: GameClientLocales;
  readonly links?: readonly {
    readonly labelKey: string;
    readonly href: string;
  }[];
  readonly setup: {
    readonly default: (modeId: string) => JsonValue;
    /** Declarative fields rendered by the shared platform setup surface. */
    readonly options?: readonly GameSetupOption[];
    readonly setupEditor?: LazyComponent<GameSetupEditorProps>;
    readonly playerColorPicker?: LazyComponent<GamePlayerColorPickerProps>;
    readonly getPreferredPlayerColor?: () => string | undefined;
    readonly getPlayerCount: (setup: JsonValue, fallback: number) => number;
    readonly updatePlayerCount: (setup: JsonValue, count: number) => JsonValue;
  };
  readonly palette?: Readonly<Record<string, string>>;
  readonly theme?: {
    readonly sharedBackground?: boolean;
    readonly scope?: string;
    readonly tokens?: Readonly<Record<string, string>>;
    readonly dataTheme?: string;
    readonly hero?: string;
    readonly footer?: string;
  };
  readonly capabilities?: Readonly<{
    readonly playerColorSelection?: boolean;
    readonly supportsSeed?: boolean;
    readonly room?: boolean;
    readonly directSolo?: boolean;
    readonly spectate?: boolean;
    readonly replay?: boolean;
    /** Exposes the platform-owned abandon/timeout controls for native rooms. */
    readonly sessionControls?: boolean;
    readonly rankings?: boolean;
    readonly stats?: boolean;
    readonly achievements?: boolean;
  }>;
  readonly providers?: ComponentType<{ children: ReactNode }>;
  readonly entry: {
    readonly loadLive: LazyComponent<GameLiveEntryProps>;
    readonly loadReplay?: LazyComponent<GameReplayEntryProps>;
    readonly loadEnd?: LazyComponent<GameEndEntryProps>;
  };
}
