export const GAME_CHAT_MAX_BODY_LENGTH = 500;
export const GAME_CHAT_HISTORY_LIMIT = 100;

export interface IGameChatMessage {
  id: string;
  gameId: string;
  sequence: number;
  senderUserId: string;
  senderName: string;
  body: string;
  createdAt: string;
}

export interface IGameChatReadState {
  readThroughSeq: number;
  throughSeq: number;
  unreadCount: number;
}

export interface IGameChatHistoryPayload {
  gameId: string;
  messages: IGameChatMessage[];
  readState: IGameChatReadState;
}

export interface IGameChatNewPayload {
  message: IGameChatMessage;
}

export interface IGameChatSendPayload {
  gameId: string;
  body: string;
}

export interface IGameChatSyncPayload {
  gameId: string;
}

export interface IGameChatReadPayload {
  gameId: string;
  throughMessageId: string;
}

export interface IGameChatReadStatePayload {
  gameId: string;
  readState: IGameChatReadState;
}
