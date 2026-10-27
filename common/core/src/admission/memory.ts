import {
  contractError,
  type MatchAdmission,
  type PlatformRoom,
} from '@board-game/contracts';
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

const MAX_PENDING = 1_000;
const DEFAULT_ROOM_LIMIT = 20;
const MAX_ROOM_LIMIT = 100;

function activeAccessGrant(grant: RoomAccessGrant): boolean {
  return grant.state === 'pending' || grant.state === 'accepted';
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<Result>(work: () => Promise<Result>): Promise<Result> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function requireId(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0)
    throw contractError('INVALID_REQUEST', `platform.admission.${name}`);
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

function optionalId(value: string | undefined, name: string): void {
  if (value !== undefined) requireId(value, name);
}

function sessionId(start: StartOperation): string {
  return start.sessionId;
}

function generationKey(roomId: string, generation: number): string {
  return JSON.stringify([roomId, generation]);
}

function roomCreateReceiptKey(principalId: string, requestId: string): string {
  return JSON.stringify([principalId, requestId]);
}

/** In-process admission persistence with room serialization and clone-on-read. */
export class MemoryAdmissionStore
  implements AdmissionStore, RoomManagementStore
{
  private readonly rooms = new Map<string, PlatformRoom>();
  private readonly starts = new Map<string, StartOperation>();
  private readonly security = new Map<string, RoomSecurityRecord>();
  private readonly roomCreateReceipts = new Map<string, RoomCreateReceipt>();
  private readonly grants = new Map<string, Map<string, RoomAccessGrant>>();
  private readonly sessionRooms = new Map<string, string>();
  private readonly roomLocks = new Map<string, Mutex>();
  private readonly generationRooms = new Map<string, string>();
  private readonly commitLock = new Mutex();

  private roomLock(roomId: string): Mutex {
    let lock = this.roomLocks.get(roomId);
    if (!lock) {
      lock = new Mutex();
      this.roomLocks.set(roomId, lock);
    }
    return lock;
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
    const stored = copy(room);
    await this.commitLock.run(async () => {
      if (this.rooms.has(room.id))
        throw contractError('CONFLICT', 'platform.room.exists');
      if (
        receipt &&
        this.roomCreateReceipts.has(
          roomCreateReceiptKey(receipt.principalId, receipt.requestId),
        )
      )
        throw contractError('CONFLICT', 'platform.admission.unique');
      this.rooms.set(room.id, stored);
      this.security.set(room.id, copy(security));
      this.grants.set(
        room.id,
        new Map(initialGrants.map((grant) => [grant.grantId, copy(grant)])),
      );
      if (receipt)
        this.roomCreateReceipts.set(
          roomCreateReceiptKey(receipt.principalId, receipt.requestId),
          copy(receipt),
        );
    });
  }

  async getRoomCreateReceipt(
    principalId: string,
    requestId: string,
  ): Promise<RoomCreateReceipt | null> {
    requireId(principalId, 'principal_id');
    requireId(requestId, 'request_id');
    const receipt = this.roomCreateReceipts.get(
      roomCreateReceiptKey(principalId, requestId),
    );
    return receipt ? copy(receipt) : null;
  }

  async getRoom(id: string): Promise<PlatformRoom | null> {
    requireId(id, 'room_id');
    const room = this.rooms.get(id);
    return room ? copy(room) : null;
  }

  async listRooms(request: RoomListRequest): Promise<RoomListResult> {
    requireId(request.principalId, 'principal_id');
    optionalId(request.gameId, 'game_id');
    optionalId(request.cursor, 'room_cursor');
    const limit = roomLimit(request.limit);
    const rooms = [...this.rooms.values()]
      .filter((room) => !room.id.startsWith('direct:'))
      .filter((room) =>
        request.gameId === undefined ? true : room.gameId === request.gameId,
      )
      .filter((room) =>
        request.status === undefined ? true : room.status === request.status,
      )
      .filter(
        (room) =>
          (room.visibility === 'public' && room.status === 'open') ||
          room.members.some(
            (member) => member.principalId === request.principalId,
          ) ||
          [...(this.grants.get(room.id)?.values() ?? [])].some(
            (grant) =>
              room.status === 'open' &&
              grant.principalId === request.principalId &&
              activeAccessGrant(grant),
          ),
      )
      .filter(
        (room) => request.cursor === undefined || room.id > request.cursor,
      )
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
    const page = rooms.slice(0, limit + 1);
    const hasNext = page.length > limit;
    const selected = hasNext ? page.slice(0, limit) : page;
    return {
      rooms: selected.map((room) => copy(room)),
      ...(hasNext ? { nextCursor: selected[selected.length - 1]?.id } : {}),
    };
  }

  async getStart(roomId: string): Promise<StartOperation | null> {
    requireId(roomId, 'room_id');
    const start = this.starts.get(roomId);
    return start ? copy(start) : null;
  }

  async getStartBySession(
    sessionIdValue: string,
  ): Promise<StartOperation | null> {
    requireId(sessionIdValue, 'session_id');
    const roomId = this.sessionRooms.get(sessionIdValue);
    if (!roomId) return null;
    const start = this.starts.get(roomId);
    return start ? copy(start) : null;
  }

  async getAdmission(sessionIdValue: string): Promise<MatchAdmission | null> {
    requireId(sessionIdValue, 'session_id');
    const roomId = this.sessionRooms.get(sessionIdValue);
    if (!roomId) return null;
    const start = this.starts.get(roomId);
    return start ? copy(start.admission) : null;
  }

  async getAdmissions(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, MatchAdmission>> {
    for (const sessionIdValue of sessionIds)
      requireId(sessionIdValue, 'session_id');
    const admissions = new Map<string, MatchAdmission>();
    for (const sessionIdValue of sessionIds) {
      const roomId = this.sessionRooms.get(sessionIdValue);
      if (!roomId) continue;
      const start = this.starts.get(roomId);
      if (start) admissions.set(sessionIdValue, copy(start.admission));
    }
    return admissions;
  }

  async getRoomAccess(roomId: string): Promise<RoomAccessSnapshot> {
    requireId(roomId, 'room_id');
    if (!this.rooms.has(roomId))
      throw contractError('NOT_FOUND', 'platform.room.not_found');
    return {
      security: copy(this.security.get(roomId) ?? {}),
      grants: [...(this.grants.get(roomId)?.values() ?? [])].map((grant) =>
        copy(grant),
      ),
    };
  }

  async getRoomAccessMany(
    roomIds: readonly string[],
  ): Promise<ReadonlyMap<string, RoomAccessSnapshot>> {
    for (const roomId of roomIds) requireId(roomId, 'room_id');
    const access = new Map<string, RoomAccessSnapshot>();
    for (const roomId of roomIds) {
      if (!this.rooms.has(roomId))
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      access.set(roomId, {
        security: copy(this.security.get(roomId) ?? {}),
        grants: [...(this.grants.get(roomId)?.values() ?? [])].map((grant) =>
          copy(grant),
        ),
      });
    }
    return access;
  }

  async listPendingRoomInvitations(
    request: RoomInvitationListRequest,
  ): Promise<RoomInvitationCandidateList> {
    requireId(request.principalId, 'principal_id');
    optionalId(request.cursor, 'room_cursor');
    const limit = roomLimit(request.limit);
    const candidates = [...this.rooms.values()]
      .filter((room) => !room.id.startsWith('direct:'))
      .filter((room) => room.status === 'open')
      .filter(
        (room) => request.cursor === undefined || room.id > request.cursor,
      )
      .flatMap((room) =>
        [...(this.grants.get(room.id)?.values() ?? [])]
          .filter(
            (grant) =>
              grant.principalId === request.principalId &&
              grant.state === 'pending',
          )
          .map((grant) => ({ room, grant })),
      )
      .sort(
        (left, right) =>
          left.room.id.localeCompare(right.room.id) ||
          left.grant.grantId.localeCompare(right.grant.grantId),
      );
    const page = candidates.slice(0, limit + 1);
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
  }

  async transaction<T>(
    roomId: string,
    work: (tx: RoomTransaction) => Promise<T>,
  ): Promise<T> {
    requireId(roomId, 'room_id');
    if (typeof work !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.transaction.callback');

    return this.roomLock(roomId).run(async () => {
      const initialRoom = this.rooms.get(roomId);
      if (!initialRoom)
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      const view = transactionView(
        initialRoom,
        this.starts.get(roomId) ?? null,
      );
      try {
        const result = await work(view.tx);
        // Clone before commit so an unusual, non-cloneable callback result
        // cannot leave a durable mutation behind.
        const resultCopy = copy(result);
        const finished = view.finish();
        await this.commitLock.run(async () => {
          this.assertUniqueStart(roomId, finished.start);
          this.rooms.set(roomId, copy(finished.room));
          this.commitStart(roomId, finished.start);
        });
        return resultCopy;
      } catch (error) {
        view.close();
        throw error;
      }
    });
  }

  async transactionWithAccess<T>(
    roomId: string,
    work: (tx: RoomManagementTransaction) => Promise<T>,
  ): Promise<T> {
    requireId(roomId, 'room_id');
    if (typeof work !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.transaction.callback');

    return this.roomLock(roomId).run(async () => {
      const initialRoom = this.rooms.get(roomId);
      if (!initialRoom)
        throw contractError('NOT_FOUND', 'platform.room.not_found');
      const view = transactionView(
        initialRoom,
        this.starts.get(roomId) ?? null,
      );
      let security = copy(this.security.get(roomId) ?? {});
      const grants = new Map<string, RoomAccessGrant>(
        [...(this.grants.get(roomId)?.entries() ?? [])].map(([id, grant]) => [
          id,
          copy(grant),
        ]),
      );
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
        const result = await work(accessTx);
        const resultCopy = copy(result);
        const finished = view.finish();
        await this.commitLock.run(async () => {
          this.assertUniqueStart(roomId, finished.start);
          this.rooms.set(roomId, copy(finished.room));
          this.commitStart(roomId, finished.start);
          this.security.set(roomId, copy(security));
          this.grants.set(
            roomId,
            new Map(
              [...grants.entries()].map(([id, grant]) => [id, copy(grant)]),
            ),
          );
        });
        return resultCopy;
      } catch (error) {
        view.close();
        throw error;
      }
    });
  }

  async listPending(limit: number): Promise<readonly StartOperation[]> {
    assertLimit(limit);
    return [...this.starts.values()]
      .filter(
        (start) =>
          start.state === 'creating' ||
          start.state === 'activating' ||
          start.state === 'cancelling',
      )
      .sort(
        (left, right) =>
          left.admission.createdAt - right.admission.createdAt ||
          left.roomId.localeCompare(right.roomId),
      )
      .slice(0, limit)
      .map((start) => copy(start));
  }

  private assertUniqueStart(
    roomId: string,
    start: StartOperation | null,
  ): void {
    if (!start) return;
    const sessionRoom = this.sessionRooms.get(sessionId(start));
    if (sessionRoom && sessionRoom !== roomId)
      throw contractError('CONFLICT', 'platform.start.session_exists');

    const generationRoom = this.generationRooms.get(
      generationKey(roomId, start.startGeneration),
    );
    if (generationRoom && generationRoom !== roomId)
      throw contractError('CONFLICT', 'platform.start.generation_exists');
  }

  private commitStart(roomId: string, start: StartOperation | null): void {
    const previous = this.starts.get(roomId);
    if (previous) {
      this.sessionRooms.delete(sessionId(previous));
      this.generationRooms.delete(
        generationKey(roomId, previous.startGeneration),
      );
    }
    if (!start) {
      this.starts.delete(roomId);
      return;
    }
    const stored = copy(start);
    this.starts.set(roomId, stored);
    this.sessionRooms.set(sessionId(start), roomId);
    this.generationRooms.set(
      generationKey(roomId, start.startGeneration),
      roomId,
    );
  }
}
