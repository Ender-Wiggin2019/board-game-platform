import type {
  JsonValue,
  Participant,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import {
  assertParticipant,
  assertPublicPlayerProfile,
  participantAccountId,
} from '@board-game/contracts';
import type { Pool } from 'pg';
import type { GameCapabilityRegistry } from './capabilities/index.js';

const DIRECTORY_SESSIONS_TABLE =
  '"board_platform_directory"."sessions"' as const;
const ADMISSION_ROOMS_TABLE = '"board_platform_admission"."rooms"' as const;
const PAGE_SIZE = 64;

type AttentionRow = {
  readonly kind: 'session' | 'room';
  readonly row_id: unknown;
  readonly game_id: unknown;
  readonly mode_id: unknown;
  readonly release_id: unknown;
  readonly backend_binding_id: unknown;
  readonly storage_binding_id: unknown;
  readonly ownership_epoch: unknown;
  readonly status: unknown;
  readonly participants: unknown;
  readonly summary: unknown;
  readonly members: unknown;
  readonly setup: unknown;
  readonly updated_at: unknown;
};

type SessionCursor = {
  readonly updatedAt: number;
  readonly sessionId: string;
};

export interface NativeShellSummaryCounts {
  readonly actionRequired: number;
  readonly waitingReady: number;
}

/**
 * Reads only bounded public directory and room projections for one principal.
 * Game code enters through exact-release pure interpreters; no Host or codec is
 * reachable from this module.
 */
export class NativeShellSummaryReader {
  public constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly registry: GameCapabilityRegistry,
  ) {}

  public async read(
    principalId: string,
  ): Promise<ReadonlyMap<string, NativeShellSummaryCounts>> {
    const counts = new Map<
      string,
      { actionRequired: number; waitingReady: number }
    >();
    const seenSessions = new Set<string>();
    const seenRooms = new Set<string>();
    let cursor: SessionCursor | undefined;
    let roomCursor: string | undefined;
    let sessionsDone = false;
    let roomsDone = false;

    for (;;) {
      const includeSessions = !sessionsDone;
      const includeRooms = !roomsDone;
      const result = await this.pool.query<AttentionRow>(
        nativeAttentionQuery(),
        [
          principalId,
          cursor?.updatedAt ?? null,
          cursor?.sessionId ?? null,
          PAGE_SIZE,
          includeSessions,
          includeRooms,
          roomCursor ?? null,
        ],
      );
      const rows = result.rows ?? [];
      const sessionRows = rows.filter((row) => row.kind === 'session');
      const roomRows = rows.filter((row) => row.kind === 'room');
      for (const row of rows) {
        if (row.kind === 'session') {
          const session = parseSession(row);
          if (!session || seenSessions.has(session.route.sessionId)) continue;
          seenSessions.add(session.route.sessionId);
          this.countSession(session, principalId, counts);
          continue;
        }
        if (!includeRooms) continue;
        const room = parseRoom(row);
        if (!room || seenRooms.has(room.id)) continue;
        seenRooms.add(room.id);
        this.countRoom(room, principalId, counts);
      }

      if (includeSessions) {
        if (sessionRows.length < PAGE_SIZE) {
          sessionsDone = true;
        } else {
          const last = oldestSessionCursor(sessionRows);
          if (!last) sessionsDone = true;
          else cursor = last;
        }
      }
      if (includeRooms) {
        if (roomRows.length < PAGE_SIZE) {
          roomsDone = true;
        } else {
          const last = latestRoomCursor(roomRows);
          if (!last) roomsDone = true;
          else roomCursor = last;
        }
      }
      if (sessionsDone && roomsDone) break;
    }

    return new Map(
      [...counts].map(([gameId, value]) => [gameId, { ...value }]),
    );
  }

  private countSession(
    session: ParsedSession,
    principalId: string,
    counts: Map<string, { actionRequired: number; waitingReady: number }>,
  ): void {
    if (
      !session.participants.some(
        (participant) => participantAccountId(participant) === principalId,
      )
    )
      return;
    const registration = this.registration(session.route);
    const interpreter = registration?.sessionAttention;
    if (!interpreter || session.summary === null) return;
    let actionRequired = false;
    try {
      actionRequired = interpreter.interpret(session.summary, {
        principalId,
        participants: session.participants,
        route: session.route,
        status: session.status,
      });
    } catch {
      actionRequired = false;
    }
    if (actionRequired)
      this.increment(counts, session.route.gameId, 'actionRequired');
  }

  private countRoom(
    room: ParsedRoom,
    principalId: string,
    counts: Map<string, { actionRequired: number; waitingReady: number }>,
  ): void {
    if (
      !room.members.some(
        (member) => participantAccountId(member) === principalId,
      )
    )
      return;
    const registration = this.registration({
      gameId: room.gameId,
      releaseId: room.releaseId,
    });
    const capacity = registration?.sessionAttention?.roomCapacity;
    if (!capacity) return;
    let roomCapacity = 0;
    try {
      roomCapacity = capacity({ setup: room.setup });
    } catch {
      return;
    }
    if (
      !Number.isSafeInteger(roomCapacity) ||
      roomCapacity < 1 ||
      room.members.length < roomCapacity
    )
      return;
    this.increment(counts, room.gameId, 'waitingReady');
  }

  private registration(route: {
    readonly gameId: string;
    readonly releaseId: string;
  }): ReturnType<GameCapabilityRegistry['resolve']> | undefined {
    try {
      return this.registry.resolve(route.gameId, route.releaseId);
    } catch {
      return undefined;
    }
  }

  private increment(
    counts: Map<string, { actionRequired: number; waitingReady: number }>,
    gameId: string,
    field: 'actionRequired' | 'waitingReady',
  ): void {
    const current = counts.get(gameId) ?? {
      actionRequired: 0,
      waitingReady: 0,
    };
    current[field] += 1;
    counts.set(gameId, current);
  }
}

