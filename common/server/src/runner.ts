import type { AddressInfo } from 'node:net';
import type { AuthorizationVersionStore } from '@board-game/contracts';
import {
  type AccessContext,
  assertDailyChallengeServiceRequest,
  assertDailyChallengeServiceResponse,
  assertGameResult,
  assertGameServiceDescription,
  assertGameStatisticsPayload,
  assertGameStatisticsQuery,
  assertGameStatisticsServiceRequest,
  assertGameStatisticsServiceResponse,
  assertJsonPayloadSize,
  assertMatchesSchema,
  assertSessionRoute,
  type BackendPort,
  canonicalStableStringify,
  contractError,
  type DailyChallengeServiceRequest,
  type DailyChallengeServiceResponse,
  DEFAULT_JSON_LIMITS,
  type GameServiceDescription,
  type GameStatisticsServiceRequest,
  type GameStatisticsServiceResponse,
  isJsonValue,
  isPlatformError,
  type JsonValue,
  type QueryOptionsRequest,
  type QueryOptionsResponse,
  type SubmitCommandRequest,
  type SubmitCommandResponse,
} from '@board-game/contracts';
import {
  type ConsumerRunReport,
  type DispatchReport,
  type FactDeliveryAck,
  InboxConsumerRunner,
  type InboxEnvelope,
  type InboxStore,
  OutboxFactDispatcher,
  type TrustedFactIngestorLike,
} from '@board-game/core';
import type { HttpHostTransportOptions } from '@board-game/host';
import {
  EmbeddedBackendAdapter,
  GameHost,
  type GameHostOptions,
  GameRegistry,
  HttpHostTransport,
  HttpPlayerTransport,
  type PlayerBackendOperation,
  type ResolveSystemAccess,
  type ResourceReconciliationResult,
  type SystemTickResult,
} from '@board-game/host';
import type { StorageDriver } from '@board-game/storage';
import {
  AuthorizationVersionStoreError,
  HttpAuthorizationVersionServer,
  type HttpAuthorizationVersionServerOptions,
  PlayerCredentialError,
  type PlayerCredentialPublicKey,
  verifyPlayerCredential,
} from './player-credentials.js';
import type {
  GameCommandServiceDescriptor,
  GameDailyChallengeService,
  GameFactConsumer,
  GameRecoveryHook,
  GameReplayQueries,
  GameServerDefinition,
  GameServerManifest,
  GameStatisticsService,
} from './types.js';

/** HTTP options owned by the game process; runner fills backend and game scope. */
export type GameServerTransportOptions = Omit<
  HttpHostTransportOptions,
  'backend' | 'allowedGameIds'
>;

/** Browser player transport options; runner supplies backend and verifier. */
export type GamePlayerTransportOptions = Omit<
  import('@board-game/host').HttpPlayerTransportOptions,
  'backend' | 'authorize'
> & {
  readonly publicKey: PlayerCredentialPublicKey;
  readonly platformId: string;
  readonly audience: string;
  readonly authorizationStore: AuthorizationVersionStore;
  /** Explicitly approved game scopes accepted in player credentials. */
  readonly approvedGameScopes?: readonly string[];
};

/** Internal service-only authorization ingress; its token never reaches browsers. */
export type GameAuthorizationTransportOptions = Omit<
  HttpAuthorizationVersionServerOptions,
  'store' | 'authorizeRoute'
>;

export type GameServerMode = 'development' | 'production';

/** Stable command wrapper used by remote platform command services. */
export const GAME_SERVICE_COMMAND_TYPE = '@board-game/service-command' as const;

export interface GameServerRunnerOptions<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends GameServerManifest,
  PlatformContext,
> {
  readonly definition: GameServerDefinition<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  >;
  /** Production is the default; development explicitly permits memory stores. */
  readonly mode?: GameServerMode;
  readonly storage: StorageDriver;
  readonly description: GameServiceDescription;
  readonly authorize: GameHostOptions['authorize'];
  readonly systemAccess: ResolveSystemAccess;
  /** A durable platform receiver for Host outbox facts. */
  readonly factReceiver?: TrustedFactIngestorLike;
  /** Required when the game declares local fact consumers. */
  readonly inbox?: InboxStore;
  readonly transport?: GameServerTransportOptions;
  readonly playerTransport?: GamePlayerTransportOptions;
  readonly authorizationTransport?: GameAuthorizationTransportOptions;
  readonly now?: () => number;
}

export interface GameServerRecoveryHookResult {
  readonly key: string;
  readonly failed: boolean;
}

export interface GameServerRecoveryReport {
  readonly timers: readonly SystemTickResult[];
  readonly resources: readonly ResourceReconciliationResult[];
  readonly facts: readonly ConsumerRunReport[];
  readonly outbox?: DispatchReport;
  readonly recovery: readonly GameServerRecoveryHookResult[];
}

