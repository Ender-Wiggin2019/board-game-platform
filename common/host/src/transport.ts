import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AccessContext,
  type ActivateSessionRequest,
  type ActivateSessionResponse,
  assertAccessContext,
  assertControlSessionRequest,
  assertCreateSessionRequest,
  assertDailyChallengeServiceRequest,
  assertDeveloperConsoleCatalogRequest,
  assertGameStatisticsServiceRequest,
  assertGetEventsRequest,
  assertJsonPayloadSize,
  assertProtocolRequest,
  assertQueryPayload,
  assertSessionRoute,
  assertSubmitCommandRequest,
  assertSubmitDeveloperCommandRequest,
  assertSubmitSystemCommandRequest,
  type BackendDescription,
  type BackendPort,
  type ControlSessionRequest,
  type ControlSessionResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  contractError,
  DAILY_CHALLENGE_BACKEND_OPERATION,
  type DailyChallengeServiceRequest,
  type DailyChallengeServiceResponse,
  DEFAULT_JSON_LIMITS,
  type DescribeRequest,
  type DeveloperConsoleCatalogRequest,
  type DeveloperConsoleCatalogResponse,
  type ErrorEnvelope,
  GAME_STATISTICS_BACKEND_OPERATION,
  type GameStatisticsServiceRequest,
  type GameStatisticsServiceResponse,
  type GetEventsRequest,
  type GetEventsResponse,
  type GetPlayerViewRequest,
  type GetSessionSummaryRequest,
  type GetStatusRequest,
  isJsonValue,
  isPlatformError,
  type JsonValue,
  type OperationStatus,
  PlatformError,
  type PlayerViewEnvelope,
  type QueryOptionsRequest,
  type QueryOptionsResponse,
  type ReadyRequest,
  type ReadyResponse,
  type ResumeRequest,
  type ResumeResult,
  type RetireSessionHistoryRequest,
  type SessionSummary,
  type SubmitCommandRequest,
  type SubmitCommandResponse,
  type SubmitDeveloperCommandRequest,
  type SubmitDeveloperCommandResponse,
  type SubmitSystemCommandRequest,
  type SubmitSystemCommandResponse,
  toErrorEnvelope,
} from '@board-game/contracts';

export const HTTP_HOST_OPERATIONS = [
  'describe',
  'ready',
  'createSession',
  'activateSession',
  'getStatus',
  'submitCommand',
  'submitSystemCommand',
  'getDeveloperConsole',
  'submitDeveloperCommand',
  'queryOptions',
  'getPlayerView',
  'getEvents',
  'resume',
  'getSessionSummary',
  'controlSession',
  'retireSessionHistory',
  DAILY_CHALLENGE_BACKEND_OPERATION,
  GAME_STATISTICS_BACKEND_OPERATION,
] as const;

export type BackendOperation = (typeof HTTP_HOST_OPERATIONS)[number];
export type ProtocolEnvelope<T> = {
  readonly protocolVersion: 1;
  readonly request: T;
};
export type ProtocolResponseEnvelope<T> = {
  readonly protocolVersion: 1;
  readonly response: T;
};

export type TransportFailureCode =
  | 'ABORTED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PROTOCOL'
  | 'RESPONSE_TOO_LARGE';

/** A transport failure has unknown outcome and is never retried by this module. */
export class BackendTransportError extends Error {
  public readonly outcome = 'unknown' as const;

  public constructor(public readonly code: TransportFailureCode) {
    super(`transport.${code.toLowerCase()}`);
    this.name = 'BackendTransportError';
  }
}

