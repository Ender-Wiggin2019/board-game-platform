/**
 * Compatibility exports for legacy platform/game entries.
 *
 * The implementation lives in @board-game/components so new games can use
 * the session provider without depending on the browser platform package.
 */
export {
  type GameSessionContextValue,
  GameSessionProvider,
  type GameSessionProviderProps,
  PlatformGameProvider,
  type PlatformGameProviderProps,
  type PlatformGameSessionContextValue,
  useGameSession,
  usePlatformGameSession,
} from '@board-game/components';
