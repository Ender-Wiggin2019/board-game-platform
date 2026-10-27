import {
  contractError,
  isPlatformError,
  type MatchAdmission,
  type PlatformRoom,
} from '@board-game/contracts';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type {
  RoomAccessGrant,
  RoomAccessSnapshot,
  RoomCreateReceipt,
  RoomInvitationCandidateList,
  RoomInvitationListRequest,
  RoomManagementStore,
  RoomManagementTransaction,
  RoomSecurityRecord,
} from '../rooms/types.js';
import {
  assertInitialRoomGrants,
  assertRoom,
  assertRoomAccessGrant,
  assertRoomCreateReceipt,
  assertStart,
  copy,
  transactionView,
} from './invariants.js';
import type {
  AdmissionStore,
  RoomListRequest,
  RoomListResult,
  RoomTransaction,
  StartOperation,
} from './types.js';

const DEFAULT_SCHEMA = 'board_platform_admission';
const MAX_PENDING = 1_000;
const DEFAULT_ROOM_LIMIT = 20;
const MAX_ROOM_LIMIT = 100;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

type Row = Record<string, unknown>;

export interface PostgresAdmissionStoreOptions {
  readonly connectionString?: string;
  readonly pool?: Pool;
  readonly poolConfig?: PoolConfig;
  readonly schema?: string;
  /** Reuse an application-owned transaction client for authorization reads. */
  readonly readConnection?: () => Pick<PoolClient, 'query'> | undefined;
  /** Runs room transaction callbacks inside an application-owned context. */
  readonly runInTransactionContext?: <T>(
    client: PoolClient,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

function assertSchemaName(schema: string): void {
  if (!IDENTIFIER.test(schema))
    throw contractError(
      'INVALID_REQUEST',
      'platform.admission.schema_name_invalid',
    );
}

function quoteIdentifier(identifier: string): string {
  assertSchemaName(identifier);
  return `"${identifier}"`;
}

function tableName(
  schema: string,
  table:
    | 'rooms'
    | 'starts'
    | 'room_security'
    | 'room_grants'
    | 'room_create_receipts',
): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PENDING)
    throw contractError('INVALID_REQUEST', 'platform.admission.pending_limit');
}

function roomLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_ROOM_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ROOM_LIMIT)
    throw contractError('INVALID_REQUEST', 'platform.admission.room_limit');
  return value;
}

function assertId(value: string, key: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw contractError('INVALID_REQUEST', `platform.admission.${key}`);
}

function assertOptionalId(value: string | undefined, key: string): void {
  if (value !== undefined) assertId(value, key);
}

function asDatabaseError(error: unknown): Error {
  if (isPlatformError(error)) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && code === undefined) return error;
  if (code === '23505')
    return contractError('CONFLICT', 'platform.admission.unique');
  if (code === '23503')
    return contractError('CONFLICT', 'platform.admission.reference');
  if (code === '40001' || code === '40P01')
    return contractError('CONFLICT', 'platform.admission.retry', true);
  if (code === '42P01' || code === '3F000')
    return contractError('INTERNAL', 'platform.admission.schema_required');
  return contractError('INTERNAL', 'platform.admission.database');
}

function jsonValue(row: Row, key: string): unknown {
  const value = row[key];
  if (typeof value !== 'string') return copy(value);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw contractError('INTERNAL', `platform.admission.${key}_invalid`);
  }
}

function grantFromRow(row: Row): RoomAccessGrant {
  const grantId = row.grant_id;
  const roomId = row.room_id;
  const principalId = row.principal_id;
  const seatId = row.seat_id;
  const state = row.state;
  if (
    typeof grantId !== 'string' ||
    typeof roomId !== 'string' ||
    typeof principalId !== 'string' ||
    (seatId !== null && seatId !== undefined && typeof seatId !== 'string') ||
    (state !== 'pending' && state !== 'accepted' && state !== 'revoked')
  )
    throw contractError('INTERNAL', 'platform.room.grant_invalid');
  return {
    grantId,
    roomId,
    principalId,
    ...(seatId ? { seatId } : {}),
    state,
  };
}