export interface TransportLimits {
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface EmbeddedBackendAdapterOptions extends TransportLimits {}

export interface RemoteBackendAdapterOptions extends TransportLimits {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs?: number;
  /** Only permits plain HTTP to loopback addresses in tests/local development. */
  readonly allowInsecureLocalhost?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface HttpHostTransportOptions extends TransportLimits {
  readonly backend: BackendPort;
  readonly serviceToken: string;
  readonly allowedGameIds: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly tokenExpiresAt: number | Date;
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => number;
}

/** Player credentials never authorize service lifecycle or system operations. */
export const PLAYER_BACKEND_OPERATIONS = [
  'submitCommand',
  'queryOptions',
  'getPlayerView',
  'getEvents',
  'resume',
  'getSessionSummary',
  'getStatus',
] as const;
export type PlayerBackendOperation = (typeof PLAYER_BACKEND_OPERATIONS)[number];

export interface HttpPlayerTransportOptions extends TransportLimits {
  readonly backend: BackendPort;
  /** Verify the short-lived credential against its route and current authorization. */
  readonly authorize: (
    token: string,
    operation: PlayerBackendOperation,
    request: Readonly<Record<string, unknown>>,
  ) => Promise<AccessContext>;
  /** Exact browser origins. Omit for a same-origin edge proxy. */
  readonly allowedOrigins?: readonly string[];
  readonly host?: string;
  readonly port?: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = DEFAULT_JSON_LIMITS.viewBytes;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_SERVICE_TOKEN_LENGTH = 32;
const ERROR_CODES = [
  'INVALID_REQUEST',
  'SCHEMA_VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_READY',
  'SESSION_SUSPENDED',
  'SESSION_CLOSED',
  'STALE_REVISION',
  'IDEMPOTENCY_CONFLICT',
  'OWNERSHIP_LOST',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return (
    actual.length === expected.size && actual.every((key) => expected.has(key))
  );
}

function requireIdentifier(
  value: unknown,
  key: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw contractError('INVALID_REQUEST', `transport.${key}.invalid`);
  }
}

function requireNonNegativeInteger(
  value: unknown,
  key: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw contractError('INVALID_REQUEST', `transport.${key}.invalid`);
  }
}

function assertEnvelope(
  value: unknown,
): asserts value is ProtocolEnvelope<unknown> {
  if (!isRecord(value) || !exactKeys(value, ['protocolVersion', 'request'])) {
    throw contractError('INVALID_REQUEST', 'transport.envelope.invalid');
  }
  if (value.protocolVersion !== 1) {
    throw contractError('INVALID_REQUEST', 'transport.protocol.unsupported');
  }
}

function assertResponseEnvelope(
  value: unknown,
): asserts value is ProtocolResponseEnvelope<unknown> {
  if (!isRecord(value) || !exactKeys(value, ['protocolVersion', 'response'])) {
    throw new BackendTransportError('PROTOCOL');
  }
  if (value.protocolVersion !== 1) throw new BackendTransportError('PROTOCOL');
}

function validateActivateRequest(
  value: unknown,
): asserts value is ActivateSessionRequest {
  assertSessionRequestBase(value);
  requireIdentifier(value.startId, 'startId');
}

function assertSessionRequestBase(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value))
    throw contractError('INVALID_REQUEST', 'transport.request.invalid');
  assertProtocolRequest(value);
  assertAccessContext(value.accessContext);
  assertSessionRoute(value.route);
}

function validateStatusRequest(
  value: unknown,
): asserts value is GetStatusRequest {
  assertSessionRequestBase(value);
  if (value.startId !== undefined) requireIdentifier(value.startId, 'startId');
  if (value.commandId !== undefined)
    requireIdentifier(value.commandId, 'commandId');
}

function validateViewRequest(
  value: unknown,
): asserts value is GetPlayerViewRequest {
  assertSessionRequestBase(value);
}

function validateEventsRequest(
  value: unknown,
): asserts value is GetEventsRequest {
  assertGetEventsRequest(value);
}

function validateResumeRequest(value: unknown): asserts value is ResumeRequest {
  assertSessionRequestBase(value);
  if (value.viewerEpoch !== undefined)
    requireIdentifier(value.viewerEpoch, 'viewerEpoch');
  if (value.streamCursor !== undefined)
    requireIdentifier(value.streamCursor, 'streamCursor');
}

function validateSummaryRequest(
  value: unknown,
): asserts value is GetSessionSummaryRequest {
  assertSessionRequestBase(value);
}

function validateQueryRequest(
  value: unknown,
): asserts value is QueryOptionsRequest {
  assertSessionRequestBase(value);
  requireNonNegativeInteger(value.revision, 'revision');
  assertQueryPayload(value.query);
}

