import {
  type AccessContext,
  type BackendPort,
  canonicalStableStringify,
  contractError,
  controlsParticipant,
  type GetEventsRequest,
  type GetPlayerViewRequest,
  type GetSessionSummaryRequest,
  isAutomatedParticipant,
  type MatchAdmission,
  type OperationStatus,
  type QueryOptionsRequest,
  type ResumeRequest,
  type SessionRoute,
  type GetStatusRequest as StatusRequest,
  type SubmitCommandRequest,
} from '@board-game/contracts';
import type { StartOperation } from '../admission/types.js';
import {
  assertCommandInput,
  assertEventsInput,
  assertExactRoute,
  assertIdentityReference,
  assertPartialRoute,
  assertQueryInput,
  assertResolvedIdentity,
  assertResumeInput,
  assertRoute,
  assertStatusInput,
  copy,
  invalid,
  requireIdentifier,
} from './invariants.js';
import type {
  CommandInput,
  CommandResponse,
  CreatedAccess,
  EventsInput,
  EventsResponse,
  PlatformIdentityReference,
  PublicRouteDescriptor,
  QueryInput,
  QueryResponse,
  ResolvedIdentity,
  ResumeInput,
  ResumeResponse,
  SessionAccessOperation,
  SessionGatewayOperation,
  SessionGatewayOptions,
  SessionGatewayResponse,
  StatusInput,
  StatusResponse,
  SummaryResponse,
  ViewResponse,
} from './types.js';

type Authorized = {
  readonly start: StartOperation;
  readonly admission: MatchAdmission;
  readonly identity: ResolvedIdentity;
  readonly access: AccessContext;
};

const ALLOWED_SCOPES = new Set([
  'session:view',
  'session:command',
  'session:spectate',
]);

function statusForStart(
  start: StartOperation,
): PublicRouteDescriptor['status'] {
  return start.state;
}

function responseStatus(
  value: unknown,
): PublicRouteDescriptor['status'] | undefined {
  if (
    value === 'suspended' ||
    value === 'active' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'paused' ||
    value === 'creating' ||
    value === 'activating' ||
    value === 'cancelling'
  )
    return value;
  return undefined;
}

function descriptor(
  start: StartOperation,
  status?: PublicRouteDescriptor['status'],
): PublicRouteDescriptor {
  return {
    authority: 'platform',
    route: copy(start.route),
    roomId: start.roomId,
    status: status ?? statusForStart(start),
  };
}

function withDescriptor<T extends object>(
  result: T,
  start: StartOperation,
  status?: PublicRouteDescriptor['status'],
): SessionGatewayResponse<T> {
  return {
    ...copy(result),
    descriptor: descriptor(start, status),
  } as SessionGatewayResponse<T>;
}

function requireActiveStart(start: StartOperation): void {
  if (
    start.state === 'creating' ||
    start.state === 'activating' ||
    start.state === 'cancelling'
  )
    throw contractError('NOT_READY', 'platform.gateway.session.notReady', true);
  if (start.state !== 'active')
    throw contractError('SESSION_CLOSED', 'platform.gateway.session.closed');
}

function isParticipant(
  admission: MatchAdmission,
  principalId: string,
): boolean {
  return admission.participants.some((participant) =>
    controlsParticipant(participant, principalId),
  );
}

function isBotParticipant(
  admission: MatchAdmission,
  principalId: string,
): boolean {
  return admission.participants.some(
    (participant) =>
      participant.principalId === principalId &&
      isAutomatedParticipant(participant),
  );
}

function normalizeScopes(
  value: CreatedAccess,
  identity: ResolvedIdentity,
  gameId: string,
  gameScopes: readonly string[],
): readonly string[] {
  let scopes: readonly string[];
  if (Array.isArray(value)) scopes = value;
  else {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('platform.gateway.access.invalid');
    const access = value as Exclude<CreatedAccess, readonly string[]>;
    if (
      access.principalId !== identity.principalId ||
      access.authEpoch !== identity.authEpoch
    )
      throw contractError(
        'UNAUTHENTICATED',
        'platform.gateway.identity.changed',
      );
    scopes = access.scopes;
  }
  if (
    !Array.isArray(scopes) ||
    scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        (!ALLOWED_SCOPES.has(scope) &&
          !(
            scope.startsWith(`${gameId}:`) &&
            !scope.startsWith('session:') &&
            gameScopes.includes(scope)
          )),
    )
  )
    throw contractError('FORBIDDEN', 'platform.gateway.scope.invalid');
  return [...new Set(scopes)];
}

