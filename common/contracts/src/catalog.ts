import type { JsonValue } from './json.js';

/** Capabilities exposed by the cross-game public platform surface. */
export const GAME_CAPABILITIES = [
  'achievements',
  'rewards',
  'wallet',
  'rating',
  'rankings',
  'profile',
  'replay',
  'messages',
] as const;

export type GameCapability = (typeof GAME_CAPABILITIES)[number];

/** Policy pins are immutable release metadata, never browser input. */
export type GamePolicyKind =
  | 'rating'
  | 'progression'
  | 'achievement'
  | 'reward';

export interface GamePolicyVersion {
  readonly kind: GamePolicyKind;
  readonly version: string;
}

/** Safe game identity and presentation metadata returned by public APIs. */
export interface GameMetadata {
  readonly gameId: string;
  readonly name: string;
  readonly description: string;
  readonly coverUrl?: string;
  readonly themeId: string;
}

/** Assets must be declared by the game before a reward can grant them. */
export interface GameAssetDefinition {
  readonly asset: string;
  readonly kind: 'currency' | 'asset';
  readonly label?: string;
}

/** Public, JSON-only projection of one pinned game release. */
export interface GameCatalogEntry {
  readonly metadata: GameMetadata;
  readonly releaseId: string;
  readonly capabilities: readonly GameCapability[];
  readonly policyVersions: readonly GamePolicyVersion[];
  readonly assets: readonly GameAssetDefinition[];
}

export interface AchievementItem {
  readonly achievementId: string;
  readonly title: string;
  readonly description: string;
  readonly tier: string;
  readonly progress: number;
  readonly target?: number;
  readonly unlocked: boolean;
  readonly unlockedAt?: number;
}

export interface AchievementCollection {
  readonly gameId: string;
  readonly principalId: string;
  readonly definitionVersion: string;
  readonly items: readonly AchievementItem[];
  readonly selectedAchievementId?: string;
}

export interface GameWalletAsset extends GameAssetDefinition {
  readonly granted: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly available: number;
  readonly revision: number;
}

export interface GameWallet {
  readonly gameId: string;
  readonly principalId: string;
  readonly assets: readonly GameWalletAsset[];
}

export interface GameRankingEntry {
  readonly principalId: string;
  readonly displayName?: string;
  readonly rank: number;
  readonly rating?: JsonValue;
}

export interface GameRankingSummary {
  readonly gameId: string;
  readonly poolId: string;
  readonly policyVersion: string;
  readonly progressionPolicyVersion: string;
  readonly entries: readonly GameRankingEntry[];
  readonly viewer?: GameRankingEntry;
}

/** Shared profile shell; game-specific fields remain bounded JSON. */
export interface GameProfileSummary {
  readonly gameId: string;
  readonly principalId: string;
  readonly displayName?: string;
  readonly stats?: JsonValue;
  readonly rank?: JsonValue;
  readonly achievements?: AchievementCollection;
  readonly wallet?: GameWallet;
  readonly rankings?: GameRankingSummary;
}
