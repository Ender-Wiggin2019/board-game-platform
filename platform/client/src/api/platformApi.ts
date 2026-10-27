import type {
  JsonValue,
  ModeDefinition,
  Participant,
  PlatformRoom,
  PlatformRoomInvitation,
  PlatformRoomView,
  PublicStartStatus,
  RoomSeatControllerInput,
  SessionRoute,
  SessionStatus,
} from '@board-game/contracts';
import type {
  IGameChatHistoryPayload,
  IGameChatMessage,
  IGameChatReadState,
} from '@board-platform/contracts/types/protocol/gameChat';
import type { IPlatformSessionPresencePayload } from '@board-platform/contracts/types/protocol/presence';
import type { IPlatformShellSummary } from '@board-platform/contracts/types/protocol/shell';
import { httpClient } from '@/api/httpClient';

export interface PlatformCatalogEntry {
  readonly gameId: string;
  /** Client release pin; remote admissions additionally advertise a channel. */
  readonly releaseId: string;
  readonly channel?: string;
  readonly mode: ModeDefinition;
  readonly metadata?: {
    readonly name?: string;
    readonly description?: string;
    readonly nameKey?: string;
    readonly descriptionKey?: string;
    readonly cover?: string;
  };
}

export interface PlatformRoomListResponse {
  readonly rooms: readonly PlatformRoomView[];
  readonly nextCursor?: string;
}

export interface PlatformRoomListParams {
  readonly gameId?: string;
  readonly status?: PlatformRoom['status'];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PlatformRoomInvitationListResponse {
  readonly items: readonly PlatformRoomInvitation[];
  readonly nextCursor?: string;
}

export interface PlatformRoomInvitationListParams {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PlatformSessionDirectoryParticipant {
  readonly principalId: string;
  readonly seatId: string;
  readonly teamId?: string;
  readonly publicProfile?: {
    readonly displayName?: string;
  };
}

export interface PlatformSessionDirectoryRecord {
  readonly sessionId: string;
  readonly admissionId: string;
  readonly route: SessionRoute;
  readonly visibility: 'public' | 'private';
  readonly participants: readonly PlatformSessionDirectoryParticipant[];
  readonly status: SessionStatus;
  readonly latestAggregateSequence: number;
  readonly summary?: JsonValue;
  readonly result?: JsonValue;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PlatformSessionListParams {
  readonly scope?: 'mine' | 'public';
  readonly status?: SessionStatus;
  readonly gameId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PlatformSessionListResponse {
  readonly items: readonly PlatformSessionDirectoryRecord[];
  readonly nextCursor?: string;
}

export interface PlatformSessionResultResponse {
  readonly route?: SessionRoute;
  readonly status?: string;
  readonly sourceRevision?: number;
  readonly result?: JsonValue | null;
  readonly endRecord?: JsonValue | null;
  readonly replayRef?: JsonValue | null;
  readonly settlement?: {
    readonly processingState?: string;
    readonly attempts?: number;
    readonly nextAttemptAt?: number;
  } | null;
  readonly completion?: {
    readonly status?: string;
    readonly endedAt?: number;
    readonly participants?: readonly Participant[];
    readonly result?: JsonValue | null;
    readonly replayRef?: JsonValue | null;
  } | null;
}

export interface CreatePlatformRoomInput {
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId?: string;
  readonly channel?: string;
  readonly requestId: string;
  readonly visibility: PlatformRoom['visibility'];
  readonly setup: JsonValue;
  readonly seed?: string;
  readonly name?: string;
  readonly password?: string;
  readonly color?: string;
}

export interface LegacyRouteDescriptor {
  readonly authority: 'legacy';
  readonly releaseId: string;
  readonly publicOrigin: string;
}

function isAllowedLegacyOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]')
  );
}

export function buildLegacyRouteTarget(
  descriptor: LegacyRouteDescriptor,
  location: Pick<
    Location,
    'origin' | 'pathname' | 'search' | 'hash'
  > = window.location,
):
  | { readonly kind: 'same-origin' }
  | { readonly kind: 'remote'; readonly url: string } {
  if (
    descriptor.authority !== 'legacy' ||
    descriptor.releaseId.length === 0 ||
    descriptor.publicOrigin.length === 0
  ) {
    throw new Error('platform.legacy.route.invalid');
  }
  const origin = new URL(descriptor.publicOrigin, location.origin);
  if (!isAllowedLegacyOrigin(origin)) {
    throw new Error('platform.legacy.route.origin_invalid');
  }
  if (origin.origin === location.origin) return { kind: 'same-origin' };
  return {
    kind: 'remote',
    url: `${origin.origin}${location.pathname}${location.search}${location.hash}`,
  };
}

export function isPlatformNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return false;
  }
  const value = error as Record<string, unknown>;
  if (value.responseCode === 'NOT_FOUND') return true;
  const response = value.response;
  if (
    typeof response !== 'object' ||
    response === null ||
    Array.isArray(response)
  ) {
    return false;
  }
  const data = (response as Record<string, unknown>).data;
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).code === 'NOT_FOUND'
  );
}

