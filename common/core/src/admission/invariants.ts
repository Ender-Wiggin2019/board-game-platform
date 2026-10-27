import {
  assertJsonPayloadSize,
  assertParticipant,
  assertPresetSeed,
  assertSessionRoute,
  canonicalStableStringify as canonicalJson,
  contractError,
  type PlatformRoom,
} from '@board-game/contracts';
import type { RoomAccessGrant, RoomCreateReceipt } from '../rooms/types.js';
import type { RoomTransaction, StartOperation } from './types.js';

export const copy = <T>(value: T): T => structuredClone(value);

export function assertRoomAccessGrant(
  roomId: string,
  grant: RoomAccessGrant,
): void {
  requireValue(
    !!grant &&
      typeof grant === 'object' &&
      grant.roomId === roomId &&
      typeof grant.grantId === 'string' &&
      grant.grantId.length > 0 &&
      grant.grantId.length <= 256 &&
      typeof grant.principalId === 'string' &&
      grant.principalId.length > 0 &&
      grant.principalId.length <= 256 &&
      (grant.seatId === undefined ||
        (typeof grant.seatId === 'string' &&
          grant.seatId.length > 0 &&
          grant.seatId.length <= 256)) &&
      (grant.state === 'pending' ||
        grant.state === 'accepted' ||
        grant.state === 'revoked'),
    'platform.room.grant',
  );
}

/** Validate an initial batch before either store changes room state. */
export function assertInitialRoomGrants(
  roomId: string,
  grants: readonly RoomAccessGrant[],
): void {
  requireValue(
    Array.isArray(grants) && grants.length <= 100,
    'platform.room.grant',
  );
  const grantIds = new Set<string>();
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const grant of grants) {
    assertRoomAccessGrant(roomId, grant);
    requireValue(
      !grantIds.has(grant.grantId) &&
        !principals.has(grant.principalId) &&
        (grant.state === 'revoked' ||
          grant.seatId === undefined ||
          !seats.has(grant.seatId)),
      'platform.room.grant',
    );
    grantIds.add(grant.grantId);
    principals.add(grant.principalId);
    if (grant.state !== 'revoked' && grant.seatId !== undefined)
      seats.add(grant.seatId);
  }
}

export function assertRoomCreateReceipt(
  roomId: string,
  receipt: RoomCreateReceipt,
): void {
  requireValue(
    !!receipt &&
      receipt.roomId === roomId &&
      typeof receipt.principalId === 'string' &&
      receipt.principalId.length > 0 &&
      receipt.principalId.length <= 256 &&
      typeof receipt.requestId === 'string' &&
      receipt.requestId.length > 0 &&
      receipt.requestId.length <= 256 &&
      /^[0-9a-f]{64}$/u.test(receipt.requestDigest) &&
      (receipt.originalPasswordHash === undefined ||
        (receipt.originalPasswordHash.length > 0 &&
          receipt.originalPasswordHash.length <= 1024)),
    'platform.room.create_receipt',
  );
}

export function requireValue(
  condition: unknown,
  key: string,
): asserts condition {
  if (!condition) throw contractError('INVALID_REQUEST', key);
}

