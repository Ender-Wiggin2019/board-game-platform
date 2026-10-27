import { createHash, randomUUID } from 'node:crypto';
import {
  assertJsonPayloadSize,
  assertParticipant,
  assertPresetSeed,
  canonicalStableStringify,
  contractError,
  isAutomatedParticipant,
  isPlatformError,
  type JsonValue,
  type Participant,
  type PlatformRoom,
  type PublicStartStatus,
  participantAccountId,
  type SessionRoute,
} from '@board-game/contracts';
import { copy, requireValue } from './invariants.js';
import type {
  AdmissionCoordinatorOptions,
  DirectSessionInput,
  MatchedSessionInput,
  RoomListOptions,
  RoomListResult,
  StartOperation,
} from './types.js';

const DEFAULT_ROOM_LIMIT = 20;
const MAX_ROOM_LIMIT = 100;
const MAX_AUTO_START_ATTEMPTS = 3;

function resetRoomReady(room: PlatformRoom): PlatformRoom['members'] {
  return room.members.map((member) => ({
    ...member,
    ready: member.controller !== undefined && member.controller !== 'human',
  }));
}

export class AdmissionCoordinator {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: AdmissionCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  async createRoom(
    principalId: string,
    input: {
      gameId: string;
      modeId: string;
      releaseId: string;
      visibility: PlatformRoom['visibility'];
      setup: JsonValue;
      seed?: string;
    },
  ): Promise<PlatformRoom> {
    requireValue(principalId.length > 0, 'platform.identity.required');
    const binding = this.options.resolveRelease(
      input.gameId,
      input.modeId,
      input.releaseId,
    );
    binding.validateSetup(input.setup);
    if (input.seed !== undefined) {
      assertPresetSeed(input.seed);
      if (binding.mode.platformRating)
        throw contractError('INVALID_REQUEST', 'platform.room.ratedSeed');
    }
    const room: PlatformRoom = {
      id: this.newId(),
      ownerId: principalId,
      ...copy(input),
      members: [{ principalId, seatId: this.newId(), ready: false }],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };
    await this.authorize(principalId, room, 'create');
    await this.options.store.createRoom(room);
    return copy(room);
  }

  async getRoom(principalId: string, roomId: string): Promise<PlatformRoom> {
    const room = await this.options.store.getRoom(roomId);
    if (!room) throw contractError('NOT_FOUND', 'platform.room.not_found');
    await this.authorize(principalId, room, 'read');
    return room;
  }

