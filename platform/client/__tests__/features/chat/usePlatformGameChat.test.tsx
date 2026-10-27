import type {
  IGameChatHistoryPayload,
  IGameChatMessage,
} from '@board-platform/contracts/types/protocol/gameChat';
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  usePlatformChat,
  usePlatformGameChat,
} from '@/features/chat/usePlatformGameChat';
import { PlatformConfigurationProvider } from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';

const SESSION_ID = 'session-platform-chat';
const ROOM_ID = 'room-platform-chat';

const chatChanged = vi.hoisted(() => ({
  handler: null as ((payload: { sequence: number }) => void) | null,
}));
const roomChatChanged = vi.hoisted(() => ({
  handler: null as ((payload: { sequence: number }) => void) | null,
}));

const platformApiMock = vi.hoisted(() => ({
  getChat: vi.fn(),
  markChatRead: vi.fn(),
  sendChat: vi.fn(),
  getRoomChat: vi.fn(),
  markRoomChatRead: vi.fn(),
  sendRoomChat: vi.fn(),
}));

vi.mock('@/api/platformApi', () => ({
  createPlatformRequestId: vi.fn(() => 'chat-request-1'),
  platformApi: platformApiMock,
}));

vi.mock('@/api/platformSocket', () => ({
  platformSocket: {
    onPlatformChatChanged: vi.fn(
      (sessionId: string, handler: (payload: { sequence: number }) => void) => {
        expect(sessionId).toBe(SESSION_ID);
        chatChanged.handler = handler;
        return vi.fn();
      },
    ),
    onPlatformRoomChatChanged: vi.fn(
      (roomId: string, handler: (payload: { sequence: number }) => void) => {
        expect(roomId).toBe(ROOM_ID);
        roomChatChanged.handler = handler;
        return vi.fn();
      },
    ),
  },
}));

