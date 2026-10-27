import { createHash } from 'node:crypto';
import { assertJsonPayloadSize, contractError } from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type { AutomationReplayResult } from '@board-game/host';
import type { AutomationTrace } from '@board-game/storage';
import {
  CLIENT_CRASH_MAX_LENGTHS,
  CLIENT_CRASH_SOURCES,
  type IClientCrashReport,
  type IClientCrashReportResponse,
  type IPlatformFeedbackListResponse,
  type IPlatformFeedbackReport,
  type IPlatformFeedbackSubmitRequest,
  type IPlatformNativeDiagnostics,
  PLATFORM_FEEDBACK_CATEGORIES,
  PLATFORM_FEEDBACK_KINDS,
  PLATFORM_FEEDBACK_SCOPES,
  PLATFORM_FEEDBACK_STATUSES,
  type TPlatformFeedbackKind,
  type TPlatformFeedbackScope,
  type TPlatformFeedbackStatus,
} from '@board-platform/contracts';
import { Injectable } from '@nestjs/common';
import type { PlatformApplicationRuntime } from '../PlatformApplicationRuntime.js';
import { PlatformSessionDiagnostics } from '../PlatformSessionDiagnostics.js';
import {
  type PlatformFeedbackListOptions,
  type PlatformFeedbackRecord,
  type PlatformFeedbackStore,
} from './store.js';

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GAME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPORT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_TRACE_SNAPSHOT_BYTES = 3 * 1024 * 1024;

export interface PlatformFeedbackListQuery {
  readonly limit?: number;
  readonly status?: TPlatformFeedbackStatus;
  readonly gameId?: string;
  readonly kind?: TPlatformFeedbackKind;
  readonly scope?: TPlatformFeedbackScope;
}

/** Durable, game-neutral feedback and native-session report boundary. */
@Injectable()
export class PlatformFeedbackService {
  public constructor(
    private readonly store: PlatformFeedbackStore,
    private readonly runtime: PlatformApplicationRuntime,
    private readonly diagnostics: PlatformSessionDiagnostics,
  ) {}