function validateRequest(operation: BackendOperation, value: unknown): void {
  switch (operation) {
    case 'describe':
    case 'ready':
      assertProtocolRequest(value);
      return;
    case 'createSession':
      assertCreateSessionRequest(value as CreateSessionRequest);
      return;
    case 'activateSession':
      validateActivateRequest(value);
      return;
    case 'getStatus':
      validateStatusRequest(value);
      return;
    case 'submitCommand':
      assertSubmitCommandRequest(value as SubmitCommandRequest);
      return;
    case 'submitSystemCommand':
      assertSubmitSystemCommandRequest(value as SubmitSystemCommandRequest);
      return;
    case 'getDeveloperConsole':
      assertDeveloperConsoleCatalogRequest(
        value as DeveloperConsoleCatalogRequest,
      );
      return;
    case 'submitDeveloperCommand':
      assertSubmitDeveloperCommandRequest(
        value as SubmitDeveloperCommandRequest,
      );
      return;
    case 'queryOptions':
      validateQueryRequest(value);
      return;
    case 'getPlayerView':
      validateViewRequest(value);
      return;
    case 'getEvents':
      validateEventsRequest(value);
      return;
    case 'resume':
      validateResumeRequest(value);
      return;
    case 'getSessionSummary':
      validateSummaryRequest(value);
      return;
    case 'controlSession':
      assertControlSessionRequest(value);
      return;
    case 'retireSessionHistory':
      assertSessionRequestBase(value);
      requireNonNegativeInteger(value.expectedRevision, 'expectedRevision');
      return;
    case DAILY_CHALLENGE_BACKEND_OPERATION:
      assertDailyChallengeServiceRequest(value);
      return;
    case GAME_STATISTICS_BACKEND_OPERATION:
      assertGameStatisticsServiceRequest(value);
      return;
  }
}

function requestEnvelope<T>(operation: BackendOperation, value: unknown): T {
  validateRequest(operation, value);
  return copy(value as T);
}

function validateResponse(value: unknown, maxBytes: number): JsonValue {
  if (!isJsonValue(value)) throw new BackendTransportError('PROTOCOL');
  assertJsonPayloadSize(value, maxBytes, 'response');
  return copy(value);
}

function errorFromThrown(error: unknown): never {
  if (isPlatformError(error)) throw error;
  throw new PlatformError(toErrorEnvelope(error));
}

function isErrorCode(value: unknown): value is (typeof ERROR_CODES)[number] {
  return (
    typeof value === 'string' &&
    (ERROR_CODES as readonly string[]).includes(value)
  );
}

function assertErrorEnvelope(value: unknown): asserts value is ErrorEnvelope {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !['code', 'messageKey', 'retryable', 'requestId', 'details'].includes(
          key,
        ),
    )
  ) {
    throw new BackendTransportError('PROTOCOL');
  }
  if (
    !isErrorCode(value.code) ||
    typeof value.messageKey !== 'string' ||
    value.messageKey.length === 0 ||
    typeof value.retryable !== 'boolean'
  ) {
    throw new BackendTransportError('PROTOCOL');
  }
  if (value.requestId !== undefined && typeof value.requestId !== 'string') {
    throw new BackendTransportError('PROTOCOL');
  }
  if (value.details !== undefined && !isJsonValue(value.details)) {
    throw new BackendTransportError('PROTOCOL');
  }
}

function platformErrorFromEnvelope(value: unknown): PlatformError {
  assertErrorEnvelope(value);
  return new PlatformError(value);
}

function dispatch(
  backend: BackendPort,
  operation: BackendOperation,
  request: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'describe':
      return backend.describe(request as DescribeRequest);
    case 'ready':
      return backend.ready(request as ReadyRequest);
    case 'createSession':
      return backend.createSession(request as CreateSessionRequest);
    case 'activateSession':
      return backend.activateSession(request as ActivateSessionRequest);
    case 'getStatus':
      return backend.getStatus(request as GetStatusRequest);
    case 'submitCommand':
      return backend.submitCommand(request as SubmitCommandRequest);
    case 'submitSystemCommand':
      return backend.submitSystemCommand(request as SubmitSystemCommandRequest);
    case 'getDeveloperConsole':
      if (!backend.getDeveloperConsole)
        throw contractError('NOT_READY', 'host.developerConsole.unavailable');
      return backend.getDeveloperConsole(
        request as DeveloperConsoleCatalogRequest,
      );
    case 'submitDeveloperCommand':
      if (!backend.submitDeveloperCommand)
        throw contractError('NOT_READY', 'host.developerConsole.unavailable');
      return backend.submitDeveloperCommand(
        request as SubmitDeveloperCommandRequest,
      );
    case 'queryOptions':
      return backend.queryOptions(request as QueryOptionsRequest);
    case 'getPlayerView':
      return backend.getPlayerView(request as GetPlayerViewRequest);
    case 'getEvents':
      return backend.getEvents(request as GetEventsRequest);
    case 'resume':
      return backend.resume(request as ResumeRequest);
    case 'getSessionSummary':
      return backend.getSessionSummary(request as GetSessionSummaryRequest);
    case 'controlSession':
      return backend.controlSession(request as ControlSessionRequest);
    case 'retireSessionHistory':
      if (!backend.retireSessionHistory)
        throw contractError('NOT_READY', 'host.history.retirement_unsupported');
      return backend.retireSessionHistory(
        request as RetireSessionHistoryRequest,
      );
    case DAILY_CHALLENGE_BACKEND_OPERATION:
      if (!backend.dailyChallenge)
        throw contractError('NOT_READY', 'host.daily.unavailable');
      return backend.dailyChallenge(request as DailyChallengeServiceRequest);
    case GAME_STATISTICS_BACKEND_OPERATION:
      if (!backend.statistics)
        throw contractError('NOT_READY', 'host.statistics.unavailable');
      return backend.statistics(request as GameStatisticsServiceRequest);
  }
  throw contractError('NOT_FOUND', 'transport.route.notFound');
}

