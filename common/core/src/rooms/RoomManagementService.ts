import { createHash, randomUUID } from 'node:crypto';
import {
  assertParticipant,
  assertPresetSeed,
  assertPublicPlayerProfile,
  canonicalStableStringify,
  contractError,
  controlsParticipant,
  isAutomatedParticipant,
  type JsonValue,
  type PlatformRoom,
  type PlatformRoomInvitation,
  type PlatformRoomView,
  type PublicPlayerProfile,
  type RoomMember,
  type RoomSeatControllerInput,
} from '@board-game/contracts';
import { copy } from '../admission/invariants.js';
import type {
  RoomAccessGrant,
  RoomAccessSnapshot,
  RoomCreateInput,
  RoomCreateReceipt,
  RoomInvitationListResult,
  RoomInviteInput,
  RoomJoinInput,
  RoomListViewResult,
  RoomManagementAction,
  RoomManagementListOptions,
  RoomManagementPolicy,
  RoomManagementStore,
  RoomManagementTransaction,
  RoomModeLimits,
} from './types.js';

const MAX_ROOM_NAME = 80;
const MAX_PASSWORD = 1024;
const MAX_REQUEST_ID = 256;
const MAX_ROOM_PAGE = 100;

function requireId(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw contractError('INVALID_REQUEST', `platform.room.${key}`);
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw contractError('INVALID_REQUEST', 'platform.room.revision');
}

function requireRoomName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_ROOM_NAME || /\p{Cc}/u.test(name))
    throw contractError('INVALID_REQUEST', 'platform.room.name');
  return name;
}

function requirePassword(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.trim().length === 0 ||
    value.length > MAX_PASSWORD ||
    /\p{Cc}/u.test(value)
  )
    throw contractError('INVALID_REQUEST', 'platform.room.password');
  return value;
}

function requireRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_REQUEST_ID ||
    /\p{Cc}/u.test(value)
  )
    throw contractError('INVALID_REQUEST', 'platform.room.request_id');
  return value;
}

function roomCreateDigest(
  principalId: string,
  input: RoomCreateInput,
  name: string | undefined,
  password: string | undefined,
  requestId: string,
): string {
  const semanticInput: Record<string, JsonValue> = {
    principalId,
    requestId,
    gameId: input.gameId,
    modeId: input.modeId,
    releaseId: input.releaseId,
    visibility: input.visibility,
    setup: input.setup,
    passwordProtected: password !== undefined,
  };
  if (name !== undefined) semanticInput.name = name;
  if (input.color !== undefined) semanticInput.color = input.color;
  if (input.seed !== undefined) semanticInput.seed = input.seed;
  return createHash('sha256')
    .update(canonicalStableStringify(semanticInput))
    .digest('hex');
}

function controlledMemberIdentity(
  controller: string,
  roomId: string,
  token: string,
): { readonly principalId: string; readonly seatId: string } {
  if (controller === 'bot')
    return {
      principalId: `${controller}:${roomId}:${token}`,
      seatId: `${controller}:${roomId}:seat:${token}`,
    };
  const digest = createHash('sha256')
    .update(canonicalStableStringify([roomId, token]))
    .digest('hex');
  return {
    principalId: `${controller}:${digest}`,
    seatId: `${controller}:${digest}:seat`,
  };
}

function activeGrant(grant: RoomAccessGrant): boolean {
  return grant.state === 'pending' || grant.state === 'accepted';
}

function resetReady(room: PlatformRoom): PlatformRoom['members'] {
  return room.members.map((member) => ({
    ...member,
    ready: member.controller !== undefined && member.controller !== 'human',
  }));
}

function botProfile(
  factory: RoomManagementPolicy['createBotProfile'],
  room: PlatformRoom,
): PublicPlayerProfile | null | undefined {
  if (!factory) return undefined;
  const profile = factory(copy(room));
  if (profile !== null) assertPublicPlayerProfile(profile);
  return profile;
}

function withColor(member: RoomMember, color: string): RoomMember {
  const profile = member.publicProfile;
  const appearance =
    profile?.appearance &&
    typeof profile.appearance === 'object' &&
    !Array.isArray(profile.appearance)
      ? (profile.appearance as Record<string, JsonValue>)
      : {};
  const next: RoomMember = {
    ...member,
    publicProfile: {
      ...(profile ?? {}),
      appearance: { ...appearance, color },
    },
  };
  if (next.publicProfile) assertPublicPlayerProfile(next.publicProfile);
  return next;
}