export function assertRoom(room: PlatformRoom): void {
  assertJsonPayloadSize(room, 512 * 1024);
  for (const key of ['id', 'ownerId', 'gameId', 'modeId', 'releaseId'] as const)
    requireValue(
      typeof room[key] === 'string' && room[key].length > 0,
      'platform.room.invalid',
    );
  if (room.name !== undefined)
    requireValue(
      typeof room.name === 'string' &&
        room.name.trim().length > 0 &&
        room.name.length <= 80 &&
        !/\p{Cc}/u.test(room.name),
      'platform.room.name',
    );
  if (room.seed !== undefined) assertPresetSeed(room.seed);
  requireValue(
    ['open', 'starting', 'started', 'closed'].includes(room.status),
    'platform.room.status',
  );
  requireValue(
    ['public', 'private'].includes(room.visibility),
    'platform.room.visibility',
  );
  requireValue(
    Number.isSafeInteger(room.revision) && room.revision >= 0,
    'platform.room.revision',
  );
  requireValue(
    Number.isSafeInteger(room.startGeneration) && room.startGeneration >= 0,
    'platform.room.generation',
  );
  requireValue(
    Array.isArray(room.members) &&
      room.members.length > 0 &&
      room.members.length <= 100,
    'platform.room.members',
  );
  const principals = new Set<string>();
  const seats = new Set<string>();
  for (const member of room.members) {
    assertParticipant({ ...member });
    requireValue(
      typeof member.principalId === 'string' &&
        member.principalId.length > 0 &&
        typeof member.seatId === 'string' &&
        member.seatId.length > 0 &&
        typeof member.ready === 'boolean',
      'platform.room.member',
    );
    requireValue(
      !principals.has(member.principalId) && !seats.has(member.seatId),
      'platform.room.duplicate_member',
    );
    principals.add(member.principalId);
    seats.add(member.seatId);
  }
  requireValue(principals.has(room.ownerId), 'platform.room.owner');
  requireValue(
    (room.members.find((member) => member.principalId === room.ownerId)
      ?.controller ?? 'human') === 'human',
    'platform.room.owner',
  );
  if (room.route) assertSessionRoute(room.route);
}

export function assertStart(start: StartOperation, room: PlatformRoom): void {
  assertJsonPayloadSize(start, 1024 * 1024);
  assertSessionRoute(start.route);
  requireValue(
    start.admission.historyPolicy === undefined ||
      ['summary-and-replay', 'progress-only', 'ephemeral-result'].includes(
        start.admission.historyPolicy,
      ),
    'platform.start.history_policy',
  );
  requireValue(
    ['creating', 'activating', 'cancelling', 'active', 'cancelled'].includes(
      start.state,
    ),
    'platform.start.state',
  );
  for (const value of [
    start.requestId,
    start.requestDigest,
    start.initiatedBy,
    start.startId,
    start.seed,
    start.admission.id,
    start.admission.validityPolicyVersion,
  ])
    requireValue(
      typeof value === 'string' && value.length > 0,
      'platform.start.invalid',
    );
  requireValue(
    start.roomId === room.id &&
      start.sessionId === start.route.sessionId &&
      start.startGeneration === room.startGeneration,
    'platform.start.identity',
  );
  requireValue(
    start.route.gameId === room.gameId &&
      start.route.modeId === room.modeId &&
      start.route.releaseId === room.releaseId,
    'platform.start.release',
  );
  requireValue(
    canonicalJson(start.admission.route) === canonicalJson(start.route),
    'platform.start.admission_route',
  );
  requireValue(
    canonicalJson(start.setup) === canonicalJson(room.setup) &&
      (room.seed === undefined || start.seed === room.seed) &&
      start.admission.visibility === room.visibility &&
      start.initiatedBy === room.ownerId,
    'platform.start.frozen_configuration',
  );
  if (room.route)
    requireValue(
      canonicalJson(room.route) === canonicalJson(start.route),
      'platform.start.room_route',
    );
  requireValue(
    start.state === 'active'
      ? room.status === 'started' && !!room.route
      : start.state === 'cancelled'
        ? room.status === 'closed'
        : room.status === 'starting',
    'platform.start.room_status',
  );
  if (start.admission.rating !== null) {
    for (const key of [
      'poolId',
      'policyVersion',
      'progressionPolicyVersion',
    ] as const)
      requireValue(
        typeof start.admission.rating?.[key] === 'string' &&
          start.admission.rating[key].length > 0,
        'platform.start.rating_policy',
      );
    requireValue(
      start.admission.rating.seasonId === null ||
        (typeof start.admission.rating.seasonId === 'string' &&
          start.admission.rating.seasonId.length > 0),
      'platform.start.season',
    );
  }
  requireValue(
    start.admission.participants.length === room.members.length,
    'platform.start.roster',
  );
  for (let index = 0; index < room.members.length; index += 1) {
    const member = room.members[index];
    const participant = start.admission.participants[index];
    assertParticipant(participant);
    requireValue(
      participant.principalId === member.principalId &&
        participant.seatId === member.seatId &&
        participant.teamId === member.teamId &&
        (participant.controller ?? 'human') === (member.controller ?? 'human'),
      'platform.start.roster',
    );
    requireValue(
      participant.controlledBy === member.controlledBy &&
        participant.controllerId === member.controllerId &&
        canonicalJson(participant.controllerOptions ?? null) ===
          canonicalJson(member.controllerOptions ?? null),
      'platform.start.controller',
    );
  }
  requireValue(
    Number.isSafeInteger(start.admission.createdAt) &&
      start.admission.createdAt >= 0,
    'platform.start.timestamp',
  );
}

