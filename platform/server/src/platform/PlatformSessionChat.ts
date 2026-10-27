import type {
  PlatformIdentityReference,
  SessionGateway,
} from '@board-game/core';
import type {
  IGameChatHistoryPayload,
  IGameChatMessage,
  IGameChatReadState,
} from '@board-platform/contracts/types/protocol/gameChat';
import type { Pool } from 'pg';
import {
  PlatformChatStore,
  type PlatformChatSubscription,
  type PlatformChatTables,
} from './PlatformChatStore.js';

const SESSION_CHAT_TABLES = {
  scopeColumn: 'session_id',
  streams: 'board_platform_social.session_chat_streams',
  senderStreams: 'board_platform_social.session_chat_sender_streams',
  messages: 'board_platform_social.session_chat_messages',
  readCursors: 'board_platform_social.session_chat_read_cursors',
  streamSenderIndex: 'session_chat_messages_session_sender_seq_idx',
  streamRequestIndex: 'session_chat_messages_session_request_idx',
  cursorPrincipalIndex: 'session_chat_read_cursors_principal_session_idx',
} as const satisfies PlatformChatTables;

export interface PlatformSessionChatSubscription {
  readonly sessionId: string;
  readonly message: IGameChatMessage;
}

/** Session-scoped native chat. Authorization stays with SessionGateway. */
export class PlatformSessionChat {
  private readonly store: PlatformChatStore;

  public constructor(pool: Pool, sessions: Pick<SessionGateway, 'descriptor'>) {
    this.store = new PlatformChatStore(pool, SESSION_CHAT_TABLES, {
      authorize: (reference, sessionId) =>
        sessions.descriptor(reference, sessionId).then(() => undefined),
    });
  }

  public static migrate(pool: Pool): Promise<void> {
    return PlatformChatStore.migrate(pool, SESSION_CHAT_TABLES);
  }

  public subscribe(
    listener: (hint: PlatformSessionChatSubscription) => void,
  ): () => void {
    return this.store.subscribe((hint: PlatformChatSubscription) =>
      listener({ sessionId: hint.targetId, message: hint.message }),
    );
  }

  public loadSnapshot(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<IGameChatHistoryPayload> {
    return this.store.loadSnapshot(reference, sessionId);
  }

  public send(
    reference: PlatformIdentityReference,
    sessionId: string,
    requestId: string,
    body: string,
  ): Promise<IGameChatMessage> {
    return this.store.send(reference, sessionId, requestId, body);
  }

  public markRead(
    reference: PlatformIdentityReference,
    sessionId: string,
    throughMessageId: string,
  ): Promise<IGameChatReadState> {
    return this.store.markRead(reference, sessionId, throughMessageId);
  }
}
