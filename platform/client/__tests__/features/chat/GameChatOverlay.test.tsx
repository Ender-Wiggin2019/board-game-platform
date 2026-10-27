import type { IGameChatMessage } from '@board-platform/contracts/types/protocol/gameChat';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GameChatOverlay } from '@/features/chat/GameChatOverlay';

function createChat(message: IGameChatMessage) {
  return {
    messages: [message],
    open: true,
    unreadCount: 0,
    setOpen: vi.fn(),
    sendMessage: vi.fn(),
  };
}

describe('GameChatOverlay', () => {
  it('keeps sender profiles inside the current game workspace', () => {
    render(
      <GameChatOverlay
        chat={createChat({
          id: 'message-1',
          gameId: 'room-session-1',
          sequence: 1,
          senderUserId: 'other-user',
          senderName: 'Other',
          body: 'Ready.',
          createdAt: '2026-06-18T10:00:00.000Z',
        })}
        gameId='brass-pittsburgh'
      />,
    );

    expect(screen.getByRole('link', { name: 'Other' })).toHaveAttribute(
      'href',
      '/games/brass-pittsburgh/profile?principalId=other-user',
    );
  });
});
