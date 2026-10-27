import { usePlatformConfiguration } from '../../providers/PlatformConfiguration.js';
import { GameChatOverlay } from './GameChatOverlay.js';
import { usePlatformGameChat } from './usePlatformGameChat.js';

/** One platform-owned chat subscription per participant session entry. */
export function PlatformSessionChat({
  sessionId,
}: {
  readonly sessionId: string;
}): React.JSX.Element | null {
  const { features } = usePlatformConfiguration();
  const chat = usePlatformGameChat(sessionId);
  if (!features.chat) return null;
  return <GameChatOverlay chat={chat} gameId={sessionId} />;
}
