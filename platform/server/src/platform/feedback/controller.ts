import { contractError } from '@board-game/contracts';
import {
  type IClientCrashReport,
  type IClientCrashReportResponse,
  type IPlatformFeedbackSubmitRequest,
  PLATFORM_FEEDBACK_STATUSES,
  type TPlatformFeedbackScope,
  type TPlatformFeedbackStatus,
} from '@board-platform/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Capabilities } from '@/auth/capabilities.decorator.js';
import { OptionalAuth } from '@/auth/optional-auth.decorator.js';
import { RolesGuard } from '@/auth/roles.guard.js';
import { PlatformErrorFilter } from '../PlatformErrorFilter.js';
import {
  input,
  type PlatformRequest as Request,
  reference,
  text,
} from '../request.js';
import { PlatformFeedbackService } from './service.js';

@Controller('platform/feedback')
@UseFilters(PlatformErrorFilter)
export class PlatformFeedbackController {
  public constructor(private readonly feedback: PlatformFeedbackService) {}

  @Post()
  public submit(@Req() request: Request, @Body() body: unknown) {
    const value = input(body, [
      'eventId',
      'kind',
      'category',
      'message',
      'expectedBehavior',
      'gameId',
      'target',
    ]);
    return this.feedback.submit(
      reference(request),
      value as unknown as IPlatformFeedbackSubmitRequest,
    );
  }

  @Post('client-crash')
  @OptionalAuth()
  public clientCrash(
    @Req() request: { user?: Request['user'] },
    @Body() body: unknown,
  ): Promise<IClientCrashReportResponse> {
    const value = input(body, [
      'eventId',
      'source',
      'message',
      'name',
      'stack',
      'componentStack',
      'url',
      'appVersion',
      'userAgent',
      'locale',
      'capturedAt',
      'gameId',
      'target',
      'environment',
      'errorContext',
    ]);
    return this.feedback.ingestClientCrash(
      value as unknown as IClientCrashReport,
      request.user?.sub && request.user.sid
        ? reference(request as Request)
        : undefined,
    );
  }

  @Get()
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ANALYTICS_READ)
  @Header('Cache-Control', 'no-store')
  public list(@Query() query: Record<string, unknown> = {}) {
    const allowed = new Set(['limit', 'status', 'gameId', 'kind', 'scope']);
    if (Object.keys(query).some((key) => !allowed.has(key)))
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    const rawLimit = query.limit;
    const limit =
      rawLimit === undefined
        ? undefined
        : typeof rawLimit === 'string'
          ? Number(rawLimit)
          : rawLimit;
    return this.feedback.list({
      ...(limit === undefined ? {} : { limit: limit as number }),
      ...(query.status === undefined
        ? {}
        : { status: query.status as TPlatformFeedbackStatus }),
      ...(query.gameId === undefined ? {} : { gameId: text(query.gameId) }),
      ...(query.kind === undefined
        ? {}
        : { kind: query.kind as 'game' | 'ai' }),
      ...(query.scope === undefined
        ? {}
        : { scope: query.scope as TPlatformFeedbackScope }),
    });
  }

  @Get('mine')
  @Header('Cache-Control', 'no-store')
  public mine(
    @Req() request: Request,
    @Query() query: Record<string, unknown> = {},
  ) {
    const allowed = new Set(['limit', 'status', 'gameId', 'kind', 'scope']);
    if (Object.keys(query).some((key) => !allowed.has(key)))
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    const rawLimit = query.limit;
    const limit =
      rawLimit === undefined
        ? undefined
        : typeof rawLimit === 'string'
          ? Number(rawLimit)
          : rawLimit;
    return this.feedback.listMine(reference(request), {
      ...(limit === undefined ? {} : { limit: limit as number }),
      ...(query.status === undefined
        ? {}
        : { status: query.status as TPlatformFeedbackStatus }),
      ...(query.gameId === undefined ? {} : { gameId: text(query.gameId) }),
      ...(query.kind === undefined
        ? {}
        : { kind: query.kind as 'game' | 'ai' }),
      ...(query.scope === undefined
        ? {}
        : { scope: query.scope as TPlatformFeedbackScope }),
    });
  }

  @Get('mine/:reportId')
  @Header('Cache-Control', 'no-store')
  public mineReport(
    @Req() request: Request,
    @Param('reportId') reportId: string,
  ) {
    return this.feedback.getMine(reference(request), reportId);
  }

  @Get('sessions/:sessionId/diagnostics')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ANALYTICS_READ)
  @Header('Cache-Control', 'no-store')
  public diagnostics(
    @Req() request: Request,
    @Param('sessionId') sessionId: string,
  ) {
    return this.feedback.diagnosticsForAdmin(reference(request), sessionId);
  }

  @Get('sessions/:sessionId/automation-traces')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  @Header('Cache-Control', 'no-store')
  public automationTraces(
    @Req() request: Request,
    @Param('sessionId') sessionId: string,
    @Query() query: Record<string, unknown> = {},
  ) {
    const allowed = new Set(['limit', 'afterCreatedAt', 'kind']);
    if (Object.keys(query).some((key) => !allowed.has(key)))
      throw contractError('INVALID_REQUEST', 'platform.request.invalid');
    const limit = parseOptionalNumber(query.limit);
    const afterCreatedAt = parseOptionalNumber(query.afterCreatedAt);
    if (
      query.kind !== undefined &&
      query.kind !== 'automation' &&
      query.kind !== 'command'
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.trace_kind');
    return this.feedback.automationTracesForAdmin(
      reference(request),
      sessionId,
      {
        ...(limit === undefined ? {} : { limit }),
        ...(afterCreatedAt === undefined ? {} : { afterCreatedAt }),
        ...(query.kind === undefined
          ? {}
          : { kind: query.kind as 'automation' | 'command' }),
      },
    );
  }

  @Post('sessions/:sessionId/automation-traces/:traceId/replay')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  public replayAutomation(
    @Req() request: Request,
    @Param('sessionId') sessionId: string,
    @Param('traceId') traceId: string,
  ) {
    return this.feedback.replayAutomationForAdmin(
      reference(request),
      sessionId,
      traceId,
    );
  }

  @Get(':reportId/trace-evidence')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  @Header('Cache-Control', 'no-store')
  public traceEvidence(
    @Req() request: Request,
    @Param('reportId') reportId: string,
  ) {
    return this.feedback.traceEvidenceForAdmin(reference(request), reportId);
  }

  @Post(':reportId/trace-evidence/replay')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  public replayTraceEvidence(
    @Req() request: Request,
    @Param('reportId') reportId: string,
  ) {
    return this.feedback.replayTraceEvidenceForAdmin(
      reference(request),
      reportId,
    );
  }

  @Get(':reportId')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ANALYTICS_READ)
  @Header('Cache-Control', 'no-store')
  public get(@Param('reportId') reportId: string) {
    return this.feedback.get(reportId);
  }

  @Patch(':reportId/status')
  @UseGuards(RolesGuard)
  @Capabilities(ECapability.ADMIN_ACCESS, ECapability.GAME_MODIFY_ANY)
  public updateStatus(
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ['status']);
    if (
      typeof value.status !== 'string' ||
      !PLATFORM_FEEDBACK_STATUSES.includes(
        value.status as TPlatformFeedbackStatus,
      )
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.status');
    return this.feedback.updateStatus(
      reportId,
      value.status as TPlatformFeedbackStatus,
    );
  }
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? Number(value) : (value as number);
}
