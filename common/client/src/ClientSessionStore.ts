import {
  type CommandPrecondition,
  type ErrorCode,
  type ErrorEnvelope,
  type GetEventsRequest,
  type GetEventsResponse,
  type GetPlayerViewRequest,
  isCommandPrecondition,
  isErrorCode,
  isJsonValue,
  isPlatformError,
  type JsonValue,
  type PlayerViewEnvelope,
  type QueryOptionsRequest,
  type QueryOptionsResponse,
  type ResumeRequest,
  type ResumeResult,
  type SafeCommandReceipt,
  type SessionRoute,
  type SubmitCommandRequest,
  type SubmitCommandResponse,
} from '@board-game/contracts';

/** Browser-facing request shapes intentionally omit the trusted server context. */
export type ClientGetPlayerViewRequest = Omit<
  GetPlayerViewRequest,
  'accessContext'
>;
export type ClientGetEventsRequest = Omit<GetEventsRequest, 'accessContext'>;
export type ClientResumeRequest = Omit<ResumeRequest, 'accessContext'>;
export type ClientSubmitCommandRequest<Command extends JsonValue = JsonValue> =
  Omit<SubmitCommandRequest<Command>, 'accessContext'>;
export type ClientQueryOptionsRequest<Query extends JsonValue = JsonValue> =
  Omit<QueryOptionsRequest<Query>, 'accessContext'>;

export interface ClientSessionTransport<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  readonly getPlayerView: (
    request: ClientGetPlayerViewRequest,
  ) => Promise<PlayerViewEnvelope<View>>;
  readonly getEvents: (
    request: ClientGetEventsRequest,
  ) => Promise<GetEventsResponse>;
  readonly resume: (
    request: ClientResumeRequest,
  ) => Promise<ResumeResult<View>>;
  readonly submitCommand: (
    request: ClientSubmitCommandRequest<Command>,
  ) => Promise<SubmitCommandResponse<View>>;
  readonly queryOptions: (
    request: ClientQueryOptionsRequest<Query>,
  ) => Promise<QueryOptionsResponse<Answer>>;
}

export interface ClientCommandIntent<Command extends JsonValue = JsonValue> {
  readonly commandId: string;
  readonly command: Command;
  readonly precondition: CommandPrecondition;
}

/** Resolve a game action against the latest public prompt fence when one exists. */
export function resolveActionPrecondition(
  snapshot: Pick<PlayerViewEnvelope, 'revision' | 'actionPrecondition'>,
  explicit?: CommandPrecondition,
): CommandPrecondition {
  return (
    explicit ??
    snapshot.actionPrecondition ?? {
      kind: 'revision',
      expectedRevision: snapshot.revision,
    }
  );
}

/** Build the intent used by game actions; management commands can keep explicit revisions. */
export function createActionIntent<Command extends JsonValue>(
  snapshot: Pick<PlayerViewEnvelope, 'revision' | 'actionPrecondition'>,
  commandId: string,
  command: Command,
  explicitPrecondition?: CommandPrecondition,
): ClientCommandIntent<Command> {
  return {
    commandId,
    command,
    precondition: resolveActionPrecondition(snapshot, explicitPrecondition),
  };
}

export type ClientTransportErrorCode = 'NETWORK' | 'TIMEOUT' | 'ABORTED';
export type ClientErrorCode =
  | ErrorCode
  | ClientTransportErrorCode
  | 'CLIENT_CLOSED'
  | 'SUBMISSION_IN_FLIGHT'
  | 'NO_VIEW'
  | 'INVALID_RESPONSE'
  | 'VIEW_GAP'
  | 'VIEW_AUDIENCE_CHANGED'
  | 'VIEW_UNSUPPORTED'
  | 'VIEW_APPLY_FAILED'
  | 'QUERY_REVISION_MISMATCH'
  | 'COMMAND_OUTCOME_UNKNOWN';

export interface ClientError {
  readonly code: ClientErrorCode;
  readonly messageKey: string;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: JsonValue;
}

export class ClientSessionStoreError extends Error {
  readonly clientError: ClientError;