function assertRequiredScopes(
  scopes: readonly string[],
  admission: MatchAdmission,
  identity: ResolvedIdentity,
  operation: SessionGatewayOperation,
): void {
  const participant = isParticipant(admission, identity.principalId);
  if (
    operation === 'command' &&
    (!participant || isBotParticipant(admission, identity.principalId))
  )
    throw contractError('FORBIDDEN', 'platform.gateway.participant.required');
  const required = participant
    ? [operation === 'command' ? 'session:command' : 'session:view']
    : ['session:view', 'session:spectate'];
  if (required.some((scope) => !scopes.includes(scope)))
    throw contractError('FORBIDDEN', 'platform.gateway.scope.denied');
}

function validateStart(start: StartOperation): void {
  assertRoute(start.route);
  if (
    start.sessionId !== start.route.sessionId ||
    !start.admission ||
    !sameRoute(start.admission.route, start.route)
  )
    throw contractError('INTERNAL', 'platform.gateway.admission.invalid');
}

function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}

function accessOperation(
  operation: SessionGatewayOperation,
): SessionAccessOperation {
  return operation === 'resume' || operation === 'summary' ? 'view' : operation;
}

export class SessionGateway {
  constructor(private readonly options: SessionGatewayOptions) {
    if (!options || typeof options !== 'object')
      invalid('platform.gateway.options.invalid');
    if (typeof options.resolveIdentity !== 'function')
      invalid('platform.gateway.resolveIdentity.required');
    if (typeof options.authorize !== 'function')
      invalid('platform.gateway.authorize.required');
    if (typeof options.createAccess !== 'function')
      invalid('platform.gateway.createAccess.required');
    if (typeof options.resolveBackend !== 'function')
      invalid('platform.gateway.resolveBackend.required');
    if (
      !options.admission ||
      typeof options.admission.getStartBySession !== 'function'
    )
      invalid('platform.gateway.admission.required');
  }