  async listRooms(
    principalId: string,
    options: RoomListOptions = {},
  ): Promise<RoomListResult> {
    requireValue(
      typeof principalId === 'string' && principalId.length > 0,
      'platform.identity.required',
    );
    const limit = options.limit ?? DEFAULT_ROOM_LIMIT;
    requireValue(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_ROOM_LIMIT,
      'platform.admission.room_limit',
    );
    let cursor = options.cursor;
    const visible: PlatformRoom[] = [];
    let nextCursor: string | undefined;
    let continuePaging = true;
    while (continuePaging) {
      const page = await this.options.store.listRooms({
        principalId,
        gameId: options.gameId,
        status: options.status,
        limit: limit - visible.length,
        cursor,
      });
      for (const room of page.rooms) {
        if (await this.options.authorize(principalId, room, 'read'))
          visible.push(copy(room));
      }
      nextCursor = page.nextCursor;
      if (nextCursor && visible.length < limit) cursor = nextCursor;
      else continuePaging = false;
    }
    return {
      rooms: visible.slice(0, limit),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async joinRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoom> {
    return this.edit(principalId, roomId, expectedRevision, 'join', (room) => {
      if (room.members.some((member) => member.principalId === principalId))
        return room;
      const binding = this.options.resolveRelease(
        room.gameId,
        room.modeId,
        room.releaseId,
      );
      if (
        binding.mode.entry !== 'room' ||
        room.members.length >= binding.mode.maxPlayers
      )
        throw contractError('CONFLICT', 'platform.room.full');
      return {
        ...room,
        members: [
          ...resetRoomReady(room),
          { principalId, seatId: this.newId(), ready: false },
        ],
      };
    });
  }

  async leaveRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoom> {
    return this.edit(principalId, roomId, expectedRevision, 'edit', (room) => {
      if (!room.members.some((member) => member.principalId === principalId))
        throw contractError('FORBIDDEN', 'platform.room.not_member');
      if (
        (room.members.find((member) => member.principalId === principalId)
          ?.controller ?? 'human') !== 'human'
      )
        throw contractError('FORBIDDEN', 'platform.room.denied');
      if (room.ownerId === principalId)
        throw contractError('CONFLICT', 'platform.room.owner_cannot_leave');
      return {
        ...room,
        members: resetRoomReady(room).filter(
          (member) => member.principalId !== principalId,
        ),
      };
    });
  }

  async configureRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    setup: JsonValue,
  ): Promise<PlatformRoom> {
    return this.edit(principalId, roomId, expectedRevision, 'edit', (room) => {
      this.requireOwner(principalId, room);
      this.options
        .resolveRelease(room.gameId, room.modeId, room.releaseId)
        .validateSetup(setup);
      return {
        ...room,
        setup: copy(setup),
        members: resetRoomReady(room),
      };
    });
  }

  async ready(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    ready: boolean,
  ): Promise<PlatformRoom> {
    requireValue(typeof ready === 'boolean', 'platform.room.ready');
    return this.edit(principalId, roomId, expectedRevision, 'edit', (room) => {
      const current = room.members.find(
        (member) => member.principalId === principalId,
      );
      if (!current)
        throw contractError('FORBIDDEN', 'platform.room.not_member');
      if ((current.controller ?? 'human') !== 'human')
        throw contractError('FORBIDDEN', 'platform.room.denied');
      return {
        ...room,
        members: room.members.map((member) =>
          member.principalId === principalId ? { ...member, ready } : member,
        ),
      };
    });
  }

  /**
   * Create and immediately launch a private one-player session. The synthetic
   * room is durable only as an idempotency fence; it is never a public lobby
   * entry.
   */
  async createDirectSession(
    principalId: string,
    input: DirectSessionInput,
  ): Promise<PublicStartStatus> {
    requireValue(
      typeof principalId === 'string' && principalId.length > 0,
      'platform.identity.required',
    );
    requireValue(!!input && typeof input === 'object', 'platform.direct.input');
    requireValue(
      typeof input.requestId === 'string' &&
        input.requestId.length > 0 &&
        input.requestId.length <= 256,
      'platform.start.request_id',
    );
    const binding = this.options.resolveRelease(
      input.gameId,
      input.modeId,
      input.releaseId,
    );
    if (
      binding.mode.entry !== 'direct-solo' ||
      binding.mode.minPlayers !== 1 ||
      binding.mode.maxPlayers !== 1 ||
      binding.mode.platformRating
    )
      throw contractError('INVALID_REQUEST', 'platform.direct.mode.invalid');
    binding.validateSetup(input.setup);

    if (input.seed !== undefined) assertPresetSeed(input.seed);
    const requestDigest = createHash('sha256')
      .update(
        canonicalStableStringify({
          principalId,
          gameId: input.gameId,
          modeId: input.modeId,
          releaseId: input.releaseId,
          setup: input.setup,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          requestId: input.requestId,
        }),
      )
      .digest('hex');
    // requestId is the caller's idempotency key. Include the trusted principal
    // so one caller cannot claim another caller's durable direct session.
    const requestKey = createHash('sha256')
      .update(
        canonicalStableStringify({ principalId, requestId: input.requestId }),
      )
      .digest('hex');
    const roomId = `direct:${requestKey}`;
    const room: PlatformRoom = {
      id: roomId,
      ownerId: principalId,
      gameId: input.gameId,
      modeId: input.modeId,
      releaseId: input.releaseId,
      visibility: 'private',
      setup: copy(input.setup),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      members: [
        {
          principalId,
          seatId: `direct-seat:${requestKey}`,
          ready: true,
        },
      ],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };
    await this.authorize(principalId, room, 'create');

    let existing = await this.options.store.getRoom(roomId);
    if (!existing) {
      try {
        await this.options.store.createRoom(room);
      } catch (error) {
        // A concurrent/retried request may have created the deterministic room.
        // Only suppress the write error when that durable room is now visible.
        existing = await this.options.store.getRoom(roomId);
        if (!existing) throw error;
      }
    }
    existing ??= await this.options.store.getRoom(roomId);
    if (!existing || !sameDirectRoom(existing, room))
      throw contractError('IDEMPOTENCY_CONFLICT', 'platform.start.conflict');

    return this.beginStart(
      principalId,
      roomId,
      0,
      input.requestId,
      requestDigest,
      'create',
    );
  }

  /**
   * Start a server-owned match from a durable matchmaker reservation.
   *
   * The caller must have selected and frozen the roster, policy and seed in
   * its own transaction (ranked matchmaking or a non-rated daily challenge).
   * The method creates a private synthetic room only as
   * the coordinator's durable lifecycle/idempotency record; it never exposes
   * the room through public listing and never accepts a browser route.
   */
  async createMatchedSession(
    input: MatchedSessionInput,
  ): Promise<PublicStartStatus> {
    requireValue(!!input && typeof input === 'object', 'platform.match.input');
    for (const [value, key] of [
      [input.roomId, 'room_id'],
      [input.sessionId, 'session_id'],
      [input.requestId, 'request_id'],
      [input.gameId, 'game_id'],
      [input.modeId, 'mode_id'],
      [input.releaseId, 'release_id'],
      [input.seed, 'seed'],
      [input.policy.validityPolicyVersion, 'policy'],
    ] as const)
      requireValue(
        typeof value === 'string' && value.length > 0 && value.length <= 256,
        `platform.match.${key}`,
      );
    const binding = this.options.resolveRelease(
      input.gameId,
      input.modeId,
      input.releaseId,
    );
    binding.validateSetup(input.setup);
    requireValue(
      Array.isArray(input.participants) && input.participants.length > 0,
      'platform.match.roster',
    );
    const trustedDirectSolo =
      binding.mode.entry === 'direct-solo' &&
      binding.mode.minPlayers === 1 &&
      binding.mode.maxPlayers === 1 &&
      !binding.mode.platformRating &&
      input.policy.rating === null &&
      input.participants.length === 1;
    const trustedRoom =
      binding.mode.entry === 'room' &&
      binding.mode.platformRating === (input.policy.rating !== null) &&
      input.participants.length >= binding.mode.minPlayers &&
      input.participants.length <= binding.mode.maxPlayers;
    requireValue(
      trustedRoom || trustedDirectSolo,
      'platform.match.mode.invalid',
    );
    const participants = copy(input.participants);
    const seenPrincipals = new Set<string>();
    const seenSeats = new Set<string>();
    for (const participant of participants) {
      assertParticipant(participant);
      const controller = participant.controller ?? 'human';
      requireValue(
        controller === 'human' ||
          (!trustedDirectSolo &&
            !binding.mode.platformRating &&
            (controller === 'ai' || controller === 'automa')),
        'platform.match.controller',
      );
      requireValue(
        !seenPrincipals.has(participant.principalId) &&
          !seenSeats.has(participant.seatId),
        'platform.match.roster',
      );
      seenPrincipals.add(participant.principalId);
      seenSeats.add(participant.seatId);
    }
    const ownerId = participants.find(
      (participant) => !isAutomatedParticipant(participant),
    )?.principalId;
    requireValue(ownerId !== undefined, 'platform.match.roster');
    const room: PlatformRoom = {
      id: input.roomId,
      ownerId,
      gameId: input.gameId,
      modeId: input.modeId,
      releaseId: input.releaseId,
      visibility: 'private',
      setup: copy(input.setup),
      members: participants.map((participant) => ({
        ...participant,
        ready: true,
      })),
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };
    let existing = await this.options.store.getRoom(room.id);
    if (!existing) {
      try {
        await this.options.store.createRoom(room);
      } catch (error) {
        existing = await this.options.store.getRoom(room.id);
        if (!existing) throw error;
      }
    }
    existing ??= await this.options.store.getRoom(room.id);
    requireValue(existing !== null, 'platform.match.room');
    if (!sameMatchedRoom(existing, room))
      throw contractError('IDEMPOTENCY_CONFLICT', 'platform.start.conflict');

    const requestDigest = matchedRequestDigest(input);
    await this.options.store.transaction(room.id, async (tx) => {
      const currentRoom = tx.getRoom();
      const existingStart = tx.getStart();
      if (existingStart) {
        if (existingStart.requestDigest !== requestDigest)
          throw contractError(
            'IDEMPOTENCY_CONFLICT',
            'platform.start.conflict',
          );
        return;
      }
      requireValue(
        currentRoom.status === 'open' && currentRoom.revision === 0,
        'platform.match.conflict',
      );
      const route: SessionRoute = {
        gameId: input.gameId,
        modeId: input.modeId,
        releaseId: input.releaseId,
        sessionId: input.sessionId,
        backendBindingId: binding.backendBindingId,
        storageBindingId: binding.storageBindingId,
        ownershipEpoch: binding.ownershipEpoch,
      };
      const frozenRoom: PlatformRoom = {
        ...currentRoom,
        status: 'starting',
        revision: 1,
        startGeneration: 1,
      };
      const operation: StartOperation = {
        startId: this.newId(),
        sessionId: input.sessionId,
        roomId: room.id,
        requestId: input.requestId,
        requestDigest,
        initiatedBy: ownerId,
        startGeneration: 1,
        state: 'creating',
        route,
        setup: copy(input.setup),
        seed: input.seed,
        admission: {
          id: this.newId(),
          route,
          visibility: 'private',
          participants,
          ...copy(input.policy),
          historyPolicy: binding.mode.history,
          createdAt: this.now(),
        },
      };
      tx.setRoom(frozenRoom);
      tx.setStart(operation);
    });
    return this.recoverStart(room.id);
  }

  /** The caller's stable requestId identifies one intent, including after lost replies. */
  async startRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<PublicStartStatus> {
    requireValue(
      typeof requestId === 'string' &&
        requestId.length > 0 &&
        requestId.length <= 256,
      'platform.start.request_id',
    );
    const requestDigest = startRequestDigest(
      principalId,
      roomId,
      expectedRevision,
      requestId,
    );
    return this.beginStart(
      principalId,
      roomId,
      expectedRevision,
      requestId,
      requestDigest,
      'start',
    );
  }

  /** Called after a committed room change; policy is checked again under the room lock. */
  async autoStartRoom(roomId: string): Promise<PublicStartStatus | null> {
    for (let attempt = 0; attempt < MAX_AUTO_START_ATTEMPTS; attempt += 1) {
      const room = await this.options.store.getRoom(roomId);
      if (
        !room ||
        room.status !== 'open' ||
        !this.options.automaticStart?.(room)
      )
        return null;
      const requestId = `auto:${room.id}:${room.startGeneration}`;
      try {
        return await this.beginStart(
          room.ownerId,
          room.id,
          room.revision,
          requestId,
          startRequestDigest(room.ownerId, room.id, room.revision, requestId),
          'start',
          true,
        );
      } catch (error) {
        if (
          !isPlatformError(error) ||
          error.envelope.code !== 'STALE_REVISION' ||
          attempt === MAX_AUTO_START_ATTEMPTS - 1
        )
          throw error;
      }
    }
    return null;
  }

  private async beginStart(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    requestId: string,
    requestDigest: string,
    action: 'create' | 'start',
    automatic = false,
  ): Promise<PublicStartStatus> {
    await this.options.store.transaction(roomId, async (tx) => {
      const room = tx.getRoom();
      await this.authorize(principalId, room, action);
      this.requireOwner(principalId, room);
      const existing = tx.getStart();
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw contractError(
            'IDEMPOTENCY_CONFLICT',
            'platform.start.conflict',
          );
        return;
      }
      this.requireOpen(room, expectedRevision);
      const binding = this.options.resolveRelease(
        room.gameId,
        room.modeId,
        room.releaseId,
      );
      binding.validateSetup(room.setup);
      if (automatic && !this.options.automaticStart?.(room))
        throw contractError('CONFLICT', 'platform.room.auto_start_changed');
      if (
        room.members.length < binding.mode.minPlayers ||
        room.members.length > binding.mode.maxPlayers ||
        (action === 'start' &&
          !automatic &&
          room.members.some((member) => !member.ready))
      )
        throw contractError('CONFLICT', 'platform.room.not_ready');
      if (action === 'start') {
        if (binding.mode.entry !== 'room')
          throw contractError('INVALID_REQUEST', 'platform.room.entry_invalid');
        const accounts = new Set(
          room.members
            .map(participantAccountId)
            .filter((id): id is string => id !== undefined),
        );
        for (const accountId of accounts)
          await this.authorize(accountId, room, 'start');
      } else if (
        binding.mode.entry !== 'direct-solo' ||
        binding.mode.minPlayers !== 1 ||
        binding.mode.maxPlayers !== 1 ||
        binding.mode.platformRating ||
        room.members.length !== 1
      ) {
        throw contractError('INVALID_REQUEST', 'platform.direct.mode.invalid');
      }
      const policy = await this.options.freezePolicy(room);
      if (room.seed !== undefined && binding.mode.platformRating)
        throw contractError('INVALID_REQUEST', 'platform.room.ratedSeed');
      if (
        binding.mode.platformRating &&
        room.members.some(
          (member) => (member.controller ?? 'human') !== 'human',
        )
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.admission.ratedControllers',
        );
      if (binding.mode.platformRating !== (policy.rating !== null))
        throw contractError(
          'INVALID_REQUEST',
          'platform.admission.rating_policy',
        );
      const seed =
        room.seed ??
        (this.options.freezeSeed
          ? await this.options.freezeSeed(copy(room))
          : this.newId());
      requireValue(
        typeof seed === 'string' && seed.length > 0 && seed.length <= 1024,
        'platform.admission.seed',
      );
      const participants = await this.freezeParticipants(room);
      const route: SessionRoute = {
        gameId: room.gameId,
        modeId: room.modeId,
        releaseId: room.releaseId,
        sessionId: this.newId(),
        backendBindingId: binding.backendBindingId,
        storageBindingId: binding.storageBindingId,
        ownershipEpoch: binding.ownershipEpoch,
      };
      const frozenRoom: PlatformRoom = {
        ...room,
        status: 'starting',
        revision: room.revision + 1,
        startGeneration: room.startGeneration + 1,
      };
      const operation: StartOperation = {
        startId: this.newId(),
        sessionId: route.sessionId,
        roomId,
        requestId,
        requestDigest,
        initiatedBy: principalId,
        startGeneration: frozenRoom.startGeneration,
        state: 'creating',
        route,
        setup: copy(room.setup),
        seed,
        admission: {
          id: this.newId(),
          route,
          visibility: room.visibility,
          participants,
          ...copy(policy),
          historyPolicy: binding.mode.history,
          createdAt: this.now(),
        },
      };
      tx.setRoom(frozenRoom);
      tx.setStart(operation);
    });
    return this.recoverStart(roomId);
  }