  public async submit(
    reference: PlatformIdentityReference,
    input: IPlatformFeedbackSubmitRequest,
  ): Promise<IPlatformFeedbackReport> {
    validateSubmission(input);
    const fingerprint = payloadFingerprint(input);
    const existing = await this.store.findByEvent(
      reference.principalId,
      input.eventId,
    );
    if (existing) {
      assertIdempotent(existing, fingerprint);
      return response(existing);
    }
    let gameId = input.gameId;
    let releaseId: string | undefined;
    let sessionId: string | undefined;
    let kind: TPlatformFeedbackKind = 'game';
    let nativeDiagnostics: IPlatformNativeDiagnostics | undefined;
    let traceId: string | undefined;
    let traceSnapshot: AutomationTrace | undefined;
    if (gameId !== undefined) {
      if (!GAME_ID_PATTERN.test(gameId))
        throw contractError('INVALID_REQUEST', 'platform.feedback.game_id');
      releaseId = this.runtime.game(gameId).releaseId;
    }
    if (input.target) {
      sessionId = input.target.sessionId;
      const descriptor = await this.runtime.sessions.descriptor(
        reference,
        sessionId,
      );
      if (gameId !== undefined && gameId !== descriptor.route.gameId)
        throw contractError('INVALID_REQUEST', 'platform.feedback.game_id');
      gameId = descriptor.route.gameId;
      releaseId = descriptor.route.releaseId;
      nativeDiagnostics = await this.diagnostics.readForPrincipal(
        reference,
        sessionId,
        input.target.eventSequence,
      );
      if (input.target.eventSequence !== undefined) {
        const event = nativeDiagnostics.events.find(
          (candidate) => candidate.sequence === input.target?.eventSequence,
        );
        if (!event)
          throw contractError(
            'INVALID_REQUEST',
            'platform.feedback.event_sequence',
          );
        kind =
          event.source?.kind === 'ai' || event.source?.kind === 'automa'
            ? 'ai'
            : 'game';
        traceId = event.source?.traceId;
        if (traceId) {
          traceSnapshot =
            (await this.diagnostics.readTraceForReport(
              reference,
              input.target.sessionId,
              input.target.eventSequence,
              nativeDiagnostics,
            )) ?? undefined;
        }
      }
    }
    validateCategoryForKind(kind, input.category, input.expectedBehavior);
    // A trace can be valid in the bounded store yet exceed report evidence
    // budget; keep the report and opaque trace reference, but omit the snapshot.
    if (
      traceSnapshot !== undefined &&
      Buffer.byteLength(JSON.stringify(traceSnapshot), 'utf8') >
        MAX_TRACE_SNAPSHOT_BYTES
    )
      traceSnapshot = undefined;
    const record = await this.store.create({
      eventId: input.eventId,
      fingerprint,
      sourceRecordId: `platform-feedback:${reference.principalId}:${input.eventId}`,
      reporterId: reference.principalId,
      kind,
      category: input.category,
      message: input.message,
      ...(input.expectedBehavior === undefined
        ? {}
        : { expectedBehavior: input.expectedBehavior }),
      ...(gameId ? { gameId } : {}),
      ...(releaseId ? { releaseId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(input.target?.eventSequence === undefined
        ? {}
        : { eventSequence: input.target.eventSequence }),
      ...(traceId === undefined ? {} : { traceId }),
      ...(traceSnapshot === undefined ? {} : { traceSnapshot }),
      ...(nativeDiagnostics ? { nativeDiagnostics } : {}),
    });
    assertIdempotent(record, fingerprint);
    return response(record);
  }

  public async ingestClientCrash(
    report: IClientCrashReport,
    reference?: PlatformIdentityReference,
  ): Promise<IClientCrashReportResponse> {
    validateClientCrash(report);
    const reporterId = reference?.principalId ?? 'anonymous';
    const fingerprint = payloadFingerprint(report);
    const existing = await this.store.findByEvent(reporterId, report.eventId);
    if (existing) {
      assertIdempotent(existing, fingerprint);
      return { id: report.eventId, reportId: existing.reportId };
    }
    let gameId = typeof report.gameId === 'string' ? report.gameId : undefined;
    let releaseId: string | undefined;
    let sessionId: string | undefined;
    let nativeDiagnostics: IPlatformNativeDiagnostics | undefined;
    if (gameId && GAME_ID_PATTERN.test(gameId)) {
      try {
        releaseId = this.runtime.game(gameId).releaseId;
      } catch {
        /* Keep crash evidence from an older or removed game without a release pin. */
      }
    }
    if (report.target) {
      if (!reference)
        throw contractError('UNAUTHENTICATED', 'platform.identity.required');
      sessionId = report.target.sessionId;
      const targetDiagnostics = await this.diagnostics.readForPrincipal(
        reference,
        sessionId,
      );
      if (gameId !== undefined && gameId !== targetDiagnostics.gameId)
        throw contractError('INVALID_REQUEST', 'platform.feedback.game_id');
      nativeDiagnostics = targetDiagnostics;
      gameId = targetDiagnostics.gameId;
      releaseId = targetDiagnostics.releaseId;
    }
    const record = await this.store.create({
      eventId: report.eventId,
      fingerprint,
      sourceRecordId: `platform-client-crash:${reporterId}:${report.eventId}`,
      reporterId,
      kind: 'game',
      category: 'bug',
      message: `${report.source}: ${report.message}`.slice(
        0,
        MAX_MESSAGE_LENGTH,
      ),
      ...(gameId ? { gameId } : {}),
      ...(releaseId ? { releaseId } : {}),
      ...(sessionId ? { sessionId } : {}),
      clientCrash: structuredClone(report),
      ...(nativeDiagnostics ? { nativeDiagnostics } : {}),
    });
    assertIdempotent(record, fingerprint);
    return { id: report.eventId, reportId: record.reportId };
  }

  public async list(
    query: PlatformFeedbackListQuery = {},
  ): Promise<IPlatformFeedbackListResponse> {
    const options = validateListQuery(query);
    const result = await this.store.list(options);
    return {
      items: result.items.map((record) => response(record, false)),
      total: result.total,
    };
  }

  public async listMine(
    reference: PlatformIdentityReference,
    query: PlatformFeedbackListQuery = {},
  ): Promise<IPlatformFeedbackListResponse> {
    const options = validateListQuery(query);
    const result = await this.store.list({
      ...options,
      reporterId: reference.principalId,
    });
    return {
      items: result.items.map((record) => response(record, false)),
      total: result.total,
    };
  }

  public async get(reportId: string): Promise<IPlatformFeedbackReport> {
    const record = await this.store.get(reportIdentifier(reportId));
    if (!record)
      throw contractError('NOT_FOUND', 'platform.feedback.not_found');
    return response(record);
  }

  public async getMine(
    reference: PlatformIdentityReference,
    reportId: string,
  ): Promise<IPlatformFeedbackReport> {
    const record = await this.store.get(reportIdentifier(reportId));
    if (!record || record.reporterId !== reference.principalId)
      throw contractError('NOT_FOUND', 'platform.feedback.not_found');
    return response(record);
  }

  public async updateStatus(
    reportId: string,
    status: TPlatformFeedbackStatus,
  ): Promise<IPlatformFeedbackReport> {
    if (!PLATFORM_FEEDBACK_STATUSES.includes(status))
      throw contractError('INVALID_REQUEST', 'platform.feedback.status');
    const updated = await this.store.updateStatus(
      reportIdentifier(reportId),
      status,
      new Date(),
    );
    if (!updated)
      throw contractError('NOT_FOUND', 'platform.feedback.not_found');
    return response(updated);
  }

  public diagnosticsForAdmin(
    reference: PlatformIdentityReference,
    sessionId: string,
  ) {
    return this.diagnostics.readForAdmin(
      reference,
      sessionIdentifier(sessionId),
    );
  }

  /** Full private traces are only exposed after the game identity issues an admin Host context. */
  public async automationTracesForAdmin(
    reference: PlatformIdentityReference,
    sessionId: string,
    options: {
      readonly limit?: number;
      readonly afterCreatedAt?: number;
      readonly kind?: AutomationTrace['kind'];
    } = {},
  ): Promise<readonly AutomationTrace[]> {
    const admission = await this.runtime.admissionStore.getAdmission(
      sessionIdentifier(sessionId),
    );
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    const game = this.runtime.game(admission.route.gameId);
    const accessContext = await game.identity.adminAccess(
      reference,
      admission.route,
    );
    if (!game.host)
      throw contractError(
        'NOT_READY',
        'platform.remote.local_host_unavailable',
      );
    return game.host.readAutomationTraces({
      route: admission.route,
      accessContext,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.afterCreatedAt === undefined
        ? {}
        : { afterCreatedAt: options.afterCreatedAt }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
    });
  }

  public async replayAutomationForAdmin(
    reference: PlatformIdentityReference,
    sessionId: string,
    traceId: string,
  ): Promise<AutomationReplayResult> {
    const admission = await this.runtime.admissionStore.getAdmission(
      sessionIdentifier(sessionId),
    );
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    const game = this.runtime.game(admission.route.gameId);
    const accessContext = await game.identity.adminAccess(
      reference,
      admission.route,
    );
    if (!game.host)
      throw contractError(
        'NOT_READY',
        'platform.remote.local_host_unavailable',
      );
    return game.host.replayAutomationDecision({
      route: admission.route,
      accessContext,
      traceId,
    });
  }

  public async traceEvidenceForAdmin(
    _reference: PlatformIdentityReference,
    reportId: string,
  ): Promise<AutomationTrace> {
    const record = await this.store.get(reportIdentifier(reportId));
    if (!record?.traceSnapshot)
      throw contractError('NOT_FOUND', 'platform.feedback.trace_not_found');
    return structuredClone(record.traceSnapshot);
  }

  /** Replays persisted report evidence even after the bounded live trace expires. */
  public async replayTraceEvidenceForAdmin(
    _reference: PlatformIdentityReference,
    reportId: string,
  ): Promise<AutomationReplayResult> {
    const record = await this.store.get(reportIdentifier(reportId));
    if (!record?.traceSnapshot || !record.sessionId)
      throw contractError('NOT_FOUND', 'platform.feedback.trace_not_found');
    const admission = await this.runtime.admissionStore.getAdmission(
      record.sessionId,
    );
    if (
      !admission ||
      (record.gameId !== undefined &&
        admission.route.gameId !== record.gameId) ||
      admission.route.releaseId !== record.traceSnapshot.releaseId
    )
      throw contractError('NOT_FOUND', 'platform.feedback.trace_not_found');
    const game = this.runtime.game(admission.route.gameId);
    if (!game.host)
      throw contractError(
        'NOT_READY',
        'platform.remote.local_host_unavailable',
      );
    return game.host.replayAutomationTraceEvidence({
      route: admission.route,
      accessContext: await game.identity.diagnosticAccess(admission.route),
      trace: structuredClone(record.traceSnapshot),
    });
  }
}

function validateSubmission(input: IPlatformFeedbackSubmitRequest): void {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw contractError('INVALID_REQUEST', 'platform.feedback.invalid');
  if (
    typeof input.eventId !== 'string' ||
    !EVENT_ID_PATTERN.test(input.eventId)
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.event_id');
  if (input.kind !== undefined && !PLATFORM_FEEDBACK_KINDS.includes(input.kind))
    throw contractError('INVALID_REQUEST', 'platform.feedback.kind');
  if (!PLATFORM_FEEDBACK_CATEGORIES.includes(input.category))
    throw contractError('INVALID_REQUEST', 'platform.feedback.category');
  if (
    typeof input.message !== 'string' ||
    input.message.trim().length === 0 ||
    input.message.length > MAX_MESSAGE_LENGTH
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.message');
  if (
    input.expectedBehavior !== undefined &&
    (typeof input.expectedBehavior !== 'string' ||
      input.expectedBehavior.trim().length === 0 ||
      input.expectedBehavior.length > 5_000)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.feedback.expected_behavior',
    );
  if (
    input.gameId !== undefined &&
    (typeof input.gameId !== 'string' || !GAME_ID_PATTERN.test(input.gameId))
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.game_id');
  if (input.target !== undefined) {
    if (
      !input.target ||
      input.target.kind !== 'native-session' ||
      typeof input.target.sessionId !== 'string' ||
      !GAME_ID_PATTERN.test(input.target.sessionId) ||
      (input.target.eventSequence !== undefined &&
        (!Number.isSafeInteger(input.target.eventSequence) ||
          input.target.eventSequence < 1))
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.target');
  }
}

function validateListQuery(
  query: PlatformFeedbackListQuery,
): PlatformFeedbackListOptions {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw contractError('INVALID_REQUEST', 'platform.request.limit');
  if (
    query.status !== undefined &&
    !PLATFORM_FEEDBACK_STATUSES.includes(query.status)
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.status');
  if (
    query.gameId !== undefined &&
    (typeof query.gameId !== 'string' || !GAME_ID_PATTERN.test(query.gameId))
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.game_id');
  if (
    query.scope !== undefined &&
    !PLATFORM_FEEDBACK_SCOPES.includes(query.scope)
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.scope');
  if (query.scope === 'platform' && query.gameId !== undefined)
    throw contractError('INVALID_REQUEST', 'platform.feedback.scope_game');
  if (query.kind !== undefined && !PLATFORM_FEEDBACK_KINDS.includes(query.kind))
    throw contractError('INVALID_REQUEST', 'platform.feedback.kind');
  return {
    limit,
    ...(query.status ? { status: query.status } : {}),
    ...(query.gameId ? { gameId: query.gameId } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.scope ? { scope: query.scope } : {}),
  };
}

function validateCategoryForKind(
  kind: TPlatformFeedbackKind,
  category: IPlatformFeedbackSubmitRequest['category'],
  expectedBehavior?: string,
): void {
  const aiCategory = category === 'behavior' || category === 'optimization';
  if ((kind === 'ai') !== aiCategory)
    throw contractError('INVALID_REQUEST', 'platform.feedback.category_kind');
  if (expectedBehavior !== undefined && kind !== 'ai')
    throw contractError(
      'INVALID_REQUEST',
      'platform.feedback.expected_behavior_kind',
    );
}

function reportIdentifier(value: string): string {
  if (typeof value !== 'string' || !REPORT_ID_PATTERN.test(value))
    throw contractError('INVALID_REQUEST', 'platform.feedback.report_id');
  return value;
}

function sessionIdentifier(value: string): string {
  if (typeof value !== 'string' || !GAME_ID_PATTERN.test(value))
    throw contractError('INVALID_REQUEST', 'platform.feedback.session_id');
  return value;
}

function response(
  record: PlatformFeedbackRecord,
  includePayload = true,
): IPlatformFeedbackReport {
  return {
    reportId: record.reportId,
    eventId: record.eventId,
    sourceRecordId: record.sourceRecordId,
    reporterId: record.reporterId,
    kind: record.kind,
    category: record.category,
    message: record.message,
    ...(record.expectedBehavior === undefined
      ? {}
      : { expectedBehavior: record.expectedBehavior }),
    ...(record.gameId ? { gameId: record.gameId } : {}),
    ...(record.releaseId ? { releaseId: record.releaseId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.eventSequence === undefined
      ? {}
      : { eventSequence: record.eventSequence }),
    ...(record.traceId === undefined
      ? {}
      : {
          traceId: record.traceId,
          traceEvidenceAvailable: record.traceSnapshot !== undefined,
        }),
    ...(includePayload && record.nativeDiagnostics
      ? { nativeDiagnostics: structuredClone(record.nativeDiagnostics) }
      : {}),
    ...(includePayload && record.clientCrash
      ? { clientCrash: structuredClone(record.clientCrash) }
      : {}),
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertIdempotent(
  record: PlatformFeedbackRecord,
  fingerprint: string,
): void {
  if (record.fingerprint === fingerprint) return;
  throw contractError(
    'IDEMPOTENCY_CONFLICT',
    'platform.feedback.event_conflict',
  );
}

function payloadFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, stableValue(object[key])]),
  );
}

function validateClientCrash(report: IClientCrashReport): void {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
  const raw: unknown = report;
  assertJsonPayloadSize(raw, 64 * 1024, 'clientCrash');
  exactKeys(report, [
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
  if (
    typeof report.eventId !== 'string' ||
    !EVENT_ID_PATTERN.test(report.eventId)
  )
    throw contractError('INVALID_REQUEST', 'platform.feedback.event_id');
  if (!CLIENT_CRASH_SOURCES.includes(report.source))
    throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
  bounded(report.message, CLIENT_CRASH_MAX_LENGTHS.message, 'message');
  boundedRequired(report.url, CLIENT_CRASH_MAX_LENGTHS.url, 'url');
  boundedRequired(
    report.userAgent,
    CLIENT_CRASH_MAX_LENGTHS.userAgent,
    'userAgent',
  );
  boundedRequired(report.locale, CLIENT_CRASH_MAX_LENGTHS.locale, 'locale');
  boundedRequired(
    report.capturedAt,
    CLIENT_CRASH_MAX_LENGTHS.capturedAt,
    'capturedAt',
  );
  for (const [field, limit] of [
    ['name', CLIENT_CRASH_MAX_LENGTHS.name],
    ['stack', CLIENT_CRASH_MAX_LENGTHS.stack],
    ['componentStack', CLIENT_CRASH_MAX_LENGTHS.componentStack],
    ['appVersion', CLIENT_CRASH_MAX_LENGTHS.appVersion],
  ] as const)
    boundedOptional(report[field], limit, field);
  if (report.gameId !== undefined && report.gameId !== null) {
    if (
      typeof report.gameId !== 'string' ||
      !GAME_ID_PATTERN.test(report.gameId) ||
      report.gameId.length > 256
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.feedback.client_crash.gameId',
      );
  }
  if (report.target !== undefined) {
    if (
      !report.target ||
      report.target.kind !== 'native-session' ||
      typeof report.target.sessionId !== 'string' ||
      !GAME_ID_PATTERN.test(report.target.sessionId)
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.target');
  }
  if (report.environment !== undefined) {
    if (
      !report.environment ||
      typeof report.environment !== 'object' ||
      Array.isArray(report.environment)
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
    exactKeys(report.environment, [
      'timezone',
      'languages',
      'platform',
      'vendor',
      'online',
      'visibilityState',
      'readyState',
      'viewport',
      'screen',
      'devicePixelRatio',
      'hardwareConcurrency',
      'deviceMemory',
      'maxTouchPoints',
      'cookieEnabled',
      'standalone',
      'serviceWorker',
      'connection',
    ]);
    for (const field of [
      'timezone',
      'platform',
      'vendor',
      'visibilityState',
      'readyState',
      'serviceWorker',
    ] as const)
      boundedOptional(
        report.environment[field],
        CLIENT_CRASH_MAX_LENGTHS.environmentText,
        field,
      );
    if (report.environment.languages !== undefined) {
      if (
        !Array.isArray(report.environment.languages) ||
        report.environment.languages.length >
          CLIENT_CRASH_MAX_LENGTHS.languageCount
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
      for (const language of report.environment.languages)
        boundedRequired(language, CLIENT_CRASH_MAX_LENGTHS.locale, 'language');
    }
    if (report.environment.viewport !== undefined)
      boundedDimensions(report.environment.viewport, 'viewport');
    if (report.environment.screen !== undefined) {
      boundedDimensions(report.environment.screen, 'screen');
      if (
        typeof report.environment.screen.colorDepth !== 'number' ||
        !Number.isFinite(report.environment.screen.colorDepth)
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
    }
    for (const field of [
      'devicePixelRatio',
      'hardwareConcurrency',
      'deviceMemory',
      'maxTouchPoints',
    ] as const)
      if (
        report.environment[field] !== undefined &&
        (typeof report.environment[field] !== 'number' ||
          !Number.isFinite(report.environment[field]) ||
          report.environment[field] < 0)
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
    for (const field of ['online', 'cookieEnabled', 'standalone'] as const)
      if (
        report.environment[field] !== undefined &&
        typeof report.environment[field] !== 'boolean'
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
    if (report.environment.connection !== undefined) {
      if (
        !report.environment.connection ||
        typeof report.environment.connection !== 'object'
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
      exactKeys(report.environment.connection, [
        'effectiveType',
        'downlink',
        'rtt',
        'saveData',
      ]);
      boundedOptional(
        report.environment.connection.effectiveType,
        CLIENT_CRASH_MAX_LENGTHS.environmentText,
        'effectiveType',
      );
      for (const field of ['downlink', 'rtt'] as const)
        if (
          report.environment.connection[field] !== undefined &&
          (typeof report.environment.connection[field] !== 'number' ||
            !Number.isFinite(report.environment.connection[field]))
        )
          throw contractError(
            'INVALID_REQUEST',
            'platform.feedback.client_crash',
          );
      if (
        report.environment.connection.saveData !== undefined &&
        typeof report.environment.connection.saveData !== 'boolean'
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
    }
  }
  if (report.errorContext !== undefined) {
    if (
      !report.errorContext ||
      typeof report.errorContext !== 'object' ||
      Array.isArray(report.errorContext)
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
    exactKeys(report.errorContext, [
      'opaque',
      'errorPresent',
      'isTrusted',
      'filename',
      'line',
      'column',
      'resourceUrl',
      'previousRecoveryAt',
    ]);
    for (const field of [
      'filename',
      'resourceUrl',
      'previousRecoveryAt',
    ] as const)
      boundedOptional(
        report.errorContext[field],
        CLIENT_CRASH_MAX_LENGTHS.url,
        field,
      );
    for (const field of ['opaque', 'errorPresent', 'isTrusted'] as const)
      if (
        report.errorContext[field] !== undefined &&
        typeof report.errorContext[field] !== 'boolean'
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
    for (const field of ['line', 'column'] as const)
      if (
        report.errorContext[field] !== undefined &&
        (typeof report.errorContext[field] !== 'number' ||
          !Number.isFinite(report.errorContext[field]))
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.feedback.client_crash',
        );
  }
}

function exactKeys(value: object, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
}

function boundedRequired(value: unknown, limit: number, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit)
    throw contractError(
      'INVALID_REQUEST',
      `platform.feedback.client_crash.${field}`,
    );
}

function boundedOptional(value: unknown, limit: number, field: string): void {
  if (value !== undefined && value !== null)
    boundedRequired(value, limit, field);
}

function bounded(value: unknown, limit: number, field: string): void {
  if (typeof value !== 'string' || value.length > limit)
    throw contractError(
      'INVALID_REQUEST',
      `platform.feedback.client_crash.${field}`,
    );
}

function boundedDimensions(value: unknown, field: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
  const dimensions = value as Record<string, unknown>;
  exactKeys(
    dimensions,
    field === 'screen'
      ? ['width', 'height', 'colorDepth']
      : ['width', 'height'],
  );
  for (const key of ['width', 'height'] as const)
    if (
      typeof dimensions[key] !== 'number' ||
      !Number.isFinite(dimensions[key]) ||
      dimensions[key] < 0
    )
      throw contractError('INVALID_REQUEST', 'platform.feedback.client_crash');
}
