import { randomUUID } from 'node:crypto';
import { contractError } from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import {
  GAME_CHAT_HISTORY_LIMIT,
  GAME_CHAT_MAX_BODY_LENGTH,
  type IGameChatHistoryPayload,
  type IGameChatMessage,
  type IGameChatReadState,
} from '@board-platform/contracts/types/protocol/gameChat';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { filterChatBody } from '@/game-chat/chatContentFilter.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_MAX_LENGTH = 200;

export interface PlatformChatTables {
  readonly scopeColumn: 'session_id' | 'room_id';
  readonly streams: string;
  readonly senderStreams: string;
  readonly messages: string;
  readonly readCursors: string;
  readonly streamSenderIndex: string;
  readonly streamRequestIndex: string;
  readonly cursorPrincipalIndex: string;
}

export type PlatformChatOperation = 'read' | 'send' | 'readCursor';

export interface PlatformChatAuthorizer {
  authorize(
    reference: PlatformIdentityReference,
    targetId: string,
    operation: PlatformChatOperation,
  ): Promise<void>;
}

interface IChatMessageRow extends QueryResultRow {
  id: string;
  target_id: string;
  chat_seq: number | string;
  sender_chat_seq: number | string;
  sender_principal_id: string;
  sender_name: string;
  body: string;
  created_at: Date | string;
}

interface IChatSnapshotRow extends QueryResultRow {
  id: string | null;
  target_id: string;
  chat_seq: number | string | null;
  sender_chat_seq: number | string | null;
  sender_principal_id: string | null;
  sender_name: string | null;
  body: string | null;
  created_at: Date | string | null;
  read_through_seq: number | string;
  through_seq: number | string;
  unread_count: number | string;
}

interface IReadStateRow extends QueryResultRow {
  read_through_seq: number | string;
  through_seq: number | string;
  unread_count: number | string;
}

type Queryable = Pick<PoolClient, 'query'>;

export interface PlatformChatSubscription {
  readonly targetId: string;
  readonly message: IGameChatMessage;
}

/** Shared durable chat storage for session and waiting-room targets. */
export class PlatformChatStore {
  private readonly subscribers = new Set<
    (hint: PlatformChatSubscription) => void
  >();

  constructor(
    private readonly pool: Pool,
    private readonly tables: PlatformChatTables,
    private readonly access: PlatformChatAuthorizer,
  ) {}

  private scope(alias: string): string {
    return `${alias}.${this.tables.scopeColumn}`;
  }