  /** Cancel a durable start only before activation, with a persisted fence. */
  async cancelStart(
    principalId: string,
    roomId: string,
  ): Promise<PublicStartStatus> {
    requireValue(
      typeof principalId === 'string' && principalId.length > 0,
      'platform.identity.required',
    );
    await this.options.store.transaction(roomId, async (tx) => {
      const room = tx.getRoom();
      await this.authorize(principalId, room, 'cancel');
      this.requireOwner(principalId, room);
      const current = tx.getStart();
      if (!current)
        throw contractError('NOT_FOUND', 'platform.start.not_found');
      if (current.state === 'active' || current.state === 'activating')
        throw contractError('CONFLICT', 'platform.start.cancel_state');
      if (current.state === 'cancelled' || current.state === 'cancelling')
        return;
      tx.setStart({ ...current, state: 'cancelling' });
    });
    return this.recoverCancellation(roomId);
  }

  /** Safe to invoke after restart. Each network operation uses the persisted identifiers. */
  async recoverStart(roomId: string): Promise<PublicStartStatus> {
    let operation = await this.options.store.getStart(roomId);
    if (!operation)
      throw contractError('NOT_FOUND', 'platform.start.not_found');
    if (
      operation.state === 'active' ||
      operation.state === 'cancelled' ||
      operation.state === 'cancelling'
    )
      return publicStatus(operation);
    const backend = this.options.resolveBackend(operation.route);
    const accessContext = await this.options.accessForStart(operation);
    if (operation.state === 'creating') {
      const created = await backend.createSession({
        protocolVersion: 1,
        accessContext,
        route: operation.route,
        startId: operation.startId,
        startGeneration: operation.startGeneration,
        setup: operation.setup,
        participants: operation.admission.participants,
        seed: operation.seed,
      });
      requireValue(
        created.startId === operation.startId &&
          created.sessionId === operation.sessionId &&
          canonicalStableStringify(created.route) ===
            canonicalStableStringify(operation.route),
        'platform.start.response_mismatch',
      );
      if (created.status !== 'suspended' && created.status !== 'active')
        throw contractError('SESSION_CLOSED', 'platform.start.host_closed');
      operation = await this.options.store.transaction(roomId, async (tx) => {
        const current = tx.getStart();
        if (!current || current.startId !== operation?.startId)
          throw contractError('CONFLICT', 'platform.start.changed');
        if (current.state !== 'creating') return current;
        const room = tx.getRoom();
        const next: StartOperation = { ...current, state: 'activating' };
        tx.setRoom({
          ...room,
          route: current.route,
          revision: room.revision + 1,
        });
        tx.setStart(next);
        return next;
      });
      // A concurrent cancel wins the persisted phase fence. Never activate
      // after observing that fence, even if create returned successfully.
      if (operation.state !== 'activating') return publicStatus(operation);
    }
    if (operation.state === 'activating') {
      const active = await backend.activateSession({
        protocolVersion: 1,
        accessContext,
        route: operation.route,
        startId: operation.startId,
      });
      requireValue(
        active.startId === operation.startId &&
          active.sessionId === operation.sessionId &&
          active.status === 'active',
        'platform.start.response_mismatch',
      );
      operation = await this.options.store.transaction(roomId, async (tx) => {
        const current = tx.getStart();
        if (!current || current.startId !== operation?.startId)
          throw contractError('CONFLICT', 'platform.start.changed');
        if (current.state === 'active') return current;
        if (current.state !== 'activating')
          throw contractError('CONFLICT', 'platform.start.changed');
        const room = tx.getRoom();
        const next: StartOperation = { ...current, state: 'active' };
        tx.setRoom({ ...room, status: 'started', revision: room.revision + 1 });
        tx.setStart(next);
        return next;
      });
    }
    return publicStatus(operation);
  }