  constructor(clientError: ClientError) {
    super(clientError.messageKey);
    this.name = 'ClientSessionStoreError';
    this.clientError = clientError;
  }
}

export type ClientSessionStatus =
  | 'loading'
  | 'ready'
  | 'recovering'
  | 'closed'
  | 'error';

export type ClientRecoveryReason =
  | 'gap'
  | 'audience-changed'
  | 'resync-required'
  | 'missing-view';

export interface PendingCommandSubmission<
  Command extends JsonValue = JsonValue,
> {
  readonly intent: ClientCommandIntent<Command>;
  readonly attempt: number;
  readonly phase: 'sending' | 'unknown';
}

export type ClientSubmissionOutcome =
  | {
      readonly outcome: 'accepted' | 'duplicate' | 'rejected';
      readonly commandId: string;
      readonly receipt: SafeCommandReceipt;
    }
  | {
      readonly outcome: 'unknown';
      readonly commandId: string;
      readonly receipt?: SafeCommandReceipt;
      readonly error: ClientError;
    }
  | {
      readonly outcome: 'error';
      readonly commandId: string;
      readonly error: ClientError;
    };

export interface ClientQueryState<Answer extends JsonValue = JsonValue> {
  readonly revision: number;
  readonly answer: Answer;
}

export interface ClientSessionState<
  Command extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  readonly route: SessionRoute;
  readonly identityKey: string | null;
  readonly status: ClientSessionStatus;
  readonly snapshot: PlayerViewEnvelope<View> | null;
  readonly pendingSubmission: PendingCommandSubmission<Command> | null;
  readonly lastSubmission: ClientSubmissionOutcome | null;
  readonly query: ClientQueryState<Answer> | null;
  readonly error: ClientError | null;
  readonly recoveryReason: ClientRecoveryReason | null;
}

export type ClientSessionListener<
  Command extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> = (state: ClientSessionState<Command, Answer, View>) => void;

export type ApplyViewDelta<View extends JsonValue = JsonValue> = (
  current: View,
  incoming: View,
  envelope: PlayerViewEnvelope<View>,
) => View;

export interface ClientSessionStoreOptions<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  readonly route: SessionRoute;
  readonly transport: ClientSessionTransport<Command, Query, Answer, View>;
  readonly applyDelta?: ApplyViewDelta<View>;
  /** An opaque local identity marker. It is never sent as access context. */
  readonly identityKey?: string | null;
}

type ViewApplyResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'recover'; readonly reason: ClientRecoveryReason };

const ROUTE_KEYS: readonly (keyof SessionRoute)[] = [
  'gameId',
  'modeId',
  'sessionId',
  'releaseId',
  'backendBindingId',
  'storageBindingId',
  'ownershipEpoch',
];

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return ROUTE_KEYS.every((key) => left[key] === right[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTurnView(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.mode === 'sequential' || value.mode === 'simultaneous') &&
    Array.isArray(value.activeSeatIds) &&
    value.activeSeatIds.length <= 64 &&
    new Set(value.activeSeatIds).size === value.activeSeatIds.length &&
    value.activeSeatIds.every(
      (seatId): seatId is string =>
        typeof seatId === 'string' && seatId.length > 0,
    )
  );
}

function isControlledParticipant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.principalId === 'string' &&
    value.principalId.length > 0 &&
    typeof value.seatId === 'string' &&
    value.seatId.length > 0 &&
    (value.controller === undefined ||
      value.controller === 'human' ||
      value.controller === 'hotseat' ||
      value.controller === 'ai' ||
      value.controller === 'automa' ||
      value.controller === 'bot') &&
    (value.publicProfile === undefined || isJsonValue(value.publicProfile))
  );
}

function isManagementCommand(value: unknown): boolean {
  return isRecord(value) && value.type === 'sessionControl';
}

const SAFE_ERROR_KEYS = new Set([
  'code',
  'messageKey',
  'retryable',
  'requestId',
  'details',
]);

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !SAFE_ERROR_KEYS.has(key))) return false;
  return (
    isErrorCode(value.code) &&
    typeof value.messageKey === 'string' &&
    value.messageKey.length > 0 &&
    typeof value.retryable === 'boolean' &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.details === undefined || isJsonValue(value.details))
  );
}