export interface CreatePlatformSoloInput {
  readonly gameId: string;
  readonly modeId: string;
  readonly releaseId?: string;
  readonly channel?: string;
  readonly requestId: string;
  readonly setup: JsonValue;
  readonly seed?: string;
}

export interface PlatformRequestIntent {
  readonly key: string;
  readonly requestId: string;
}

function requestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const createPlatformRequestId = requestId;

function admissionTarget(input: {
  readonly channel?: string;
  readonly releaseId?: string;
}): { readonly channel: string } | { readonly releaseId: string } {
  if (input.channel) return { channel: input.channel };
  if (input.releaseId) return { releaseId: input.releaseId };
  throw new Error('platform.admission.release_or_channel_required');
}

export function resolvePlatformRequestIntent(
  current: PlatformRequestIntent | null,
  key: string,
): PlatformRequestIntent {
  if (current?.key === key) return current;
  return { key, requestId: createPlatformRequestId() };
}

export const platformApi = {
  async catalog(): Promise<readonly PlatformCatalogEntry[]> {
    const response = await httpClient.get<readonly PlatformCatalogEntry[]>(
      '/platform/catalog',
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async shellSummary(): Promise<IPlatformShellSummary> {
    const response = await httpClient.get<IPlatformShellSummary>(
      '/platform/shell/summary',
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getLegacyRoute(sessionId: string): Promise<LegacyRouteDescriptor> {
    const response = await httpClient.get<LegacyRouteDescriptor>(
      `/platform/legacy/${encodeURIComponent(sessionId)}/route`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async listRooms(
    params: PlatformRoomListParams = {},
  ): Promise<PlatformRoomListResponse> {
    const response = await httpClient.get<PlatformRoomListResponse>(
      '/platform/rooms',
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async listInvitations(
    params: PlatformRoomInvitationListParams = {},
  ): Promise<PlatformRoomInvitationListResponse> {
    const response = await httpClient.get<PlatformRoomInvitationListResponse>(
      '/platform/invitations',
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async listSessions(
    params: PlatformSessionListParams = {},
  ): Promise<PlatformSessionListResponse> {
    const response = await httpClient.get<PlatformSessionListResponse>(
      '/platform/sessions',
      { showServerUpdateDialog: true, params },
    );
    return response.data;
  },

  async getPresence(
    sessionId: string,
  ): Promise<IPlatformSessionPresencePayload> {
    const response = await httpClient.get<IPlatformSessionPresencePayload>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/presence`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getSessionResult(
    sessionId: string,
  ): Promise<PlatformSessionResultResponse> {
    const response = await httpClient.get<PlatformSessionResultResponse>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/result`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  /** Read a retained terminal native report through the platform authority. */

  async rematch(
    sessionId: string,
    requestId: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/rematch`,
      { requestId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getChat(sessionId: string): Promise<IGameChatHistoryPayload> {
    const response = await httpClient.get<IGameChatHistoryPayload>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/chat`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async sendChat(
    sessionId: string,
    requestId: string,
    body: string,
  ): Promise<IGameChatMessage> {
    const response = await httpClient.post<IGameChatMessage>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/chat`,
      { requestId, body },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async markChatRead(
    sessionId: string,
    throughMessageId: string,
  ): Promise<IGameChatReadState> {
    const response = await httpClient.post<IGameChatReadState>(
      `/platform/sessions/${encodeURIComponent(sessionId)}/chat/read`,
      { throughMessageId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getRoomChat(roomId: string): Promise<IGameChatHistoryPayload> {
    const response = await httpClient.get<IGameChatHistoryPayload>(
      `/platform/rooms/${encodeURIComponent(roomId)}/chat`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async sendRoomChat(
    roomId: string,
    requestId: string,
    body: string,
  ): Promise<IGameChatMessage> {
    const response = await httpClient.post<IGameChatMessage>(
      `/platform/rooms/${encodeURIComponent(roomId)}/chat`,
      { requestId, body },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async markRoomChatRead(
    roomId: string,
    throughMessageId: string,
  ): Promise<IGameChatReadState> {
    const response = await httpClient.post<IGameChatReadState>(
      `/platform/rooms/${encodeURIComponent(roomId)}/chat/read`,
      { throughMessageId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async getRoom(roomId: string): Promise<PlatformRoomView> {
    const response = await httpClient.get<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}`,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async createRoom(input: CreatePlatformRoomInput): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      '/platform/rooms',
      {
        gameId: input.gameId,
        modeId: input.modeId,
        ...admissionTarget(input),
        requestId: input.requestId,
        visibility: input.visibility,
        setup: input.setup,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.color === undefined ? {} : { color: input.color }),
      },
      {
        showServerUpdateDialog: true,
      },
    );
    return response.data;
  },

  async createSolo(input: CreatePlatformSoloInput): Promise<PublicStartStatus> {
    const response = await httpClient.post<PublicStartStatus>(
      '/platform/solo',
      {
        gameId: input.gameId,
        modeId: input.modeId,
        ...admissionTarget(input),
        requestId: input.requestId,
        setup: input.setup,
        ...(input.seed === undefined ? {} : { seed: input.seed }),
      },
      {
        showServerUpdateDialog: true,
      },
    );
    return response.data;
  },

  async joinRoom(
    roomId: string,
    expectedRevision: number | undefined,
    input: { password?: string; color?: string } = {},
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/join`,
      {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...input,
      },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async addBot(
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/bots`,
      { expectedRevision },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async setRoomController(
    roomId: string,
    expectedRevision: number,
    controller: RoomSeatControllerInput,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/controllers`,
      { expectedRevision, controller },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async leaveRoom(
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/leave`,
      { expectedRevision },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async configureRoom(
    roomId: string,
    expectedRevision: number,
    setup: JsonValue,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.patch<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/setup`,
      { expectedRevision, setup },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async readyRoom(
    roomId: string,
    expectedRevision: number,
    ready: boolean,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/ready`,
      { expectedRevision, ready },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async startRoom(
    roomId: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<PublicStartStatus> {
    const response = await httpClient.post<PublicStartStatus>(
      `/platform/rooms/${encodeURIComponent(roomId)}/start`,
      { expectedRevision, requestId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async cancelStart(roomId: string): Promise<PublicStartStatus> {
    const response = await httpClient.post<PublicStartStatus>(
      `/platform/rooms/${encodeURIComponent(roomId)}/cancel-start`,
      {},
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async renameRoom(
    roomId: string,
    expectedRevision: number,
    name: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.patch<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/name`,
      { expectedRevision, name },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async deleteRoom(
    roomId: string,
    expectedRevision: number,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/delete`,
      { expectedRevision },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async kickRoomMember(
    roomId: string,
    expectedRevision: number,
    principalId: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/kick`,
      { expectedRevision, principalId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async inviteToRoom(
    roomId: string,
    expectedRevision: number,
    principalId: string,
    seatId?: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/invites`,
      { expectedRevision, principalId, ...(seatId ? { seatId } : {}) },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async revokeRoomInvite(
    roomId: string,
    expectedRevision: number,
    principalId: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/invites/revoke`,
      { expectedRevision, principalId },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async acceptInvitation(
    roomId: string,
    grantId: string,
    input: { password?: string; color?: string } = {},
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(grantId)}/accept`,
      input,
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async declineInvitation(
    roomId: string,
    grantId: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.post<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/invites/${encodeURIComponent(grantId)}/decline`,
      {},
      { showServerUpdateDialog: true },
    );
    return response.data;
  },

  async setRoomColor(
    roomId: string,
    expectedRevision: number,
    color: string,
  ): Promise<PlatformRoomView> {
    const response = await httpClient.patch<PlatformRoomView>(
      `/platform/rooms/${encodeURIComponent(roomId)}/color`,
      { expectedRevision, color },
      { showServerUpdateDialog: true },
    );
    return response.data;
  },
};