function message(overrides?: Partial<IGameChatMessage>): IGameChatMessage {
  return {
    id: 'message-1',
    gameId: SESSION_ID,
    sequence: 1,
    senderUserId: 'other-user',
    senderName: 'Other',
    body: 'Ready.',
    createdAt: '2026-06-18T10:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  messages: IGameChatMessage[] = [message()],
  unreadCount = messages.length,
  gameId = SESSION_ID,
): IGameChatHistoryPayload {
  const throughSeq = messages.at(-1)?.sequence ?? 0;
  return {
    gameId,
    messages,
    readState: {
      readThroughSeq: 0,
      throughSeq,
      unreadCount,
    },
  };
}

describe('usePlatformGameChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatChanged.handler = null;
    roomChatChanged.handler = null;
    useAuthStore.getState().login('token', {
      id: 'current-user',
      name: 'Current',
      email: 'current@example.test',
    });
    platformApiMock.getChat.mockResolvedValue(snapshot());
    platformApiMock.markChatRead.mockResolvedValue({
      readThroughSeq: 1,
      throughSeq: 1,
      unreadCount: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads durable chat snapshots, refreshes on platform chat hints, and marks read', async () => {
    const next = message({ id: 'message-2', sequence: 2, body: 'Copy.' });
    platformApiMock.getChat
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([message(), next], 2));

    const { result } = renderHook(() => usePlatformGameChat(SESSION_ID));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => result.current.setOpen(true));
    await waitFor(() =>
      expect(platformApiMock.markChatRead).toHaveBeenCalledWith(
        SESSION_ID,
        'message-1',
      ),
    );
    expect(result.current.unreadCount).toBe(0);

    act(() => chatChanged.handler?.({ sequence: 2 }));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(platformApiMock.getChat).toHaveBeenCalledTimes(2);
  });

  it('retries an uncertain send with the same request id and body', async () => {
    vi.useFakeTimers();
    const sent = message({ id: 'message-2', sequence: 2, body: 'Hello.' });
    platformApiMock.sendChat
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(sent);
    const { result } = renderHook(() => usePlatformGameChat(SESSION_ID));

    await act(async () => {
      result.current.sendMessage('  Hello.  ');
      await Promise.resolve();
    });
    expect(platformApiMock.sendChat).toHaveBeenCalledTimes(1);
    expect(platformApiMock.sendChat).toHaveBeenLastCalledWith(
      SESSION_ID,
      'chat-request-1',
      'Hello.',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(platformApiMock.sendChat).toHaveBeenCalledTimes(2);
    expect(platformApiMock.sendChat).toHaveBeenLastCalledWith(
      SESSION_ID,
      'chat-request-1',
      'Hello.',
    );
  });

  it('drops an in-flight snapshot when the authenticated identity changes', async () => {
    let resolve!: (payload: IGameChatHistoryPayload) => void;
    let calls = 0;
    platformApiMock.getChat.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<IGameChatHistoryPayload>((promiseResolve) => {
          resolve = promiseResolve;
        });
      }
      return Promise.resolve(
        snapshot([
          message({
            id: 'new-account-message',
            senderUserId: 'new-user',
          }),
        ]),
      );
    });
    const { result, rerender } = renderHook(() =>
      usePlatformGameChat(SESSION_ID),
    );

    act(() => {
      useAuthStore.getState().login('other-token', {
        id: 'other-user',
        name: 'Other account',
        email: 'other-account@example.test',
      });
    });
    rerender();
    await waitFor(() =>
      expect(platformApiMock.getChat).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    await act(async () => {
      resolve(snapshot());
      await Promise.resolve();
    });
    expect(result.current.messages[0]?.id).toBe('new-account-message');
  });

  it('reads room chat for public viewers but gates writes by membership', async () => {
    const next = message({
      id: 'room-message-2',
      gameId: ROOM_ID,
      sequence: 2,
      body: 'Welcome.',
    });
    platformApiMock.getRoomChat
      .mockResolvedValueOnce(snapshot([], 0, ROOM_ID))
      .mockResolvedValueOnce(snapshot([next], 1, ROOM_ID));
    platformApiMock.sendRoomChat.mockResolvedValue(next);

    const { result, rerender } = renderHook(
      ({ canSend }: { canSend: boolean }) =>
        usePlatformChat(ROOM_ID, 'room', canSend),
      { initialProps: { canSend: false } },
    );
    await waitFor(() =>
      expect(platformApiMock.getRoomChat).toHaveBeenCalledWith(ROOM_ID),
    );
    expect(result.current.canSend).toBe(false);
    act(() => result.current.sendMessage('Not admitted'));
    expect(platformApiMock.sendRoomChat).not.toHaveBeenCalled();

    rerender({ canSend: true });
    expect(result.current.canSend).toBe(true);
    act(() => result.current.sendMessage('Hello room.'));
    expect(platformApiMock.sendRoomChat).toHaveBeenCalledTimes(1);

    act(() => roomChatChanged.handler?.({ sequence: 1 }));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(platformApiMock.getRoomChat).toHaveBeenCalledTimes(2);
  });

  it('does not advertise sending or issue writes without a native session target', () => {
    const { result } = renderHook(() => usePlatformGameChat(null));

    expect(result.current.canSend).toBe(false);
    act(() => result.current.sendMessage('No target'));
    expect(platformApiMock.sendChat).not.toHaveBeenCalled();
  });

  it('does not load or subscribe to chat when the platform feature is disabled', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <PlatformConfigurationProvider
        value={{
          brand: { name: 'Orbit Table' },
          features: { chat: false, rankings: true },
        }}
      >
        {children}
      </PlatformConfigurationProvider>
    );
    const { result } = renderHook(() => usePlatformGameChat(SESSION_ID), {
      wrapper,
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.canSend).toBe(false);
    act(() => result.current.sendMessage('Not available'));
    expect(platformApiMock.getChat).not.toHaveBeenCalled();
    expect(platformApiMock.sendChat).not.toHaveBeenCalled();
  });
});
