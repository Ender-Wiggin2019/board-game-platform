import { describe, expect, it } from 'vitest';
import {
  GAME_CHAT_HISTORY_LIMIT,
  GAME_CHAT_MAX_BODY_LENGTH,
  type IGameChatHistoryPayload,
  type IGameChatMessage,
  type IGameChatReadState,
} from '../../../src/types/protocol/gameChat.js';

describe('game chat protocol', () => {
  it('defines bounded live chat payloads independent of a game implementation', () => {
    const message: IGameChatMessage = {
      id: 'chat-1',
      gameId: 'game-1',
      sequence: 7,
      senderUserId: 'user-1',
      senderName: 'Alice',
      body: 'Ready for the next round.',
      createdAt: '2026-06-18T10:00:00.000Z',
    };
    const readState: IGameChatReadState = {
      readThroughSeq: 5,
      throughSeq: 7,
      unreadCount: 2,
    };
    const history: IGameChatHistoryPayload = {
      gameId: 'game-1',
      messages: [message],
      readState,
    };

    expect(GAME_CHAT_MAX_BODY_LENGTH).toBe(500);
    expect(GAME_CHAT_HISTORY_LIMIT).toBe(100);
    expect(history.messages).toEqual([message]);
  });
});
