import {
  type PlatformRoomInvitationList,
  type PlatformRoomView,
  participantAccountId,
  type RoomSeatControllerInput,
} from '@board-game/contracts';
import {
  type RoomCreateInput,
  type RoomInviteInput,
  type RoomJoinInput,
  type RoomListViewResult,
  type RoomManagementListOptions,
  type RoomManagementPolicy,
  RoomManagementService,
  type RoomManagementStore,
} from '@board-game/core';
import { hashRoomPassword, verifyRoomPassword } from '@/auth/password.js';

export type PlatformRoomCreateInput = Omit<RoomCreateInput, 'gameId'> & {
  readonly gameId?: string;
};

export interface PlatformRoomManagementOptions extends RoomManagementPolicy {
  readonly store: RoomManagementStore;
  /** Compatibility default for clients predating the game catalog. */
  readonly defaultGameId?: string;
  readonly publicNames?: (
    principalIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  /** Best-effort account cache invalidation after a committed room mutation. */
  readonly onAccountChanged?: (principalIds: readonly string[]) => void;
}

/** Shared account-aware room service; all game policy comes from registration. */
export class PlatformRoomManagement {
  private readonly service: RoomManagementService;

  public constructor(private readonly options: PlatformRoomManagementOptions) {
    this.service = new RoomManagementService(options.store, {
      resolveMode: options.resolveMode,
      ...(options.resolveCapacity
        ? { resolveCapacity: options.resolveCapacity }
        : {}),
      authorize: options.authorize,
      authorizeInvite: options.authorizeInvite,
      hashPassword:
        options.hashPassword ??
        ((password) => hashRoomPassword(password.trim())),
      verifyPassword:
        options.verifyPassword ??
        ((passwordHash, password) =>
          verifyRoomPassword(password.trim(), passwordHash)),
      ...(options.validateColor
        ? { validateColor: options.validateColor }
        : {}),
      ...(options.createBotProfile
        ? { createBotProfile: options.createBotProfile }
        : {}),
      ...(options.controllers ? { controllers: options.controllers } : {}),
      ...(options.controllerOptions
        ? { controllerOptions: options.controllerOptions }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.newId ? { newId: options.newId } : {}),
    });
  }

  public createRoom(
    principalId: string,
    input: PlatformRoomCreateInput,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, undefined, () =>
      this.projectRoom(
        this.service.createRoom(principalId, {
          ...input,
          gameId: input.gameId ?? this.options.defaultGameId ?? '',
        }),
      ),
    );
  }

  public getRoom(
    principalId: string,
    roomId: string,
  ): Promise<PlatformRoomView> {
    return this.projectRoom(this.service.getRoom(principalId, roomId));
  }

  public async listRooms(
    principalId: string,
    options?: RoomManagementListOptions,
  ): Promise<RoomListViewResult> {
    const page = await this.service.listRooms(principalId, options);
    return { ...page, rooms: await this.projectRooms(page.rooms) };
  }

  public async listInvitations(
    principalId: string,
    options?: Pick<RoomManagementListOptions, 'limit' | 'cursor'>,
  ): Promise<PlatformRoomInvitationList> {
    const page = await this.service.listInvitations(principalId, options);
    if (!this.options.publicNames || page.items.length === 0) return page;
    const names = await this.options.publicNames([
      ...new Set(page.items.map((item) => item.ownerId)),
    ]);
    return {
      ...page,
      items: page.items.map((item) => {
        const ownerName = names.get(item.ownerId);
        return ownerName ? { ...item, ownerName } : item;
      }),
    };
  }