async function invoke(
  backend: BackendPort,
  operation: BackendOperation,
  input: unknown,
  limits: Required<TransportLimits>,
): Promise<JsonValue> {
  const request = requestEnvelope(operation, input);
  assertJsonPayloadSize(
    { protocolVersion: 1, request },
    limits.maxRequestBytes,
    'request',
  );
  let result: unknown;
  try {
    result = await dispatch(backend, operation, request);
  } catch (error) {
    errorFromThrown(error);
  }
  return validateResponse(result, limits.maxResponseBytes);
}

function normalizeLimits(options: TransportLimits): Required<TransportLimits> {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxRequestBytes) ||
    maxRequestBytes < 1 ||
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1
  ) {
    throw contractError('INVALID_REQUEST', 'transport.limits.invalid');
  }
  return { maxRequestBytes, maxResponseBytes };
}

abstract class BackendAdapterBase implements BackendPort {
  protected abstract call<T>(
    operation: BackendOperation,
    input: unknown,
  ): Promise<T>;

  public describe(request: DescribeRequest): Promise<BackendDescription> {
    return this.call<BackendDescription>('describe', request);
  }

  public ready(request: ReadyRequest): Promise<ReadyResponse> {
    return this.call<ReadyResponse>('ready', request);
  }

  public createSession(
    request: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    return this.call<CreateSessionResponse>('createSession', request);
  }

  public activateSession(
    request: ActivateSessionRequest,
  ): Promise<ActivateSessionResponse> {
    return this.call<ActivateSessionResponse>('activateSession', request);
  }

  public getStatus(request: GetStatusRequest): Promise<OperationStatus> {
    return this.call<OperationStatus>('getStatus', request);
  }

  public submitCommand(
    request: SubmitCommandRequest,
  ): Promise<SubmitCommandResponse> {
    return this.call<SubmitCommandResponse>('submitCommand', request);
  }

  public submitSystemCommand(
    request: SubmitSystemCommandRequest,
  ): Promise<SubmitSystemCommandResponse> {
    return this.call<SubmitSystemCommandResponse>(
      'submitSystemCommand',
      request,
    );
  }

  public getDeveloperConsole(
    request: DeveloperConsoleCatalogRequest,
  ): Promise<DeveloperConsoleCatalogResponse> {
    return this.call<DeveloperConsoleCatalogResponse>(
      'getDeveloperConsole',
      request,
    );
  }

  public submitDeveloperCommand(
    request: SubmitDeveloperCommandRequest,
  ): Promise<SubmitDeveloperCommandResponse> {
    return this.call<SubmitDeveloperCommandResponse>(
      'submitDeveloperCommand',
      request,
    );
  }

  public queryOptions(
    request: QueryOptionsRequest,
  ): Promise<QueryOptionsResponse> {
    return this.call<QueryOptionsResponse>('queryOptions', request);
  }

  public getPlayerView(
    request: GetPlayerViewRequest,
  ): Promise<PlayerViewEnvelope> {
    return this.call<PlayerViewEnvelope>('getPlayerView', request);
  }

  public getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
    return this.call<GetEventsResponse>('getEvents', request);
  }

  public resume(request: ResumeRequest): Promise<ResumeResult> {
    return this.call<ResumeResult>('resume', request);
  }

  public getSessionSummary(
    request: GetSessionSummaryRequest,
  ): Promise<SessionSummary> {
    return this.call<SessionSummary>('getSessionSummary', request);
  }

  public controlSession(
    request: ControlSessionRequest,
  ): Promise<ControlSessionResponse> {
    return this.call<ControlSessionResponse>('controlSession', request);
  }

  public retireSessionHistory(
    request: RetireSessionHistoryRequest,
  ): Promise<SessionSummary> {
    return this.call<SessionSummary>('retireSessionHistory', request);
  }

  public dailyChallenge(
    request: DailyChallengeServiceRequest,
  ): Promise<DailyChallengeServiceResponse> {
    return this.call<DailyChallengeServiceResponse>(
      DAILY_CHALLENGE_BACKEND_OPERATION,
      request,
    );
  }

  public statistics(
    request: GameStatisticsServiceRequest,
  ): Promise<GameStatisticsServiceResponse> {
    return this.call<GameStatisticsServiceResponse>(
      GAME_STATISTICS_BACKEND_OPERATION,
      request,
    );
  }
}

