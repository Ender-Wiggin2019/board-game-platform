import { usePlatformConfiguration } from '../../providers/PlatformConfiguration.js';
import type { IUseGameChatResult } from './chatTypes.js';
import { usePlatformChat } from './usePlatformGameChat.js';

/** Durable waiting-room chat. Read access follows the room view; writes are
 * enabled only while the current viewer is an admitted open-room member. */
export function usePlatformRoomChat(
  roomId: string | null,
  canSend: boolean,
): IUseGameChatResult {
  const { features } = usePlatformConfiguration();
  return usePlatformChat(features.chat ? roomId : null, 'room', canSend);
}