function memberColor(member: RoomMember): string | undefined {
  const appearance = member.publicProfile?.appearance;
  if (
    !appearance ||
    typeof appearance !== 'object' ||
    Array.isArray(appearance)
  )
    return undefined;
  const color = (appearance as Record<string, unknown>).color;
  return typeof color === 'string' ? color : undefined;
}

function requireOpen(tx: RoomManagementTransaction): PlatformRoom {
  const room = tx.getRoom();
  if (room.status !== 'open' || tx.getStart() !== null)
    throw contractError('CONFLICT', 'platform.room.started');
  return room;
}

function requireOwner(principalId: string, room: PlatformRoom): void {
  if (room.ownerId !== principalId)
    throw contractError('FORBIDDEN', 'platform.room.owner_required');
}

function member(
  room: PlatformRoom,
  principalId: string,
): RoomMember | undefined {
  return room.members.find(
    (candidate) => candidate.principalId === principalId,
  );
}

function controlledMember(
  room: PlatformRoom,
  principalId: string,
): RoomMember | undefined {
  return room.members.find((candidate) =>
    controlsParticipant(candidate, principalId),
  );
}

function grantFor(
  grants: readonly RoomAccessGrant[],
  principalId: string,
): RoomAccessGrant | undefined {
  return grants.find(
    (grant) => grant.principalId === principalId && activeGrant(grant),
  );
}

function roomWithRevision(
  room: PlatformRoom,
  changes: PlatformRoom,
): PlatformRoom {
  return {
    ...changes,
    revision: room.revision + 1,
  };
}

/**
 * Generic room lifecycle and private-access policy. It owns no game policy;
 * callers inject mode bounds, account authorization, friendship checks and
 * optional color/password adapters.
 */
export class RoomManagementService {
  private readonly now: () => number;
  private readonly newId: () => string;