function roomCreateReceiptFromRow(row: Row): RoomCreateReceipt {
  const principalId = row.principal_id;
  const requestId = row.request_id;
  const requestDigest = row.request_digest;
  const roomId = row.room_id;
  const originalPasswordHash = row.original_password_hash;
  if (
    typeof principalId !== 'string' ||
    typeof requestId !== 'string' ||
    typeof requestDigest !== 'string' ||
    typeof roomId !== 'string' ||
    (originalPasswordHash !== null &&
      originalPasswordHash !== undefined &&
      typeof originalPasswordHash !== 'string')
  )
    throw contractError('INTERNAL', 'platform.room.create_receipt_invalid');
  return {
    principalId,
    requestId,
    requestDigest,
    roomId,
    ...(originalPasswordHash ? { originalPasswordHash } : {}),
  };
}

function roomFromRow(row: Row): PlatformRoom {
  const room = jsonValue(row, 'room');
  assertRoom(room as PlatformRoom);
  return copy(room as PlatformRoom);
}

function startFromRow(row: Row, room: PlatformRoom): StartOperation {
  const start = jsonValue(row, 'start');
  assertStart(start as StartOperation, room);
  return copy(start as StartOperation);
}

/** Durable admission persistence. Construction validates only local options; I/O starts at migrate or a store operation. */
export class PostgresAdmissionStore
  implements AdmissionStore, RoomManagementStore
{
  readonly schema: string;
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly readConnection?: PostgresAdmissionStoreOptions['readConnection'];
  private readonly runInTransactionContext?: PostgresAdmissionStoreOptions['runInTransactionContext'];

  constructor(options: PostgresAdmissionStoreOptions | string = {}) {
    const normalized =
      typeof options === 'string' ? { connectionString: options } : options;
    this.schema = normalized.schema ?? DEFAULT_SCHEMA;
    assertSchemaName(this.schema);
    this.readConnection = normalized.readConnection;
    this.runInTransactionContext = normalized.runInTransactionContext;
    if (normalized.pool) {
      this.pool = normalized.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool({
        ...normalized.poolConfig,
        connectionString:
          normalized.connectionString ??
          normalized.poolConfig?.connectionString,
      });
      this.ownsPool = true;
    }
  }

  /** Apply the small, explicit schema migration. The constructor never calls this. */
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of this.migrationStatements())
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  /** Verify the required tables and JSON/status columns without changing schema. */
  async validateSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])`,
        [
          this.schema,
          [
            'rooms',
            'starts',
            'room_security',
            'room_grants',
            'room_create_receipts',
          ],
        ],
      );
      const foundTables = new Set(tables.rows.map((row) => row.table_name));
      if (
        !foundTables.has('rooms') ||
        !foundTables.has('starts') ||
        !foundTables.has('room_security') ||
        !foundTables.has('room_grants') ||
        !foundTables.has('room_create_receipts')
      )
        throw contractError('INTERNAL', 'platform.admission.schema_required');
      const columns = await client.query<{
        table_name: string;
        column_name: string;
      }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])`,
        [
          this.schema,
          [
            'rooms',
            'starts',
            'room_security',
            'room_grants',
            'room_create_receipts',
          ],
        ],
      );
      const byTable = new Map<string, Set<string>>();
      for (const row of columns.rows) {
        const current = byTable.get(row.table_name) ?? new Set<string>();
        current.add(row.column_name);
        byTable.set(row.table_name, current);
      }
      const rooms = byTable.get('rooms') ?? new Set<string>();
      const starts = byTable.get('starts') ?? new Set<string>();
      const security = byTable.get('room_security') ?? new Set<string>();
      const grants = byTable.get('room_grants') ?? new Set<string>();
      const receipts = byTable.get('room_create_receipts') ?? new Set<string>();
      if (
        !rooms.has('id') ||
        !rooms.has('room') ||
        !starts.has('room_id') ||
        !starts.has('start_generation') ||
        !starts.has('session_id') ||
        !starts.has('status') ||
        !starts.has('start') ||
        !security.has('room_id') ||
        !security.has('password_hash') ||
        !grants.has('grant_id') ||
        !grants.has('room_id') ||
        !grants.has('principal_id') ||
        !grants.has('seat_id') ||
        !grants.has('state') ||
        !receipts.has('principal_id') ||
        !receipts.has('request_id') ||
        !receipts.has('request_digest') ||
        !receipts.has('room_id') ||
        !receipts.has('original_password_hash')
      )
        throw contractError('INTERNAL', 'platform.admission.schema_invalid');
    } catch (error) {
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async createRoom(room: PlatformRoom): Promise<void> {
    await this.createRoomWithAccess(room, {});
  }

  async createRoomWithAccess(
    room: PlatformRoom,
    security: RoomSecurityRecord,
    initialGrants: readonly RoomAccessGrant[] = [],
    receipt?: RoomCreateReceipt,
  ): Promise<void> {
    assertRoom(room);
    assertInitialRoomGrants(room.id, initialGrants);
    if (receipt) assertRoomCreateReceipt(room.id, receipt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (receipt)
        await client.query(
          `INSERT INTO ${tableName(this.schema, 'room_create_receipts')}
            (principal_id, request_id, request_digest, room_id, original_password_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            receipt.principalId,
            receipt.requestId,
            receipt.requestDigest,
            receipt.roomId,
            receipt.originalPasswordHash ?? null,
          ],
        );
      await client.query(
        `INSERT INTO ${tableName(this.schema, 'rooms')} (id, room)
         VALUES ($1, $2::jsonb)`,
        [room.id, JSON.stringify(copy(room))],
      );
      await client.query(
        `INSERT INTO ${tableName(this.schema, 'room_security')} (room_id, password_hash)
         VALUES ($1, $2)`,
        [room.id, security.passwordHash ?? null],
      );
      for (const grant of initialGrants)
        await client.query(
          `INSERT INTO ${tableName(this.schema, 'room_grants')}
            (grant_id, room_id, principal_id, seat_id, state)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            grant.grantId,
            room.id,
            grant.principalId,
            grant.seatId ?? null,
            grant.state,
          ],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async getRoomCreateReceipt(
    principalId: string,
    requestId: string,
  ): Promise<RoomCreateReceipt | null> {
    assertId(principalId, 'principal_id');
    assertId(requestId, 'request_id');
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT principal_id, request_id, request_digest, room_id,
                original_password_hash
           FROM ${tableName(this.schema, 'room_create_receipts')}
          WHERE principal_id = $1 AND request_id = $2`,
        [principalId, requestId],
      );
      return result.rows[0]
        ? roomCreateReceiptFromRow(result.rows[0] as Row)
        : null;
    });
  }

  async getRoom(id: string): Promise<PlatformRoom | null> {
    assertId(id, 'room_id');
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT room FROM ${tableName(this.schema, 'rooms')} WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? roomFromRow(result.rows[0] as Row) : null;
    });
  }

  async listRooms(request: RoomListRequest): Promise<RoomListResult> {
    assertId(request.principalId, 'principal_id');
    assertOptionalId(request.gameId, 'game_id');
    assertOptionalId(request.cursor, 'room_cursor');
    const limit = roomLimit(request.limit);
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT room
           FROM ${tableName(this.schema, 'rooms')}
          WHERE id NOT LIKE 'direct:%'
            AND ($2::text IS NULL OR room->>'gameId' = $2)
            AND ($3::text IS NULL OR room->>'status' = $3)
            AND ($4::text IS NULL OR id > $4)
            AND (
              (room->>'visibility' = 'public' AND room->>'status' = 'open')
              OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(room->'members') AS member
                 WHERE member->>'principalId' = $1
              )
              OR EXISTS (
                SELECT 1
                  FROM ${tableName(this.schema, 'room_grants')} grant_row
                 WHERE grant_row.room_id = id
                   AND room->>'status' = 'open'
                   AND grant_row.principal_id = $1
                   AND grant_row.state IN ('pending', 'accepted')
              )
            )
          ORDER BY id ASC
          LIMIT $5`,
        [
          request.principalId,
          request.gameId ?? null,
          request.status ?? null,
          request.cursor ?? null,
          limit + 1,
        ],
      );
      const page = result.rows.map((row) => roomFromRow(row as Row));
      const hasNext = page.length > limit;
      const selected = hasNext ? page.slice(0, limit) : page;
      return {
        rooms: selected.map((room) => copy(room)),
        ...(hasNext ? { nextCursor: selected[selected.length - 1]?.id } : {}),
      };
    });
  }

  async getStart(roomId: string): Promise<StartOperation | null> {
    assertId(roomId, 'room_id');
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT s.start, r.room
           FROM ${tableName(this.schema, 'starts')} s
           JOIN ${tableName(this.schema, 'rooms')} r ON r.id = s.room_id
          WHERE s.room_id = $1`,
        [roomId],
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0] as Row;
      return startFromRow(row, roomFromRow(row));
    });
  }

  async getStartBySession(sessionId: string): Promise<StartOperation | null> {
    assertId(sessionId, 'session_id');
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT s.start, r.room
           FROM ${tableName(this.schema, 'starts')} s
           JOIN ${tableName(this.schema, 'rooms')} r ON r.id = s.room_id
          WHERE s.session_id = $1`,
        [sessionId],
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0] as Row;
      return startFromRow(row, roomFromRow(row));
    });
  }

  async getAdmission(sessionId: string): Promise<MatchAdmission | null> {
    assertId(sessionId, 'session_id');
    return (await this.getAdmissions([sessionId])).get(sessionId) ?? null;
  }

  async getAdmissions(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, MatchAdmission>> {
    for (const sessionId of sessionIds) assertId(sessionId, 'session_id');
    if (sessionIds.length === 0) return new Map();
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT s.session_id, s.start, r.room
           FROM ${tableName(this.schema, 'starts')} s
           JOIN ${tableName(this.schema, 'rooms')} r ON r.id = s.room_id
          WHERE s.session_id = ANY($1::text[])`,
        [[...sessionIds]],
      );
      const admissions = new Map<string, MatchAdmission>();
      for (const row of result.rows) {
        const typed = row as Row;
        const sessionId = typed.session_id;
        if (typeof sessionId !== 'string' || sessionId.length === 0)
          throw contractError('INTERNAL', 'platform.admission.session_invalid');
        admissions.set(
          sessionId,
          copy(startFromRow(typed, roomFromRow(typed)).admission),
        );
      }
      return admissions;
    });
  }

  async getRoomAccess(roomId: string): Promise<RoomAccessSnapshot> {
    assertId(roomId, 'room_id');
    const access = await this.getRoomAccessMany([roomId]);
    const value = access.get(roomId);
    if (!value) throw contractError('NOT_FOUND', 'platform.room.not_found');
    return value;
  }

  async getRoomAccessMany(
    roomIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomAccessSnapshot>> {
    for (const roomId of roomIds) assertId(roomId, 'room_id');
    if (roomIds.length === 0) return new Map();
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT r.id AS room_id,
                security.password_hash,
                grant_row.grant_id,
                grant_row.room_id AS grant_room_id,
                grant_row.principal_id,
                grant_row.seat_id,
                grant_row.state
           FROM ${tableName(this.schema, 'rooms')} r
           LEFT JOIN ${tableName(this.schema, 'room_security')} security
             ON security.room_id = r.id
           LEFT JOIN ${tableName(this.schema, 'room_grants')} grant_row
             ON grant_row.room_id = r.id
          WHERE r.id = ANY($1::text[])
          ORDER BY r.id ASC, grant_row.grant_id ASC`,
        [[...roomIds]],
      );
      const access = new Map<
        string,
        {
          security: RoomSecurityRecord;
          grants: RoomAccessGrant[];
        }
      >();
      for (const row of result.rows) {
        const typed = row as Row;
        const roomId = typed.room_id;
        if (typeof roomId !== 'string' || roomId.length === 0)
          throw contractError('INTERNAL', 'platform.room.id_invalid');
        let current = access.get(roomId);
        if (!current) {
          current = {
            security: {
              ...(typed.password_hash
                ? { passwordHash: String(typed.password_hash) }
                : {}),
            },
            grants: [],
          };
          access.set(roomId, current);
        }
        if (typed.grant_id !== null && typed.grant_id !== undefined) {
          current.grants.push(
            grantFromRow({
              ...typed,
              room_id: typed.grant_room_id ?? roomId,
            }),
          );
        }
      }
      if (access.size !== new Set(roomIds).size)
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      return new Map(
        [...access].map(([roomId, value]) => [
          roomId,
          {
            security: copy(value.security),
            grants: value.grants.map((grant) => copy(grant)),
          },
        ]),
      );
    });
  }

  async listPendingRoomInvitations(
    request: RoomInvitationListRequest,
  ): Promise<RoomInvitationCandidateList> {
    assertId(request.principalId, 'principal_id');
    assertOptionalId(request.cursor, 'room_cursor');
    const limit = roomLimit(request.limit);
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT r.room,
                grant_row.grant_id,
                grant_row.room_id,
                grant_row.principal_id,
                grant_row.seat_id,
                grant_row.state
           FROM ${tableName(this.schema, 'rooms')} r
           JOIN ${tableName(this.schema, 'room_grants')} grant_row
             ON grant_row.room_id = r.id
          WHERE r.id NOT LIKE 'direct:%'
            AND r.room->>'status' = 'open'
            AND grant_row.principal_id = $1
            AND grant_row.state = 'pending'
            AND ($2::text IS NULL OR r.id > $2)
          ORDER BY r.id ASC, grant_row.grant_id ASC
          LIMIT $3`,
        [request.principalId, request.cursor ?? null, limit + 1],
      );
      const page = result.rows.map((row) => {
        const typed = row as Row;
        return {
          room: roomFromRow(typed),
          grant: grantFromRow(typed),
        };
      });
      const hasNext = page.length > limit;
      const selected = hasNext ? page.slice(0, limit) : page;
      return {
        items: selected.map(({ room, grant }) => ({
          room: copy(room),
          grant: copy(grant),
        })),
        ...(hasNext
          ? { nextCursor: selected[selected.length - 1]?.room.id }
          : {}),
      };
    });
  }

  async transaction<T>(
    roomId: string,
    work: (tx: RoomTransaction) => Promise<T>,
  ): Promise<T> {
    assertId(roomId, 'room_id');
    if (typeof work !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.transaction.callback');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roomResult = await client.query(
        `SELECT room FROM ${tableName(this.schema, 'rooms')} WHERE id = $1 FOR UPDATE`,
        [roomId],
      );
      if (!roomResult.rows[0])
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      const room = roomFromRow(roomResult.rows[0] as Row);
      const startResult = await client.query(
        `SELECT start FROM ${tableName(this.schema, 'starts')} WHERE room_id = $1`,
        [roomId],
      );
      const initialStart = startResult.rows[0]
        ? startFromRow(
            {
              ...(startResult.rows[0] as Row),
              room: room,
            },
            room,
          )
        : null;
      const view = transactionView(room, initialStart);
      try {
        const result = await (this.runInTransactionContext
          ? this.runInTransactionContext(client, () => work(view.tx))
          : work(view.tx));
        const resultCopy = copy(result);
        const finished = view.finish();
        await client.query(
          `UPDATE ${tableName(this.schema, 'rooms')}
              SET room = $2::jsonb, updated_at = clock_timestamp()
            WHERE id = $1`,
          [roomId, JSON.stringify(finished.room)],
        );
        if (finished.start) {
          if (initialStart) {
            await client.query(
              `UPDATE ${tableName(this.schema, 'starts')}
                  SET start_generation = $2,
                      session_id = $3,
                      status = $4,
                      start = $5::jsonb
                WHERE room_id = $1`,
              [
                roomId,
                finished.start.startGeneration,
                finished.start.sessionId,
                finished.start.state,
                JSON.stringify(finished.start),
              ],
            );
          } else {
            await client.query(
              `INSERT INTO ${tableName(this.schema, 'starts')}
                (room_id, start_generation, session_id, status, start)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [
                roomId,
                finished.start.startGeneration,
                finished.start.sessionId,
                finished.start.state,
                JSON.stringify(finished.start),
              ],
            );
          }
        }
        await client.query('COMMIT');
        return resultCopy;
      } catch (error) {
        view.close();
        throw error;
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async transactionWithAccess<T>(
    roomId: string,
    work: (tx: RoomManagementTransaction) => Promise<T>,
  ): Promise<T> {
    assertId(roomId, 'room_id');
    if (typeof work !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.transaction.callback');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roomResult = await client.query(
        `SELECT room FROM ${tableName(this.schema, 'rooms')} WHERE id = $1 FOR UPDATE`,
        [roomId],
      );
      if (!roomResult.rows[0])
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      const room = roomFromRow(roomResult.rows[0] as Row);
      const startResult = await client.query(
        `SELECT start FROM ${tableName(this.schema, 'starts')} WHERE room_id = $1`,
        [roomId],
      );
      const initialStart = startResult.rows[0]
        ? startFromRow(
            {
              ...(startResult.rows[0] as Row),
              room,
            },
            room,
          )
        : null;
      const securityResult = await client.query(
        `SELECT password_hash FROM ${tableName(this.schema, 'room_security')} WHERE room_id = $1 FOR UPDATE`,
        [roomId],
      );
      let security: RoomSecurityRecord = {
        ...(securityResult.rows[0]?.password_hash
          ? { passwordHash: String(securityResult.rows[0].password_hash) }
          : {}),
      };
      const grantResult = await client.query(
        `SELECT grant_id, room_id, principal_id, seat_id, state
           FROM ${tableName(this.schema, 'room_grants')}
          WHERE room_id = $1
          ORDER BY grant_id ASC
          FOR UPDATE`,
        [roomId],
      );
      const grants = new Map<string, RoomAccessGrant>(
        grantResult.rows.map((row) => {
          const grant = grantFromRow(row as Row);
          return [grant.grantId, grant];
        }),
      );
      const view = transactionView(room, initialStart);
      const accessTx: RoomManagementTransaction = {
        ...view.tx,
        getSecurity: () => {
          view.tx.getRoom();
          return copy(security);
        },
        setSecurity: (next) => {
          view.tx.getRoom();
          security = copy(next);
        },
        getGrants: () => {
          view.tx.getRoom();
          return [...grants.values()].map((grant) => copy(grant));
        },
        setGrant: (grant) => {
          view.tx.getRoom();
          assertRoomAccessGrant(roomId, grant);
          for (const existing of grants.values()) {
            if (existing.grantId === grant.grantId) continue;
            if (existing.principalId === grant.principalId)
              throw contractError('CONFLICT', 'platform.room.grant');
            if (
              grant.state !== 'revoked' &&
              grant.seatId !== undefined &&
              existing.state !== 'revoked' &&
              existing.seatId === grant.seatId
            )
              throw contractError('CONFLICT', 'platform.room.grant');
          }
          grants.set(grant.grantId, copy(grant));
        },
        deleteGrant: (grantId) => {
          view.tx.getRoom();
          grants.delete(grantId);
        },
      };
      try {
        const result = await (this.runInTransactionContext
          ? this.runInTransactionContext(client, () => work(accessTx))
          : work(accessTx));
        const resultCopy = copy(result);
        const finished = view.finish();
        await client.query(
          `UPDATE ${tableName(this.schema, 'rooms')}
              SET room = $2::jsonb, updated_at = clock_timestamp()
            WHERE id = $1`,
          [roomId, JSON.stringify(finished.room)],
        );
        if (finished.start) {
          if (initialStart) {
            await client.query(
              `UPDATE ${tableName(this.schema, 'starts')}
                  SET start_generation = $2,
                      session_id = $3,
                      status = $4,
                      start = $5::jsonb
                WHERE room_id = $1`,
              [
                roomId,
                finished.start.startGeneration,
                finished.start.sessionId,
                finished.start.state,
                JSON.stringify(finished.start),
              ],
            );
          } else {
            await client.query(
              `INSERT INTO ${tableName(this.schema, 'starts')}
                (room_id, start_generation, session_id, status, start)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [
                roomId,
                finished.start.startGeneration,
                finished.start.sessionId,
                finished.start.state,
                JSON.stringify(finished.start),
              ],
            );
          }
        }
        await client.query(
          `UPDATE ${tableName(this.schema, 'room_security')}
              SET password_hash = $2
            WHERE room_id = $1`,
          [roomId, security.passwordHash ?? null],
        );
        await client.query(
          `DELETE FROM ${tableName(this.schema, 'room_grants')} WHERE room_id = $1`,
          [roomId],
        );
        for (const grant of grants.values()) {
          await client.query(
            `INSERT INTO ${tableName(this.schema, 'room_grants')}
              (grant_id, room_id, principal_id, seat_id, state)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              grant.grantId,
              roomId,
              grant.principalId,
              grant.seatId ?? null,
              grant.state,
            ],
          );
        }
        await client.query('COMMIT');
        return resultCopy;
      } catch (error) {
        view.close();
        throw error;
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async listPending(limit: number): Promise<readonly StartOperation[]> {
    assertLimit(limit);
    return this.read(async (client) => {
      const result = await client.query(
        `SELECT s.start, r.room
           FROM ${tableName(this.schema, 'starts')} s
           JOIN ${tableName(this.schema, 'rooms')} r ON r.id = s.room_id
          WHERE s.status IN ('creating', 'activating', 'cancelling')
          ORDER BY (s.start->'admission'->>'createdAt')::double precision,
                   s.room_id
          LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => {
        const typed = row as Row;
        return startFromRow(typed, roomFromRow(typed));
      });
    });
  }

  private async read<T>(
    work: (client: Pick<PoolClient, 'query'>) => Promise<T>,
  ): Promise<T> {
    const contextual = this.readConnection?.();
    if (contextual) {
      try {
        return await work(contextual);
      } catch (error) {
        throw asDatabaseError(error);
      }
    }
    const client = await this.pool.connect();
    try {
      return await work(client);
    } catch (error) {
      throw asDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private migrationStatements(): readonly string[] {
    const schema = quoteIdentifier(this.schema);
    const rooms = tableName(this.schema, 'rooms');
    const starts = tableName(this.schema, 'starts');
    return [
      `CREATE SCHEMA IF NOT EXISTS ${schema}`,
      `CREATE TABLE IF NOT EXISTS ${rooms} (
        id text PRIMARY KEY,
        room jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`,
      `ALTER TABLE ${rooms} ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp()`,
      `ALTER TABLE ${rooms} ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`,
      `CREATE TABLE IF NOT EXISTS ${tableName(this.schema, 'room_create_receipts')} (
        principal_id text NOT NULL,
        request_id text NOT NULL,
        request_digest text NOT NULL,
        room_id text NOT NULL,
        original_password_hash text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT room_create_receipts_key PRIMARY KEY (principal_id, request_id),
        CONSTRAINT room_create_receipts_room_unique UNIQUE (room_id),
        CONSTRAINT room_create_receipts_identity_check
          CHECK (length(principal_id) BETWEEN 1 AND 256 AND length(request_id) BETWEEN 1 AND 256),
        CONSTRAINT room_create_receipts_digest_check
          CHECK (length(request_digest) = 64),
        CONSTRAINT room_create_receipts_room_check
          CHECK (length(room_id) BETWEEN 1 AND 256),
        CONSTRAINT room_create_receipts_password_check
          CHECK (original_password_hash IS NULL OR length(original_password_hash) BETWEEN 1 AND 1024)
      )`,
      `CREATE TABLE IF NOT EXISTS ${starts} (
        room_id text NOT NULL REFERENCES ${rooms}(id) ON DELETE CASCADE,
        start_generation bigint NOT NULL,
        session_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('creating', 'activating', 'cancelling', 'active', 'cancelled')),
        start jsonb NOT NULL,
        CONSTRAINT starts_room_generation_unique UNIQUE (room_id, start_generation),
        CONSTRAINT starts_session_unique UNIQUE (session_id)
      )`,
      `CREATE TABLE IF NOT EXISTS ${tableName(this.schema, 'room_security')} (
        room_id text PRIMARY KEY REFERENCES ${rooms}(id) ON DELETE CASCADE,
        password_hash text,
        CONSTRAINT room_security_password_hash_check
          CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND 1024)
      )`,
      `INSERT INTO ${tableName(this.schema, 'room_security')} (room_id)
       SELECT id FROM ${rooms}
       ON CONFLICT (room_id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS ${tableName(this.schema, 'room_grants')} (
        grant_id text PRIMARY KEY,
        room_id text NOT NULL REFERENCES ${rooms}(id) ON DELETE CASCADE,
        principal_id text NOT NULL,
        seat_id text,
        state text NOT NULL CHECK (state IN ('pending', 'accepted', 'revoked')),
        CONSTRAINT room_grants_identity_check
          CHECK (length(grant_id) BETWEEN 1 AND 256 AND length(principal_id) BETWEEN 1 AND 256),
        CONSTRAINT room_grants_seat_check
          CHECK (seat_id IS NULL OR length(seat_id) BETWEEN 1 AND 256),
        CONSTRAINT room_grants_room_principal_unique UNIQUE (room_id, principal_id)
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier('room_grants_active_seat_idx')}
         ON ${tableName(this.schema, 'room_grants')} (room_id, seat_id)
       WHERE state IN ('pending', 'accepted') AND seat_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('room_grants_room_state_idx')}
         ON ${tableName(this.schema, 'room_grants')} (room_id, state)`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('room_grants_pending_principal_idx')}
         ON ${tableName(this.schema, 'room_grants')} (principal_id, room_id)
       WHERE state = 'pending'`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('rooms_open_members_idx')}
         ON ${rooms} USING gin ((room->'members'))
       WHERE room->>'status' = 'open'`,
      `ALTER TABLE ${starts}
         DROP CONSTRAINT IF EXISTS starts_status_check`,
      `ALTER TABLE ${starts}
         ADD CONSTRAINT starts_status_check
         CHECK (status IN ('creating', 'activating', 'cancelling', 'active', 'cancelled'))`,
      `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.schema}_starts_pending_idx`)}
         ON ${starts} (status, start_generation, room_id)`,
    ];
  }
}