  /**
   * Replays cancellation using the persisted start identity. The host create
   * call is idempotent, and the cancel command is stable across retries.
   */
  private async recoverCancellation(
    roomId: string,
  ): Promise<PublicStartStatus> {
    let operation = await this.options.store.getStart(roomId);
    if (!operation)
      throw contractError('NOT_FOUND', 'platform.start.not_found');
    if (operation.state === 'cancelled') return publicStatus(operation);
    if (operation.state !== 'cancelling') return publicStatus(operation);

    const backend = this.options.resolveBackend(operation.route);
    const accessContext = await this.options.accessForStart(operation);
    const created = await backend.createSession({
      protocolVersion: 1,
      accessContext,
      route: operation.route,
      startId: operation.startId,
      startGeneration: operation.startGeneration,
      setup: operation.setup,
      participants: operation.admission.participants,
      seed: operation.seed,
    });
    requireValue(
      created.startId === operation.startId &&
        created.sessionId === operation.sessionId &&
        canonicalStableStringify(created.route) ===
          canonicalStableStringify(operation.route),
      'platform.start.response_mismatch',
    );
    if (created.status === 'cancelled')
      return this.confirmCancellation(roomId, operation.startId);
    if (created.status !== 'suspended')
      throw contractError('CONFLICT', 'platform.start.cancel_host_state');

    const commandId = `${operation.startId}:cancel`;
    const cancelled = await backend.controlSession({
      protocolVersion: 1,
      accessContext,
      route: operation.route,
      commandId,
      expectedRevision: 0,
      action: 'cancel',
    });
    requireValue(
      canonicalStableStringify(cancelled.route) ===
        canonicalStableStringify(operation.route) &&
        cancelled.receipt.commandId === commandId &&
        cancelled.receipt.sessionId === operation.sessionId &&
        (cancelled.receipt.status === 'accepted' ||
          cancelled.receipt.status === 'duplicate'),
      'platform.start.response_mismatch',
    );
    if (cancelled.status !== 'cancelled')
      throw contractError('CONFLICT', 'platform.start.cancel_host_state');
    return this.confirmCancellation(roomId, operation.startId);
  }

