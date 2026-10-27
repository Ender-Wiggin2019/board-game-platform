import {
  contractError,
  type JsonValue,
  type PlatformRoom,
  type RoomSeatControllerInput,
  type SessionStatus,
} from '@board-game/contracts';
import type {
  CommandInput,
  EventsInput,
  QueryInput,
  ResumeInput,
  StatusInput,
} from '@board-game/core';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from './PlatformErrorFilter.js';
import { PlatformGameServices } from './PlatformGameServices.js';
import { PlatformReleaseAdministration } from './PlatformReleaseAdministration.js';
import {
  assertPlatformFeature,
  PLATFORM_CONFIGURATION,
  type PlatformPublicConfiguration,
} from './platform-configuration.js';
import {
  input,
  pageLimit,
  type PlatformRequest as Request,
  reference,
  revision,
  sessionReference,
  text,
} from './request.js';

@Controller('platform')
@UseFilters(PlatformErrorFilter)
export class PlatformController {
  constructor(
    @Inject(PlatformApplicationRuntime)
    private readonly runtime: PlatformApplicationRuntime,
    @Optional()
    @Inject(PlatformGameServices)
    private readonly games?: PlatformGameServices,
    @Optional()
    @Inject(PlatformReleaseAdministration)
    private readonly releaseAdministration?: PlatformReleaseAdministration,
    @Optional()
    @Inject(PLATFORM_CONFIGURATION)
    private readonly configuration?: PlatformPublicConfiguration,
  ) {}

  private assertChatEnabled(): void {
    assertPlatformFeature(this.configuration, 'chat');
  }

  @Get('catalog')
  @Header('Cache-Control', 'no-store')
  catalog() {
    return this.runtime.releaseRegistry && this.releaseAdministration
      ? this.releaseAdministration.platformCatalog()
      : this.runtime.catalog();
  }

  @Get('shell/summary')
  @Header('Cache-Control', 'no-store')
  async shellSummary(@Req() request: Request) {
    const identity = await this.runtime.identity.resolve(reference(request));
    if (!this.games)
      throw contractError('NOT_READY', 'platform.shell.summary_unavailable');
    return this.games.readShellSummary(identity.principalId);
  }