export class EmbeddedBackendAdapter extends BackendAdapterBase {
  private readonly limits: Required<TransportLimits>;

  public constructor(
    private readonly backend: BackendPort,
    options: EmbeddedBackendAdapterOptions = {},
  ) {
    super();
    this.limits = normalizeLimits(options);
  }

  protected async call<T>(
    operation: BackendOperation,
    input: unknown,
  ): Promise<T> {
    return (await invoke(
      this.backend,
      operation,
      input,
      this.limits,
    )) as unknown as T;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function normalizeBaseUrl(options: RemoteBackendAdapterOptions): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw contractError('INVALID_REQUEST', 'transport.remote.url.invalid');
  }
  if (
    url.protocol !== 'https:' &&
    !(
      options.allowInsecureLocalhost &&
      url.protocol === 'http:' &&
      isLoopbackHostname(url.hostname)
    )
  ) {
    throw contractError('INVALID_REQUEST', 'transport.remote.https.required');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function validateServiceToken(token: string): void {
  if (typeof token !== 'string' || token.length < MIN_SERVICE_TOKEN_LENGTH) {
    throw contractError('INVALID_REQUEST', 'transport.serviceToken.invalid');
  }
}

function parseTokenExpiry(value: number | Date): number {
  const expiry = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(expiry) || expiry <= 0) {
    throw contractError('INVALID_REQUEST', 'transport.tokenExpiry.invalid');
  }
  return expiry;
}

function compareToken(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function requestHeaders(
  headers: IncomingMessage['headers'],
): string | undefined {
  const value = headers.authorization;
  if (Array.isArray(value)) return undefined;
  const match = /^Bearer\s+([^\s]+)$/i.exec(value ?? '');
  return match?.[1];
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'RATE_LIMITED':
      return 429;
    case 'NOT_READY':
      return 503;
    case 'INVALID_REQUEST':
      return 400;
    case 'SCHEMA_VALIDATION_FAILED':
      return 422;
    case 'INTERNAL':
      return 500;
    default:
      return 409;
  }
}

function errorEnvelope(error: unknown): ReturnType<typeof toErrorEnvelope> {
  return isPlatformError(error) ? error.envelope : toErrorEnvelope(error);
}

function jsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw contractError('INTERNAL', 'transport.serialization.failed');
  }
}

function responseEnvelope(
  value: JsonValue,
  limits: Required<TransportLimits>,
): Uint8Array {
  const body = { protocolVersion: 1, response: value } as const;
  const bytes = jsonBytes(body);
  if (bytes.byteLength > limits.maxResponseBytes) {
    throw contractError(
      'PAYLOAD_TOO_LARGE',
      'transport.response.tooLarge',
      false,
      {
        maxBytes: limits.maxResponseBytes,
        byteLength: bytes.byteLength,
      },
    );
  }
  return bytes;
}

function errorResponse(
  error: unknown,
  limits: Required<TransportLimits>,
): { status: number; bytes: Uint8Array } {
  const envelope = errorEnvelope(error);
  const body = { protocolVersion: 1, error: envelope };
  let bytes = jsonBytes(body);
  if (bytes.byteLength > limits.maxResponseBytes) {
    bytes = jsonBytes({
      protocolVersion: 1,
      error: {
        code: 'INTERNAL',
        messageKey: 'transport.response.tooLarge',
        retryable: false,
      },
    });
  }
  return { status: httpStatusForCode(envelope.code), bytes };
}

