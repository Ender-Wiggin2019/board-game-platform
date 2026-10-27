import { contractError } from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type {
  IGameChatHistoryPayload,
  IGameChatMessage,
  IGameChatReadState,
} from '@board-platform/contracts/types/protocol/gameChat';
import type { Pool } from 'pg';
import {
  type PlatformChatOperation,
  PlatformChatStore,
  type PlatformChatSubscription,
  type PlatformChatTables,
} from './PlatformChatStore.js';

const ROOM_CHAT_TABLES = {
  scopeColumn: 'room_id',
  streams: 'board_platform_social.room_chat_streams',
  senderStreams: 'board_platform_social.room_chat_sender_streams',
  messages: 'board_platform_social.room_chat_messages',
  readCursors: 'board_platform_social.room_chat_read_cursors',
  streamSenderIndex: 'room_chat_messages_room_sender_seq_idx',
  streamRequestIndex: 'room_chat_messages_room_request_idx',
  cursorPrincipalIndex: 'room_chat_read_cursors_principal_room_idx',
} as const satisfies PlatformChatTables;

export interface PlatformRoomChatSubscription {
  readonly roomId: string;
  readonly message: IGameChatMessage;
}

/**
 * Server-side authorization for waiting-room chat. The callback must recheck
 * current room visibility/membership on every operation. In particular,
 * private rooms must reject users who have left or were kicked.
 */
export interface PlatformRoomChatAccess {
  authorize(
    reference: PlatformIdentityReference,
    roomId: string,
    operation: PlatformChatOperation,
  ): Promise<void>;
}

/** Room chat uses the same bounded history, filtering, and idempotent store as session chat. */
export class PlatformRoomChat {
  private readonly store: PlatformChatStore;

  public constructor(pool: Pool, access: PlatformRoomChatAccess) {
    this.store = new PlatformChatStore(pool, ROOM_CHAT_TABLES, {
      authorize: async (reference, roomId, operation) => {
        await access.authorize(reference, roomId, operation);
      },
    });
  }

  public static migrate(pool: Pool): Promise<void> {
    return PlatformChatStore.migrate(pool, ROOM_CHAT_TABLES);
  }

  public subscribe(
    listener: (hint: PlatformRoomChatSubscription) => void,
  ): () => void {
    return this.store.subscribe((hint: PlatformChatSubscription) =>
      listener({ roomId: hint.targetId, message: hint.message }),
    );
  }

  public loadSnapshot(
    reference: PlatformIdentityReference,
    roomId: string,
  ): Promise<IGameChatHistoryPayload> {
    return this.store.loadSnapshot(reference, roomId);
  }

  public send(
    reference: PlatformIdentityReference,
    roomId: string,
    requestId: string,
    body: string,
  ): Promise<IGameChatMessage> {
    return this.store.send(reference, roomId, requestId, body);
  }

  public markRead(
    reference: PlatformIdentityReference,
    roomId: string,
    throughMessageId: string,
  ): Promise<IGameChatReadState> {
    return this.store.markRead(reference, roomId, throughMessageId);
  }

  /** Helper for room adapters that model authorization as a boolean. */
  public static accessFromBoolean(
    authorize: (
      reference: PlatformIdentityReference,
      roomId: string,
      operation: PlatformChatOperation,
    ) => Promise<boolean>,
  ): PlatformRoomChatAccess {
    return {
      authorize: async (reference, roomId, operation) => {
        if (!(await authorize(reference, roomId, operation)))
          throw contractError('FORBIDDEN', 'platform.room.chat_denied');
      },
    };
  }
}