  @Post('solo')
  async solo(@Req() request: Request, @Body() body: unknown) {
    const value = input(body, [
      'gameId',
      'modeId',
      'releaseId',
      'channel',
      'requestId',
      'setup',
      'seed',
    ]);
    const identity = await this.runtime.identity.resolve(reference(request));
    const gameId = text(value.gameId ?? this.runtime.options.defaultGameId);
    const modeId = text(value.modeId);
    if (this.runtime.releaseRegistry) {
      if (value.releaseId !== undefined || value.channel === undefined)
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.channel_required',
        );
      return this.runtime.createDirectSessionFromChannel(identity.principalId, {
        gameId,
        modeId,
        channel: text(value.channel),
        requestId: text(value.requestId),
        setup: value.setup as JsonValue,
        ...(value.seed !== undefined ? { seed: text(value.seed) } : {}),
      });
    }
    return this.runtime.admission.createDirectSession(identity.principalId, {
      gameId,
      modeId: this.runtime.publicModeId(gameId, modeId),
      releaseId: text(value.releaseId),
      requestId: text(value.requestId),
      setup: value.setup as JsonValue,
      ...(value.seed !== undefined ? { seed: text(value.seed) } : {}),
    });
  }

  @Get('rooms')
  @Header('Cache-Control', 'no-store')
  async rooms(@Req() request: Request, @Query() query: unknown) {
    const value = input(query, ['gameId', 'status', 'limit', 'cursor']);
    if (
      value.status !== undefined &&
      !['open', 'starting', 'started', 'closed'].includes(text(value.status))
    )
      throw contractError('INVALID_REQUEST', 'platform.room.status');
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.listRooms(identity.principalId, {
      ...(value.gameId !== undefined ? { gameId: text(value.gameId) } : {}),
      ...(value.status !== undefined
        ? { status: text(value.status) as PlatformRoom['status'] }
        : {}),
      ...(value.cursor !== undefined ? { cursor: text(value.cursor) } : {}),
      ...(value.limit !== undefined ? { limit: pageLimit(value.limit) } : {}),
    });
  }

  @Get('invitations')
  @Header('Cache-Control', 'no-store')
  async invitations(@Req() request: Request, @Query() query: unknown) {
    const value = input(query, ['limit', 'cursor']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.listInvitations(identity.principalId, {
      ...(value.cursor !== undefined ? { cursor: text(value.cursor) } : {}),
      ...(value.limit !== undefined ? { limit: pageLimit(value.limit) } : {}),
    });
  }

  @Post('rooms')
  async createRoom(@Req() request: Request, @Body() body: unknown) {
    const value = input(body, [
      'gameId',
      'modeId',
      'releaseId',
      'channel',
      'requestId',
      'visibility',
      'setup',
      'seed',
      'name',
      'password',
      'color',
    ]);
    if (value.visibility !== 'public' && value.visibility !== 'private')
      throw contractError('INVALID_REQUEST', 'platform.room.visibility');
    const identity = await this.runtime.identity.resolve(reference(request));
    const gameId = text(value.gameId ?? this.runtime.options.defaultGameId);
    const modeId = text(value.modeId);
    if (this.runtime.releaseRegistry) {
      if (value.releaseId !== undefined || value.channel === undefined)
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.channel_required',
        );
      const selected = await this.runtime.channelForNewAdmission({
        gameId,
        modeId,
        channel: text(value.channel),
      });
      return this.runtime.rooms.createRoom(identity.principalId, {
        gameId,
        modeId: this.runtime.publicModeId(gameId, modeId, selected.releaseId),
        releaseId: selected.releaseId,
        ...(value.requestId !== undefined
          ? { requestId: text(value.requestId) }
          : {}),
        visibility: value.visibility,
        setup: value.setup as JsonValue,
        ...(value.seed !== undefined ? { seed: text(value.seed) } : {}),
        ...(value.name !== undefined ? { name: text(value.name) } : {}),
        ...(value.password !== undefined
          ? { password: text(value.password) }
          : {}),
        ...(value.color !== undefined ? { color: text(value.color) } : {}),
      });
    }
    return this.runtime.rooms.createRoom(identity.principalId, {
      gameId,
      modeId: this.runtime.publicModeId(gameId, modeId),
      releaseId: text(value.releaseId),
      ...(value.requestId !== undefined
        ? { requestId: text(value.requestId) }
        : {}),
      visibility: value.visibility,
      setup: value.setup as JsonValue,
      ...(value.seed !== undefined ? { seed: text(value.seed) } : {}),
      ...(value.name !== undefined ? { name: text(value.name) } : {}),
      ...(value.password !== undefined
        ? { password: text(value.password) }
        : {}),
      ...(value.color !== undefined ? { color: text(value.color) } : {}),
    });
  }

  @Get('rooms/:id')
  @Header('Cache-Control', 'no-store')
  async room(@Req() request: Request, @Param('id') id: string) {
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.getRoom(identity.principalId, text(id));
  }

  @Post('rooms/:id/join')
  async join(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'password', 'color']);
    const identity = await this.runtime.identity.resolve(reference(request));
    const roomId = text(id);
    const current =
      value.expectedRevision === undefined
        ? await this.runtime.admissionStore.getRoom(roomId)
        : undefined;
    if (value.expectedRevision === undefined && !current)
      throw contractError('NOT_FOUND', 'platform.room.not_found');
    await this.runtime.rooms.joinRoom(
      identity.principalId,
      roomId,
      revision(value.expectedRevision ?? current?.revision),
      {
        ...(value.password !== undefined
          ? { password: text(value.password) }
          : {}),
        ...(value.color !== undefined ? { color: text(value.color) } : {}),
      },
    );
    const started = await this.runtime.admission.autoStartRoom(roomId);
    if (started) {
      await this.runtime.notifyRoomChanged?.(roomId, identity.principalId);
    }
    return this.runtime.rooms.getRoom(identity.principalId, roomId);
  }

  @Post('rooms/:id/bots')
  async addBot(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision']);
    const identity = await this.runtime.identity.resolve(reference(request));
    const roomId = text(id);
    await this.runtime.rooms.addBot(
      identity.principalId,
      roomId,
      revision(value.expectedRevision),
    );
    const started = await this.runtime.admission.autoStartRoom(roomId);
    if (started) {
      await this.runtime.notifyRoomChanged?.(roomId, identity.principalId);
    }
    return this.runtime.rooms.getRoom(identity.principalId, roomId);
  }

  @Post('rooms/:id/controllers')
  async addControlledSeat(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'controller']);
    const controller = input(value.controller, [
      'kind',
      'controllerId',
      'options',
      'displayName',
    ]);
    let selection: RoomSeatControllerInput;
    if (controller.kind === 'hotseat') {
      if (
        controller.controllerId !== undefined ||
        controller.options !== undefined
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.controllerUnsupported',
        );
      selection = {
        kind: 'hotseat',
        ...(controller.displayName !== undefined
          ? { displayName: text(controller.displayName) }
          : {}),
      };
    } else if (controller.kind === 'ai' || controller.kind === 'automa') {
      if (controller.displayName !== undefined)
        throw contractError(
          'INVALID_REQUEST',
          'platform.room.controllerUnsupported',
        );
      selection = {
        kind: controller.kind,
        controllerId: text(controller.controllerId),
        ...(controller.options !== undefined
          ? { options: controller.options as JsonValue }
          : {}),
      };
    } else
      throw contractError(
        'INVALID_REQUEST',
        'platform.room.controllerUnsupported',
      );
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.addControlledSeat(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      selection,
    );
  }

  @Post('rooms/:id/leave')
  async leave(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.leaveRoom(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
    );
  }

  @Patch('rooms/:id/name')
  async renameRoom(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'name']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.renameRoom(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      text(value.name),
    );
  }

  @Post('rooms/:id/delete')
  async deleteRoom(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.deleteRoom(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
    );
  }

  @Post('rooms/:id/kick')
  async kickRoomMember(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'principalId']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.kickMember(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      text(value.principalId),
    );
  }

  @Post('rooms/:id/invites')
  async inviteToRoom(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'principalId', 'seatId']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.grantInvite(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      {
        principalId: text(value.principalId),
        ...(value.seatId !== undefined ? { seatId: text(value.seatId) } : {}),
      },
    );
  }

  @Post('rooms/:id/invites/:grantId/accept')
  async acceptRoomInvitation(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    const value = input(body ?? {}, ['password', 'color']);
    const identity = await this.runtime.identity.resolve(reference(request));
    const roomId = text(id);
    await this.runtime.rooms.acceptInvitation(
      identity.principalId,
      roomId,
      text(grantId),
      {
        ...(value.password !== undefined
          ? { password: text(value.password) }
          : {}),
        ...(value.color !== undefined ? { color: text(value.color) } : {}),
      },
    );
    const started = await this.runtime.admission.autoStartRoom(roomId);
    if (started) {
      await this.runtime.notifyRoomChanged?.(roomId, identity.principalId);
    }
    return this.runtime.rooms.getRoom(identity.principalId, roomId);
  }

  @Post('rooms/:id/invites/:grantId/decline')
  async declineRoomInvitation(
    @Req() request: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @Body() body: unknown,
  ) {
    input(body ?? {}, []);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.declineInvitation(
      identity.principalId,
      text(id),
      text(grantId),
    );
  }

  @Post('rooms/:id/invites/revoke')
  async revokeRoomInvite(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'principalId']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.revokeInvite(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      text(value.principalId),
    );
  }

  @Patch('rooms/:id/color')
  async setRoomColor(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'color']);
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.setColor(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      text(value.color),
    );
  }

  @Patch('rooms/:id/setup')
  async configure(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'setup']);
    const identity = await this.runtime.identity.resolve(reference(request));
    await this.runtime.rooms.configureRoom(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      value.setup as JsonValue,
    );
    const started = await this.runtime.admission.autoStartRoom(text(id));
    if (started) {
      await this.runtime.notifyRoomChanged?.(text(id), identity.principalId);
    }
    return this.runtime.rooms.getRoom(identity.principalId, text(id));
  }

  @Post('rooms/:id/ready')
  async ready(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'ready']);
    if (typeof value.ready !== 'boolean')
      throw contractError('INVALID_REQUEST', 'platform.room.ready');
    const identity = await this.runtime.identity.resolve(reference(request));
    return this.runtime.rooms.ready(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      value.ready,
    );
  }

  @Post('rooms/:id/start')
  async start(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['expectedRevision', 'requestId']);
    const identity = await this.runtime.identity.resolve(reference(request));
    const started = await this.runtime.admission.startRoom(
      identity.principalId,
      text(id),
      revision(value.expectedRevision),
      text(value.requestId),
    );
    await this.runtime.notifyRoomChanged?.(text(id), identity.principalId);
    return started;
  }

  @Post('rooms/:id/cancel-start')
  async cancel(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    input(body, []);
    const identity = await this.runtime.identity.resolve(reference(request));
    const cancelled = await this.runtime.admission.cancelStart(
      identity.principalId,
      text(id),
    );
    await this.runtime.notifyRoomChanged?.(text(id), identity.principalId);
    return cancelled;
  }

  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  directory(@Req() request: Request, @Query() query: unknown) {
    const value = input(query, [
      'gameId',
      'scope',
      'status',
      'limit',
      'cursor',
    ]);
    if (
      value.scope !== undefined &&
      value.scope !== 'mine' &&
      value.scope !== 'public'
    )
      throw contractError('INVALID_REQUEST', 'platform.request.scope');
    if (
      value.status !== undefined &&
      !['suspended', 'active', 'completed', 'cancelled', 'paused'].includes(
        text(value.status),
      )
    )
      throw contractError('INVALID_REQUEST', 'platform.request.status');
    return this.runtime.listSessions(
      reference(request),
      value.scope === 'public' ? 'public' : 'mine',
      {
        ...(value.gameId !== undefined ? { gameId: text(value.gameId) } : {}),
        ...(value.status !== undefined
          ? { status: value.status as SessionStatus }
          : {}),
        ...(value.limit !== undefined ? { limit: pageLimit(value.limit) } : {}),
        ...(value.cursor !== undefined ? { cursor: text(value.cursor) } : {}),
      },
    );
  }

  @Get('sessions/:id/route')
  @Header('Cache-Control', 'no-store')
  route(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.sessions.descriptor(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/view')
  @Header('Cache-Control', 'no-store')
  view(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.views.view(sessionReference(request), text(id));
  }

  @Post('sessions/:id/resume')
  resume(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: ResumeInput,
  ) {
    return this.runtime.views.resume(sessionReference(request), text(id), body);
  }

  @Post('sessions/:id/commands')
  command(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: CommandInput,
  ) {
    return this.runtime.views.command(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/query')
  query(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: QueryInput,
  ) {
    return this.runtime.sessions.query(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/events')
  events(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: EventsInput,
  ) {
    return this.runtime.sessions.events(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/status')
  status(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: StatusInput,
  ) {
    return this.runtime.sessions.status(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Get('sessions/:id/completion')
  @Header('Cache-Control', 'no-store')
  completion(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.results.getCompletion(
      sessionReference(request),
      text(id),
    );
  }

  /** Stable platform result alias used by the end-session shell. */
  @Get('sessions/:id/result')
  @Header('Cache-Control', 'no-store')
  result(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.results.getCompletion(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/end-record')
  @Header('Cache-Control', 'no-store')
  endRecord(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.results.getEndRecord(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/settlement')
  @Header('Cache-Control', 'no-store')
  settlement(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.results.getSettlement(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/replay/manifest')
  @Header('Cache-Control', 'no-store')
  replayManifest(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.results.getReplayManifest(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/replay/route')
  @Header('Cache-Control', 'no-store')
  replayRoute(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.replaySessions.descriptor(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/replay/view')
  @Header('Cache-Control', 'no-store')
  replayView(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.replaySessions.view(
      sessionReference(request),
      text(id),
    );
  }

  @Post('sessions/:id/replay/resume')
  replayResume(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: ResumeInput,
  ) {
    return this.runtime.replaySessions.resume(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/replay/query')
  replayQuery(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: QueryInput,
  ) {
    return this.runtime.results.queryReplay(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/replay/events')
  replayEvents(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: EventsInput,
  ) {
    return this.runtime.replaySessions.events(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Post('sessions/:id/replay/status')
  replayStatus(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: StatusInput,
  ) {
    return this.runtime.replaySessions.status(
      sessionReference(request),
      text(id),
      body,
    );
  }

  @Get('sessions/:id/replay/frames')
  @Header('Cache-Control', 'no-store')
  replayFrames(
    @Req() request: Request,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const value = input(query, ['from', 'limit']);
    if (
      value.from !== undefined &&
      (typeof value.from !== 'string' ||
        !/^(0|[1-9][0-9]{0,6})$/.test(value.from))
    )
      throw contractError('INVALID_REQUEST', 'platform.request.replay_range');
    return this.runtime.results.getReplayFrames(
      sessionReference(request),
      text(id),
      value.from === undefined ? 0 : Number(value.from),
      value.limit === undefined ? 10 : pageLimit(value.limit),
    );
  }

  @Get('sessions/:id/chat')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  @Header('Cache-Control', 'no-store')
  chat(@Req() request: Request, @Param('id') id: string) {
    this.assertChatEnabled();
    return this.runtime.chat.loadSnapshot(sessionReference(request), text(id));
  }

  @Get('rooms/:id/chat')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  @Header('Cache-Control', 'no-store')
  roomChat(@Req() request: Request, @Param('id') id: string) {
    this.assertChatEnabled();
    return this.runtime.roomChat.loadSnapshot(reference(request), text(id));
  }

  @Post('rooms/:id/chat')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  sendRoomChat(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertChatEnabled();
    const value = input(body, ['requestId', 'body']);
    if (typeof value.body !== 'string')
      throw contractError('INVALID_REQUEST', 'platform.chat.body_invalid');
    return this.runtime.roomChat.send(
      reference(request),
      text(id),
      text(value.requestId),
      value.body,
    );
  }

  @Post('rooms/:id/chat/read')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  readRoomChat(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertChatEnabled();
    const value = input(body, ['throughMessageId']);
    return this.runtime.roomChat.markRead(
      reference(request),
      text(id),
      text(value.throughMessageId),
    );
  }

  @Post('sessions/:id/chat')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  sendChat(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertChatEnabled();
    const value = input(body, ['requestId', 'body']);
    if (typeof value.body !== 'string')
      throw contractError('INVALID_REQUEST', 'platform.chat.body_invalid');
    return this.runtime.chat.send(
      sessionReference(request),
      text(id),
      text(value.requestId),
      value.body,
    );
  }

  @Post('sessions/:id/chat/read')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.GAME_PLAY)
  readChat(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    this.assertChatEnabled();
    const value = input(body, ['throughMessageId']);
    return this.runtime.chat.markRead(
      sessionReference(request),
      text(id),
      text(value.throughMessageId),
    );
  }

  @Get('sessions/:id/summary')
  @Header('Cache-Control', 'no-store')
  summary(@Req() request: Request, @Param('id') id: string) {
    return this.runtime.sessions.summary(sessionReference(request), text(id));
  }
}