function sendJson(
  response: ServerResponse,
  status: number,
  bytes: Uint8Array,
): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
  });
  response.end(bytes);
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)
  ) {
    throw contractError(
      'PAYLOAD_TOO_LARGE',
      'transport.request.tooLarge',
      false,
      { maxBytes },
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise<string>((resolve, reject) => {
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        reject(
          contractError(
            'PAYLOAD_TOO_LARGE',
            'transport.request.tooLarge',
            false,
            { maxBytes },
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('aborted', () => reject(new BackendTransportError('ABORTED')));
    request.on('error', () => reject(new BackendTransportError('ABORTED')));
  });
}

function operationFromPath(pathname: string): BackendOperation | undefined {
  const match = /^\/v1\/([^/]+)$/u.exec(pathname);
  if (!match) return undefined;
  return (HTTP_HOST_OPERATIONS as readonly string[]).includes(match[1])
    ? (match[1] as BackendOperation)
    : undefined;
}

function filterDescription(
  operation: BackendOperation,
  value: JsonValue,
  allowedGameIds: ReadonlySet<string>,
): JsonValue {
  if ((operation !== 'describe' && operation !== 'ready') || !isRecord(value))
    return value;
  if (operation === 'describe') {
    if (!Array.isArray(value.gameIds)) return value;
    return {
      ...value,
      gameIds: value.gameIds.filter(
        (gameId): gameId is string =>
          typeof gameId === 'string' && allowedGameIds.has(gameId),
      ),
    };
  }
  if (!isRecord(value.description) || !Array.isArray(value.description.gameIds))
    return value;
  return {
    ...value,
    description: {
      ...value.description,
      gameIds: value.description.gameIds.filter(
        (gameId): gameId is string =>
          typeof gameId === 'string' && allowedGameIds.has(gameId),
      ),
    },
  };
}

function routeForRequest(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value.route) ? value.route : undefined;
}

function accessForRequest(value: unknown): AccessContext | undefined {
  return isRecord(value) && isRecord(value.accessContext)
    ? (value.accessContext as unknown as AccessContext)
    : undefined;
}

function authorizeServiceRequest(
  operation: BackendOperation,
  value: unknown,
  allowedGameIds: ReadonlySet<string>,
  allowedScopes: ReadonlySet<string>,
): void {
  const route = routeForRequest(value);
  if (operation === DAILY_CHALLENGE_BACKEND_OPERATION && !route)
    throw contractError('INVALID_REQUEST', 'transport.daily.route_required');
  if (operation === GAME_STATISTICS_BACKEND_OPERATION && !route)
    throw contractError(
      'INVALID_REQUEST',
      'transport.statistics.route_required',
    );
  if (
    route &&
    typeof route.gameId === 'string' &&
    !allowedGameIds.has(route.gameId)
  ) {
    throw contractError('FORBIDDEN', 'transport.game.denied');
  }
  const accessContext = accessForRequest(value);
  if (
    accessContext &&
    accessContext.scopes.some(
      (scope) => !allowedScopes.has(scope) && !allowedScopes.has('*'),
    )
  ) {
    throw contractError('FORBIDDEN', 'transport.scope.denied');
  }
  if (
    operation === 'submitSystemCommand' &&
    accessContext &&
    !accessContext.scopes.includes('session:system')
  ) {
    throw contractError('FORBIDDEN', 'transport.system.scope.denied');
  }
  if (
    (operation === 'getDeveloperConsole' ||
      operation === 'submitDeveloperCommand') &&
    (!accessContext ||
      !accessContext.scopes.includes('session:admin') ||
      !accessContext.scopes.includes('session:developer'))
  ) {
    throw contractError('FORBIDDEN', 'transport.developerConsole.scope.denied');
  }
  if (
    operation === GAME_STATISTICS_BACKEND_OPERATION &&
    accessContext &&
    !accessContext.scopes.includes('statistics:read')
  )
    throw contractError('FORBIDDEN', 'transport.statistics.scope.denied');
}

function normalizeHttpOptions(options: HttpHostTransportOptions): {
  readonly limits: Required<TransportLimits>;
  readonly serviceToken: string;
  readonly allowedGameIds: ReadonlySet<string>;
  readonly allowedScopes: ReadonlySet<string>;
  readonly tokenExpiresAt: number;
  readonly now: () => number;
  readonly host: string;
  readonly port: number;
} {
  validateServiceToken(options.serviceToken);
  if (
    !Array.isArray(options.allowedGameIds) ||
    options.allowedGameIds.length === 0 ||
    options.allowedGameIds.some(
      (id) => typeof id !== 'string' || id.length === 0,
    )
  ) {
    throw contractError('INVALID_REQUEST', 'transport.allowedGames.invalid');
  }
  if (
    !Array.isArray(options.allowedScopes) ||
    options.allowedScopes.some(
      (scope) => typeof scope !== 'string' || scope.length === 0,
    )
  ) {
    throw contractError('INVALID_REQUEST', 'transport.allowedScopes.invalid');
  }
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw contractError('INVALID_REQUEST', 'transport.port.invalid');
  }
  return {
    limits: normalizeLimits(options),
    serviceToken: options.serviceToken,
    allowedGameIds: new Set(options.allowedGameIds),
    allowedScopes: new Set(options.allowedScopes),
    tokenExpiresAt: parseTokenExpiry(options.tokenExpiresAt),
    now: options.now ?? Date.now,
    host: options.host ?? '127.0.0.1',
    port,
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ReturnType<typeof normalizeHttpOptions> & {
    readonly backend: BackendPort;
  },
): Promise<void> {
  try {
    const operation = operationFromPath(
      new URL(request.url ?? '/', 'http://localhost').pathname,
    );
    if (request.method !== 'POST' || operation === undefined) {
      throw contractError('NOT_FOUND', 'transport.route.notFound');
    }
    const receivedToken = requestHeaders(request.headers);
    if (!receivedToken || !compareToken(options.serviceToken, receivedToken)) {
      throw contractError('UNAUTHENTICATED', 'transport.serviceToken.invalid');
    }
    if (options.now() >= options.tokenExpiresAt) {
      throw contractError('UNAUTHENTICATED', 'transport.serviceToken.expired');
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;|\s*$)/iu.test(contentType)
    ) {
      throw contractError('INVALID_REQUEST', 'transport.contentType.invalid');
    }
    const body = await readRequestBody(request, options.limits.maxRequestBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw contractError('INVALID_REQUEST', 'transport.json.invalid');
    }
    assertEnvelope(parsed);
    const validated = requestEnvelope(operation, parsed.request);
    authorizeServiceRequest(
      operation,
      validated,
      options.allowedGameIds,
      options.allowedScopes,
    );
    let result = await invoke(
      options.backend,
      operation,
      validated,
      options.limits,
    );
    result = filterDescription(operation, result, options.allowedGameIds);
    sendJson(response, 200, responseEnvelope(result, options.limits));
  } catch (error) {
    if (
      (request.aborted || (!request.complete && request.destroyed)) &&
      !response.headersSent
    )
      return;
    const failure = errorResponse(error, options.limits);
    sendJson(response, failure.status, failure.bytes);
  }
}

export class HttpHostTransport {
  public readonly server: Server;
  private readonly options: ReturnType<typeof normalizeHttpOptions> & {
    readonly backend: BackendPort;
  };

  public constructor(options: HttpHostTransportOptions) {
    this.options = {
      ...normalizeHttpOptions(options),
      backend: options.backend,
    };
    this.server = createServer((request, response) => {
      void handleHttpRequest(request, response, this.options);
    });
  }

  public listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(contractError('INTERNAL', 'transport.server.address.invalid'));
          return;
        }
        resolve(address);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.options.port, this.options.host);
    });
  }

  public close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** A separate browser endpoint; no service token or caller-supplied identity is accepted. */