function isViewEnvelope<View extends JsonValue = JsonValue>(
  value: unknown,
): value is PlayerViewEnvelope<View> {
  if (!isRecord(value)) return false;
  return (
    typeof value.gameId === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.releaseId === 'string' &&
    Number.isSafeInteger(value.viewSchemaVersion) &&
    (value.viewSchemaVersion as number) > 0 &&
    typeof value.audienceKey === 'string' &&
    typeof value.viewEpoch === 'string' &&
    Number.isSafeInteger(value.baseRevision) &&
    (value.baseRevision as number) >= 0 &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= (value.baseRevision as number) &&
    (value.eventSequence === undefined ||
      (Number.isSafeInteger(value.eventSequence) &&
        (value.eventSequence as number) >= 0)) &&
    typeof value.streamCursor === 'string' &&
    (value.kind === 'snapshot' ||
      value.kind === 'section-replacement' ||
      value.kind === 'patch') &&
    isJsonValue(value.payload) &&
    (value.turn === undefined ||
      value.turn === null ||
      isTurnView(value.turn)) &&
    (value.actingSeatId === undefined ||
      (typeof value.actingSeatId === 'string' &&
        value.actingSeatId.length > 0)) &&
    (value.actionPrecondition === undefined ||
      isCommandPrecondition(value.actionPrecondition)) &&
    (value.controlledSeats === undefined ||
      (Array.isArray(value.controlledSeats) &&
        value.controlledSeats.length <= 64 &&
        value.controlledSeats.every(isControlledParticipant)))
  );
}

const SAFE_RECEIPT_KEYS = new Set([
  'commandId',
  'sessionId',
  'status',
  'persistedRevision',
  'persistedAt',
  'resultRetention',
  'error',
]);

function isSafeReceipt(value: unknown): value is SafeCommandReceipt {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !SAFE_RECEIPT_KEYS.has(key)))
    return false;
  return (
    typeof value.commandId === 'string' &&
    value.commandId.length > 0 &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    (value.status === 'accepted' ||
      value.status === 'rejected' ||
      value.status === 'duplicate' ||
      value.status === 'unknown') &&
    (value.resultRetention === 'replayable' ||
      value.resultRetention === 'ephemeral-result') &&
    (value.persistedRevision === undefined ||
      (Number.isSafeInteger(value.persistedRevision) &&
        (value.persistedRevision as number) >= 0)) &&
    (value.persistedAt === undefined ||
      (typeof value.persistedAt === 'number' &&
        Number.isFinite(value.persistedAt))) &&
    (value.error === undefined || isErrorEnvelope(value.error))
  );
}

function isSubmitResponse<View extends JsonValue = JsonValue>(
  value: unknown,
): value is SubmitCommandResponse<View> {
  return (
    isRecord(value) &&
    isSafeReceipt(value.receipt) &&
    (value.view === undefined || isViewEnvelope<View>(value.view))
  );
}

function isResumeResult<View extends JsonValue = JsonValue>(
  value: unknown,
): value is ResumeResult<View> {
  if (!isRecord(value) || !isViewEnvelope<View>(value.view)) return false;
  if (value.kind === 'snapshot' || value.kind === 'delta') return true;
  return (
    value.kind === 'resync-required' &&
    (value.reason === 'cursor-expired' ||
      value.reason === 'audience-changed' ||
      value.reason === 'base-mismatch')
  );
}

function makeClientError(
  code: ClientErrorCode,
  messageKey: string,
  retryable = false,
  details?: JsonValue,
): ClientError {
  return details === undefined
    ? { code, messageKey, retryable }
    : { code, messageKey, retryable, details: clone(details) };
}

function contractErrorToClient(error: ErrorEnvelope): ClientError {
  return {
    code: error.code,
    messageKey: error.messageKey,
    retryable: error.retryable,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.details === undefined ? {} : { details: clone(error.details) }),
  };
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined;
  return error.code;
}