  public renameRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    name: string,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.renameRoom(principalId, roomId, expectedRevision, name),
      ),
    );
  }

  public configureRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    setup: RoomCreateInput['setup'],
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.configureRoom(
          principalId,
          roomId,
          expectedRevision,
          setup,
        ),
      ),
    );
  }

  public ready(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    ready: boolean,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.ready(principalId, roomId, expectedRevision, ready),
      ),
    );
  }

  public deleteRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.deleteRoom(principalId, roomId, expectedRevision),
      ),
    );
  }

  public joinRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input?: RoomJoinInput,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.joinRoom(principalId, roomId, expectedRevision, input),
      ),
    );
  }

  public addBot(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.addBot(principalId, roomId, expectedRevision),
      ),
    );
  }

  public addControlledSeat(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input: RoomSeatControllerInput,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.addControlledSeat(
          principalId,
          roomId,
          expectedRevision,
          input,
        ),
      ),
    );
  }

  public acceptInvitation(
    principalId: string,
    roomId: string,
    invitationId: string,
    input?: RoomJoinInput,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.acceptInvite(principalId, roomId, invitationId, input),
      ),
    );
  }

  public declineInvitation(
    principalId: string,
    roomId: string,
    invitationId: string,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.declineInvite(principalId, roomId, invitationId),
      ),
    );
  }

  public leaveRoom(
    principalId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.leaveRoom(principalId, roomId, expectedRevision),
      ),
    );
  }

  public kickMember(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    targetPrincipalId: string,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.kickMember(
          principalId,
          roomId,
          expectedRevision,
          targetPrincipalId,
        ),
      ),
    );
  }

  public grantInvite(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    input: RoomInviteInput,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.grantInvite(principalId, roomId, expectedRevision, input),
      ),
    );
  }

  public revokeInvite(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    inviteePrincipalId: string,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.revokeInvite(
          principalId,
          roomId,
          expectedRevision,
          inviteePrincipalId,
        ),
      ),
    );
  }

  public setColor(
    principalId: string,
    roomId: string,
    expectedRevision: number,
    color: string,
  ): Promise<PlatformRoomView> {
    return this.mutateAndNotify(principalId, roomId, () =>
      this.projectRoom(
        this.service.setColor(principalId, roomId, expectedRevision, color),
      ),
    );
  }

  private async mutateAndNotify<T extends PlatformRoomView>(
    principalId: string,
    roomId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = roomId ? await this.captureParticipants(roomId) : [];
    const room = await operation();
    const after = await this.captureParticipants(room.id);
    this.notifyAccounts([principalId, ...before, ...after]);
    return room;
  }

  private async captureParticipants(
    roomId: string,
  ): Promise<readonly string[]> {
    try {
      const [room, access] = await Promise.all([
        this.options.store.getRoom(roomId),
        this.options.store.getRoomAccess(roomId),
      ]);
      if (!room) return [];
      return [
        room.ownerId,
        ...room.members
          .map(participantAccountId)
          .filter(
            (principalId): principalId is string => principalId !== undefined,
          ),
        ...access.grants.map((grant) => grant.principalId),
      ];
    } catch {
      return [];
    }
  }

  private notifyAccounts(principalIds: readonly string[]): void {
    const unique = [...new Set(principalIds)].filter(
      (principalId) => principalId.length > 0,
    );
    if (unique.length === 0) return;
    try {
      this.options.onAccountChanged?.(unique);
    } catch {
      // Cache invalidation must never change a committed room mutation.
    }
  }

  private async projectRoom(
    pending: Promise<PlatformRoomView>,
  ): Promise<PlatformRoomView> {
    const room = await pending;
    return (await this.projectRooms([room]))[0] ?? room;
  }

  private async projectRooms(
    rooms: readonly PlatformRoomView[],
  ): Promise<readonly PlatformRoomView[]> {
    if (!this.options.publicNames || rooms.length === 0) return rooms;
    const names = await this.options.publicNames([
      ...new Set(
        rooms.flatMap((room) =>
          room.members
            .map(participantAccountId)
            .filter(
              (principalId): principalId is string => principalId !== undefined,
            ),
        ),
      ),
    ]);
    return rooms.map((room) => ({
      ...room,
      members: room.members.map((member) => {
        const accountId = participantAccountId(member);
        const displayName =
          member.publicProfile?.displayName ??
          (accountId
            ? (names.get(accountId) ??
              ((member.controller ?? 'human') === 'human'
                ? accountId
                : undefined))
            : undefined);
        return {
          ...member,
          ...(displayName !== undefined
            ? {
                publicProfile: {
                  ...member.publicProfile,
                  displayName,
                },
              }
            : member.publicProfile
              ? { publicProfile: member.publicProfile }
              : {}),
        };
      }),
    }));
  }
}