  private async confirmCancellation(
    roomId: string,
    startId: string,
  ): Promise<PublicStartStatus> {
    const operation = await this.options.store.transaction(
      roomId,
      async (tx) => {
        const current = tx.getStart();
        if (!current || current.startId !== startId)
          throw contractError('CONFLICT', 'platform.start.changed');
        if (current.state === 'cancelled') return current;
        if (current.state !== 'cancelling')
          throw contractError('CONFLICT', 'platform.start.changed');
        const room = tx.getRoom();
        tx.setRoom({
          ...room,
          route: current.route,
          status: 'closed',
          revision: room.revision + 1,
        });
        const next: StartOperation = { ...current, state: 'cancelled' };
        tx.setStart(next);
        return next;
      },
    );
    return publicStatus(operation);
  }

  async recoverPending(
    limit = 100,
  ): Promise<readonly { roomId: string; recovered: boolean }[]> {
    const pending = await this.options.store.listPending(limit);
    const results: { roomId: string; recovered: boolean }[] = [];
    for (const operation of pending) {
      try {
        if (operation.state === 'cancelling')
          await this.recoverCancellation(operation.roomId);
        else await this.recoverStart(operation.roomId);
        results.push({ roomId: operation.roomId, recovered: true });
      } catch {
        // Keep the durable operation for retry; a failed/unknown network reply never creates a replacement.
        results.push({ roomId: operation.roomId, recovered: false });
      }
    }
    return results;
  }