  public constructor(
    private readonly store: RoomManagementStore,
    private readonly policy: RoomManagementPolicy,
  ) {
    if (!store || typeof store.transactionWithAccess !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.room.store_required');
    if (!policy || typeof policy.resolveMode !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.room.policy_required');
    this.now = policy.now ?? Date.now;
    this.newId = policy.newId ?? randomUUID;
  }

  public async createRoom(
    principalId: string,
    input: RoomCreateInput,
  ): Promise<PlatformRoomView> {
    requireId(principalId, 'principal');
    if (!input || typeof input !== 'object')
      throw contractError('INVALID_REQUEST', 'platform.room.input');
    requireId(input.gameId, 'game');
    requireId(input.modeId, 'mode');
    requireId(input.releaseId, 'release');
    const mode = this.policy.resolveMode(
      input.gameId,
      input.modeId,
      input.releaseId,
    );
    if (mode.entry !== 'room')
      throw contractError('INVALID_REQUEST', 'platform.room.entry_invalid');
    mode.validateSetup(input.setup);
    if (input.seed !== undefined) {
      assertPresetSeed(input.seed);
      if (mode.platformRating)
        throw contractError('INVALID_REQUEST', 'platform.room.ratedSeed');
    }
    const name = requireRoomName(input.name);
    const password = requirePassword(input.password);
    const requestId = requireRequestId(input.requestId);
    const requestDigest = requestId
      ? roomCreateDigest(principalId, input, name, password, requestId)
      : '';
    if (requestId) {
      const receipt = await this.store.getRoomCreateReceipt(
        principalId,
        requestId,
      );
      if (receipt)
        return this.replayRoomCreate(
          principalId,
          password,
          requestDigest,
          receipt,
        );
    }
    if (
      password !== undefined &&
      (!this.policy.hashPassword ||
        (requestId !== undefined && !this.policy.verifyPassword))
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.room.password_unsupported',
      );
    const owner: RoomMember = {
      principalId,
      seatId: this.newId(),
      ready: false,
    };
    const roomWithoutColor: PlatformRoom = {
      id: this.newId(),
      ownerId: principalId,
      gameId: input.gameId,
      modeId: input.modeId,
      releaseId: input.releaseId,
      ...(name ? { name } : {}),
      visibility: input.visibility,
      setup: copy(input.setup),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      members: [owner],
      revision: 0,
      startGeneration: 0,
      status: 'open',
    };
    const validatedColor =
      input.color === undefined
        ? undefined
        : this.validateColor(input.color, roomWithoutColor, principalId);
    const room: PlatformRoom = validatedColor
      ? { ...roomWithoutColor, members: [withColor(owner, validatedColor)] }
      : roomWithoutColor;
    await this.authorize(principalId, room, 'create');
    const passwordHash =
      password !== undefined
        ? await this.policy.hashPassword?.(password)
        : undefined;
    const receipt: RoomCreateReceipt | undefined = requestId
      ? {
          principalId,
          requestId,
          requestDigest,
          roomId: room.id,
          ...(passwordHash ? { originalPasswordHash: passwordHash } : {}),
        }
      : undefined;
    try {
      await this.store.createRoomWithAccess(
        room,
        { ...(passwordHash ? { passwordHash } : {}) },
        [],
        receipt,
      );
    } catch (error) {
      if (!requestId) throw error;
      const existing = await this.store.getRoomCreateReceipt(
        principalId,
        requestId,
      );
      if (!existing) throw error;
      return this.replayRoomCreate(
        principalId,
        password,
        requestDigest,
        existing,
      );
    }
    return this.toView(
      room,
      { security: { ...(passwordHash ? { passwordHash } : {}) }, grants: [] },
      principalId,
    );
  }

  public async getRoom(
    principalId: string,
    roomId: string,
  ): Promise<PlatformRoomView> {
    requireId(principalId, 'principal');
    requireId(roomId, 'id');
    const room = await this.requireRoom(roomId);
    const access = await this.store.getRoomAccess(roomId);
    await this.authorize(principalId, room, 'read', access);
    return this.toView(room, access, principalId);
  }

  public async listRooms(
    principalId: string,
    options: RoomManagementListOptions = {},
  ): Promise<RoomListViewResult> {
    requireId(principalId, 'principal');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROOM_PAGE)
      throw contractError('INVALID_REQUEST', 'platform.room.limit');
    const page = await this.store.listRooms({
      principalId,
      gameId: options.gameId,
      status: options.status,
      cursor: options.cursor,
      limit,
    });
    const accessByRoom = await this.store.getRoomAccessMany(
      page.rooms.map((room) => room.id),
    );
    const rooms: PlatformRoomView[] = [];
    for (const room of page.rooms) {
      const access = accessByRoom.get(room.id);
      if (!access) throw contractError('NOT_FOUND', 'platform.room.not_found');
      if (!(await this.policy.authorize(principalId, room, 'read', access)))
        continue;
      rooms.push(this.toView(room, access, principalId));
    }
    return {
      rooms,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  public async listInvitations(
    principalId: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<RoomInvitationListResult> {
    requireId(principalId, 'principal');
    const listPendingRoomInvitations = this.store.listPendingRoomInvitations;
    if (!listPendingRoomInvitations)
      throw contractError(
        'INTERNAL',
        'platform.room.invitation_store_required',
      );
    const page = await listPendingRoomInvitations.call(this.store, {
      principalId,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
    const items: PlatformRoomInvitation[] = [];
    for (const candidate of page.items) {
      const { room, grant } = candidate;
      if (
        grant.roomId !== room.id ||
        grant.principalId !== principalId ||
        grant.state !== 'pending' ||
        room.status !== 'open' ||
        room.members.some((member) => member.principalId === principalId)
      )
        continue;
      const access = await this.store.getRoomAccess(room.id);
      const currentGrant = access.grants.find(
        (candidateGrant) => candidateGrant.grantId === grant.grantId,
      );
      if (!currentGrant || currentGrant.state !== 'pending') continue;
      if (
        !(await this.policy.authorize(
          principalId,
          room,
          'read-invitation',
          access,
        ))
      )
        continue;
      items.push({
        grantId: grant.grantId,
        roomId: room.id,
        gameId: room.gameId,
        modeId: room.modeId,
        releaseId: room.releaseId,
        ...(room.name ? { roomName: room.name } : {}),
        ownerId: room.ownerId,
        ...(grant.seatId ? { reservedSeatId: grant.seatId } : {}),
      });
    }
    return {
      items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  public async renameRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    name: string,
  ): Promise<PlatformRoomView> {
    const nextName = requireRoomName(name);
    if (!nextName) throw contractError('INVALID_REQUEST', 'platform.room.name');
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      requireOwner(principalId, room);
      if (room.name === nextName) return room;
      const next = roomWithRevision(room, {
        ...room,
        name: nextName,
        members: resetReady(room),
      });
      tx.setRoom(next);
      return next;
    });
  }

  public async configureRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    setup: JsonValue,
  ): Promise<PlatformRoomView> {
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      requireOwner(principalId, room);
      const mode = this.policy.resolveMode(
        room.gameId,
        room.modeId,
        room.releaseId,
      );
      mode.validateSetup(setup);
      const next = roomWithRevision(room, {
        ...room,
        setup: copy(setup),
        members: resetReady(room),
      });
      const capacity = this.resolveCapacity(next, mode);
      const reserved = tx
        .getGrants()
        .filter(
          (grant) =>
            activeGrant(grant) &&
            grant.seatId &&
            !member(room, grant.principalId),
        ).length;
      if (room.members.length + reserved > capacity)
        throw contractError('CONFLICT', 'platform.room.reserved_capacity');
      tx.setRoom(next);
      return next;
    });
  }

  public async ready(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    ready: boolean,
  ): Promise<PlatformRoomView> {
    if (typeof ready !== 'boolean')
      throw contractError('INVALID_REQUEST', 'platform.room.ready');
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      const current = member(room, principalId);
      if (!current)
        throw contractError('FORBIDDEN', 'platform.room.not_member');
      if (
        isAutomatedParticipant(current) ||
        (current.controller ?? 'human') !== 'human'
      )
        throw contractError('FORBIDDEN', 'platform.room.denied');
      if (current.ready === ready) return room;
      const next = roomWithRevision(room, {
        ...room,
        members: room.members.map((candidate) =>
          candidate.principalId === principalId
            ? { ...candidate, ready }
            : candidate,
        ),
      });
      tx.setRoom(next);
      return next;
    });
  }