function isUnknownTransportError(error: unknown): boolean {
  if (isPlatformError(error)) return false;
  if (error instanceof ClientSessionStoreError) {
    return (
      error.clientError.code === 'NETWORK' ||
      error.clientError.code === 'TIMEOUT' ||
      error.clientError.code === 'ABORTED'
    );
  }
  if (isRecord(error) && error.outcome === 'unknown') return true;
  const code = errorCode(error);
  if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'ABORTED') {
    return true;
  }
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return code === undefined || !isErrorCode(code);
}

function toClientError(
  error: unknown,
  fallbackCode: ClientTransportErrorCode | 'INTERNAL' = 'NETWORK',
): ClientError {
  if (error instanceof ClientSessionStoreError) return error.clientError;
  if (isPlatformError(error)) return contractErrorToClient(error.envelope);

  const code = errorCode(error);
  if (code === 'NETWORK' || code === 'TIMEOUT' || code === 'ABORTED') {
    return makeClientError(code, `platform.client.${code.toLowerCase()}`, true);
  }
  if (isErrorCode(code)) {
    return makeClientError(code as ErrorCode, 'platform.client.transportError');
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return makeClientError('ABORTED', 'platform.client.aborted', true);
  }
  return makeClientError(
    fallbackCode,
    fallbackCode === 'INTERNAL'
      ? 'platform.client.internal'
      : 'platform.client.network',
    fallbackCode !== 'INTERNAL',
  );
}

function asStoreError(error: unknown): ClientSessionStoreError {
  return error instanceof ClientSessionStoreError
    ? error
    : new ClientSessionStoreError(toClientError(error, 'INTERNAL'));
}

export class ClientSessionStore<
  Command extends JsonValue = JsonValue,
  Query extends JsonValue = JsonValue,
  Answer extends JsonValue = JsonValue,
  View extends JsonValue = JsonValue,
