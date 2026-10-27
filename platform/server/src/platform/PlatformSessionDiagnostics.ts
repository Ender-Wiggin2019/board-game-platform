import {
  assertJsonPayloadSize,
  contractError,
  type GetEventsResponse,
  type GetSessionSummaryRequest,
  isJsonValue,
  type SessionRoute,
  type SessionSummary,
} from '@board-game/contracts';
import type { PlatformIdentityReference } from '@board-game/core';
import type { AutomationTrace } from '@board-game/storage';
import type { IPlatformNativeDiagnostics } from '@board-platform/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PlatformApplicationRuntime } from './PlatformApplicationRuntime.js';

const MAX_EVENTS = 200;
const MAX_BYTES = 256 * 1024;

/**
 * Shared bounded native-session diagnostics. Player reads go through the
 * authenticated SessionGateway; operator reads use a server-created
 * diagnostic Host context for the pinned game release.
 */
@Injectable()
export class PlatformSessionDiagnostics {
  public constructor(
    @Inject(PlatformApplicationRuntime)
    private readonly runtime: PlatformApplicationRuntime,
  ) {}

  public async readForPrincipal(
    reference: PlatformIdentityReference,
    sessionId: string,
    selectedSequence?: number,
  ): Promise<IPlatformNativeDiagnostics> {
    const summary = await this.runtime.sessions.summary(reference, sessionId);
    const events = await this.runtime.sessions.events(reference, sessionId, {
      afterSequence:
        selectedSequence === undefined
          ? Math.max(0, (summary.eventSequence ?? 0) - MAX_EVENTS)
          : Math.max(0, selectedSequence - 1),
      limit: MAX_EVENTS,
    });
    return sanitizeProjection(sessionId, summary, events, summary.route);
  }

  public async readForAdmin(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<IPlatformNativeDiagnostics> {
    const admission = await this.runtime.admissionStore.getAdmission(sessionId);
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    const game = this.runtime.game(admission.route.gameId);
    await game.identity.adminAccess(reference, admission.route);
    const request: GetSessionSummaryRequest = {
      protocolVersion: 1,
      route: admission.route,
      accessContext: await game.identity.diagnosticAccess(admission.route),
    };
    const backend = this.runtime.resolveBackend(admission.route);
    const summary = await backend.getSessionSummary(request);
    const events = await backend.getEvents({
      ...request,
      afterSequence: Math.max(0, (summary.eventSequence ?? 0) - MAX_EVENTS),
      limit: MAX_EVENTS,
    });
    return sanitizeProjection(sessionId, summary, events, admission.route);
  }

  /** Captures the private trace selected by a trusted public event source. */
  public async readTraceForReport(
    reference: PlatformIdentityReference,
    sessionId: string,
    eventSequence: number,
    trustedDiagnostics?: IPlatformNativeDiagnostics,
  ): Promise<AutomationTrace | null> {
    const diagnostics =
      trustedDiagnostics ??
      (await this.readForPrincipal(reference, sessionId, eventSequence));
    const event = diagnostics.events.find(
      (candidate) => candidate.sequence === eventSequence,
    );
    const traceId = event?.source?.traceId;
    if (!traceId) return null;
    const admission = await this.runtime.admissionStore.getAdmission(sessionId);
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    const game = this.runtime.game(admission.route.gameId);
    if (!game.host)
      throw contractError(
        'NOT_READY',
        'platform.remote.local_host_unavailable',
      );
    return game.host.readAutomationTraceSnapshot({
      route: admission.route,
      accessContext: await game.identity.diagnosticAccess(admission.route),
      traceId,
    });
  }
}

function sanitizeProjection(
  sessionId: string,
  summary: SessionSummary,
  events: GetEventsResponse,
  expectedRoute: SessionRoute,
): IPlatformNativeDiagnostics {
  const latestSequence = summary.eventSequence ?? 0;
  if (
    !sameRoute(summary.route, expectedRoute) ||
    summary.route.sessionId !== sessionId ||
    events.sessionId !== sessionId ||
    events.gameId !== summary.route.gameId ||
    events.releaseId !== summary.route.releaseId ||
    !isJsonValue(summary.summary) ||
    !Number.isSafeInteger(summary.sourceRevision) ||
    summary.sourceRevision < 0 ||
    !Number.isSafeInteger(summary.updatedAt) ||
    summary.updatedAt < 0 ||
    (summary.eventSequence !== undefined &&
      (!Number.isSafeInteger(summary.eventSequence) ||
        summary.eventSequence < 0)) ||
    typeof events.audienceKey !== 'string' ||
    typeof events.viewEpoch !== 'string' ||
    !Number.isSafeInteger(events.nextSequence) ||
    events.nextSequence < 0 ||
    typeof events.hasMore !== 'boolean' ||
    typeof events.resetRequired !== 'boolean' ||
    events.resetRequired ||
    !Array.isArray(events.events) ||
    events.events.length > MAX_EVENTS ||
    !['suspended', 'active', 'paused', 'completed', 'cancelled'].includes(
      summary.status,
    )
  )
    throw new Error('Invalid native diagnostic projection');

  let previousSequence = -1;
  const projectedEvents: IPlatformNativeDiagnostics['events'][number][] = [];
  for (const { eventId, sequence, payload, source } of events.events) {
    if (
      typeof eventId !== 'string' ||
      eventId.length === 0 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence <= previousSequence ||
      !isJsonValue(payload)
    )
      throw new Error('Invalid native diagnostic event projection');
    const sourceKindValid =
      source === undefined ||
      source.kind === 'human' ||
      source.kind === 'ai' ||
      source.kind === 'automa' ||
      source.kind === 'system';
    if (
      !sourceKindValid ||
      (source !== undefined &&
        source.seatId !== undefined &&
        (typeof source.seatId !== 'string' || source.seatId.length === 0)) ||
      (source !== undefined &&
        source.traceId !== undefined &&
        (typeof source.traceId !== 'string' || source.traceId.length === 0))
    )
      throw new Error('Invalid native diagnostic event source');
    previousSequence = sequence;
    assertJsonPayloadSize(payload, MAX_BYTES, 'diagnostic event');
    if (sequence <= latestSequence)
      projectedEvents.push({
        eventId,
        sequence,
        payload,
        ...(source === undefined ? {} : { source: structuredClone(source) }),
      });
  }
  assertJsonPayloadSize(summary.summary, MAX_BYTES, 'diagnostic summary');

  let boundedEvents = projectedEvents;
  const base: Omit<IPlatformNativeDiagnostics, 'events'> = {
    kind: 'native-session',
    sessionId,
    gameId: summary.route.gameId,
    releaseId: summary.route.releaseId,
    status: summary.status,
    sourceRevision: summary.sourceRevision,
    updatedAt: summary.updatedAt,
    summary: structuredClone(summary.summary),
  };
  while (jsonBytes({ ...base, events: boundedEvents }) > MAX_BYTES) {
    if (boundedEvents.length === 0)
      throw contractError(
        'PAYLOAD_TOO_LARGE',
        'platform.diagnostics.too_large',
      );
    boundedEvents = boundedEvents.slice(1);
  }
  return structuredClone({ ...base, events: boundedEvents });
}

function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return (
    left.gameId === right.gameId &&
    left.modeId === right.modeId &&
    left.sessionId === right.sessionId &&
    left.releaseId === right.releaseId &&
    left.backendBindingId === right.backendBindingId &&
    left.storageBindingId === right.storageBindingId &&
    left.ownershipEpoch === right.ownershipEpoch
  );
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