  async command<Command extends import('@board-game/contracts').JsonValue>(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: CommandInput<Command>,
  ): Promise<CommandResponse> {
    assertCommandInput<Command>(input);
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'command',
    );
    requireActiveStart(authorized.start);
    const request: SubmitCommandRequest<Command> = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
      commandId: input.commandId,
      precondition: copy(input.precondition),
      command: copy(input.command),
    };
    const backend = this.backend(authorized.start.route);
    const result = await backend.submitCommand(request);
    if (result.receipt.sessionId !== sessionId) this.responseRouteError();
    if (result.view) assertPartialRoute(result.view, authorized.start.route);
    return withDescriptor(result, authorized.start);
  }

  async view(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<ViewResponse> {
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'view',
    );
    requireActiveStart(authorized.start);
    const request: GetPlayerViewRequest = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
    };
    const result = await this.backend(authorized.start.route).getPlayerView(
      request,
    );
    assertPartialRoute(result, authorized.start.route);
    return withDescriptor(result, authorized.start);
  }

  /**
   * Returns routing metadata after the same admission and access checks as a
   * view, without resolving or dispatching the frozen backend.
   */
  async descriptor(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<PublicRouteDescriptor> {
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'view',
    );
    return descriptor(authorized.start);
  }

  async resume(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: ResumeInput = {},
  ): Promise<ResumeResponse> {
    assertResumeInput(input);
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'resume',
    );
    requireActiveStart(authorized.start);
    const request: ResumeRequest = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
      ...(input.viewerEpoch !== undefined
        ? { viewerEpoch: input.viewerEpoch }
        : {}),
      ...(input.streamCursor !== undefined
        ? { streamCursor: input.streamCursor }
        : {}),
    };
    const result = await this.backend(authorized.start.route).resume(request);
    if (!result || typeof result !== 'object' || !('view' in result))
      this.responseRouteError();
    assertPartialRoute(result.view, authorized.start.route);
    return withDescriptor(result, authorized.start);
  }

  async query<Query extends import('@board-game/contracts').JsonValue>(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: QueryInput<Query>,
  ): Promise<QueryResponse> {
    assertQueryInput<Query>(input);
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'query',
    );
    requireActiveStart(authorized.start);
    const request: QueryOptionsRequest<Query> = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
      revision: input.revision,
      query: copy(input.query),
    };
    const result = await this.backend(authorized.start.route).queryOptions(
      request,
    );
    assertExactRoute(result.route, authorized.start.route);
    return withDescriptor(result, authorized.start);
  }

  async events(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: EventsInput,
  ): Promise<EventsResponse> {
    assertEventsInput(input);
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'events',
    );
    requireActiveStart(authorized.start);
    const request: GetEventsRequest = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
      afterSequence: input.afterSequence,
      limit: input.limit,
      ...(input.viewEpoch !== undefined ? { viewEpoch: input.viewEpoch } : {}),
    };
    const result = await this.backend(authorized.start.route).getEvents(
      request,
    );
    assertPartialRoute(result, authorized.start.route);
    return withDescriptor(result, authorized.start);
  }

  async status(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: StatusInput = {},
  ): Promise<StatusResponse> {
    assertStatusInput(input);
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'status',
    );
    if (
      authorized.start.state === 'creating' ||
      authorized.start.state === 'activating' ||
      authorized.start.state === 'cancelling'
    ) {
      const result: OperationStatus = input.commandId
        ? {
            kind: 'command',
            commandId: input.commandId,
            sessionId,
            status: 'unknown',
          }
        : {
            kind: 'start',
            startId: input.startId ?? authorized.start.startId,
            sessionId,
            status:
              input.startId && input.startId !== authorized.start.startId
                ? 'unknown'
                : 'pending',
          };
      return withDescriptor(result, authorized.start);
    }
    if (authorized.start.state === 'cancelled') {
      const result: OperationStatus = input.commandId
        ? {
            kind: 'command',
            commandId: input.commandId,
            sessionId,
            status: 'unknown',
          }
        : {
            kind: 'start',
            startId: input.startId ?? authorized.start.startId,
            sessionId,
            status:
              input.startId && input.startId !== authorized.start.startId
                ? 'unknown'
                : 'cancelled',
          };
      return withDescriptor(result, authorized.start, 'cancelled');
    }
    const request: StatusRequest = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
      ...(input.startId !== undefined ? { startId: input.startId } : {}),
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    };
    const result = await this.backend(authorized.start.route).getStatus(
      request,
    );
    if (result.sessionId !== undefined && result.sessionId !== sessionId)
      this.responseRouteError();
    const resultStatus = responseStatus(result.status);
    return withDescriptor(result, authorized.start, resultStatus);
  }

  async summary(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<SummaryResponse> {
    const authorized = await this.authorizeSession(
      reference,
      sessionId,
      'summary',
    );
    requireActiveStart(authorized.start);
    const request: GetSessionSummaryRequest = {
      protocolVersion: 1,
      accessContext: authorized.access,
      route: copy(authorized.start.route),
    };
    const result = await this.backend(authorized.start.route).getSessionSummary(
      request,
    );
    assertExactRoute(result.route, authorized.start.route);
    return withDescriptor(result, authorized.start, result.status);
  }

  private async authorizeSession(
    reference: PlatformIdentityReference,
    sessionId: string,
    operation: SessionGatewayOperation,
  ): Promise<Authorized> {
    assertIdentityReference(reference);
    const canonicalSessionId = requireIdentifier(sessionId, 'sessionId');
    const resolved = await this.options.resolveIdentity(copy(reference));
    assertResolvedIdentity(resolved);
    const identity: ResolvedIdentity = {
      principalId: resolved.principalId,
      authEpoch: resolved.authEpoch,
      active: resolved.active,
    };
    if (identity.principalId !== reference.principalId || !identity.active)
      throw contractError(
        'UNAUTHENTICATED',
        'platform.gateway.identity.inactive',
      );
    const start =
      await this.options.admission.getStartBySession(canonicalSessionId);
    if (!start)
      throw contractError('NOT_FOUND', 'platform.gateway.session.notFound');
    validateStart(start);
    const admission = copy(start.admission);
    const controlled = admission.participants.filter((participant) =>
      controlsParticipant(participant, identity.principalId),
    );
    const selected =
      reference.seatId !== undefined
        ? controlled.find(
            (participant) => participant.seatId === reference.seatId,
          )
        : (controlled.find(
            (participant) => participant.principalId === identity.principalId,
          ) ?? (controlled.length === 1 ? controlled[0] : undefined));
    if (
      (reference.seatId !== undefined && !selected) ||
      (controlled.length > 0 && !selected)
    )
      throw contractError('FORBIDDEN', 'platform.gateway.seat.required');
    const allowed = await this.options.authorize(
      copy(identity),
      copy(admission),
      operation,
    );
    if (!allowed)
      throw contractError('FORBIDDEN', `platform.gateway.${operation}.denied`);
    const created = await this.options.createAccess(
      copy(identity),
      copy(admission),
      accessOperation(operation),
    );
    const scopes = normalizeScopes(
      created,
      identity,
      admission.route.gameId,
      this.options.gameScopes?.[admission.route.gameId] ?? [],
    );
    assertRequiredScopes(scopes, admission, identity, operation);
    return {
      start: copy(start),
      admission,
      identity: copy(identity),
      access: {
        principalId: identity.principalId,
        authEpoch: identity.authEpoch,
        scopes,
        ...(selected ? { seatId: selected.seatId } : {}),
      },
    };
  }

  private backend(route: SessionRoute): BackendPort {
    const backend = this.options.resolveBackend(copy(route));
    if (!backend || typeof backend !== 'object')
      throw contractError('INTERNAL', 'platform.gateway.backend.invalid');
    return backend;
  }

  private responseRouteError(): never {
    throw contractError('OWNERSHIP_LOST', 'platform.gateway.response.route');
  }
}