export interface GameServerRunner<Command extends JsonValue = JsonValue> {
  readonly mode: GameServerMode;
  readonly description: GameServiceDescription;
  readonly host: GameHost;
  readonly backend: BackendPort;
  readonly transport?: HttpHostTransport;
  readonly playerTransport?: HttpPlayerTransport;
  readonly authorizationTransport?: HttpAuthorizationVersionServer;
  readonly transportAddress?: AddressInfo;
  readonly playerTransportAddress?: AddressInfo;
  readonly authorizationTransportAddress?: AddressInfo;
  /** Immutable, game-owned service descriptors advertised by the description. */
  readonly commandServices: ReadonlyMap<
    string,
    GameCommandServiceDescriptor<Command>
  >;
  readonly replayQueries?: GameReplayQueries;
  start(): Promise<AddressInfo | undefined>;
  close(): Promise<void>;
  recoverOnce(): Promise<GameServerRecoveryReport>;
  recoverAutomationOnce(): Promise<readonly SystemTickResult[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}

const STORAGE_CONFLICT_RETRY_DELAYS_MS = [5, 15, 35, 75] as const;

function isRetryableStorageConflict(error: unknown): boolean {
  return (
    isPlatformError(error) &&
    error.envelope.code === 'CONFLICT' &&
    error.envelope.messageKey === 'host.storage.conflict' &&
    error.envelope.retryable
  );
}

/**
 * PostgreSQL serializable transactions may abort after waiting for a session
 * lock.  The Host has already mapped only that storage condition to this
 * stable, retryable envelope.  Retry the complete operation; never retry
 * stale revisions, authorization failures, or unknown transport outcomes.
 */
async function withStorageConflictRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      const delay = STORAGE_CONFLICT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableStorageConflict(error))
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function unsupported(messageKey: string): never {
  throw contractError('NOT_READY', messageKey);
}

function normalizeMode(value: unknown): GameServerMode {
  if (value === undefined || value === 'production' || value === 'development')
    return value ?? 'production';
  throw contractError('INVALID_REQUEST', 'server.runner.mode.invalid');
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? '127.0.0.1').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

function assertPlayerRoute(
  value: unknown,
  description: GameServiceDescription,
): asserts value is import('@board-game/contracts').SessionRoute {
  try {
    assertSessionRoute(value);
  } catch {
    throw contractError('FORBIDDEN', 'server.runner.player.route_invalid');
  }
  const route = value as import('@board-game/contracts').SessionRoute;
  if (
    route.gameId !== description.gameId ||
    route.releaseId !== description.releaseId ||
    route.backendBindingId !== description.backendBindingId ||
    route.storageBindingId !== description.storageBindingId ||
    route.ownershipEpoch !== description.ownershipEpoch ||
    !description.modes.some((mode) => mode.id === route.modeId)
  )
    throw contractError('FORBIDDEN', 'server.runner.player.route_denied');
}

function mapPlayerCredentialError(error: unknown): never {
  if (error instanceof AuthorizationVersionStoreError)
    throw contractError(
      'FORBIDDEN',
      'server.runner.player.authorization_denied',
    );
  if (!(error instanceof PlayerCredentialError)) throw error;
  if (error.code === 'CREDENTIAL_EXPIRED')
    throw contractError(
      'UNAUTHENTICATED',
      'server.runner.player.credential_expired',
    );
  if (error.code === 'CREDENTIAL_FUTURE')
    throw contractError(
      'UNAUTHENTICATED',
      'server.runner.player.credential_not_yet_valid',
    );
  if (
    error.code === 'ISSUER_MISMATCH' ||
    error.code === 'AUDIENCE_MISMATCH' ||
    error.code === 'SIGNATURE_INVALID' ||
    error.code === 'INVALID_KEY' ||
    error.code === 'INVALID_TOKEN'
  )
    throw contractError(
      'UNAUTHENTICATED',
      'server.runner.player.credential_invalid',
    );
  throw contractError('FORBIDDEN', 'server.runner.player.authorization_denied');
}

