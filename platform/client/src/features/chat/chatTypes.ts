import type { IGameChatMessage } from '@board-platform/contracts/types/protocol/gameChat';

export interface IUseGameChatResult {
  messages: IGameChatMessage[];
  open: boolean;
  unreadCount: number;
  setOpen: (open: boolean) => void;
  sendMessage: (body: string) => void;
  /** Native room chat can be readable while writes are membership-gated. */
  canSend?: boolean;
}