  private async edit(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    action: 'edit' | 'join',
    change: (room: PlatformRoom) => PlatformRoom,
  ): Promise<PlatformRoom> {
    return this.options.store.transaction(roomId, async (tx) => {
      const room = tx.getRoom();
      await this.authorize(principalId, room, action);
      this.requireOpen(room, expectedRevision);
      const next = { ...change(room), revision: room.revision + 1 };
      tx.setRoom(next);
      return copy(next);
    });
  }

  private requireOpen(room: PlatformRoom, expectedRevision: number): void {
    if (room.status !== 'open')
      throw contractError('CONFLICT', 'platform.room.frozen');
    if (room.revision !== expectedRevision)
      throw contractError('STALE_REVISION', 'platform.room.stale');
  }

  private requireOwner(principalId: string, room: PlatformRoom): void {
    if (room.ownerId !== principalId)
      throw contractError('FORBIDDEN', 'platform.room.owner_required');
  }

  private async authorize(
    principalId: string,
    room: PlatformRoom,
    action: Parameters<AdmissionCoordinatorOptions['authorize']>[2],
  ): Promise<void> {
    if (!(await this.options.authorize(principalId, copy(room), action)))
      throw contractError('FORBIDDEN', 'platform.admission.denied');
  }

  private async freezeParticipants(
    room: PlatformRoom,
  ): Promise<readonly Participant[]> {
    const expected = room.members.map(
      ({ ready: _ready, ...participant }) => participant,
    );
    const supplied = this.options.freezeParticipants
      ? await this.options.freezeParticipants(copy(room))
      : expected;
    requireValue(
      Array.isArray(supplied) && supplied.length === expected.length,
      'platform.start.roster',
    );
    assertJsonPayloadSize(supplied, 256 * 1024, 'platform.start.participants');
    for (let index = 0; index < expected.length; index += 1) {
      const participant = supplied[index];
      assertParticipant(participant);
      requireValue(
        Object.keys(participant).every((key) =>
          [
            'principalId',
            'seatId',
            'teamId',
            'controller',
            'controlledBy',
            'controllerId',
            'controllerOptions',
            'publicProfile',
          ].includes(key),
        ),
        'platform.start.roster',
      );
      requireValue(
        participantIdentity(participant) ===
          participantIdentity(expected[index]),
        'platform.start.roster',
      );
    }
    return copy(supplied);
  }
}