  static async migrate(pool: Pool, tables: PlatformChatTables): Promise<void> {
    // Shared social state has no game-specific storage dependency.
    await pool.query('CREATE SCHEMA IF NOT EXISTS board_platform_social');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tables.streams} (
        ${tables.scopeColumn} text PRIMARY KEY,
        last_seq bigint NOT NULL DEFAULT 0,
        read_tracking_baseline_seq bigint NOT NULL DEFAULT 0
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tables.senderStreams} (
        ${tables.scopeColumn} text NOT NULL,
        principal_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        last_sender_seq bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (${tables.scopeColumn}, principal_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tables.messages} (
        id uuid PRIMARY KEY,
        ${tables.scopeColumn} text NOT NULL,
        chat_seq bigint NOT NULL,
        sender_chat_seq bigint NOT NULL,
        sender_principal_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        sender_name text NOT NULL,
        body text NOT NULL CHECK (char_length(body) <= ${GAME_CHAT_MAX_BODY_LENGTH}),
        request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND ${REQUEST_ID_MAX_LENGTH}),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (${tables.scopeColumn}, chat_seq),
        UNIQUE (${tables.scopeColumn}, sender_principal_id, request_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${tables.streamSenderIndex}
      ON ${tables.messages} (${tables.scopeColumn}, sender_principal_id, chat_seq DESC)
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${tables.streamRequestIndex}
      ON ${tables.messages} (${tables.scopeColumn}, request_id)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tables.readCursors} (
        ${tables.scopeColumn} text NOT NULL,
        principal_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        last_read_seq bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (${tables.scopeColumn}, principal_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${tables.cursorPrincipalIndex}
      ON ${tables.readCursors} (principal_id, ${tables.scopeColumn})
    `);
  }

  /** Register a best-effort realtime hint listener; history remains durable. */
  subscribe(listener: (hint: PlatformChatSubscription) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async loadSnapshot(
    reference: PlatformIdentityReference,
    targetId: string,
  ): Promise<IGameChatHistoryPayload> {
    await this.authorize(reference, targetId);
    const result = await this.pool.query<IChatSnapshotRow>(
      `
        WITH snapshot_base AS (
          SELECT
            $1::text AS target_id,
            COALESCE(stream.last_seq, 0) AS through_seq,
            GREATEST(
              COALESCE(cursor.last_read_seq, 0),
              COALESCE(stream.read_tracking_baseline_seq, 0)
            ) AS read_through_seq
          FROM (SELECT 1) AS seed
          LEFT JOIN ${this.tables.streams} AS stream ON ${this.scope('stream')} = $1::text
          LEFT JOIN ${this.tables.readCursors} AS cursor
            ON ${this.scope('cursor')} = $1::text
            AND cursor.principal_id = $2::uuid
        ),
        snapshot AS (
          SELECT
            base.*,
            COALESCE(sender.last_sender_seq, 0) AS own_through_seq,
            COALESCE((
              SELECT message.sender_chat_seq
              FROM ${this.tables.messages} AS message
              WHERE ${this.scope('message')} = base.target_id
                AND message.sender_principal_id = $2::uuid
                AND message.chat_seq <= base.read_through_seq
              ORDER BY message.chat_seq DESC
              LIMIT 1
            ), 0) AS own_read_through_seq
          FROM snapshot_base AS base
          LEFT JOIN ${this.tables.senderStreams} AS sender
            ON ${this.scope('sender')} = base.target_id
            AND sender.principal_id = $2::uuid
        ),
        state AS (
          SELECT
            snapshot.*,
            LEAST(
              ${GAME_CHAT_HISTORY_LIMIT}::bigint,
              GREATEST(
                0::bigint,
                (snapshot.through_seq - snapshot.read_through_seq) -
                (snapshot.own_through_seq - snapshot.own_read_through_seq)
              )
            )::integer AS unread_count
          FROM snapshot
        ),
        recent_desc AS (
          SELECT message.*
          FROM ${this.tables.messages} AS message
          INNER JOIN state ON state.target_id = ${this.scope('message')}
          WHERE message.chat_seq <= state.through_seq
          ORDER BY message.chat_seq DESC
          LIMIT ${GAME_CHAT_HISTORY_LIMIT}
        ),
        recent AS (
          SELECT * FROM recent_desc ORDER BY chat_seq
        )
        SELECT
          recent.id,
          state.target_id,
          recent.chat_seq,
          recent.sender_chat_seq,
          recent.sender_principal_id,
          recent.sender_name,
          recent.body,
          recent.created_at,
          state.read_through_seq,
          state.through_seq,
          state.unread_count
        FROM state
        LEFT JOIN recent ON true
        ORDER BY recent.chat_seq NULLS LAST
      `,
      [targetId, reference.principalId],
    );
    const state = result.rows[0];
    return {
      gameId: targetId,
      messages: result.rows.flatMap((row) =>
        row.id === null ||
        row.chat_seq === null ||
        row.sender_chat_seq === null ||
        row.sender_principal_id === null ||
        row.sender_name === null ||
        row.body === null ||
        row.created_at === null
          ? []
          : [this.toMessage(row as IChatMessageRow, targetId)],
      ),
      readState: state
        ? this.toReadState(state)
        : { readThroughSeq: 0, throughSeq: 0, unreadCount: 0 },
    };
  }

  async send(
    reference: PlatformIdentityReference,
    targetId: string,
    requestId: string,
    rawBody: string,
  ): Promise<IGameChatMessage> {
    await this.authorize(reference, targetId, 'send');
    const normalizedRequestId = this.validateRequestId(requestId);
    const body = this.validateBody(rawBody);
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const senderResult = await client.query<{ name: string }>(
        'SELECT name FROM public.users WHERE id = $1::uuid',
        [reference.principalId],
      );
      const sender = senderResult.rows[0];
      if (!sender)
        throw contractError('UNAUTHENTICATED', 'platform.identity.inactive');

      // Upserting the fixed stream row serializes all writers for one session,
      // including the first writer when no row existed yet.
      await client.query(
        `INSERT INTO ${this.tables.streams} (${this.tables.scopeColumn})
         VALUES ($1)
         ON CONFLICT (${this.tables.scopeColumn})
         DO UPDATE SET last_seq = ${this.tables.streams}.last_seq`,
        [targetId],
      );
      const duplicate = await client.query<IChatMessageRow>(
        `SELECT id, ${this.tables.scopeColumn} AS target_id, chat_seq, sender_chat_seq,
                sender_principal_id, sender_name, body, created_at
         FROM ${this.tables.messages}
         WHERE ${this.tables.scopeColumn} = $1 AND request_id = $2
         FOR UPDATE`,
        [targetId, normalizedRequestId],
      );
      const existing = duplicate.rows[0];
      if (existing) {
        if (
          existing.sender_principal_id !== reference.principalId ||
          existing.body !== body
        )
          throw contractError(
            'IDEMPOTENCY_CONFLICT',
            'platform.chat.request_conflict',
          );
        await client.query('COMMIT');
        committed = true;
        return this.toMessage(existing, targetId);
      }

      const stream = await client.query<{ chat_seq: number | string }>(
        `UPDATE ${this.tables.streams}
         SET last_seq = last_seq + 1
         WHERE ${this.tables.scopeColumn} = $1
         RETURNING last_seq AS chat_seq`,
        [targetId],
      );
      const sequence = stream.rows[0]?.chat_seq;
      if (sequence === undefined)
        throw contractError('INTERNAL', 'platform.chat.stream_unavailable');
      const senderSequence = await client.query<{
        sender_chat_seq: number | string;
      }>(
        `INSERT INTO ${this.tables.senderStreams} (${this.tables.scopeColumn}, principal_id, last_sender_seq)
         VALUES ($1, $2::uuid, 1)
         ON CONFLICT (${this.tables.scopeColumn}, principal_id)
         DO UPDATE SET last_sender_seq = ${this.tables.senderStreams}.last_sender_seq + 1
         RETURNING last_sender_seq AS sender_chat_seq`,
        [targetId, reference.principalId],
      );
      const senderSeq = senderSequence.rows[0]?.sender_chat_seq;
      if (senderSeq === undefined)
        throw contractError(
          'INTERNAL',
          'platform.chat.sender_stream_unavailable',
        );
      const messageResult = await client.query<IChatMessageRow>(
        `INSERT INTO ${this.tables.messages} (
           id, ${this.tables.scopeColumn}, chat_seq, sender_chat_seq,
           sender_principal_id, sender_name, body, request_id
         ) VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8)
         RETURNING id, ${this.tables.scopeColumn} AS target_id, chat_seq, sender_chat_seq,
                   sender_principal_id, sender_name, body, created_at`,
        [
          randomUUID(),
          targetId,
          sequence,
          senderSeq,
          reference.principalId,
          sender.name,
          body,
          normalizedRequestId,
        ],
      );
      const row = messageResult.rows[0];
      if (!row)
        throw contractError('INTERNAL', 'platform.chat.message_unavailable');
      await client.query('COMMIT');
      committed = true;
      const message = this.toMessage(row, targetId);
      this.notify({ targetId, message });
      return message;
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  async markRead(
    reference: PlatformIdentityReference,
    targetId: string,
    throughMessageId: string,
  ): Promise<IGameChatReadState> {
    await this.authorize(reference, targetId, 'readCursor');
    if (!UUID_PATTERN.test(throughMessageId))
      throw contractError('INVALID_REQUEST', 'platform.chat.message_invalid');
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const target = await client.query<{ chat_seq: number | string }>(
        `SELECT chat_seq FROM ${this.tables.messages}
         WHERE id = $1::uuid AND ${this.tables.scopeColumn} = $2`,
        [throughMessageId, targetId],
      );
      const targetSequence = target.rows[0]?.chat_seq;
      if (targetSequence === undefined)
        throw contractError(
          'INVALID_REQUEST',
          'platform.chat.message_not_found',
        );
      await client.query(
        `INSERT INTO ${this.tables.readCursors} (${this.tables.scopeColumn}, principal_id, last_read_seq)
         VALUES ($1, $2::uuid, $3)
         ON CONFLICT (${this.tables.scopeColumn}, principal_id)
         DO UPDATE SET
           last_read_seq = GREATEST(${this.tables.readCursors}.last_read_seq, EXCLUDED.last_read_seq),
           updated_at = CASE
             WHEN ${this.tables.readCursors}.last_read_seq < EXCLUDED.last_read_seq
             THEN now() ELSE ${this.tables.readCursors}.updated_at END`,
        [targetId, reference.principalId, targetSequence],
      );
      const state = await this.readState(
        client,
        targetId,
        reference.principalId,
      );
      await client.query('COMMIT');
      committed = true;
      return state;
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  private async authorize(
    reference: PlatformIdentityReference,
    targetId: string,
    operation: PlatformChatOperation = 'read',
  ): Promise<void> {
    if (!UUID_PATTERN.test(reference.principalId))
      throw contractError('UNAUTHENTICATED', 'platform.identity.inactive');
    if (
      typeof targetId !== 'string' ||
      targetId.trim() !== targetId ||
      !targetId
    )
      throw contractError('INVALID_REQUEST', 'platform.session.identifier');
    await this.access.authorize(reference, targetId, operation);
  }

  private validateRequestId(value: string): string {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value ||
      value.length > REQUEST_ID_MAX_LENGTH
    )
      throw contractError('INVALID_REQUEST', 'platform.chat.request_invalid');
    return value;
  }

  private validateBody(value: string): string {
    if (typeof value !== 'string')
      throw contractError('INVALID_REQUEST', 'platform.chat.body_invalid');
    const body = filterChatBody(value.trim());
    if (!body)
      throw contractError('INVALID_REQUEST', 'platform.chat.body_required');
    if (body.length > GAME_CHAT_MAX_BODY_LENGTH)
      throw contractError('INVALID_REQUEST', 'platform.chat.body_invalid');
    return body;
  }

  private async readState(
    client: Queryable,
    targetId: string,
    principalId: string,
  ): Promise<IGameChatReadState> {
    const result = await client.query<IReadStateRow>(
      `
        WITH snapshot AS (
          SELECT
            COALESCE(stream.last_seq, 0) AS through_seq,
            GREATEST(
              COALESCE(cursor.last_read_seq, 0),
              COALESCE(stream.read_tracking_baseline_seq, 0)
            ) AS read_through_seq,
            COALESCE(sender.last_sender_seq, 0) AS own_through_seq,
            COALESCE((
              SELECT message.sender_chat_seq
              FROM ${this.tables.messages} AS message
              WHERE ${this.scope('message')} = $1
                AND message.sender_principal_id = $2::uuid
                AND message.chat_seq <= GREATEST(
                  COALESCE(cursor.last_read_seq, 0),
                  COALESCE(stream.read_tracking_baseline_seq, 0)
                )
              ORDER BY message.chat_seq DESC
              LIMIT 1
            ), 0) AS own_read_through_seq
          FROM (SELECT 1) AS seed
          LEFT JOIN ${this.tables.streams} AS stream ON ${this.scope('stream')} = $1
          LEFT JOIN ${this.tables.readCursors} AS cursor
            ON ${this.scope('cursor')} = $1 AND cursor.principal_id = $2::uuid
          LEFT JOIN ${this.tables.senderStreams} AS sender
            ON ${this.scope('sender')} = $1 AND sender.principal_id = $2::uuid
        )
        SELECT
          read_through_seq,
          through_seq,
          LEAST(
            ${GAME_CHAT_HISTORY_LIMIT}::bigint,
            GREATEST(
              0::bigint,
              (through_seq - read_through_seq) -
              (own_through_seq - own_read_through_seq)
            )
          )::integer AS unread_count
        FROM snapshot
      `,
      [targetId, principalId],
    );
    const row = result.rows[0];
    return row
      ? this.toReadState(row)
      : { readThroughSeq: 0, throughSeq: 0, unreadCount: 0 };
  }

  private toMessage(row: IChatMessageRow, targetId: string): IGameChatMessage {
    return {
      id: row.id,
      gameId: targetId,
      sequence: Number(row.chat_seq),
      senderUserId: row.sender_principal_id,
      senderName: row.sender_name,
      body: row.body,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString(),
    };
  }

  private toReadState(row: {
    read_through_seq: number | string;
    through_seq: number | string;
    unread_count: number | string;
  }): IGameChatReadState {
    return {
      readThroughSeq: Number(row.read_through_seq),
      throughSeq: Number(row.through_seq),
      unreadCount: Number(row.unread_count),
    };
  }

  private notify(hint: PlatformChatSubscription): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(hint);
      } catch {
        // A realtime hint cannot change the durable send result.
      }
    }
  }
}