  public async deleteRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.mutate(
      principalId,
      roomId,
      expectedRevision,
      'delete',
      (tx) => {
        const room = requireOpen(tx);
        requireOwner(principalId, room);
        for (const grant of tx.getGrants()) {
          if (activeGrant(grant)) tx.setGrant({ ...grant, state: 'revoked' });
        }
        const next = roomWithRevision(room, {
          ...room,
          status: 'closed',
          members: resetReady(room),
        });
        tx.setRoom(next);
        return next;
      },
    );
  }

  public async joinRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input: RoomJoinInput = {},
  ): Promise<PlatformRoomView> {
    const password = requirePassword(input.password);
    return this.mutate(principalId, roomId, expectedRevision, 'join', (tx) =>
      this.joinInTransaction(principalId, input, password, tx),
    );
  }

  /** Add a server-owned bot seat using the room's configured bot profile factory. */
  public async addBot(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.addControlledMember(
      principalId,
      roomId,
      expectedRevision,
      (room) => {
        const profile = botProfile(this.policy.createBotProfile, room);
        if (profile === undefined || profile === null)
          throw contractError('CONFLICT', 'platform.room.unavailable');
        return { controller: 'bot', ready: true, publicProfile: copy(profile) };
      },
    );
  }

  public async addControlledSeat(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input: RoomSeatControllerInput,
  ): Promise<PlatformRoomView> {
    return this.addControlledMember(
      principalId,
      roomId,
      expectedRevision,
      (room) => {
        const capabilities = this.policy.controllers?.(copy(room));
        if (
          !input ||
          typeof input !== 'object' ||
          !capabilities ||
          typeof capabilities.hotseat !== 'boolean' ||
          !Array.isArray(capabilities.automation)
        )
          throw contractError(
            'INVALID_REQUEST',
            'platform.room.controllerUnsupported',
          );
        if (input.kind === 'hotseat') {
          if (!capabilities.hotseat)
            throw contractError(
              'FORBIDDEN',
              'platform.room.controllerUnsupported',
            );
          if (
            input.displayName !== undefined &&
            typeof input.displayName !== 'string'
          )
            throw contractError(
              'INVALID_REQUEST',
              'platform.room.controllerUnsupported',
            );
          const publicProfile = {
            displayName:
              input.displayName?.trim() || `Player ${room.members.length + 1}`,
          };
          assertPublicPlayerProfile(publicProfile);
          return {
            controller: 'hotseat',
            controlledBy: principalId,
            ready: true,
            publicProfile,
          };
        }
        if (
          (input.kind !== 'ai' && input.kind !== 'automa') ||
          typeof input.controllerId !== 'string' ||
          input.controllerId.trim().length === 0
        )
          throw contractError(
            'INVALID_REQUEST',
            'platform.room.controllerUnsupported',
          );
        const descriptor = capabilities.automation.find(
          (candidate) =>
            candidate.id === input.controllerId &&
            candidate.kind === input.kind,
        );
        if (!descriptor || !this.policy.controllerOptions)
          throw contractError(
            'FORBIDDEN',
            'platform.room.controllerUnsupported',
          );
        const controllerOptions = this.policy.controllerOptions(
          copy(room),
          input,
        );
        return {
          controller: descriptor.kind,
          controllerId: descriptor.id,
          controllerOptions,
          ready: true,
          publicProfile: { displayName: descriptor.label },
        };
      },
    );
  }

  private async addControlledMember(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    create: (room: PlatformRoom) => Omit<RoomMember, 'principalId' | 'seatId'>,
  ): Promise<PlatformRoomView> {
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      requireOwner(principalId, room);
      const controller = create(copy(room));
      const mode = this.policy.resolveMode(
        room.gameId,
        room.modeId,
        room.releaseId,
      );
      const grants = tx.getGrants();
      const reserved = grants.filter(
        (grant) =>
          activeGrant(grant) &&
          grant.seatId !== undefined &&
          !member(room, grant.principalId),
      ).length;
      const capacity = this.resolveCapacity(room, mode);
      if (room.members.length + reserved >= capacity)
        throw contractError(
          'CONFLICT',
          reserved > 0
            ? 'platform.room.reserved_capacity'
            : 'platform.room.full',
        );
      let token: string;
      let botPrincipalId: string;
      let seatId: string;
      const controllerKind = controller.controller;
      if (!controllerKind)
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.controllerUnsupported',
        );
      do {
        token = this.newId();
        const identity = controlledMemberIdentity(
          controllerKind,
          room.id,
          token,
        );
        botPrincipalId = identity.principalId;
        seatId = identity.seatId;
      } while (
        room.members.some(
          (candidate) =>
            candidate.principalId === botPrincipalId ||
            candidate.seatId === seatId,
        ) ||
        grants.some((grant) => activeGrant(grant) && grant.seatId === seatId)
      );
      const added: RoomMember = {
        principalId: botPrincipalId,
        seatId,
        ...controller,
      };
      assertParticipant(added);
      const next = roomWithRevision(room, {
        ...room,
        members: [...resetReady(room), added],
      });
      tx.setRoom(next);
      return next;
    });
  }

  /**
   * Accepts one exact pending grant while holding the room/access lock. The
   * grant id is part of the authorization check so a public room cannot turn
   * a revoked invitation into an unrestricted join.
   */
  public async acceptInvite(
    principalId: string,
    roomId: string,
    grantId: string,
    input: RoomJoinInput = {},
  ): Promise<PlatformRoomView> {
    requireId(grantId, 'invite');
    const password = requirePassword(input.password);
    return this.mutateCurrent(principalId, roomId, 'join', async (tx) => {
      const grant = tx
        .getGrants()
        .find(
          (candidate) =>
            candidate.grantId === grantId &&
            candidate.principalId === principalId &&
            candidate.state === 'pending',
        );
      if (!grant)
        throw contractError('NOT_FOUND', 'platform.room.invite_not_found');
      return this.joinInTransaction(principalId, input, password, tx, grantId);
    });
  }

  /** Declines one exact pending grant and releases any reserved seat. */
  public async declineInvite(
    principalId: string,
    roomId: string,
    grantId: string,
  ): Promise<PlatformRoomView> {
    requireId(grantId, 'invite');
    return this.mutateCurrent(principalId, roomId, 'decline', (tx) => {
      const grant = tx
        .getGrants()
        .find(
          (candidate) =>
            candidate.grantId === grantId &&
            candidate.principalId === principalId &&
            candidate.state === 'pending',
        );
      if (!grant)
        throw contractError('NOT_FOUND', 'platform.room.invite_not_found');
      const room = requireOpen(tx);
      tx.setGrant({ ...grant, state: 'revoked' });
      const next = roomWithRevision(room, {
        ...room,
        members: resetReady(room),
      });
      tx.setRoom(next);
      return next;
    });
  }

  public async leaveRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      if (!member(room, principalId))
        throw contractError('FORBIDDEN', 'platform.room.not_member');
      const current = member(room, principalId);
      if (
        current &&
        (isAutomatedParticipant(current) ||
          (current.controller ?? 'human') !== 'human')
      )
        throw contractError('FORBIDDEN', 'platform.room.denied');
      if (room.ownerId === principalId)
        throw contractError('CONFLICT', 'platform.room.owner_cannot_leave');
      const next = roomWithRevision(room, {
        ...room,
        members: resetReady(room).filter(
          (candidate) => candidate.principalId !== principalId,
        ),
      });
      tx.setRoom(next);
      for (const grant of tx.getGrants()) {
        if (grant.principalId === principalId && activeGrant(grant))
          tx.setGrant({ ...grant, state: 'revoked' });
      }
      return next;
    });
  }

  public async kickMember(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    targetPrincipalId: string,
  ): Promise<PlatformRoomView> {
    requireId(targetPrincipalId, 'target');
    return this.mutate(principalId, roomId, expectedRevision, 'kick', (tx) => {
      const room = requireOpen(tx);
      requireOwner(principalId, room);
      if (targetPrincipalId === room.ownerId)
        throw contractError('CONFLICT', 'platform.room.owner_cannot_kick');
      if (!member(room, targetPrincipalId))
        throw contractError('NOT_FOUND', 'platform.room.member_not_found');
      const next = roomWithRevision(room, {
        ...room,
        members: resetReady(room).filter(
          (candidate) => candidate.principalId !== targetPrincipalId,
        ),
      });
      tx.setRoom(next);
      for (const grant of tx.getGrants()) {
        if (grant.principalId === targetPrincipalId && activeGrant(grant))
          tx.setGrant({ ...grant, state: 'revoked' });
      }
      return next;
    });
  }

  public async grantInvite(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input: RoomInviteInput,
  ): Promise<PlatformRoomView> {
    requireId(input?.principalId, 'invitee');
    if (input.seatId !== undefined) requireId(input.seatId, 'seat');
    return this.mutate(
      principalId,
      roomId,
      expectedRevision,
      'invite',
      async (tx) => {
        const room = requireOpen(tx);
        requireOwner(principalId, room);
        if (
          input.principalId === principalId ||
          member(room, input.principalId)
        )
          throw contractError('CONFLICT', 'platform.room.member_exists');
        if (
          !(await this.policy.authorizeInvite(
            principalId,
            input.principalId,
            room,
          ))
        )
          throw contractError('FORBIDDEN', 'platform.room.invitee_denied');
        const grants = tx.getGrants();
        const existing = grants.find(
          (grant) => grant.principalId === input.principalId,
        );
        const activeReservations = grants.filter(
          (grant) =>
            activeGrant(grant) &&
            grant.seatId &&
            grant.principalId !== input.principalId &&
            !room.members.some(
              (member) => member.principalId === grant.principalId,
            ),
        );
        if (
          input.seatId &&
          (room.members.some(
            (candidate) => candidate.seatId === input.seatId,
          ) ||
            grants.some(
              (grant) =>
                activeGrant(grant) &&
                grant.seatId === input.seatId &&
                grant.principalId !== input.principalId,
            ))
        )
          throw contractError('CONFLICT', 'platform.room.seat_taken');
        if (
          input.seatId &&
          room.members.length + activeReservations.length >=
            this.resolveCapacity(
              room,
              this.policy.resolveMode(room.gameId, room.modeId, room.releaseId),
            )
        )
          throw contractError('CONFLICT', 'platform.room.reserved_capacity');
        const grant: RoomAccessGrant = {
          grantId: existing?.grantId ?? this.newId(),
          roomId,
          principalId: input.principalId,
          ...(input.seatId ? { seatId: input.seatId } : {}),
          state: 'pending',
        };
        tx.setGrant(grant);
        if (
          existing &&
          existing.seatId === grant.seatId &&
          existing.state === 'pending'
        )
          return room;
        const next = roomWithRevision(room, {
          ...room,
          members: resetReady(room),
        });
        tx.setRoom(next);
        return next;
      },
    );
  }

  public async revokeInvite(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    inviteePrincipalId: string,
  ): Promise<PlatformRoomView> {
    requireId(inviteePrincipalId, 'invitee');
    return this.mutate(
      principalId,
      roomId,
      expectedRevision,
      'invite',
      (tx) => {
        const room = requireOpen(tx);
        requireOwner(principalId, room);
        if (member(room, inviteePrincipalId))
          throw contractError('CONFLICT', 'platform.room.member_exists');
        const grant = tx
          .getGrants()
          .find((candidate) => candidate.principalId === inviteePrincipalId);
        if (!grant)
          throw contractError('NOT_FOUND', 'platform.room.invite_not_found');
        if (grant.state === 'revoked') return room;
        tx.setGrant({ ...grant, state: 'revoked' });
        const next = roomWithRevision(room, {
          ...room,
          members: resetReady(room),
        });
        tx.setRoom(next);
        return next;
      },
    );
  }

  public async setColor(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    color: string,
  ): Promise<PlatformRoomView> {
    requireId(color, 'color');
    return this.mutate(principalId, roomId, expectedRevision, 'edit', (tx) => {
      const room = requireOpen(tx);
      const current = member(room, principalId);
      if (!current)
        throw contractError('FORBIDDEN', 'platform.room.not_member');
      if (
        isAutomatedParticipant(current) ||
        (current.controller ?? 'human') !== 'human'
      )
        throw contractError('FORBIDDEN', 'platform.room.denied');
      const validatedColor = this.validateColor(color, room, principalId);
      if (memberColor(current) === validatedColor) return room;
      const next = roomWithRevision(room, {
        ...room,
        members: resetReady(room).map((candidate) =>
          candidate.principalId === principalId
            ? withColor(candidate, validatedColor)
            : candidate,
        ),
      });
      tx.setRoom(next);
      return next;
    });
  }

  private async joinInTransaction(
    principalId: string,
    input: RoomJoinInput,
    password: string | undefined,
    tx: RoomManagementTransaction,
    requiredGrantId?: string,
  ): Promise<PlatformRoom> {
    const room = requireOpen(tx);
    const mode = this.policy.resolveMode(
      room.gameId,
      room.modeId,
      room.releaseId,
    );
    if (mode.entry !== 'room')
      throw contractError('INVALID_REQUEST', 'platform.room.entry_invalid');
    const currentMember = member(room, principalId);
    const grants = tx.getGrants();
    const grant = grantFor(grants, principalId);
    if (
      requiredGrantId !== undefined &&
      (!grant || grant.grantId !== requiredGrantId || grant.state !== 'pending')
    )
      throw contractError('NOT_FOUND', 'platform.room.invite_not_found');
    const security = tx.getSecurity();
    if (!currentMember) {
      const passwordAccepted =
        !!security.passwordHash &&
        !!password &&
        !!this.policy.verifyPassword &&
        (await this.policy.verifyPassword(security.passwordHash, password));
      if (
        !grant &&
        ((room.visibility === 'private' && !passwordAccepted) ||
          (security.passwordHash && !passwordAccepted))
      )
        throw contractError('FORBIDDEN', 'platform.room.join_denied');
      const reservedForOthers = grants.filter(
        (candidate) =>
          activeGrant(candidate) &&
          candidate.seatId &&
          candidate.principalId !== principalId &&
          !room.members.some(
            (roomMember) => roomMember.principalId === candidate.principalId,
          ),
      );
      if (
        room.members.length + reservedForOthers.length >=
        this.resolveCapacity(room, mode)
      )
        throw contractError('CONFLICT', 'platform.room.reserved_capacity');
      if (room.members.length >= this.resolveCapacity(room, mode))
        throw contractError('CONFLICT', 'platform.room.full');
      let seatId = grant?.seatId;
      if (seatId === undefined) {
        do {
          seatId = this.newId();
        } while (
          room.members.some((candidate) => candidate.seatId === seatId) ||
          grants.some(
            (candidate) =>
              activeGrant(candidate) && candidate.seatId === seatId,
          )
        );
      }
      if (room.members.some((candidate) => candidate.seatId === seatId))
        throw contractError('CONFLICT', 'platform.room.seat_taken');
      const validatedColor = input.color
        ? this.validateColor(input.color, room, principalId)
        : undefined;
      const added = validatedColor
        ? withColor({ principalId, seatId, ready: false }, validatedColor)
        : { principalId, seatId, ready: false };
      const next = roomWithRevision(room, {
        ...room,
        members: [...resetReady(room), added],
      });
      tx.setRoom(next);
      if (grant && grant.state === 'pending')
        tx.setGrant({ ...grant, state: 'accepted' });
      return next;
    }
    if (requiredGrantId !== undefined && grant) {
      // A grant cannot normally target an existing member, but accepting it
      // is still safe and idempotent if an earlier join committed first.
      tx.setGrant({ ...grant, state: 'accepted' });
      return room;
    }
    if (input.color) {
      const validatedColor = this.validateColor(input.color, room, principalId);
      const nextMember = withColor(currentMember, validatedColor);
      const next = roomWithRevision(room, {
        ...room,
        members: resetReady(room).map((candidate) =>
          candidate.principalId === principalId ? nextMember : candidate,
        ),
      });
      tx.setRoom(next);
      return next;
    }
    return room;
  }

  private async mutate(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    action: RoomManagementAction,
    work: (
      tx: RoomManagementTransaction,
    ) => Promise<PlatformRoom> | PlatformRoom,
  ): Promise<PlatformRoomView> {
    requireId(principalId, 'principal');
    requireId(roomId, 'id');
    requireRevision(expectedRevision);
    return this.store.transactionWithAccess(roomId, async (tx) => {
      const room = tx.getRoom();
      if (room.revision !== expectedRevision)
        throw contractError('CONFLICT', 'platform.room.revision');
      await this.authorize(principalId, room, action, {
        security: tx.getSecurity(),
        grants: tx.getGrants(),
      });
      const next = await work(tx);
      return this.toView(
        next,
        {
          security: tx.getSecurity(),
          grants: tx.getGrants(),
        },
        principalId,
      );
    });
  }

  private async mutateCurrent(
    principalId: string,
    roomId: string,
    action: RoomManagementAction,
    work: (
      tx: RoomManagementTransaction,
    ) => Promise<PlatformRoom> | PlatformRoom,
  ): Promise<PlatformRoomView> {
    requireId(principalId, 'principal');
    requireId(roomId, 'id');
    return this.store.transactionWithAccess(roomId, async (tx) => {
      const room = tx.getRoom();
      await this.authorize(principalId, room, action, {
        security: tx.getSecurity(),
        grants: tx.getGrants(),
      });
      const next = await work(tx);
      return this.toView(
        next,
        {
          security: tx.getSecurity(),
          grants: tx.getGrants(),
        },
        principalId,
      );
    });
  }

  private async authorize(
    principalId: string,
    room: PlatformRoom,
    action: RoomManagementAction,
    access?: RoomAccessSnapshot,
  ): Promise<void> {
    if (!(await this.policy.authorize(principalId, room, action, access)))
      throw contractError('FORBIDDEN', 'platform.room.denied');
  }

  private async replayRoomCreate(
    principalId: string,
    password: string | undefined,
    requestDigest: string,
    receipt: RoomCreateReceipt,
  ): Promise<PlatformRoomView> {
    const room = await this.store.getRoom(receipt.roomId);
    if (!room)
      throw contractError(
        'IDEMPOTENCY_CONFLICT',
        'platform.room.create_deleted',
      );
    const access = await this.store.getRoomAccess(receipt.roomId);
    await this.authorize(principalId, room, 'create', access);
    if (receipt.requestDigest !== requestDigest)
      throw contractError(
        'IDEMPOTENCY_CONFLICT',
        'platform.room.create_conflict',
      );
    const originalPasswordHash = receipt.originalPasswordHash;
    if ((password !== undefined) !== (originalPasswordHash !== undefined))
      throw contractError(
        'IDEMPOTENCY_CONFLICT',
        'platform.room.create_conflict',
      );
    if (originalPasswordHash !== undefined) {
      if (!this.policy.verifyPassword)
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.password_unsupported',
        );
      if (password === undefined)
        throw contractError(
          'IDEMPOTENCY_CONFLICT',
          'platform.room.create_conflict',
        );
      if (!(await this.policy.verifyPassword(originalPasswordHash, password)))
        throw contractError(
          'IDEMPOTENCY_CONFLICT',
          'platform.room.create_conflict',
        );
    }
    return this.toView(room, access, principalId);
  }

  private async requireRoom(roomId: string): Promise<PlatformRoom> {
    const room = await this.store.getRoom(roomId);
    if (!room) throw contractError('NOT_FOUND', 'platform.room.not_found');
    return room;
  }

  private validateColor(
    color: string,
    room: PlatformRoom,
    principalId: string,
  ): string {
    if (!this.policy.validateColor)
      throw contractError('INVALID_REQUEST', 'platform.room.color_unsupported');
    const validated = this.policy.validateColor(color, room, principalId);
    if (
      typeof validated !== 'string' ||
      validated.length === 0 ||
      validated.length > 64
    )
      throw contractError('INVALID_REQUEST', 'platform.room.color');
    return validated;
  }

  private toView(
    room: PlatformRoom,
    access: RoomAccessSnapshot,
    principalId: string,
  ): PlatformRoomView {
    const mode = this.policy.resolveMode(
      room.gameId,
      room.modeId,
      room.releaseId,
    );
    const isMember = controlledMember(room, principalId) !== undefined;
    const reservations = isMember
      ? access.grants.filter(activeGrant).map((grant) => ({
          grantId: grant.grantId,
          principalId: grant.principalId,
          ...(grant.seatId ? { seatId: grant.seatId } : {}),
          state: grant.state as 'pending' | 'accepted',
        }))
      : undefined;
    return {
      ...copy(room),
      metadata: {
        ...(room.name ? { name: room.name } : {}),
        passwordProtected: Boolean(access.security.passwordHash),
        capacity: this.resolveCapacity(room, mode),
        memberCount: room.members.length,
        ...(this.policy.createBotProfile
          ? {
              botsAllowed:
                botProfile(this.policy.createBotProfile, room) !== null,
            }
          : {}),
        ...(reservations ? { reservations } : {}),
        ...(this.policy.controllers
          ? { controllers: this.policy.controllers(copy(room)) }
          : {}),
      },
    };
  }

  private resolveCapacity(room: PlatformRoom, mode: RoomModeLimits): number {
    const capacity = this.policy.resolveCapacity?.(room) ?? mode.maxPlayers;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < mode.minPlayers ||
      capacity > mode.maxPlayers ||
      capacity < room.members.length
    )
      throw contractError(
        capacity < room.members.length ? 'CONFLICT' : 'INVALID_REQUEST',
        'platform.room.capacity',
      );
    return capacity;
  }
}