interface ParsedSession {
  readonly route: SessionRoute;
  readonly status: SessionStatus;
  readonly participants: readonly Participant[];
  readonly summary: JsonValue | null;
}

interface ParsedRoom {
  readonly id: string;
  readonly gameId: string;
  readonly releaseId: string;
  readonly setup: JsonValue;
  readonly members: readonly Participant[];
}

function nativeAttentionQuery(): string {
  return `
    WITH session_rows AS (
      SELECT
        'session'::text AS kind,
        s.session_id AS row_id,
        s.game_id,
        s.mode_id,
        s.release_id,
        s.backend_binding_id,
        s.storage_binding_id,
        s.ownership_epoch,
        s.status,
        s.participants,
        s.summary,
        NULL::jsonb AS members,
        NULL::jsonb AS setup,
        s.updated_at
      FROM ${DIRECTORY_SESSIONS_TABLE} s
      WHERE $5::boolean
        AND s.status = 'active'
        AND (
          s.participants @> jsonb_build_array(jsonb_build_object('principalId', $1::text)) OR
          s.participants @> jsonb_build_array(jsonb_build_object('controlledBy', $1::text))
        )
        AND (
          $2::double precision IS NULL OR
          (s.updated_at, s.session_id) < ($2::double precision, $3::text)
        )
      ORDER BY s.updated_at DESC, s.session_id DESC
      LIMIT $4::integer
    ),
    room_rows AS (
      SELECT
        'room'::text AS kind,
        room_row.id AS row_id,
        room_row.room->>'gameId' AS game_id,
        room_row.room->>'modeId' AS mode_id,
        room_row.room->>'releaseId' AS release_id,
        NULL::text AS backend_binding_id,
        NULL::text AS storage_binding_id,
        NULL::text AS ownership_epoch,
        room_row.room->>'status' AS status,
        NULL::jsonb AS participants,
        NULL::jsonb AS summary,
        room_row.room->'members' AS members,
        room_row.room->'setup' AS setup,
        0::double precision AS updated_at
      FROM ${ADMISSION_ROOMS_TABLE} room_row
      WHERE $6::boolean
        AND room_row.id NOT LIKE 'direct:%'
        AND room_row.room->>'status' = 'open'
        AND ($7::text IS NULL OR room_row.id > $7::text)
        AND (
          room_row.room->'members' @>
            jsonb_build_array(jsonb_build_object('principalId', $1::text)) OR
          room_row.room->'members' @>
            jsonb_build_array(jsonb_build_object('controlledBy', $1::text))
        )
      ORDER BY room_row.id ASC
      LIMIT $4::integer
    )
    SELECT * FROM session_rows
    UNION ALL
    SELECT * FROM room_rows`;
}