> {
  private readonly route: SessionRoute;
  private readonly transport: ClientSessionTransport<
    Command,
    Query,
    Answer,
    View
  >;
  private readonly applyDelta: ApplyViewDelta<View> | undefined;
  private readonly listeners = new Set<
    ClientSessionListener<Command, Answer, View>
  >();
  private identityKey: string | null;
  private state: ClientSessionState<Command, Answer, View>;
  private generation = 0;
  private viewOperation = 0;
  private queryOperation = 0;
  private disposed = false;
  private recoveryGeneration = -1;
  private recoveryPromise: Promise<void> | null = null;

  constructor(
    options: ClientSessionStoreOptions<Command, Query, Answer, View>,
  ) {
    this.route = clone(options.route);
    this.transport = options.transport;
    this.applyDelta = options.applyDelta;
    this.identityKey = options.identityKey ?? null;
    this.state = this.makeInitialState('loading');
  }

  public getState(): ClientSessionState<Command, Answer, View> {
    return clone(this.state);
  }

  /** Drop private caches after any authorized channel reports lost access. */
  public invalidateAccess(error: unknown): boolean {
    const failure = toClientError(error);
    if (
      this.disposed ||
      !['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'SESSION_CLOSED'].includes(
        failure.code,
      )
    )
      return false;
    this.generation += 1;
    this.viewOperation += 1;
    this.queryOperation += 1;
    this.recoveryGeneration = -1;
    this.recoveryPromise = null;
    this.state = {
      ...this.makeInitialState(
        failure.code === 'SESSION_CLOSED' ? 'closed' : 'error',
      ),
      error: failure,
    };
    this.emit();
    return true;
  }

  public subscribe(
    listener: ClientSessionListener<Command, Answer, View>,
  ): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setIdentity(identityKey: string | null): void {
    if (this.disposed || identityKey === this.identityKey) return;
    this.identityKey = identityKey;
    this.generation += 1;
    this.viewOperation += 1;
    this.queryOperation += 1;
    this.recoveryGeneration = -1;
    this.recoveryPromise = null;
    this.state = this.makeInitialState('loading');
    this.emit();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.viewOperation += 1;
    this.queryOperation += 1;
    this.recoveryGeneration = -1;
    this.recoveryPromise = null;
    this.disposed = true;
    this.state = this.makeInitialState('closed');
    this.listeners.clear();
  }

  public async load(): Promise<void> {
    if (this.disposed) return;
    const currentGeneration = this.generation;
    const operation = ++this.viewOperation;
    this.queryOperation += 1;
    this.recoveryPromise = null;
    this.recoveryGeneration = -1;
    this.patchState({
      status: 'loading',
      snapshot: null,
      query: null,
      error: null,
      recoveryReason: null,
    });
    await this.fetchSnapshot(currentGeneration, operation);
  }

  public async resume(): Promise<void> {
    if (this.disposed) return;
    const currentGeneration = this.generation;
    const operation = ++this.viewOperation;
    const currentSnapshot = this.state.snapshot;
    this.patchState({
      status: currentSnapshot ? 'recovering' : 'loading',
      error: null,
      recoveryReason: null,
    });

    try {
      const request: ClientResumeRequest = {
        protocolVersion: 1,
        route: clone(this.route),
        ...(currentSnapshot
          ? {
              viewerEpoch: currentSnapshot.viewEpoch,
              streamCursor: currentSnapshot.streamCursor,
            }
          : {}),
      };
      const result = await this.transport.resume(clone(request));
      if (
        !this.isCurrent(currentGeneration) ||
        operation !== this.viewOperation
      )
        return;
      if (!isResumeResult<View>(result)) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.invalidResumeResponse',
          ),
        );
      }
      if (result.kind === 'resync-required') {
        await this.triggerRecovery('resync-required', currentGeneration);
        if (this.isCurrent(currentGeneration))
          this.clearResolvedSubmissionError();
        return;
      }
      const applied = this.integrateView(result.view);
      if (applied.kind === 'stale' && this.state.snapshot) {
        this.patchState({ status: 'ready', recoveryReason: null });
      }
      if (applied.kind === 'recover') {
        await this.triggerRecovery(applied.reason, currentGeneration);
      }
      // A successful explicit refresh acknowledges a resolved action error.
      // Unknown outcomes retain their exact intent until a receipt resolves it.
      if (this.isCurrent(currentGeneration))
        this.clearResolvedSubmissionError();
    } catch (error) {
      if (this.isCurrent(currentGeneration)) {
        const clientError =
          error instanceof ClientSessionStoreError
            ? error.clientError
            : toClientError(error);
        if (this.invalidateAccess(clientError))
          throw new ClientSessionStoreError(clientError);
        this.patchState({
          status: clientError.code === 'SESSION_CLOSED' ? 'closed' : 'error',
          error: clientError,
        });
        throw new ClientSessionStoreError(clientError);
      }
      return;
    }
  }

  public async submitCommand(
    intent: ClientCommandIntent<Command>,
  ): Promise<SubmitCommandResponse<View>> {
    this.assertSubmissionReady(intent);
    const snapshot = this.state.snapshot;
    const resolvedIntent =
      snapshot &&
      snapshot.actionPrecondition &&
      intent.precondition.kind === 'revision' &&
      !isManagementCommand(intent.command)
        ? {
            ...intent,
            precondition: snapshot.actionPrecondition,
          }
        : intent;
    return this.submitIntent(clone(resolvedIntent), this.generation, 1);
  }

  public async submitAction(
    commandId: string,
    command: Command,
    explicitPrecondition?: CommandPrecondition,
  ): Promise<SubmitCommandResponse<View>> {
    const snapshot = this.state.snapshot;
    if (!snapshot) {
      throw new ClientSessionStoreError(
        makeClientError('NO_VIEW', 'platform.client.commandNeedsView'),
      );
    }
    const intent = createActionIntent(
      snapshot,
      commandId,
      command,
      explicitPrecondition,
    );
    this.assertSubmissionReady(intent);
    return this.submitIntent(clone(intent), this.generation, 1);
  }

  public async retryPending(): Promise<SubmitCommandResponse<View>> {
    if (this.disposed) throw this.closedError();
    const pending = this.state.pendingSubmission;
    if (!pending || pending.phase !== 'unknown') {
      throw new ClientSessionStoreError(
        makeClientError(
          'COMMAND_OUTCOME_UNKNOWN',
          'platform.client.noUnknownSubmission',
        ),
      );
    }
    return this.submitIntent(
      clone(pending.intent),
      this.generation,
      pending.attempt + 1,
    );
  }

  public async queryOptions(
    query: Query,
    revision?: number,
  ): Promise<QueryOptionsResponse<Answer>> {
    if (this.disposed) throw this.closedError();
    const requestedRevision = revision ?? this.state.snapshot?.revision;
    if (
      requestedRevision === undefined ||
      !Number.isSafeInteger(requestedRevision) ||
      requestedRevision < 0
    ) {
      throw new ClientSessionStoreError(
        makeClientError('NO_VIEW', 'platform.client.queryNeedsRevision'),
      );
    }
    const currentGeneration = this.generation;
    const operation = ++this.queryOperation;
    const snapshotAtRequest = this.state.snapshot;
    try {
      const request: ClientQueryOptionsRequest<Query> = {
        protocolVersion: 1,
        route: clone(this.route),
        revision: requestedRevision,
        query: clone(query),
      };
      const response = await this.transport.queryOptions(clone(request));
      if (
        !this.isCurrent(currentGeneration) ||
        operation !== this.queryOperation
      )
        return response;
      if (!isRecord(response)) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.invalidQueryResponse',
          ),
        );
      }
      const queryResponse = response as QueryOptionsResponse<Answer>;
      if (
        !isRecord(queryResponse.route) ||
        !sameRoute(queryResponse.route, this.route) ||
        !Number.isSafeInteger(queryResponse.revision) ||
        !isJsonValue(queryResponse.answer)
      ) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.invalidQueryResponse',
          ),
        );
      }
      if (
        queryResponse.revision !== requestedRevision ||
        this.state.snapshot === null ||
        this.state.snapshot.revision !== requestedRevision ||
        (snapshotAtRequest !== null &&
          (snapshotAtRequest.audienceKey !== this.state.snapshot.audienceKey ||
            snapshotAtRequest.viewEpoch !== this.state.snapshot.viewEpoch))
      ) {
        return response;
      }
      this.patchState({
        query: {
          revision: queryResponse.revision,
          answer: clone(queryResponse.answer),
        },
        error: null,
      });
      return response;
    } catch (error) {
      if (
        !this.isCurrent(currentGeneration) ||
        operation !== this.queryOperation
      )
        throw asStoreError(error);
      const clientError =
        error instanceof ClientSessionStoreError
          ? error.clientError
          : toClientError(error);
      if (this.invalidateAccess(clientError))
        throw new ClientSessionStoreError(clientError);
      this.patchState({
        status: clientError.code === 'SESSION_CLOSED' ? 'closed' : 'error',
        error: clientError,
      });
      throw new ClientSessionStoreError(clientError);
    }
  }

  private makeInitialState(
    status: ClientSessionStatus,
  ): ClientSessionState<Command, Answer, View> {
    return {
      route: this.route,
      identityKey: this.identityKey,
      status,
      snapshot: null,
      pendingSubmission: null,
      lastSubmission: null,
      query: null,
      error: null,
      recoveryReason: null,
    };
  }

  private clearResolvedSubmissionError(): void {
    if (
      this.state.status === 'ready' &&
      this.state.pendingSubmission === null &&
      (this.state.lastSubmission?.outcome === 'rejected' ||
        this.state.lastSubmission?.outcome === 'error')
    )
      this.patchState({ lastSubmission: null });
  }

  private patchState(
    patch: Partial<ClientSessionState<Command, Answer, View>>,
  ): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, route: this.route };
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private closedError(): ClientSessionStoreError {
    return new ClientSessionStoreError(
      makeClientError('CLIENT_CLOSED', 'platform.client.closed'),
    );
  }

  private assertSubmissionReady(intent: ClientCommandIntent<Command>): void {
    if (this.disposed) throw this.closedError();
    if (this.state.pendingSubmission) {
      throw new ClientSessionStoreError(
        makeClientError(
          'SUBMISSION_IN_FLIGHT',
          'platform.client.submissionInFlight',
          true,
        ),
      );
    }
    this.validateIntent(intent);
  }

  private validateIntent(intent: ClientCommandIntent<Command>): void {
    if (
      !isRecord(intent) ||
      typeof intent.commandId !== 'string' ||
      intent.commandId.length === 0 ||
      !isJsonValue(intent.command) ||
      !isJsonValue(intent.precondition)
    ) {
      throw new ClientSessionStoreError(
        makeClientError('INVALID_REQUEST', 'platform.client.invalidCommand'),
      );
    }
  }

  private async fetchSnapshot(
    currentGeneration: number,
    operation: number,
  ): Promise<void> {
    try {
      const response = await this.transport.getPlayerView({
        protocolVersion: 1,
        route: clone(this.route),
      });
      if (
        !this.isCurrent(currentGeneration) ||
        operation !== this.viewOperation
      ) {
        return;
      }
      if (!isViewEnvelope<View>(response)) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.invalidViewResponse',
          ),
        );
      }
      const applied = this.integrateView(response);
      if (applied.kind === 'recover') {
        throw new ClientSessionStoreError(
          makeClientError('VIEW_GAP', 'platform.client.viewNeedsResync', true),
        );
      }
    } catch (error) {
      if (
        !this.isCurrent(currentGeneration) ||
        operation !== this.viewOperation
      ) {
        return;
      }
      const clientError =
        error instanceof ClientSessionStoreError
          ? error.clientError
          : toClientError(error);
      if (this.invalidateAccess(clientError))
        throw new ClientSessionStoreError(clientError);
      this.patchState({
        status: clientError.code === 'SESSION_CLOSED' ? 'closed' : 'error',
        error: clientError,
      });
      throw new ClientSessionStoreError(clientError);
    }
  }

  private async triggerRecovery(
    reason: ClientRecoveryReason,
    currentGeneration: number,
  ): Promise<void> {
    if (!this.isCurrent(currentGeneration)) return;
    if (this.recoveryPromise && this.recoveryGeneration === currentGeneration) {
      return this.recoveryPromise;
    }
    this.recoveryGeneration = currentGeneration;
    const operation = ++this.viewOperation;
    this.queryOperation += 1;
    this.patchState({
      status: 'recovering',
      snapshot: null,
      query: null,
      error: null,
      recoveryReason: reason,
    });
    const recovery = this.fetchSnapshot(currentGeneration, operation).finally(
      () => {
        if (this.recoveryPromise === recovery) {
          this.recoveryPromise = null;
          this.recoveryGeneration = -1;
        }
      },
    );
    this.recoveryPromise = recovery;
    return recovery;
  }

  private integrateView(view: PlayerViewEnvelope<View>): ViewApplyResult {
    if (
      view.gameId !== this.route.gameId ||
      view.sessionId !== this.route.sessionId ||
      view.releaseId !== this.route.releaseId
    ) {
      throw new ClientSessionStoreError(
        makeClientError('INVALID_RESPONSE', 'platform.client.routeMismatch'),
      );
    }

    const current = this.state.snapshot;
    if (
      current &&
      (current.audienceKey !== view.audienceKey ||
        current.viewEpoch !== view.viewEpoch)
    ) {
      return { kind: 'recover', reason: 'audience-changed' };
    }
    if (current && view.revision <= current.revision) {
      return { kind: 'stale' };
    }
    if (view.kind !== 'snapshot') {
      if (!current) return { kind: 'recover', reason: 'missing-view' };
      if (view.baseRevision !== current.revision) {
        return { kind: 'recover', reason: 'gap' };
      }
      if (!this.applyDelta) {
        return { kind: 'recover', reason: 'missing-view' };
      }
      let nextPayload: View;
      try {
        nextPayload = this.applyDelta(
          clone(current.payload),
          clone(view.payload),
          clone(view),
        );
      } catch {
        throw new ClientSessionStoreError(
          makeClientError(
            'VIEW_APPLY_FAILED',
            'platform.client.viewApplyFailed',
            true,
          ),
        );
      }
      if (!isJsonValue(nextPayload)) {
        throw new ClientSessionStoreError(
          makeClientError(
            'VIEW_APPLY_FAILED',
            'platform.client.viewPayloadInvalid',
            true,
          ),
        );
      }
      this.queryOperation += 1;
      this.patchState({
        query: null,
        status: 'ready',
        snapshot: { ...clone(view), payload: clone(nextPayload) },
        error: null,
        recoveryReason: null,
      });
      return { kind: 'accepted' };
    }

    this.queryOperation += 1;
    this.patchState({
      status: 'ready',
      snapshot: clone(view),
      query: null,
      error: null,
      recoveryReason: null,
    });
    return { kind: 'accepted' };
  }

  private async submitIntent(
    intent: ClientCommandIntent<Command>,
    currentGeneration: number,
    attempt: number,
  ): Promise<SubmitCommandResponse<View>> {
    this.patchState({
      status: this.state.status === 'closed' ? 'error' : this.state.status,
      pendingSubmission: {
        intent: clone(intent),
        attempt,
        phase: 'sending',
      },
      lastSubmission: null,
      error: null,
    });
    try {
      const request: ClientSubmitCommandRequest<Command> = {
        protocolVersion: 1,
        route: clone(this.route),
        commandId: intent.commandId,
        precondition: clone(intent.precondition),
        command: clone(intent.command),
      };
      const response = await this.transport.submitCommand(clone(request));
      if (!this.isCurrent(currentGeneration)) return response;
      if (!isSubmitResponse<View>(response)) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.invalidCommandResponse',
          ),
        );
      }
      const receipt = response.receipt;
      if (
        receipt.commandId !== intent.commandId ||
        receipt.sessionId !== this.route.sessionId
      ) {
        throw new ClientSessionStoreError(
          makeClientError(
            'INVALID_RESPONSE',
            'platform.client.commandReceiptMismatch',
          ),
        );
      }
      if (receipt.status === 'unknown') {
        const unknownError = receipt.error
          ? contractErrorToClient(receipt.error)
          : makeClientError(
              'COMMAND_OUTCOME_UNKNOWN',
              'platform.client.commandOutcomeUnknown',
              true,
            );
        this.patchState({
          status: 'error',
          pendingSubmission: {
            intent: clone(intent),
            attempt,
            phase: 'unknown',
          },
          lastSubmission: {
            outcome: 'unknown',
            commandId: intent.commandId,
            receipt: clone(receipt),
            error: unknownError,
          },
          error: unknownError,
        });
        return response;
      }

      this.patchState({
        status: 'ready',
        pendingSubmission: null,
        lastSubmission: {
          outcome: receipt.status,
          commandId: intent.commandId,
          receipt: clone(receipt),
        },
        error: null,
      });

      if (response.view) {
        const operation = ++this.viewOperation;
        const applied = this.integrateView(response.view);
        if (applied.kind === 'recover') {
          try {
            await this.triggerRecovery(applied.reason, currentGeneration);
          } catch {
            // The command outcome is known even when refreshing the view fails.
          }
        } else if (operation !== this.viewOperation) {
          return response;
        }
      } else if (
        receipt.status === 'accepted' ||
        receipt.status === 'duplicate'
      ) {
        try {
          await this.triggerRecovery('missing-view', currentGeneration);
        } catch {
          // Keep the known receipt available; state carries the refresh error.
        }
      }
      return response;
    } catch (error) {
      if (!this.isCurrent(currentGeneration)) throw asStoreError(error);
      const clientError =
        error instanceof ClientSessionStoreError
          ? error.clientError
          : toClientError(error);
      if (this.invalidateAccess(clientError))
        throw new ClientSessionStoreError(clientError);
      if (isUnknownTransportError(error)) {
        this.patchState({
          status: 'error',
          pendingSubmission: {
            intent: clone(intent),
            attempt,
            phase: 'unknown',
          },
          lastSubmission: {
            outcome: 'unknown',
            commandId: intent.commandId,
            error: clientError,
          },
          error: clientError,
        });
      } else {
        this.patchState({
          status: clientError.code === 'SESSION_CLOSED' ? 'closed' : 'error',
          pendingSubmission: null,
          lastSubmission: {
            outcome: 'error',
            commandId: intent.commandId,
            error: clientError,
          },
          error: clientError,
        });
      }
      throw new ClientSessionStoreError(clientError);
    }
  }
}