function publicStatus(operation: StartOperation): PublicStartStatus {
  const { startId, sessionId, roomId, state, route } = operation;
  return copy({ startId, sessionId, roomId, state, route });
}

function startRequestDigest(
  principalId: string,
  roomId: string,
  expectedRevision: number,
  requestId: string,
): string {
  return createHash('sha256')
    .update(
      canonicalStableStringify({
        principalId,
        roomId,
        expectedRevision,
        requestId,
      }),
    )
    .digest('hex');
}

function matchedRequestDigest(input: MatchedSessionInput): string {
  return createHash('sha256')
    .update(
      canonicalStableStringify({
        roomId: input.roomId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        gameId: input.gameId,
        modeId: input.modeId,
        releaseId: input.releaseId,
        setup: input.setup,
        seed: input.seed,
        participants: input.participants,
        policy: input.policy,
      }),
    )
    .digest('hex');
}

function sameDirectRoom(
  existing: PlatformRoom,
  expected: PlatformRoom,
): boolean {
  return (
    existing.id === expected.id &&
    existing.ownerId === expected.ownerId &&
    existing.gameId === expected.gameId &&
    existing.modeId === expected.modeId &&
    existing.releaseId === expected.releaseId &&
    existing.visibility === expected.visibility &&
    existing.seed === expected.seed &&
    canonicalStableStringify(existing.setup) ===
      canonicalStableStringify(expected.setup) &&
    canonicalStableStringify(existing.members) ===
      canonicalStableStringify(expected.members)
  );
}

function sameMatchedRoom(
  existing: PlatformRoom,
  expected: PlatformRoom,
): boolean {
  return (
    existing.id === expected.id &&
    existing.ownerId === expected.ownerId &&
    existing.gameId === expected.gameId &&
    existing.modeId === expected.modeId &&
    existing.releaseId === expected.releaseId &&
    existing.visibility === expected.visibility &&
    canonicalStableStringify(existing.setup) ===
      canonicalStableStringify(expected.setup) &&
    canonicalStableStringify(
      existing.members.map(({ ready: _ready, ...member }) => member),
    ) ===
      canonicalStableStringify(
        expected.members.map(({ ready: _ready, ...member }) => member),
      )
  );
}

function participantIdentity(participant: Participant): string {
  return canonicalStableStringify([
    participant.principalId,
    participant.seatId,
    participant.teamId ?? null,
    participant.controller ?? 'human',
    participant.controlledBy ?? null,
    participant.controllerId ?? null,
    participant.controllerOptions ?? null,
  ]);
}