/** Transaction handles expire at completion; callers cannot retain a mutable store view. */
export function transactionView(
  initialRoom: PlatformRoom,
  initialStart: StartOperation | null,
) {
  let room = copy(initialRoom);
  let start = copy(initialStart);
  let open = true;
  const active = () => requireValue(open, 'platform.transaction.closed');
  const tx: RoomTransaction = {
    getRoom: () => {
      active();
      return copy(room);
    },
    setRoom: (next) => {
      active();
      assertRoom(next);
      requireValue(
        next.id === room.id &&
          next.ownerId === room.ownerId &&
          next.gameId === room.gameId &&
          next.modeId === room.modeId &&
          next.releaseId === room.releaseId,
        'platform.room.identity',
      );
      requireValue(
        next.revision === room.revision + 1,
        'platform.room.revision',
      );
      const permitted: Record<
        PlatformRoom['status'],
        readonly PlatformRoom['status'][]
      > = {
        open: ['open', 'starting', 'closed'],
        starting: ['starting', 'started', 'closed'],
        started: ['started'],
        closed: ['closed'],
      };
      requireValue(
        permitted[room.status].includes(next.status),
        'platform.room.transition',
      );
      requireValue(
        next.startGeneration ===
          room.startGeneration +
            (room.status === 'open' && next.status === 'starting' ? 1 : 0),
        'platform.room.generation',
      );
      if (room.status !== 'open') {
        requireValue(
          canonicalJson(next.setup) === canonicalJson(room.setup) &&
            next.seed === room.seed &&
            canonicalJson(next.members) === canonicalJson(room.members) &&
            next.visibility === room.visibility,
          'platform.room.frozen',
        );
      }
      if (room.route)
        requireValue(
          canonicalJson(next.route) === canonicalJson(room.route),
          'platform.room.route',
        );
      room = copy(next);
    },
    getStart: () => {
      active();
      return copy(start);
    },
    setStart: (next) => {
      active();
      assertStart(next, room);
      if (start) {
        const { state: _before, ...previous } = start;
        const { state: _after, ...updated } = next;
        requireValue(
          canonicalJson(previous) === canonicalJson(updated),
          'platform.start.immutable',
        );
        const permitted: Record<
          StartOperation['state'],
          readonly StartOperation['state'][]
        > = {
          creating: ['creating', 'activating', 'cancelling'],
          activating: ['activating', 'active'],
          cancelling: ['cancelling', 'cancelled'],
          active: ['active'],
          cancelled: ['cancelled'],
        };
        requireValue(
          permitted[start.state].includes(next.state),
          'platform.start.transition',
        );
      }
      start = copy(next);
    },
  };
  return {
    tx,
    finish: () => {
      active();
      open = false;
      if (start) assertStart(start, room);
      else
        requireValue(
          room.status !== 'starting' && room.status !== 'started',
          'platform.room.missing_start',
        );
      return { room, start };
    },
    close: () => {
      open = false;
    },
  };
}