export class HttpPlayerTransport {
  readonly server: Server;
  private readonly limits: Required<TransportLimits>;
  private readonly origins: ReadonlySet<string>;

  constructor(private readonly options: HttpPlayerTransportOptions) {
    this.limits = normalizeLimits(options);
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535)
      throw contractError('INVALID_REQUEST', 'transport.port.invalid');
    this.origins = new Set(options.allowedOrigins ?? []);
    for (const origin of this.origins) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw contractError('INVALID_REQUEST', 'transport.origin.invalid');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        throw contractError('INVALID_REQUEST', 'transport.origin.invalid');
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = DEFAULT_TIMEOUT_MS;
    this.server.headersTimeout = 10_000;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('vary', 'Origin');
    try {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        let sameOrigin = false;
        try {
          const parsed = new URL(origin);
          sameOrigin =
            ['http:', 'https:'].includes(parsed.protocol) &&
            parsed.origin === origin &&
            parsed.host === request.headers.host;
        } catch {
          // Opaque and invalid origins never obtain player credentials or views.
        }
        if (!sameOrigin && !this.origins.has(origin))
          throw contractError('FORBIDDEN', 'transport.origin.denied');
        response.setHeader('access-control-allow-origin', origin);
      }
      const operation = operationFromPath(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      );
      if (
        operation === undefined ||
        !(PLAYER_BACKEND_OPERATIONS as readonly string[]).includes(operation)
      )
        throw contractError('FORBIDDEN', 'transport.player.operation_denied');
      if (request.method === 'OPTIONS' && origin !== undefined) {
        response.setHeader('access-control-allow-methods', 'POST');
        response.setHeader(
          'access-control-allow-headers',
          'authorization, content-type',
        );
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST')
        throw contractError('NOT_FOUND', 'transport.route.notFound');
      const token = requestHeaders(request.headers);
      if (!token)
        throw contractError(
          'UNAUTHENTICATED',
          'transport.player.credential_required',
        );
      if (
        typeof request.headers['content-type'] !== 'string' ||
        !/^application\/json(?:\s*;|\s*$)/iu.test(
          request.headers['content-type'],
        )
      )
        throw contractError('INVALID_REQUEST', 'transport.contentType.invalid');
      const body = await readRequestBody(request, this.limits.maxRequestBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw contractError('INVALID_REQUEST', 'transport.json.invalid');
      }
      assertEnvelope(parsed);
      if (
        !isRecord(parsed.request) ||
        Object.hasOwn(parsed.request, 'accessContext')
      )
        throw contractError('FORBIDDEN', 'transport.player.identity_forbidden');
      assertSessionRoute(parsed.request.route);
      if (operation === 'getStatus') {
        requireIdentifier(parsed.request.commandId, 'commandId');
        if (parsed.request.startId !== undefined)
          throw contractError('FORBIDDEN', 'transport.player.operation_denied');
      }
      const accessContext = await this.options.authorize(
        token,
        operation as PlayerBackendOperation,
        copy(parsed.request),
      );
      assertAccessContext(accessContext);
      if (
        accessContext.scopes.some(
          (scope) =>
            scope === '*' ||
            (scope.startsWith('session:') &&
              !['session:view', 'session:command', 'session:spectate'].includes(
                scope,
              )),
        )
      )
        throw contractError('FORBIDDEN', 'transport.player.scope_denied');
      const trusted = requestEnvelope(operation, {
        ...parsed.request,
        accessContext,
      });
      const result = await invoke(
        this.options.backend,
        operation,
        trusted,
        this.limits,
      );
      sendJson(response, 200, responseEnvelope(result, this.limits));
    } catch (error) {
      if (
        (request.aborted || (!request.complete && request.destroyed)) &&
        !response.headersSent
      )
        return;
      const failure = errorResponse(error, this.limits);
      sendJson(response, failure.status, failure.bytes);
    }
  }

  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(contractError('INTERNAL', 'transport.server.address.invalid'));
          return;
        }
        resolve(address);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(
        this.options.port ?? 0,
        this.options.host ?? '127.0.0.1',
      );
    });
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export class RemoteBackendAdapter extends BackendAdapterBase {
  private readonly limits: Required<TransportLimits>;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: RemoteBackendAdapterOptions) {
    super();
    validateServiceToken(options.serviceToken);
    this.baseUrl = normalizeBaseUrl(options);
    this.limits = normalizeLimits(options);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw contractError('INVALID_REQUEST', 'transport.timeout.invalid');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  protected async call<T>(
    operation: BackendOperation,
    input: unknown,
  ): Promise<T> {
    const request = requestEnvelope(operation, input);
    assertJsonPayloadSize(
      { protocolVersion: 1, request },
      this.limits.maxRequestBytes,
      'request',
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = new URL(this.baseUrl.toString());
      url.pathname = `${this.baseUrl.pathname.replace(/\/$/u, '')}/v1/${operation}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.serviceToken}`,
          },
          body: JSON.stringify({ protocolVersion: 1, request }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted)
          throw new BackendTransportError('TIMEOUT');
        if (error instanceof Error && error.name === 'AbortError')
          throw new BackendTransportError('ABORTED');
        throw new BackendTransportError('NETWORK');
      }
      let body: string;
      try {
        body = await readResponseBody(response, this.limits.maxResponseBytes);
      } catch (error) {
        if (controller.signal.aborted)
          throw new BackendTransportError('TIMEOUT');
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new BackendTransportError('PROTOCOL');
      }
      if (!response.ok) {
        if (
          !isRecord(parsed) ||
          !exactKeys(parsed, ['protocolVersion', 'error']) ||
          parsed.protocolVersion !== 1
        ) {
          throw new BackendTransportError('PROTOCOL');
        }
        throw platformErrorFromEnvelope(parsed.error);
      }
      assertResponseEnvelope(parsed);
      return validateResponse(
        parsed.response,
        this.limits.maxResponseBytes,
      ) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)
  ) {
    throw new BackendTransportError('RESPONSE_TOO_LARGE');
  }
  if (!response.body) {
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes)
        throw new BackendTransportError('RESPONSE_TOO_LARGE');
      return text;
    } catch (error) {
      if (error instanceof BackendTransportError) throw error;
      throw new BackendTransportError('NETWORK');
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already over the limit; preserve that stable error.
        }
        throw new BackendTransportError('RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof BackendTransportError) throw error;
    throw new BackendTransportError('NETWORK');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