async function authorizePlayerRequest(
  token: string,
  operation: PlayerBackendOperation,
  request: Readonly<Record<string, unknown>>,
  options: {
    readonly description: GameServiceDescription;
    readonly publicKey: PlayerCredentialPublicKey;
    readonly platformId: string;
    readonly audience: string;
    readonly authorizationStore: AuthorizationVersionStore;
    readonly approvedGameScopes?: readonly string[];
    readonly now?: () => number;
  },
): Promise<AccessContext> {
  if (Object.hasOwn(request, 'accessContext'))
    throw contractError('FORBIDDEN', 'server.runner.player.identity_forbidden');
  const route = request.route;
  assertPlayerRoute(route, options.description);
  try {
    const accessContext = await verifyPlayerCredential({
      token,
      publicKey: options.publicKey,
      expectedPlatformId: options.platformId,
      expectedAudience: options.audience,
      expectedRoute: route,
      authorizationStore: options.authorizationStore,
      ...(options.approvedGameScopes
        ? { approvedGameScopes: options.approvedGameScopes }
        : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
    const requiredScope =
      operation === 'submitCommand' ? 'session:command' : 'session:view';
    if (!accessContext.scopes.includes(requiredScope))
      throw contractError('FORBIDDEN', 'server.runner.player.scope_denied');
    return accessContext;
  } catch (error) {
    mapPlayerCredentialError(error);
  }
}

function localFactAck(envelope: InboxEnvelope): FactDeliveryAck {
  return {
    envelopeKey: envelope.envelopeKey,
    producerId: envelope.producerId,
    eventId: envelope.eventId,
    digest: envelope.digest,
  };
}

/**
 * Accepts each outgoing fact in the game-owned Inbox before attempting the
 * platform delivery. A retry therefore reuses the same local envelope and
 * can safely repeat the remote idempotent ingest.
 */
function composeFactReceiver(
  inbox: InboxStore | undefined,
  remote: TrustedFactIngestorLike | undefined,
): TrustedFactIngestorLike | undefined {
  if (!inbox && !remote) return undefined;
  return {
    ingest: async (delivery) => {
      const local = inbox ? await inbox.accept(delivery.fact) : undefined;
      const external = remote ? await remote.ingest(delivery) : undefined;
      if (external) return external;
      if (!local)
        throw contractError('INTERNAL', 'server.runner.fact_receiver.empty');
      return localFactAck(local);
    },
  };
}

function assertIdentity<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends GameServerManifest,
  PlatformContext,
>(
  definition: GameServerDefinition<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  >,
  description: GameServiceDescription,
): void {
  if (
    definition.manifest.gameId !== description.gameId ||
    definition.manifest.releaseId !== description.releaseId ||
    definition.module.gameId !== description.gameId ||
    definition.module.releaseId !== description.releaseId
  )
    throw contractError('CONFLICT', 'server.runner.description.identity');
  if (!sameJson(definition.module.modes, description.modes))
    throw contractError('CONFLICT', 'server.runner.description.modes');
  if (!sameJson(definition.module.schemas.setup, description.setupSchema))
    throw contractError('CONFLICT', 'server.runner.description.setup_schema');
}

function assertCommands<Command extends JsonValue>(
  services: {
    readonly commands?: readonly GameCommandServiceDescriptor<Command>[];
  },
  description: GameServiceDescription,
): ReadonlyMap<string, GameCommandServiceDescriptor<Command>> {
  const local = services.commands ?? [];
  const advertised = description.commands ?? [];
  if (local.length !== advertised.length)
    throw contractError('CONFLICT', 'server.runner.description.commands');
  const byKey = new Map<string, GameCommandServiceDescriptor<Command>>();
  for (const descriptor of local) {
    if (byKey.has(descriptor.key))
      throw contractError('CONFLICT', 'server.runner.description.commands');
    byKey.set(descriptor.key, descriptor);
  }
  for (const descriptor of advertised) {
    const localDescriptor = byKey.get(descriptor.key);
    if (!localDescriptor || localDescriptor.operation !== descriptor.operation)
      throw contractError('CONFLICT', 'server.runner.description.commands');
  }
  return new Map(byKey);
}

function assertReplayQueries(
  services: {
    readonly replay?: {
      readonly presenter?: unknown;
      readonly queries?: GameReplayQueries;
      readonly settlement?: unknown;
    };
  },
  description: GameServiceDescription,
): GameReplayQueries | undefined {
  if (services.replay?.presenter !== undefined)
    unsupported('server.runner.replay.presenter_unsupported');
  if (services.replay?.settlement !== undefined)
    unsupported('server.runner.replay.settlement_unsupported');
  const queries = services.replay?.queries;
  if (!queries) {
    if (description.replay !== undefined)
      throw contractError('CONFLICT', 'server.runner.description.replay');
    return undefined;
  }
  if (!description.replay)
    throw contractError('CONFLICT', 'server.runner.description.replay');
  if (!sameJson(queries.manifest(200), description.replay.manifestQuery))
    throw contractError(
      'CONFLICT',
      'server.runner.description.replay_manifest',
    );
  const frameQuery = queries.frames(0, 1);
  if (
    frameQuery === null ||
    typeof frameQuery !== 'object' ||
    Array.isArray(frameQuery) ||
    (frameQuery as { readonly type?: unknown }).type !==
      description.replay.framesQueryType
  )
    throw contractError('CONFLICT', 'server.runner.description.replay_frames');
  return queries;
}

function assertDailyChallengeService(
  services: { readonly dailyChallenge?: GameDailyChallengeService },
  description: GameServiceDescription,
): GameDailyChallengeService | undefined {
  const service = services.dailyChallenge;
  if (!service) {
    if (description.dailyChallenge !== undefined)
      throw contractError(
        'CONFLICT',
        'server.runner.description.daily_challenge',
      );
    return undefined;
  }
  const advertised = description.dailyChallenge;
  if (!advertised)
    throw contractError(
      'CONFLICT',
      'server.runner.description.daily_challenge',
    );
  if (!sameJson(service.description, advertised))
    throw contractError(
      'CONFLICT',
      'server.runner.description.daily_challenge',
    );
  const mode = description.modes.find(
    (candidate) => candidate.id === advertised.modeId,
  );
  if (
    !mode ||
    advertised.playerCount < mode.minPlayers ||
    advertised.playerCount > mode.maxPlayers
  )
    throw contractError(
      'CONFLICT',
      'server.runner.description.daily_challenge',
    );
  return service;
}

function assertStatisticsService(
  services: { readonly statistics?: GameStatisticsService },
  description: GameServiceDescription,
): GameStatisticsService | undefined {
  const service = services.statistics;
  if (!service) {
    if (description.statistics !== undefined)
      throw contractError('CONFLICT', 'server.runner.description.statistics');
    return undefined;
  }
  const advertised = description.statistics;
  if (!advertised || !sameJson(service.description, advertised))
    throw contractError('CONFLICT', 'server.runner.description.statistics');
  return service;
}

function assertUnsupportedServices(services: {
  readonly platform?: unknown;
  readonly view?: unknown;
}): void {
  if (services.platform !== undefined)
    unsupported('server.runner.platform_unsupported');
  if (services.view !== undefined)
    unsupported('server.runner.view_unsupported');
}

class RunnerBackend<Command extends JsonValue> extends EmbeddedBackendAdapter {
  constructor(
    host: GameHost,
    private readonly serviceDescription: GameServiceDescription,
    private readonly commandServices: ReadonlyMap<
      string,
      GameCommandServiceDescriptor<Command>
    >,
    private readonly replayQueries?: GameReplayQueries,
    private readonly dailyChallengeService?: GameDailyChallengeService,
    private readonly statisticsService?: GameStatisticsService,
  ) {
    super(host);
  }

  override async describe(request: Parameters<BackendPort['describe']>[0]) {
    const description = await super.describe(request);
    return {
      ...description,
      features: [
        ...new Set([...description.features, 'runtime-description-v1']),
      ],
      service: copy(this.serviceDescription),
    };
  }

  override async ready(request: Parameters<BackendPort['ready']>[0]) {
    const response = await super.ready(request);
    return {
      ...response,
      description: await this.describe(request),
    };
  }

  override async submitCommand(
    request: SubmitCommandRequest,
  ): Promise<SubmitCommandResponse> {
    const serviceCommand = parseServiceCommand(request.command);
    if (!serviceCommand)
      return withStorageConflictRetry(() => super.submitCommand(request));
    const descriptor = this.commandServices.get(serviceCommand.key);
    const advertised = this.serviceDescription.commands?.find(
      (candidate) => candidate.key === serviceCommand.key,
    );
    if (!descriptor || !advertised)
      throw contractError(
        'NOT_FOUND',
        'server.runner.command_service.unavailable',
      );
    assertMatchesSchema(serviceCommand.input, advertised.inputSchema);
    const parsed = descriptor.parse(serviceCommand.input);
    const command = descriptor.toCommand(parsed);
    if (!isJsonValue(command))
      throw contractError(
        'INVALID_REQUEST',
        'server.runner.command_service.command',
      );
    return withStorageConflictRetry(() =>
      super.submitCommand({ ...request, command }),
    );
  }

  override async getPlayerView(
    request: Parameters<BackendPort['getPlayerView']>[0],
  ) {
    return withStorageConflictRetry(() => super.getPlayerView(request));
  }

  override async resume(request: Parameters<BackendPort['resume']>[0]) {
    return withStorageConflictRetry(() => super.resume(request));
  }

  override async getEvents(request: Parameters<BackendPort['getEvents']>[0]) {
    return withStorageConflictRetry(() => super.getEvents(request));
  }

  override async getSessionSummary(
    request: Parameters<BackendPort['getSessionSummary']>[0],
  ) {
    return withStorageConflictRetry(() => super.getSessionSummary(request));
  }

  override async getStatus(request: Parameters<BackendPort['getStatus']>[0]) {
    return withStorageConflictRetry(() => super.getStatus(request));
  }

  override async queryOptions(
    request: QueryOptionsRequest,
  ): Promise<QueryOptionsResponse> {
    const replay = this.serviceDescription.replay;
    if (!replay || !this.replayQueries) return super.queryOptions(request);
    if (sameJson(request.query, replay.manifestQuery)) {
      const eventLimit = readEventLimit(request.query);
      await this.replaySummary(request);
      const query = this.replayQueries.manifest(eventLimit);
      assertJsonPayloadSize(query, DEFAULT_JSON_LIMITS.queryBytes, 'query');
      return super.queryOptions({ ...request, query });
    }
    if (
      isRecord(request.query) &&
      request.query.type === replay.framesQueryType
    ) {
      const { from, limit } = readFrameRange(request.query);
      await this.replaySummary(request);
      const query = this.replayQueries.frames(from, limit);
      assertJsonPayloadSize(query, DEFAULT_JSON_LIMITS.queryBytes, 'query');
      return super.queryOptions({ ...request, query });
    }
    return super.queryOptions(request);
  }

  async dailyChallenge(
    request: DailyChallengeServiceRequest,
  ): Promise<DailyChallengeServiceResponse> {
    assertDailyChallengeServiceRequest(request);
    const service = this.dailyChallengeService;
    const description = this.serviceDescription.dailyChallenge;
    if (!service || !description)
      throw contractError('NOT_READY', 'server.runner.daily.unavailable');
    const route = request.route;
    if (
      route.gameId !== this.serviceDescription.gameId ||
      route.releaseId !== this.serviceDescription.releaseId ||
      route.backendBindingId !== this.serviceDescription.backendBindingId ||
      route.storageBindingId !== this.serviceDescription.storageBindingId ||
      route.ownershipEpoch !== this.serviceDescription.ownershipEpoch ||
      route.modeId !== description.modeId
    )
      throw contractError('FORBIDDEN', 'server.runner.daily.route_denied');
    if (!description.operations.includes(request.operation))
      throw contractError(
        'NOT_READY',
        'server.runner.daily.operation_unavailable',
      );

    switch (request.operation) {
      case 'validateSettings':
        await service.validateSettings(request.settings);
        return { operation: request.operation, accepted: true };
      case 'publicSettings': {
        const publicSettings = await service.publicSettings(request.settings);
        if (!isJsonValue(publicSettings))
          throw contractError(
            'INVALID_REQUEST',
            'server.runner.daily.public_settings',
          );
        const response = {
          operation: request.operation,
          publicSettings,
        } as const;
        assertDailyChallengeServiceResponse(response);
        return copy(response);
      }
      case 'prepare': {
        const prepared = await service.prepare(
          request.challengeDate,
          request.settings,
        );
        if (
          !prepared ||
          typeof prepared.seed !== 'string' ||
          prepared.seed.length === 0 ||
          !isJsonValue(prepared.setup)
        )
          throw contractError('INVALID_REQUEST', 'server.runner.daily.prepare');
        const response = {
          operation: request.operation,
          seed: prepared.seed,
          setup: prepared.setup,
          ...(prepared.publicSettings === undefined
            ? {}
            : { publicSettings: prepared.publicSettings }),
        } as const;
        assertDailyChallengeServiceResponse(response);
        return copy(response);
      }
      case 'validateSetup':
        await service.validateSetup(request.setup);
        return { operation: request.operation, accepted: true };
      case 'participants': {
        if (request.context.sessionId !== route.sessionId)
          throw contractError('FORBIDDEN', 'server.runner.daily.route_denied');
        const participants = await service.participants(request.context);
        if (
          !Array.isArray(participants) ||
          participants.length !== description.playerCount
        )
          throw contractError(
            'INVALID_REQUEST',
            'server.runner.daily.participants',
          );
        const response = {
          operation: request.operation,
          participants,
        } as const;
        assertDailyChallengeServiceResponse(response);
        return copy(response);
      }
      case 'score': {
        if (!sameJson(request.admission.route, request.route))
          throw contractError('FORBIDDEN', 'server.runner.daily.route_denied');
        assertGameResult(request.result, request.admission.participants);
        const score = await service.score(request.result, request.admission);
        if (
          score !== null &&
          (!Number.isFinite(score.score) ||
            (score.result !== undefined && !isJsonValue(score.result)))
        )
          throw contractError('INVALID_REQUEST', 'server.runner.daily.score');
        const response = { operation: request.operation, score } as const;
        assertDailyChallengeServiceResponse(response);
        return copy(response);
      }
    }
  }

  async statistics(
    request: GameStatisticsServiceRequest,
  ): Promise<GameStatisticsServiceResponse> {
    assertGameStatisticsServiceRequest(request);
    const service = this.statisticsService;
    const description = this.serviceDescription.statistics;
    if (!service || !description)
      throw contractError('NOT_READY', 'server.runner.statistics.unavailable');
    const route = request.route;
    if (
      route.gameId !== this.serviceDescription.gameId ||
      route.releaseId !== this.serviceDescription.releaseId ||
      route.backendBindingId !== this.serviceDescription.backendBindingId ||
      route.storageBindingId !== this.serviceDescription.storageBindingId ||
      route.ownershipEpoch !== this.serviceDescription.ownershipEpoch
    )
      throw contractError('FORBIDDEN', 'server.runner.statistics.route_denied');
    if (!request.accessContext.scopes.includes('statistics:read'))
      throw contractError('FORBIDDEN', 'server.runner.statistics.scope_denied');
    const operation = description.operations.find(
      (candidate) => candidate.key === request.operation,
    );
    if (!operation || operation.audience !== request.audience)
      throw contractError(
        'NOT_READY',
        'server.runner.statistics.operation_unavailable',
      );
    assertGameStatisticsQuery(request.query, operation);
    const response = await service.query(request);
    assertGameStatisticsServiceResponse(response);
    if (
      response.operation !== request.operation ||
      response.audience !== request.audience
    )
      throw contractError(
        'CONFLICT',
        'server.runner.statistics.response_mismatch',
      );
    assertGameStatisticsPayload(response.payload, operation);
    return copy(response);
  }

  private async replaySummary(request: QueryOptionsRequest) {
    const summary = await super.getSessionSummary({
      protocolVersion: request.protocolVersion,
      accessContext: request.accessContext,
      route: request.route,
    });
    if (summary.status !== 'completed')
      throw contractError('CONFLICT', 'server.runner.replay.not_completed');
    if (summary.historyAvailable === false)
      throw contractError(
        'SESSION_CLOSED',
        'server.runner.replay.not_retained',
      );
    if (summary.sourceRevision !== request.revision)
      throw contractError('STALE_REVISION', 'host.revision.stale');
    return summary;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseServiceCommand(
  value: JsonValue,
): { readonly key: string; readonly input: JsonValue } | undefined {
  if (!isRecord(value) || value.type !== GAME_SERVICE_COMMAND_TYPE)
    return undefined;
  if (
    Object.keys(value).some((key) => !['type', 'key', 'input'].includes(key)) ||
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    !Object.hasOwn(value, 'input') ||
    !isJsonValue(value.input)
  )
    throw contractError(
      'INVALID_REQUEST',
      'server.runner.command_service.wrapper',
    );
  return { key: value.key, input: value.input };
}

function readEventLimit(value: JsonValue): number {
  // The v1 description deliberately leaves the manifest query opaque.  The
  // current GameReplayQueries port accepts the common event-limit argument,
  // but a game may advertise a static/custom query instead.
  if (!isRecord(value) || !Object.hasOwn(value, 'eventLimit')) return 200;
  if (!Number.isSafeInteger(value.eventLimit))
    throw contractError(
      'INVALID_REQUEST',
      'server.runner.replay.manifest_query',
    );
  const eventLimit = value.eventLimit as number;
  if (eventLimit < 1 || eventLimit > 1_000)
    throw contractError(
      'INVALID_REQUEST',
      'server.runner.replay.manifest_query',
    );
  return eventLimit;
}

function readFrameRange(value: Record<string, unknown>): {
  readonly from: number;
  readonly limit: number;
} {
  if (
    !Number.isSafeInteger(value.from) ||
    !Number.isSafeInteger(value.limit) ||
    (value.from as number) < 0 ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  )
    throw contractError('INVALID_REQUEST', 'server.runner.replay.frame_query');
  return { from: value.from as number, limit: value.limit as number };
}

class GameServerRunnerImpl<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends GameServerManifest,
  PlatformContext,
> implements GameServerRunner<Command>
{
  readonly mode: GameServerMode;
  readonly description: GameServiceDescription;
  readonly host: GameHost;
  readonly backend: BackendPort;
  readonly transport?: HttpHostTransport;
  readonly playerTransport?: HttpPlayerTransport;
  readonly authorizationTransport?: HttpAuthorizationVersionServer;
  readonly commandServices: ReadonlyMap<
    string,
    GameCommandServiceDescriptor<Command>
  >;
  readonly replayQueries?: GameReplayQueries;

  private readonly storage: StorageDriver;
  private readonly systemAccess: ResolveSystemAccess;
  private readonly now: () => number;
  private readonly inbox?: InboxStore;
  private readonly inboxConsumers?: InboxConsumerRunner;
  private readonly consumerKeys: readonly string[];
  private readonly dispatcher?: OutboxFactDispatcher;
  private readonly recoveryHooks: readonly GameRecoveryHook[];
  private started = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private address?: AddressInfo;
  private playerAddress?: AddressInfo;
  private authorizationAddress?: AddressInfo;
  private recoveryPromise?: Promise<GameServerRecoveryReport>;
  private automationPromise?: Promise<readonly SystemTickResult[]>;

  constructor(
    options: GameServerRunnerOptions<
      S,
      Setup,
      Command,
      View,
      Event,
      Query,
      Answer,
      SystemCommand,
      Manifest,
      PlatformContext
    >,
  ) {
    assertGameServiceDescription(options.description);
    this.mode = normalizeMode(options.mode);
    if (this.mode === 'production' && !options.storage.capabilities.durable)
      unsupported('server.runner.storage.durable_required');
    if (
      this.mode === 'development' &&
      options.transport &&
      !isLoopbackHost(options.transport.host)
    )
      throw contractError(
        'INVALID_REQUEST',
        'server.runner.development_transport_loopback',
      );
    if (options.authorizationTransport && !options.playerTransport)
      throw contractError(
        'INVALID_REQUEST',
        'server.runner.authorization_transport_requires_player',
      );
    if (options.playerTransport) {
      if (
        this.mode === 'production' &&
        options.playerTransport.authorizationStore.capabilities?.durable !==
          true
      )
        unsupported('server.runner.player_authorization.durable_required');
      if (
        this.mode === 'development' &&
        !isLoopbackHost(options.playerTransport.host)
      )
        throw contractError(
          'INVALID_REQUEST',
          'server.runner.development_player_transport_loopback',
        );
      if (options.playerTransport.platformId !== options.description.platformId)
        throw contractError(
          'CONFLICT',
          'server.runner.player_authorization.platform',
        );
    }
    if (
      this.mode === 'development' &&
      options.authorizationTransport &&
      !isLoopbackHost(options.authorizationTransport.host)
    )
      throw contractError(
        'INVALID_REQUEST',
        'server.runner.development_authorization_transport_loopback',
      );
    const authorizationCredentials =
      options.authorizationTransport?.credentials;
    if (
      authorizationCredentials?.some(
        (credential) =>
          credential.platformId !== options.description.platformId,
      )
    )
      throw contractError(
        'CONFLICT',
        'server.runner.authorization_transport.platform',
      );
    if (
      options.inbox &&
      this.mode === 'production' &&
      !options.inbox.capabilities.durable
    )
      unsupported('server.runner.inbox.durable_required');
    assertIdentity(options.definition, options.description);
    assertUnsupportedServices(options.definition.services);
    this.commandServices = assertCommands(
      options.definition.services,
      options.description,
    );
    this.replayQueries = assertReplayQueries(
      options.definition.services,
      options.description,
    );
    const dailyChallengeService = assertDailyChallengeService(
      options.definition.services,
      options.description,
    );
    const statisticsService = assertStatisticsService(
      options.definition.services,
      options.description,
    );
    const facts = options.definition.services.facts ?? [];
    this.inbox = options.inbox;
    if (facts.length > 0) {
      if (!options.inbox)
        throw contractError('INVALID_REQUEST', 'server.runner.inbox.required');
      this.inboxConsumers = new InboxConsumerRunner(options.inbox);
      for (const fact of facts) this.registerFactConsumer(fact);
    }
    this.description = copy(options.description);
    this.storage = options.storage;
    this.systemAccess = options.systemAccess;
    this.now = options.now ?? Date.now;
    this.recoveryHooks = [...(options.definition.services.recovery ?? [])];

    const authorize: GameHostOptions['authorize'] = async (
      context,
      operation,
      route,
      action,
    ) => {
      if (
        route.gameId !== this.description.gameId ||
        route.releaseId !== this.description.releaseId ||
        route.backendBindingId !== this.description.backendBindingId ||
        route.storageBindingId !== this.description.storageBindingId ||
        route.ownershipEpoch !== this.description.ownershipEpoch
      )
        throw contractError('FORBIDDEN', 'server.runner.route.mismatch');
      await options.authorize(context, operation, route, action);
    };
    const registry = new GameRegistry().register(options.definition.module);
    this.host = new GameHost({
      registry,
      storage: options.storage,
      backendBindingId: options.description.backendBindingId,
      storageBindingId: options.description.storageBindingId,
      ...(options.description.replay
        ? {
            replayReference: {
              platformId: options.description.platformId,
              formatVersion: 1,
            },
          }
        : {}),
      authorize,
      ...(options.now ? { now: options.now } : {}),
      ...(options.definition.services.storage?.resourceStore
        ? {
            entitlementStore: options.definition.services.storage.resourceStore,
          }
        : {}),
      ...(options.definition.services.automation
        ? { automationPolicies: options.definition.services.automation }
        : {}),
    });
    this.backend = new RunnerBackend(
      this.host,
      this.description,
      this.commandServices,
      this.replayQueries,
      dailyChallengeService,
      statisticsService,
    );
    if (options.transport) {
      this.transport = new HttpHostTransport({
        ...options.transport,
        backend: this.backend,
        allowedGameIds: [this.description.gameId],
      });
    }
    if (options.playerTransport) {
      const playerOptions = options.playerTransport;
      this.playerTransport = new HttpPlayerTransport({
        ...playerOptions,
        backend: this.backend,
        authorize: (token, operation, request) =>
          authorizePlayerRequest(token, operation, request, {
            description: this.description,
            publicKey: playerOptions.publicKey,
            platformId: playerOptions.platformId,
            audience: playerOptions.audience,
            authorizationStore: playerOptions.authorizationStore,
            ...(playerOptions.approvedGameScopes
              ? { approvedGameScopes: playerOptions.approvedGameScopes }
              : {}),
            now: this.now,
          }),
      });
      if (options.authorizationTransport) {
        this.authorizationTransport = new HttpAuthorizationVersionServer({
          ...options.authorizationTransport,
          store: playerOptions.authorizationStore,
          authorizeRoute: (route) => {
            try {
              assertPlayerRoute(route, this.description);
              return true;
            } catch {
              return false;
            }
          },
        });
      }
    }
    const factReceiver = composeFactReceiver(
      options.inbox,
      options.factReceiver,
    );
    if (factReceiver) {
      this.dispatcher = new OutboxFactDispatcher({
        source: options.storage,
        receiver: factReceiver,
        sourceIdentity: {
          gameId: this.description.gameId,
          releaseId: this.description.releaseId,
          backendBindingId: this.description.backendBindingId,
          ownershipEpoch: this.description.ownershipEpoch,
        },
        now: this.now,
      });
    }
    this.consumerKeys = facts.map((fact) => fact.key);
  }

  get transportAddress(): AddressInfo | undefined {
    return this.address;
  }

  get playerTransportAddress(): AddressInfo | undefined {
    return this.playerAddress;
  }

  get authorizationTransportAddress(): AddressInfo | undefined {
    return this.authorizationAddress;
  }

  async start(): Promise<AddressInfo | undefined> {
    this.assertOpen();
    if (this.started) return this.address;
    this.started = true;
    try {
      if (this.transport) this.address = await this.transport.listen();
      if (this.playerTransport)
        this.playerAddress = await this.playerTransport.listen();
      if (this.authorizationTransport)
        this.authorizationAddress = await this.authorizationTransport.listen();
      return this.address;
    } catch (error) {
      this.started = false;
      await Promise.allSettled([
        this.transport?.close(),
        this.playerTransport?.close(),
        this.authorizationTransport?.close(),
      ]);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const recovery = this.recoveryPromise;
    const automation = this.automationPromise;
    this.closePromise = (async () => {
      const pending = await Promise.allSettled([recovery, automation]);
      await this.host.drain();
      await Promise.all([
        this.transport?.close(),
        this.playerTransport?.close(),
        this.authorizationTransport?.close(),
      ]);
      await this.storage.close();
      await this.inbox?.close();
      const failed = pending.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failed) throw failed.reason;
    })();
    return this.closePromise;
  }

  recoverOnce(): Promise<GameServerRecoveryReport> {
    this.assertOpen();
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.runRecovery().finally(() => {
        this.recoveryPromise = undefined;
      });
    }
    return this.recoveryPromise;
  }

  recoverAutomationOnce(): Promise<readonly SystemTickResult[]> {
    this.assertOpen();
    if (!this.automationPromise) {
      this.automationPromise = this.host
        .tickSystemCommands(this.systemAccess, 100, { kind: 'automation' })
        .finally(() => {
          this.automationPromise = undefined;
        });
    }
    return this.automationPromise;
  }

  private async runRecovery(): Promise<GameServerRecoveryReport> {
    const timers = await this.host.tickSystemCommands(this.systemAccess, 100, {
      kind: 'system',
    });
    const resources = await this.host.reconcileResources(100);
    const outbox = this.dispatcher
      ? await this.dispatcher.dispatchOnce()
      : undefined;
    const facts: ConsumerRunReport[] = [];
    if (this.inboxConsumers) {
      for (const key of this.consumerKeys)
        facts.push(
          await this.inboxConsumers.runOnce(key, {
            limit: 100,
            now: this.now(),
          }),
        );
    }
    const recovery: GameServerRecoveryHookResult[] = [];
    for (const hook of this.recoveryHooks) {
      try {
        await hook.recover();
        recovery.push({ key: hook.key, failed: false });
      } catch {
        recovery.push({ key: hook.key, failed: true });
      }
    }
    return {
      timers,
      resources,
      facts,
      ...(outbox ? { outbox } : {}),
      recovery,
    };
  }

  private registerFactConsumer(consumer: GameFactConsumer): void {
    this.inboxConsumers?.registerExternal(consumer.key, (envelope) =>
      consumer.consume(envelope),
    );
  }

  private assertOpen(): void {
    if (this.closed) throw contractError('NOT_READY', 'server.runner.closed');
  }
}

export function createGameServerRunner<
  S,
  Setup extends JsonValue,
  Command extends JsonValue,
  View extends JsonValue,
  Event,
  Query extends JsonValue,
  Answer extends JsonValue,
  SystemCommand extends JsonValue,
  Manifest extends GameServerManifest,
  PlatformContext,
>(
  options: GameServerRunnerOptions<
    S,
    Setup,
    Command,
    View,
    Event,
    Query,
    Answer,
    SystemCommand,
    Manifest,
    PlatformContext
  >,
): GameServerRunner<Command> {
  return new GameServerRunnerImpl(options);
}
