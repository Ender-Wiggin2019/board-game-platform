import { contractError } from '@board-game/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';
import { PlatformErrorFilter } from './PlatformErrorFilter.js';
import { PlatformPlayerConnections } from './PlatformPlayerConnections.js';
import { PlatformReleaseAdministration } from './PlatformReleaseAdministration.js';
import {
  input,
  type PlatformRequest as Request,
  sessionReference,
  text,
} from './request.js';

@Controller('platform')
@UseFilters(PlatformErrorFilter)
export class PlatformReleaseController {
  constructor(
    @Inject(PlatformReleaseAdministration)
    private readonly releases: PlatformReleaseAdministration,
    @Inject(PlatformApplicationRuntime)
    private readonly runtime: PlatformApplicationRuntime,
    @Optional()
    @Inject(PlatformPlayerConnections)
    private readonly playerConnections?: PlatformPlayerConnections,
  ) {}

  @Get('releases/catalog')
  @Header('Cache-Control', 'no-store')
  catalog() {
    return this.releases.catalog();
  }

  @Get(
    'releases/:gameId/:releaseId/bindings/:backendBindingId/service-description',
  )
  @Header('Cache-Control', 'no-store')
  serviceDescription(
    @Param('gameId') gameId: string,
    @Param('releaseId') releaseId: string,
    @Param('backendBindingId') backendBindingId: string,
  ) {
    return this.releases.serviceDescription(
      text(gameId),
      text(releaseId),
      text(backendBindingId),
    );
  }

  @Get('releases/:gameId/:releaseId/bindings/:backendBindingId/client-locator')
  @Header('Cache-Control', 'no-store')
  clientLocator(
    @Param('gameId') gameId: string,
    @Param('releaseId') releaseId: string,
    @Param('backendBindingId') backendBindingId: string,
  ) {
    return this.releases.clientLocator(
      text(gameId),
      text(releaseId),
      text(backendBindingId),
    );
  }

  @Get('sessions/:id/client-locator')
  @Header('Cache-Control', 'no-store')
  sessionClientLocator(@Req() request: Request, @Param('id') id: string) {
    return this.releases.sessionClientLocator(
      sessionReference(request),
      text(id),
    );
  }

  @Get('sessions/:id/connection')
  @Header('Cache-Control', 'no-store')
  connectionGet(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.connect(request, id, body);
  }

  @Post('sessions/:id/connection')
  @Header('Cache-Control', 'no-store')
  connectionPost(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.connect(request, id, body);
  }

  private connect(request: Request, id: string, body: unknown) {
    if (!this.playerConnections)
      throw contractError(
        'NOT_READY',
        'platform.player.connections_unavailable',
      );
    const value = input(body ?? {}, ['mode']);
    return this.playerConnections.connect(sessionReference(request), text(id), {
      ...(value.mode === undefined
        ? {}
        : { mode: text(value.mode) as 'player' | 'viewer' }),
    });
  }

  @Post('sessions/:id/connection/revoke')
  revokeConnection(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!this.playerConnections)
      throw contractError(
        'NOT_READY',
        'platform.player.connections_unavailable',
      );
    input(body ?? {}, []);
    return this.playerConnections.revoke(sessionReference(request), text(id));
  }

  @Get('admin/releases')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  adminList() {
    return this.releases.adminList();
  }

  @Get('admin/releases/reconciliation')
  @Header('Cache-Control', 'no-store')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  reconciliation() {
    return this.releases.reconciliation();
  }

  @Post('admin/releases')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  register(@Body() body: unknown) {
    return this.releases.registerStaged(body);
  }

  @Post([
    'admin/releases/bindings/:backendBindingId/ready',
    'admin/releases/bindings/:backendBindingId/activate',
  ])
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  ready(
    @Param('backendBindingId') backendBindingId: string,
    @Body() body: unknown,
  ) {
    input(body ?? {}, []);
    return this.releases.ready(text(backendBindingId));
  }

  @Post('admin/releases/bindings/:backendBindingId/endpoints')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  updateBindingEndpoints(
    @Param('backendBindingId') backendBindingId: string,
    @Body() body: unknown,
  ) {
    return this.releases.updateBindingEndpoints(text(backendBindingId), body);
  }

  @Post('admin/releases/channels/switch')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  switchChannel(@Body() body: unknown) {
    return this.releases.switchChannel(body);
  }

  @Post('admin/releases/bindings/:backendBindingId/drain')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  drain(
    @Param('backendBindingId') backendBindingId: string,
    @Body() body: unknown,
  ) {
    input(body ?? {}, []);
    return this.releases.drain(text(backendBindingId));
  }

  @Post('admin/releases/bindings/:backendBindingId/disable')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  disable(
    @Param('backendBindingId') backendBindingId: string,
    @Body() body: unknown,
  ) {
    input(body ?? {}, []);
    return this.releases.disable(text(backendBindingId));
  }

  @Post('admin/releases/bindings/:backendBindingId/retain')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  retain(
    @Param('backendBindingId') backendBindingId: string,
    @Body() body: unknown,
  ) {
    input(body ?? {}, []);
    return this.releases.retain(text(backendBindingId));
  }
}

/** Compatibility name for callers that group administration routes by service. */
export { PlatformReleaseController as PlatformReleaseAdministrationController };
