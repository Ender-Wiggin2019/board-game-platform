import { contractError } from '@board-game/contracts';
import type {
  PlatformIdentityReference,
  SessionGateway,
} from '@board-game/core';
import {
  GAME_NOTE_MAX_LENGTH,
  type IGameNoteResponse,
} from '@board-platform/contracts/types/protocol/notes';
import type { Pool } from 'pg';

/** Private player notes stay outside game state, events, and public facts. */
export class PlatformSessionNotes {
  constructor(
    private readonly pool: Pool,
    private readonly sessions: Pick<SessionGateway, 'descriptor'>,
  ) {}

  static async migrate(pool: Pool): Promise<void> {
    await pool.query('CREATE SCHEMA IF NOT EXISTS board_platform_social');
    await pool.query(`CREATE TABLE IF NOT EXISTS board_platform_social.session_notes (
      session_id text NOT NULL,
      principal_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      content text NOT NULL CHECK (char_length(content) <= ${GAME_NOTE_MAX_LENGTH}),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, principal_id)
    )`);
  }

  async get(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<IGameNoteResponse> {
    await this.sessions.descriptor(reference, sessionId);
    const result = await this.pool.query<{ content: string; updated_at: Date }>(
      'SELECT content, updated_at FROM board_platform_social.session_notes WHERE session_id = $1 AND principal_id = $2',
      [sessionId, reference.principalId],
    );
    const row = result.rows[0];
    return {
      content: row?.content ?? '',
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  async save(
    reference: PlatformIdentityReference,
    sessionId: string,
    content: string,
  ): Promise<IGameNoteResponse> {
    if (typeof content !== 'string' || content.length > GAME_NOTE_MAX_LENGTH)
      throw contractError('INVALID_REQUEST', 'platform.note.content_invalid');
    await this.sessions.descriptor(reference, sessionId);
    const result = await this.pool.query<{ content: string; updated_at: Date }>(
      `INSERT INTO board_platform_social.session_notes (session_id, principal_id, content)
       VALUES ($1, $2, $3) ON CONFLICT (session_id, principal_id)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now() RETURNING content, updated_at`,
      [sessionId, reference.principalId, content],
    );
    const row = result.rows[0];
    return { content: row.content, updatedAt: row.updated_at.toISOString() };
  }
}