function parseSession(row: AttentionRow): ParsedSession | null {
  const gameId = text(row.game_id);
  const modeId = text(row.mode_id);
  const sessionId = text(row.row_id);
  const releaseId = text(row.release_id);
  const backendBindingId = text(row.backend_binding_id);
  const storageBindingId = text(row.storage_binding_id);
  const ownershipEpoch = text(row.ownership_epoch);
  const status = sessionStatus(row.status);
  const participants = participantsOf(row.participants);
  if (
    !gameId ||
    !modeId ||
    !sessionId ||
    !releaseId ||
    !backendBindingId ||
    !storageBindingId ||
    !ownershipEpoch ||
    !status ||
    participants.length === 0
  )
    return null;
  return {
    route: {
      gameId,
      modeId,
      sessionId,
      releaseId,
      backendBindingId,
      storageBindingId,
      ownershipEpoch,
    },
    status,
    participants,
    summary: row.summary === null ? null : (row.summary as JsonValue),
  };
}

function parseRoom(row: AttentionRow): ParsedRoom | null {
  const id = text(row.row_id);
  const gameId = text(row.game_id);
  const releaseId = text(row.release_id);
  const members = participantsOf(row.members, { allowReady: true });
  if (
    !id ||
    id.startsWith('direct:') ||
    row.status !== 'open' ||
    !gameId ||
    !releaseId ||
    members.length === 0
  )
    return null;
  return {
    id,
    gameId,
    releaseId,
    setup: (row.setup ?? null) as JsonValue,
    members,
  };
}

function parseSessionCursor(row: AttentionRow): SessionCursor | undefined {
  const sessionId = text(row.row_id);
  const updatedAt = Number(row.updated_at);
  if (!sessionId || !Number.isFinite(updatedAt)) return undefined;
  return { sessionId, updatedAt };
}

function parseRoomCursor(row: AttentionRow): string | undefined {
  return text(row.row_id);
}

function oldestSessionCursor(
  rows: readonly AttentionRow[],
): SessionCursor | undefined {
  let oldest: SessionCursor | undefined;
  for (const row of rows) {
    const candidate = parseSessionCursor(row);
    if (
      candidate &&
      (!oldest ||
        candidate.updatedAt < oldest.updatedAt ||
        (candidate.updatedAt === oldest.updatedAt &&
          candidate.sessionId < oldest.sessionId))
    )
      oldest = candidate;
  }
  return oldest;
}

function latestRoomCursor(rows: readonly AttentionRow[]): string | undefined {
  let latest: string | undefined;
  for (const row of rows) {
    const candidate = parseRoomCursor(row);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

function participantsOf(
  value: unknown,
  options: { readonly allowReady?: boolean } = {},
): readonly Participant[] {
  if (!Array.isArray(value)) return [];
  const participants: Participant[] = [];
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return [];
    const record = candidate as Record<string, unknown>;
    const principalId = text(record.principalId);
    const seatId = text(record.seatId);
    if (!principalId || !seatId) return [];
    const allowed = new Set([
      'principalId',
      'seatId',
      'teamId',
      'controller',
      'controlledBy',
      'controllerId',
      'controllerOptions',
      'publicProfile',
      ...(options.allowReady ? ['ready'] : []),
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) return [];
    if (
      options.allowReady &&
      record.ready !== undefined &&
      typeof record.ready !== 'boolean'
    )
      return [];
    try {
      assertParticipant(record);
    } catch {
      return [];
    }
    if (principals.has(principalId) || seats.has(seatId)) return [];
    principals.add(principalId);
    seats.add(seatId);
    if (record.publicProfile !== undefined) {
      try {
        assertPublicPlayerProfile(record.publicProfile);
      } catch {
        return [];
      }
    }
    participants.push({
      principalId,
      seatId,
      ...(text(record.teamId) ? { teamId: text(record.teamId) } : {}),
      ...(record.controller !== undefined
        ? { controller: record.controller }
        : {}),
      ...(typeof record.controlledBy === 'string'
        ? { controlledBy: record.controlledBy }
        : {}),
      ...(typeof record.controllerId === 'string'
        ? { controllerId: record.controllerId }
        : {}),
      ...(record.controllerOptions !== undefined
        ? { controllerOptions: record.controllerOptions as JsonValue }
        : {}),
      ...(record.publicProfile !== undefined
        ? { publicProfile: record.publicProfile }
        : {}),
    });
  }
  return participants;
}

function sessionStatus(value: unknown): SessionStatus | undefined {
  return value === 'suspended' ||
    value === 'active' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'paused'
    ? value
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
