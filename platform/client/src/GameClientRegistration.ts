import type { GameEntryRuntime } from '@board-game/client';
import type {
  GameClientDefinition,
  LazyComponent,
} from '@board-game/components';
import type { ECapability } from '@board-platform/contracts/auth/permissions';
import type { AnyRoute } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';

export type {
  GameClientDefinition,
  GameEndEntryProps,
  GameLiveEntryProps,
  GamePlayerColorPickerProps,
  GameReplayEntryProps,
  GameSeatHandoffLabels,
  GameSetupBooleanOption,
  GameSetupEditorProps,
  GameSetupIntegerOption,
  GameSetupOption,
  GameSetupOptionsProps,
  GameSetupSelectOption,
  LazyComponent,
} from '@board-game/components';

export interface GameExtensionProps {
  readonly gameId: string;
  readonly userId?: string;
  readonly runtime?: GameEntryRuntime;
}

export interface GameShellBadges {
  readonly friendPendingCount: number;
  readonly actionRequiredCount: number;
  readonly waitingReadyCount: number;
  readonly unreadCount: number;
}

/** A game-owned page inside the platform's game workspace. */
export interface GameWorkspacePage {
  readonly id: string;
  readonly labelKey: string;
  readonly load: LazyComponent<GameExtensionProps>;
  readonly requiredCapability?: ECapability;
}

export type ApplicationGlobalsScope = 'root' | 'session' | 'legacy';

/** Platform application capabilities attached to a common game definition. */
export interface GameClientRegistration extends GameClientDefinition {
  /** Native sessions receive shared chat by default. Existing custom presenters opt out. */
  readonly sessionChat?: 'platform' | 'game';
  readonly pages?: readonly GameWorkspacePage[];
  readonly administration?: readonly GameWorkspacePage[];
  readonly createRoutes?: (host: {
    readonly rootRoute: AnyRoute;
    readonly runtime: GameEntryRuntime;
  }) => readonly AnyRoute[];
  readonly account?: {
    readonly resolveSignInReturnTo?: (
      search: Readonly<Record<string, unknown>>,
    ) => string | undefined;
    readonly activationHelp?: LazyComponent<{ returnTo?: string }>;
  };
  readonly applicationGlobals?: LazyComponent<{
    readonly runtime: GameEntryRuntime;
    readonly gameId?: string;
    readonly scope: ApplicationGlobalsScope;
  }>;
  /** Optional route gate; lazy globals are not downloaded while another game is active. */
  readonly applicationGlobalsWhen?: (pathname: string) => boolean;
  readonly legacyRoutes?: readonly {
    readonly pathPrefix: string;
    readonly access?: 'public' | 'authenticated' | 'play';
    readonly load?: LazyComponent<{ runtime: GameEntryRuntime }>;
  }[];
  readonly extensions?: Readonly<{
    readonly profile?: LazyComponent<GameExtensionProps>;
    readonly stats?: LazyComponent<GameExtensionProps>;
    readonly achievements?: LazyComponent<GameExtensionProps>;
    readonly rankings?: LazyComponent<GameExtensionProps>;
  }>;
}

export type { ComponentType, ReactNode };
