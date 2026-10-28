import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  assertGameServiceDescription,
  assertMatchesSchema,
  type BackendDescription,
  type BackendPort,
  canonicalStableStringify,
  contractError,
  type GameMetadata,
  type GamePolicyVersion,
  type GameServiceDescription,
  isPlatformError,
  type JsonObject,
  type JsonValue,
  type PlatformCompletionRecord,
  type PlatformRoom,
  participantAccountId,
  type ReadyResponse,
  type ReleaseManifest,
  type SessionRoute,
} from '@board-game/contracts';
import {
  AdmissionCoordinator,
  type AdmissionPolicy,
  InboxConsumerRunner,
  type InboxEnvelope,
  type InboxStore,
  OutboxFactDispatcher,
  type PlatformIdentityReference,
  PostgresAdmissionStore,
  PostgresInboxStore,
  PostgresSessionDirectory,
  type ReleaseBinding,
  type RoomManagementPolicy,
  type RoomManagementStore,
  type SessionDirectoryListOptions,
  type SessionDirectoryStore,
  SessionGateway,
  type SessionGatewayOptions,
  TrustedFactIngestor,
} from '@board-game/core';
import {
  EmbeddedBackendAdapter,
  GameHost,
  GameRegistry,
  RemoteBackendAdapter,
  type ResourceStore,
  type SystemTickResult,
} from '@board-game/host';
import {
  type AutomationPolicy,
  automationOptions,
  type GameModule,
} from '@board-game/sdk';
import {
  GAME_SERVICE_COMMAND_TYPE,
  type GameCommandServiceCollection,
  GameCommandServiceRegistry,
  type GameCommandServiceRequest,
} from '@board-game/server';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import type { GameAccessRegistration } from '@board-platform/contracts';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import {
  type CompletionRecordStore,
  PostgresCompletionRecordStore,
} from './CompletionRecordStore.js';
import type { GameAccessService } from './game-access/service.js';
import { PlatformAccountIdentity } from './PlatformAccountIdentity.js';
import type { PlatformChatOperation } from './PlatformChatStore.js';
import type { PlatformIdentity } from './PlatformIdentity.js';
import { PlatformRoomChat } from './PlatformRoomChat.js';
import { PlatformRoomManagement } from './PlatformRoomManagement.js';
import { PlatformSessionChat } from './PlatformSessionChat.js';
import { PlatformSessionNotes } from './PlatformSessionNotes.js';
import { PlatformSessionResults } from './PlatformSessionResults.js';
import { PlatformSessionViews } from './PlatformSessionViews.js';
import { ReleaseRegistry } from './releases/index.js';
import type {
  BindingReadinessEvidence,
  ChannelRecord,
  CompareAndSwapChannelInput,
  DesiredGameInstallation,
  ReleaseBindingRecord,
  ReleaseDeploymentKind,
  ReleaseEndpointRefs,
  ReleaseRecord,
  ReleaseRegistryStore,
} from './releases/types.js';

export interface PlatformApplicationOptions {
  /** Required for independent services; one game instance belongs to one platform. */
  readonly platformId?: string;
  readonly db: NodePgDatabase;
  readonly pool: Pool;
  readonly defaultGameId?: string;
  /** Independent production shells disable in-process games and game-owned SQL storage. */
  readonly allowEmbeddedGames?: boolean;
  readonly storage?: StorageDriver;
  readonly admissionStore?: RoomManagementStore;
  readonly inbox?: InboxStore;
  readonly directory?: SessionDirectoryStore;
  readonly completionStore?: CompletionRecordStore;
  /** Durable release/binding/channel authority. Omit for the legacy direct test path. */
  readonly releaseRegistry?: ReleaseRegistryStore;
  /** Operator file intent for read-only comparison; the durable registry remains authoritative. */
  readonly desiredGameInstallations?: readonly DesiredGameInstallation[];
  /** Resolvers used to reconstruct remote adapters after a platform restart. */
  readonly remoteRuntime?: RemoteRuntimeOptions;
  /** Explicitly permits HTTP artifact roots for loopback development only. */
  readonly allowInsecureLocalhost?: boolean;
  /** Platform-owned, business-idempotent settlement; game closures are never installed here. */
  readonly settleCompletion?: (
    record: PlatformCompletionRecord,
  ) => Promise<void>;
  readonly gameAccess?: GameAccessService;
}

/** Server-owned policy supplied once for an installed game release. */
export type GameAccessPolicy = Pick<
  PlatformIdentity,
  | 'authorize'
  | 'accessScopes'
  | 'authorizeRoom'
  | 'authorizeRoomInvite'
  | 'freezeParticipants'
  | 'authorizeHost'
  | 'adminAccess'
  | 'diagnosticAccess'
  | 'startAccess'
  | 'systemAccess'
> &
  Partial<Pick<PlatformIdentity, 'developerAccess'>>;

export interface RemoteBindingRegistration extends ReleaseEndpointRefs {
  readonly deployment: ReleaseDeploymentKind;
}

export interface RemotePolicyResolution {
  readonly identity: GameAccessPolicy;
  readonly policy: AdmissionPolicy;
  readonly scopes?: readonly string[];
  readonly publicModes?: readonly string[];
  readonly access?: GameAccessRegistration;
  readonly playerCountField?: string;
  /** A JSON declaration for a nested room setup player-count field. */
  readonly roomCapacity?: GameServiceDescription['roomCapacity'];
}

/** Release-pinned JSON policy data handed to the platform settlement facade. */
export interface RemoteSettlementReleaseInput {
  readonly gameId: string;
  readonly releaseId: string;
  readonly metadata: GameMetadata;
  readonly service: GameServiceDescription;
  /** Explicit platform approval; never inferred from the service manifest. */
  readonly approvedFeatures?: readonly string[];
  readonly approvedModes: readonly string[];
  readonly approvedPolicyVersions: readonly GamePolicyVersion[];
  readonly policyBundle?: JsonValue;
}

export type RemoteSettlementReleaseHook = (
  input: RemoteSettlementReleaseInput,
) => Promise<void> | void;

export type RemoteDailyChallengeReleaseInput = Pick<
  RemoteSettlementReleaseInput,
  'gameId' | 'releaseId' | 'service' | 'approvedModes'
>;

export type RemoteDailyChallengeReleaseHook = (
  input: RemoteDailyChallengeReleaseInput,
) => Promise<void> | void;

export interface RemoteCredentialResolution {
  readonly serviceToken: string;
  readonly allowInsecureLocalhost?: boolean;
  readonly timeoutMs?: number;
}

export interface RemoteReadinessProbeInput {
  readonly backend: BackendPort;
  readonly release: ReleaseRecord;
  readonly binding: ReleaseBindingRecord;
  readonly ready: BackendDescription;
}

export interface RemoteRuntimeOptions {
  readonly resolvePolicy: (
    release: ReleaseRecord,
    binding: ReleaseBindingRecord,
  ) => Promise<RemotePolicyResolution> | RemotePolicyResolution;
  readonly resolveCredential: (
    release: ReleaseRecord,
    binding: ReleaseBindingRecord,
  ) => Promise<RemoteCredentialResolution> | RemoteCredentialResolution;
  /** Explicit protocol + storage probe. A backend.ready response alone is insufficient. */
  readonly probeReadiness: (
    input: RemoteReadinessProbeInput,
  ) => Promise<BindingReadinessEvidence>;
}

export interface GameRegistration {
  readonly metadata: GameMetadata;
  readonly identity: GameAccessPolicy;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  readonly ownershipEpoch: string;
  readonly activeBackend?: BackendPort;
  readonly retainedBackends?: ReadonlyMap<string, BackendPort>;
  readonly resourceStore?: ResourceStore;
  readonly scopes?: readonly string[];
  readonly publicModes?: readonly string[];
  readonly capacity: (room: PlatformRoom) => number;
  readonly validateColor?: RoomManagementPolicy['validateColor'];
  readonly createBotProfile?: RoomManagementPolicy['createBotProfile'];
  readonly controllers?: { readonly hotseat?: boolean };
  readonly automation?: readonly AutomationPolicy[];
  readonly freezePolicy: (room: PlatformRoom) => Promise<AdmissionPolicy>;
  readonly freezeSeed?: (room: PlatformRoom) => Promise<string>;
  readonly automaticStart?: (room: PlatformRoom) => boolean;
  /** Optional game-owned catalog and admission entitlement gate. */
  readonly access?: GameAccessRegistration;
}

export interface InstalledGame extends GameRegistration {
  readonly gameId: string;
  readonly releaseId: string;
  readonly host: GameHost;
  readonly backend: BackendPort;
  readonly description?: never;
}

/** Only data and platform policies cross this registration boundary. */
export interface RemoteGameRegistration {
  readonly description: GameServiceDescription;
  readonly backend: BackendPort;
  readonly identity: GameAccessPolicy;
  readonly policy: AdmissionPolicy;
  readonly scopes?: readonly string[];
  readonly publicModes?: readonly string[];
  readonly access?: GameAccessRegistration;
  /** A declared setup field, for games whose room capacity is a setup option. */
  readonly playerCountField?: string;
  /** A declared nested setup path, preferred over the legacy top-level field. */
  readonly roomCapacity?: GameServiceDescription['roomCapacity'];
  /** Required when a persistent release registry is configured. */
  readonly manifest?: ReleaseManifest;
  /** Platform-approved feature projection; never inferred from the manifest. */
  readonly approvedFeatures?: readonly string[];
  /** Platform-approved modes; never inferred from the service description. */
  readonly approvedModes?: readonly string[];
  /** Immutable JSON policy data retained with the exact release. */
  readonly policyBundle?: JsonValue;
  /** Platform-approved policy pins; never inferred from the bundle. */
  readonly approvedPolicyVersions?: readonly GamePolicyVersion[];
  readonly binding?: RemoteBindingRegistration;
  readonly readinessProbe?: (
    input: RemoteReadinessProbeInput,
  ) => Promise<BindingReadinessEvidence>;
}

export interface InstalledRemoteGame extends GameRegistration {
  readonly gameId: string;
  readonly releaseId: string;
  readonly description: GameServiceDescription;
  readonly host?: never;
  readonly backend: BackendPort;
  readonly activeBackend: BackendPort;
}

export type RegisteredGame = InstalledGame | InstalledRemoteGame;

interface RemoteBindingLoadOptions {
  /** Metadata restore never waits on the game process. */
  readonly requireLive?: boolean;
  /** A backend that was already probed by readyRemoteBinding. */
  readonly backend?: BackendPort;
  /** The matching ready response for `backend`. */
  readonly ready?: ReadyResponse;
}

function remoteBindingEndpointFingerprint(
  binding: Pick<
    ReleaseBindingRecord,
    | 'controlEndpoint'
    | 'playerEndpoint'
    | 'authorizationEndpoint'
    | 'clientArtifactBaseUrl'
    | 'serviceCredentialRef'
  >,
): string {
  return canonicalStableStringify({
    controlEndpoint: binding.controlEndpoint,
    playerEndpoint: binding.playerEndpoint,
    ...(binding.authorizationEndpoint === undefined
      ? {}
      : { authorizationEndpoint: binding.authorizationEndpoint }),
    clientArtifactBaseUrl: binding.clientArtifactBaseUrl,
    serviceCredentialRef: binding.serviceCredentialRef,
  });
}

function isCancelledControlFact(envelope: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (envelope.kind !== 'SessionControlled') return false;
  const payload = envelope.payload;
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).action === 'cancel' &&
      ((payload as Record<string, unknown>).status === undefined ||
        (payload as Record<string, unknown>).status === 'cancelled'),
  );
}

function readJsonObjectPath(
  root: unknown,
  path: readonly string[],
): { readonly found: boolean; readonly value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, segment)
    )
      return { found: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function remoteRoomPlayerCount(
  setup: unknown,
  mode: { readonly minPlayers: number; readonly maxPlayers: number },
  roomCapacity: GameServiceDescription['roomCapacity'],
  legacyPlayerCountField: string | undefined,
): unknown {
  if (roomCapacity) {
    const located = readJsonObjectPath(setup, roomCapacity.playerCountPath);
    return located.found
      ? located.value
      : (roomCapacity.defaultPlayerCount ?? mode.maxPlayers);
  }
  if (
    legacyPlayerCountField &&
    setup !== null &&
    typeof setup === 'object' &&
    !Array.isArray(setup)
  )
    return Object.hasOwn(setup, legacyPlayerCountField)
      ? (setup as Record<string, unknown>)[legacyPlayerCountField]
      : undefined;
  return mode.maxPlayers;
}

function unavailableRemoteBackend(): BackendPort {
  const unavailable = async (..._args: readonly unknown[]): Promise<never> => {
    throw contractError(
      'NOT_READY',
      'platform.remote.binding_unavailable',
      true,
    );
  };
  return {
    describe: unavailable,
    ready: unavailable,
    createSession: unavailable,
    activateSession: unavailable,
    getStatus: unavailable,
    submitCommand: unavailable,
    submitSystemCommand: unavailable,
    queryOptions: unavailable,
    getPlayerView: unavailable,
    getEvents: unavailable,
    resume: unavailable,
    getSessionSummary: unavailable,
    controlSession: unavailable,
    retireSessionHistory: unavailable,
  };
}

/** Shared application lifecycle. It has no imports from any game's rules or UI. */
export class PlatformApplicationRuntime {
  get embeddedGamesEnabled(): boolean {
    return this.options.allowEmbeddedGames !== false;
  }
  readonly gameAccess?: GameAccessService;
  readonly identity: PlatformAccountIdentity;
  readonly storage: StorageDriver;
  readonly admissionStore: RoomManagementStore;
  readonly inbox: InboxStore;
  readonly directory: SessionDirectoryStore;
  readonly completionStore?: CompletionRecordStore;
  readonly consumers: InboxConsumerRunner;
  readonly registry = new GameRegistry();
  readonly admission: AdmissionCoordinator;
  readonly rooms: PlatformRoomManagement;
  readonly sessions: SessionGateway;
  /** Used only by replay endpoints; it never authorizes chat or gameplay. */
  readonly replaySessions: SessionGateway;
  readonly dispatcher: OutboxFactDispatcher;
  readonly factReceiver: TrustedFactIngestor;
  readonly releaseRegistry?: ReleaseRegistry;
  readonly views: PlatformSessionViews;
  readonly results: PlatformSessionResults;
  readonly chat: PlatformSessionChat;
  readonly roomChat: PlatformRoomChat;
  readonly notes: PlatformSessionNotes;
  private readonly games = new Map<string, RegisteredGame>();
  /** Exact release registrations; `games` remains the legacy current projection. */
  private readonly releaseGames = new Map<string, RegisteredGame>();
  private readonly bindings = new Map<string, ReleaseBinding>();
  private readonly remoteBindingStatuses = new Map<
    string,
    ReleaseBindingRecord['status']
  >();
  /** Endpoint identity currently represented by each installed remote release. */
  private readonly remoteBindingEndpoints = new Map<string, string>();
  /** Registry revision last probed successfully by the live adapter. */
  private readonly remoteBindingLiveRevisions = new Map<string, number>();
  /** Prevents an older asynchronous channel projection from publishing late. */
  private readonly remoteProjectionGenerations = new Map<string, number>();
  private readonly remoteProjectionRecoveryPending = new Set<string>();
  private readonly remoteProjectionRecoveryHooks = new Set<string>();
  private readonly releaseRegistryStore?: ReleaseRegistryStore;
  private readonly remoteRuntime?: RemoteRuntimeOptions;
  private remoteSettlementReleaseHook?: RemoteSettlementReleaseHook;
  private remoteDailyChallengeReleaseHook?: RemoteDailyChallengeReleaseHook;
  private publicReplayAuthorization?: (
    route: SessionRoute,
    principalId: string,
  ) => Promise<boolean>;
  private settleCompletionHandler?: (
    record: PlatformCompletionRecord,
  ) => Promise<void>;
  private readonly gameScopes: Record<string, readonly string[]> = {};
  private readonly consumerNames = new Set<string>();
  private readonly gameConsumerNames = new Map<string, Set<string>>();
  private readonly commandServiceRegistries = new Map<
    string,
    GameCommandServiceCollection
  >();
  private readonly recoveryHooks = new Map<string, () => Promise<void>>();
  private readonly gameRecoveryHookNames = new Map<string, Set<string>>();
  private readonly registeredGameAccess = new Set<string>();
  private readonly transactionConnection = new AsyncLocalStorage<PoolClient>();
  private automationRecovery: Promise<readonly SystemTickResult[]> | undefined;
  private draining = false;
  private readonly completionWorkerId = randomUUID();
  private readonly changeListeners = new Set<
    (sessionId: string, revision: number) => void
  >();
  private readonly accountChangeListeners = new Set<
    (principalIds: readonly string[]) => void
  >();

  constructor(readonly options: PlatformApplicationOptions) {
    if (options.remoteRuntime && !options.releaseRegistry)
      throw contractError(
        'INVALID_REQUEST',
        'platform.remote.registry_required',
      );
    this.releaseRegistryStore = options.releaseRegistry;
    this.remoteRuntime = options.remoteRuntime;
    this.settleCompletionHandler = options.settleCompletion;
    this.releaseRegistry = options.releaseRegistry
      ? new ReleaseRegistry(options.releaseRegistry)
      : undefined;
    this.gameAccess = options.gameAccess;
    this.identity = new PlatformAccountIdentity(options.db, () =>
      this.currentDatabase(),
    );
    this.storage =
      options.storage ??
      (this.embeddedGamesEnabled
        ? new PostgresStorageDriver({
            pool: options.pool,
            runInTransactionContext: (connection, work) =>
              this.transactionConnection.run(connection, work),
          })
        : new MemoryStorageDriver());
    this.admissionStore =
      options.admissionStore ??
      new PostgresAdmissionStore({
        pool: options.pool,
        readConnection: () => this.transactionConnection.getStore(),
        runInTransactionContext: (connection, work) =>
          this.transactionConnection.run(connection, work),
      });
    this.inbox =
      options.inbox ?? new PostgresInboxStore({ pool: options.pool });
    this.directory =
      options.directory ??
      new PostgresSessionDirectory({
        pool: options.pool,
        admission: this.admissionStore,
        retentionResolver: (admission) =>
          admission.historyPolicy ??
          this.resolveRelease(
            admission.route.gameId,
            admission.route.modeId,
            admission.route.releaseId,
          ).mode.history,
      });
    if (options.completionStore && !options.platformId)
      throw contractError(
        'INVALID_REQUEST',
        'platform.results.platform_id_required',
      );
    this.completionStore =
      options.completionStore ??
      (options.platformId
        ? new PostgresCompletionRecordStore({
            pool: options.pool,
            platformId: options.platformId,
            admission: this.admissionStore,
          })
        : undefined);
    this.consumers = new InboxConsumerRunner(this.inbox);
    this.registerFactConsumer(
      'platform:session-directory:v1',
      async (envelope) => {
        const isDirectoryFact = [
          'SessionCreated',
          'SessionActivated',
          'SessionSummaryChanged',
          'SessionCompleted',
          'SessionControlled',
        ].includes(envelope.kind);
        if (isDirectoryFact) {
          let projection = envelope;
          if (
            (envelope.kind === 'SessionCompleted' ||
              isCancelledControlFact(envelope)) &&
            envelope.sessionId
          ) {
            const admission = await this.admissionStore.getAdmission(
              envelope.sessionId,
            );
            if (
              admission &&
              this.releaseGame(
                admission.route.gameId,
                admission.route.releaseId,
              ).description
            ) {
              if (!this.completionStore)
                throw contractError(
                  'NOT_READY',
                  'platform.results.store_unavailable',
                );
              const { record } = await this.completionStore.accept(
                envelope,
                admission,
              );
              const payload = envelope.payload as JsonObject;
              projection = {
                ...envelope,
                payload: {
                  ...(payload.summary !== undefined
                    ? { summary: payload.summary }
                    : {}),
                  ...(record.result
                    ? { result: record.result as unknown as JsonValue }
                    : {}),
                  ...(record.status === 'completed'
                    ? {
                        resultRevision: record.resultRevision,
                        endedAt: record.endedAt,
                      }
                    : {}),
                  ...(record.status === 'cancelled'
                    ? { action: 'cancel', status: 'cancelled' }
                    : {}),
                },
              };
            }
          }
          await this.directory.applyFact(projection);
          if (envelope.sessionId) {
            const admission = await this.admissionStore.getAdmission(
              envelope.sessionId,
            );
            if (admission)
              this.notifyAccountsChanged(
                admission.participants.flatMap(
                  (participant) => participantAccountId(participant) ?? [],
                ),
              );
          }
        }
        if (envelope.sessionId && envelope.aggregateSequence !== undefined)
          this.notifyChanged(envelope.sessionId, envelope.aggregateSequence);
      },
    );
    this.admission = new AdmissionCoordinator({
      store: this.admissionStore,
      resolveRelease: (gameId, modeId, releaseId) =>
        this.resolveRelease(gameId, modeId, releaseId),
      resolveBackend: (route) => this.resolveBackend(route),
      authorize: (principalId, room, action) =>
        this.authorizeRoom(principalId, room, action),
      freezePolicy: (room) =>
        this.releaseGame(room.gameId, room.releaseId).freezePolicy(room),
      automaticStart: (room) =>
        this.releaseGame(room.gameId, room.releaseId).automaticStart?.(room) ??
        false,
      freezeSeed: async (room) =>
        this.releaseGame(room.gameId, room.releaseId).freezeSeed?.(room) ??
        randomUUID(),
      freezeParticipants: async (room) => {
        const game = this.releaseGame(room.gameId, room.releaseId);
        const binding = this.resolveRelease(
          room.gameId,
          room.modeId,
          room.releaseId,
        );
        if (
          binding.mode.entry === 'room' &&
          room.members.length !== game.capacity(room)
        )
          throw contractError('CONFLICT', 'platform.room.not_full');
        return game.identity.freezeParticipants(room);
      },
      accessForStart: (operation) =>
        this.releaseGame(
          operation.route.gameId,
          operation.route.releaseId,
        ).identity.startAccess(operation),
    });
    this.rooms = new PlatformRoomManagement({
      store: this.admissionStore,
      ...(options.defaultGameId
        ? { defaultGameId: options.defaultGameId }
        : {}),
      resolveMode: (gameId, modeId, releaseId) => {
        this.publicModeId(gameId, modeId, releaseId);
        const binding = this.resolveRelease(gameId, modeId, releaseId);
        return { ...binding.mode, validateSetup: binding.validateSetup };
      },
      resolveCapacity: (room) =>
        this.resolveRelease(room.gameId, room.modeId, room.releaseId).mode
          .entry === 'direct-solo'
          ? 1
          : this.releaseGame(room.gameId, room.releaseId).capacity(room),
      authorize: (principalId, room, action, access) =>
        this.authorizeRoom(principalId, room, action, access),
      authorizeInvite: (ownerId, inviteeId, room) =>
        this.authorizeRoomInvite(ownerId, inviteeId, room),
      publicNames: (ids) => this.accountIdentity().publicNames(ids),
      validateColor: (color, room, principalId) => {
        const validate = this.releaseGame(
          room.gameId,
          room.releaseId,
        ).validateColor;
        if (!validate)
          throw contractError(
            'INVALID_REQUEST',
            'platform.room.color_unsupported',
          );
        return validate(color, room, principalId);
      },
      createBotProfile: (room) =>
        this.releaseGame(room.gameId, room.releaseId).createBotProfile?.(
          room,
        ) ?? null,
      controllers: (room) => {
        const game = this.releaseGame(room.gameId, room.releaseId);
        const mode = this.resolveRelease(
          room.gameId,
          room.modeId,
          room.releaseId,
        ).mode;
        if (
          mode.platformRating ||
          mode.entry !== 'room' ||
          game.releaseId !== room.releaseId
        )
          return { hotseat: false, automation: [] };
        return {
          hotseat:
            (game.description?.controllers ?? game.controllers)?.hotseat ===
            true,
          automation: (
            game.description?.controllers?.automation ??
            game.automation ??
            []
          ).map((policy) => ({
            id: policy.id,
            ...(policy.version !== undefined
              ? { version: policy.version }
              : {}),
            kind: policy.kind,
            label: policy.label,
            ...(policy.optionsSchema
              ? { optionsSchema: policy.optionsSchema }
              : {}),
            ...(policy.defaultOptions !== undefined
              ? { defaultOptions: policy.defaultOptions }
              : {}),
            ...(policy.presets ? { presets: policy.presets } : {}),
          })),
        };
      },
      controllerOptions: (room, input) => {
        const game = this.releaseGame(room.gameId, room.releaseId);
        const policy =
          game.releaseId === room.releaseId
            ? (
                game.description?.controllers?.automation ?? game.automation
              )?.find(
                (candidate) =>
                  candidate.id === input.controllerId &&
                  candidate.kind === input.kind,
              )
            : undefined;
        if (!policy)
          throw contractError('NOT_READY', 'platform.automation.unavailable');
        return automationOptions(policy, input.options);
      },
      onAccountChanged: (principalIds) =>
        this.notifyAccountsChanged(principalIds),
    });
    const sessionGatewayOptions: SessionGatewayOptions = {
      gameScopes: this.gameScopes,
      admission: this.admissionStore,
      resolveIdentity: (reference) => this.accountIdentity().resolve(reference),
      authorize: (identity, admission, operation) =>
        this.releaseGame(
          admission.route.gameId,
          admission.route.releaseId,
        ).identity.authorize(identity, admission, operation),
      createAccess: (identity, admission, operation) =>
        this.releaseGame(
          admission.route.gameId,
          admission.route.releaseId,
        ).identity.accessScopes(identity, admission, operation),
      resolveBackend: (route) => this.resolveBackend(route),
    };
    this.sessions = new SessionGateway(sessionGatewayOptions);
    this.replaySessions = new SessionGateway({
      ...sessionGatewayOptions,
      authorize: async (identity, admission, operation) =>
        (await sessionGatewayOptions.authorize(
          identity,
          admission,
          operation,
        )) ||
        (operation !== 'command' &&
          (await this.publicReplayAuthorization?.(
            admission.route,
            identity.principalId,
          )) === true),
    });
    this.views = new PlatformSessionViews(
      this.sessions,
      this.admissionStore,
      (id, revision) => this.notifyChanged(id, revision),
    );
    this.results = new PlatformSessionResults(this.sessions, this.directory, {
      completionStore: this.completionStore,
      platformId: options.platformId,
      replaySessions: this.replaySessions,
    });
    this.chat = new PlatformSessionChat(options.pool, this.sessions);
    this.notes = new PlatformSessionNotes(options.pool, this.sessions);
    this.roomChat = new PlatformRoomChat(options.pool, {
      authorize: (reference, roomId, operation) =>
        this.authorizeRoomChat(reference, roomId, operation),
    });
    this.factReceiver = new TrustedFactIngestor({
      admission: this.admissionStore,
      inbox: this.inbox,
      allowedKinds: [
        'SessionCreated',
        'SessionActivated',
        'SessionSummaryChanged',
        'SessionCompleted',
        'SessionControlled',
        'GameFact',
      ],
      authorizeSource: (source, route) => {
        if (
          source.gameId !== route.gameId ||
          source.releaseId !== route.releaseId ||
          source.backendBindingId !== route.backendBindingId ||
          source.ownershipEpoch !== route.ownershipEpoch
        )
          return false;
        try {
          this.resolveBackend(route);
          return true;
        } catch {
          return false;
        }
      },
    });
    this.dispatcher = new OutboxFactDispatcher({
      source: this.storage,
      receiver: this.factReceiver,
      sourceIdentity: (_record, route) => ({
        gameId: route.gameId,
        releaseId: route.releaseId,
        backendBindingId: route.backendBindingId,
        ownershipEpoch: route.ownershipEpoch,
      }),
    });
  }

  /** Installed by PlatformGameServices after the runtime provider is created. */
  setRemoteSettlementReleaseHook(hook: RemoteSettlementReleaseHook): void {
    this.remoteSettlementReleaseHook = hook;
  }

  setRemoteDailyChallengeReleaseHook(
    hook: RemoteDailyChallengeReleaseHook,
  ): void {
    this.remoteDailyChallengeReleaseHook = hook;
  }

  setPublicReplayAuthorization(
    authorize: (route: SessionRoute, principalId: string) => Promise<boolean>,
  ): void {
    this.publicReplayAuthorization = authorize;
  }

  /** Installs the platform-owned completion dispatcher without game closures. */
  setSettlementHandler(
    handler: (record: PlatformCompletionRecord) => Promise<void>,
  ): void {
    this.settleCompletionHandler = handler;
  }

  async authorizeRoomChat(
    reference: PlatformIdentityReference,
    roomId: string,
    operation: PlatformChatOperation,
  ): Promise<void> {
    const identity = await this.accountIdentity().resolve(reference);
    const room = await this.rooms.getRoom(identity.principalId, roomId);
    if (
      operation === 'send' &&
      (room.status !== 'open' ||
        !room.members.some(
          (member) => member.principalId === identity.principalId,
        ) ||
        !(await this.authorizeRoom(identity.principalId, room, 'edit')))
    )
      throw contractError('FORBIDDEN', 'platform.room.chat_denied');
  }

  private async authorizeRoom(
    principalId: string,
    room: PlatformRoom,
    action: Parameters<GameAccessPolicy['authorizeRoom']>[2],
    access?: Parameters<GameAccessPolicy['authorizeRoom']>[3],
  ): Promise<boolean> {
    const game = this.releaseGame(room.gameId, room.releaseId);
    if (!(await game.identity.authorizeRoom(principalId, room, action, access)))
      return false;
    const gameAccess = this.gameAccess;
    const required = gameAccess?.requiredEntitlement(
      room.gameId,
      room.releaseId,
    );
    if (!gameAccess || !required) return true;
    const member = room.members.some(
      (candidate) => candidate.principalId === principalId,
    );
    // Existing members keep their room/session controls after revocation. A
    // required entitlement gates only a new room, a new member, or browsing.
    if (action !== 'create' && member) return true;
    if (action !== 'create' && action !== 'join' && action !== 'read')
      return true;
    return gameAccess.allows(room.gameId, room.releaseId, principalId);
  }

  private async authorizeRoomInvite(
    ownerId: string,
    inviteeId: string,
    room: PlatformRoom,
  ): Promise<boolean> {
    if (
      !(await this.releaseGame(
        room.gameId,
        room.releaseId,
      ).identity.authorizeRoomInvite(ownerId, inviteeId, room))
    )
      return false;
    if (!this.gameAccess?.requiredEntitlement(room.gameId, room.releaseId))
      return true;
    return this.gameAccess.allows(room.gameId, room.releaseId, inviteeId);
  }

  currentDatabase(): NodePgDatabase {
    const connection = this.transactionConnection.getStore();
    return connection ? drizzle(connection) : this.options.db;
  }

  /** Installs a protocol client without importing or constructing a game module/Host. */
  async registerRemoteGame(
    registration: RemoteGameRegistration,
  ): Promise<InstalledRemoteGame> {
    return this.registerRemoteGameInternal(registration);
  }

  /** Runs the platform-owned readiness probe for a staged remote binding. */
  async readyRemoteBinding(
    backendBindingId: string,
  ): Promise<ReleaseBindingRecord> {
    if (
      !this.releaseRegistryStore ||
      !this.remoteRuntime ||
      !this.options.platformId
    )
      throw contractError('NOT_READY', 'platform.remote.registry_unavailable');
    const binding = await this.releaseRegistryStore.getBinding(
      this.options.platformId,
      backendBindingId,
    );
    if (!binding)
      throw contractError('NOT_FOUND', 'platform.release.unavailable');
    if (binding.status === 'ready') {
      const release = await this.releaseRegistryStore.getRelease(
        this.options.platformId,
        binding.gameId,
        binding.releaseId,
      );
      if (!release)
        throw contractError('NOT_FOUND', 'platform.release.unavailable');
      // A ready binding is an explicit operator probe, not a cache hit. Build
      // a fresh adapter so credential rotations and endpoint changes take
      // effect even when the registry revision is unchanged.
      const backend = await this.createRemoteBackend(release, binding);
      const ready = await this.probeRemoteReady(backend, release.service);
      await this.remoteRuntime.probeReadiness({
        backend,
        release,
        binding,
        ready: ready.description,
      });
      await this.ensureRemoteBindingLoaded(binding, {
        requireLive: true,
        backend,
        ready,
      });
      return binding;
    }
    if (binding.status !== 'staged')
      throw contractError('CONFLICT', 'platform.release.binding_not_probeable');
    const release = await this.releaseRegistryStore.getRelease(
      this.options.platformId,
      binding.gameId,
      binding.releaseId,
    );
    if (!release)
      throw contractError('NOT_FOUND', 'platform.release.unavailable');
    const credential = await this.remoteRuntime.resolveCredential(
      release,
      binding,
    );
    const backend = new RemoteBackendAdapter({
      baseUrl: binding.controlEndpoint,
      serviceToken: credential.serviceToken,
      ...(credential.allowInsecureLocalhost !== undefined
        ? { allowInsecureLocalhost: credential.allowInsecureLocalhost }
        : {}),
      ...(credential.timeoutMs !== undefined
        ? { timeoutMs: credential.timeoutMs }
        : {}),
    });
    const ready = await this.probeRemoteReady(backend, release.service);
    const evidence = await this.remoteRuntime.probeReadiness({
      backend,
      release,
      binding,
      ready: ready.description,
    });
    const updated = await this.releaseRegistryStore.recordBindingReadiness({
      platformId: this.options.platformId,
      backendBindingId,
      evidence,
      expectedRevision: binding.revision,
    });
    await this.ensureRemoteBindingLoaded(updated, {
      requireLive: true,
      backend,
      ready,
    });
    return updated;
  }

  /**
   * Updates the in-memory publication view after an administrative state
   * transition. This deliberately performs no remote probe: drain/retain/
   * retire are registry operations, and a game may be offline while the
   * platform still serves retained results.
   */
  refreshRemoteBindingMetadata(binding: ReleaseBindingRecord): void {
    if (
      !this.options.platformId ||
      binding.platformId !== this.options.platformId
    )
      throw contractError('FORBIDDEN', 'platform.remote.platform_mismatch');
    const current = this.releaseGames.get(
      this.releaseKey(binding.gameId, binding.releaseId),
    );
    if (!current || !('description' in current) || !current.description) return;
    const modes = current.description.modes;
    if (binding.status === 'retired') {
      this.replaceRemoteBackend(current, unavailableRemoteBackend());
    }
    this.updateRemoteBindingStatus(binding, modes);
  }

  private async registerRemoteGameInternal(
    registration: RemoteGameRegistration,
    options: {
      readonly persistRegistry?: boolean;
      readonly probeReady?: boolean;
      readonly ready?: ReadyResponse;
    } = {},
  ): Promise<InstalledRemoteGame> {
    assertGameServiceDescription(registration.description);
    const description = structuredClone(registration.description);
    if (
      !this.options.platformId ||
      description.platformId !== this.options.platformId
    )
      throw contractError('FORBIDDEN', 'platform.remote.platform_mismatch');
    if (!this.completionStore)
      throw contractError('NOT_READY', 'platform.results.store_unavailable');
    const ready =
      options.ready ??
      (options.probeReady === false
        ? undefined
        : await this.probeRemoteReady(registration.backend, description));
    if (ready) this.assertRemoteReady(ready, description);
    // Recheck after the remote call: concurrent registration must not overwrite a release.
    const releaseKey = this.releaseKey(
      description.gameId,
      description.releaseId,
    );
    if (this.releaseGames.has(releaseKey))
      throw contractError('CONFLICT', 'platform.game.already_registered');
    if (
      [...this.releaseGames.values()].some(
        (game) => game.backendBindingId === description.backendBindingId,
      )
    )
      throw contractError('CONFLICT', 'platform.binding.already_registered');
    const publicModes =
      registration.publicModes ??
      registration.approvedModes ??
      description.modes.map((mode) => mode.id);
    if (
      publicModes.some(
        (id) => !description.modes.some((mode) => mode.id === id),
      )
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.remote.mode_unavailable',
      );
    if (
      description.modes.some((mode) => mode.platformRating) &&
      !registration.policy.rating
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.remote.rating_policy_required',
      );
    if (
      description.modes.some((mode) => mode.platformRating) &&
      (registration.policyBundle === undefined ||
        !registration.approvedPolicyVersions ||
        registration.approvedPolicyVersions.length === 0)
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.remote.settlement_policy_approval_required',
      );
    if (registration.policy.rating && !this.settleCompletionHandler)
      throw contractError(
        'NOT_READY',
        'platform.remote.settlement_unavailable',
      );
    let persistedBinding: ReleaseBindingRecord | undefined;
    let persistedRelease: ReleaseRecord | undefined;
    if (this.releaseRegistry && options.persistRegistry !== false) {
      if (!registration.manifest || !registration.binding)
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.registry_registration_required',
        );
      if (registration.manifest.integration.profile !== 'legacy-service-v1')
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.manifest_profile_invalid',
        );
      if (!registration.approvedFeatures)
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.approval_required',
        );
      if (
        (description.statistics !== undefined) !==
        registration.approvedFeatures.includes('statistics')
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.statistics_approval_required',
        );
      if (!registration.approvedModes)
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.approval_required',
        );
      const approvedModes = registration.approvedModes;
      if (publicModes.some((id) => !approvedModes.includes(id)))
        throw contractError(
          'INVALID_REQUEST',
          'platform.remote.mode_not_approved',
        );
      const release = await this.releaseRegistry.registerRelease({
        platformId: description.platformId,
        manifest: registration.manifest,
        service: description,
        approvedFeatures: registration.approvedFeatures,
        approvedModes,
        ...(registration.policyBundle === undefined
          ? {}
          : { policyBundle: registration.policyBundle }),
        ...(registration.approvedPolicyVersions === undefined
          ? {}
          : { approvedPolicyVersions: registration.approvedPolicyVersions }),
      });
      persistedRelease = release;
      persistedBinding = await this.releaseRegistry.registerBinding({
        platformId: description.platformId,
        gameId: description.gameId,
        releaseId: description.releaseId,
        backendBindingId: description.backendBindingId,
        storageBindingId: description.storageBindingId,
        ownershipEpoch: description.ownershipEpoch,
        ...registration.binding,
      });
      if (persistedBinding.status !== 'ready') {
        if (!ready)
          throw contractError(
            'NOT_READY',
            'platform.remote.readiness_probe_required',
          );
        const readinessProbe =
          registration.readinessProbe ?? this.remoteRuntime?.probeReadiness;
        if (!readinessProbe)
          throw contractError(
            'NOT_READY',
            'platform.remote.readiness_probe_required',
          );
        const evidence = await readinessProbe({
          backend: registration.backend,
          release,
          binding: persistedBinding,
          ready: ready.description,
        });
        const store = this.releaseRegistryStore;
        if (!store)
          throw contractError(
            'NOT_READY',
            'platform.remote.registry_unavailable',
          );
        persistedBinding = await store.recordBindingReadiness({
          platformId: description.platformId,
          backendBindingId: description.backendBindingId,
          evidence,
          expectedRevision: persistedBinding.revision,
        });
      }
    }
    const policy = structuredClone(registration.policy);
    const playerCountField = registration.playerCountField;
    const roomCapacity = registration.roomCapacity ?? description.roomCapacity;
    const installed: InstalledRemoteGame = {
      gameId: description.gameId,
      releaseId: description.releaseId,
      metadata: description.metadata,
      description,
      identity: registration.identity,
      backendBindingId: description.backendBindingId,
      storageBindingId: description.storageBindingId,
      ownershipEpoch: description.ownershipEpoch,
      backend: registration.backend,
      activeBackend: registration.backend,
      publicModes: [...publicModes],
      scopes: [...(registration.scopes ?? [])],
      ...(registration.access ? { access: registration.access } : {}),
      freezePolicy: async (room) => {
        const mode = description.modes.find(
          (candidate) => candidate.id === room.modeId,
        );
        if (!mode)
          throw contractError(
            'INVALID_REQUEST',
            'platform.remote.mode_unavailable',
          );
        return mode.platformRating
          ? structuredClone(policy)
          : { ...structuredClone(policy), rating: null };
      },
      capacity: (room) => {
        const mode = description.modes.find(
          (candidate) => candidate.id === room.modeId,
        );
        if (!mode)
          throw contractError(
            'INVALID_REQUEST',
            'platform.remote.mode_unavailable',
          );
        const count = remoteRoomPlayerCount(
          room.setup,
          mode,
          roomCapacity,
          playerCountField,
        );
        if (
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < mode.minPlayers ||
          count > mode.maxPlayers
        )
          throw contractError(
            'INVALID_REQUEST',
            'platform.remote.capacity_invalid',
          );
        return count;
      },
    };
    try {
      if (
        options.persistRegistry !== false &&
        !this.games.has(description.gameId)
      )
        this.games.set(description.gameId, installed);
      this.releaseGames.set(releaseKey, installed);
      if (persistedBinding)
        for (const mode of description.modes)
          this.remoteBindingStatuses.set(
            this.bindingKey(description.gameId, mode.id, description.releaseId),
            persistedBinding.status,
          );
      if (registration.access) this.registerGameAccess(registration.access);
      this.gameScopes[description.gameId] = [
        ...new Set([
          ...(this.gameScopes[description.gameId] ?? []),
          ...(installed.scopes ?? []),
        ]),
      ];
      for (const mode of description.modes)
        this.bindings.set(
          this.bindingKey(description.gameId, mode.id, description.releaseId),
          {
            gameId: description.gameId,
            releaseId: description.releaseId,
            mode,
            backendBindingId: description.backendBindingId,
            storageBindingId: description.storageBindingId,
            ownershipEpoch: description.ownershipEpoch,
            backend: installed.backend,
            validateSetup: (setup) =>
              assertMatchesSchema(setup, description.setupSchema),
          },
        );
      this.views.registerDefault(
        description.gameId,
        description.releaseId,
        this.sessions,
      );
      this.results.registerRemoteRelease(
        description.gameId,
        description.releaseId,
      );
      if (description.replay) {
        const replay = description.replay;
        this.results.registerReplayQueries(
          description.gameId,
          description.releaseId,
          {
            manifest: () => structuredClone(replay.manifestQuery),
            frames: (from, limit) => ({
              type: replay.framesQueryType,
              from,
              limit,
            }),
          },
        );
      }
      const commands = new GameCommandServiceRegistry<JsonValue>(
        description.gameId,
        description.releaseId,
        (reference, sessionId, input) =>
          this.sessions.command(reference, sessionId, input),
      );
      for (const command of description.commands ?? [])
        commands.register({
          key: command.key,
          operation: command.operation,
          parse: (input) => {
            assertMatchesSchema(input, command.inputSchema);
            return input;
          },
          toCommand: (input) => ({
            type: GAME_SERVICE_COMMAND_TYPE,
            key: command.key,
            input,
          }),
        });
      this.registerCommandServices(
        description.gameId,
        description.releaseId,
        commands,
      );
      await this.remoteSettlementReleaseHook?.({
        gameId: description.gameId,
        releaseId: description.releaseId,
        metadata: description.metadata,
        service: description,
        approvedFeatures:
          persistedRelease?.approvedFeatures ?? registration.approvedFeatures,
        approvedModes:
          persistedRelease?.approvedModes ??
          registration.approvedModes ??
          publicModes,
        approvedPolicyVersions:
          persistedRelease?.approvedPolicyVersions ??
          registration.approvedPolicyVersions ??
          [],
        ...(persistedRelease?.policyBundle !== undefined
          ? { policyBundle: persistedRelease.policyBundle }
          : registration.policyBundle !== undefined
            ? { policyBundle: registration.policyBundle }
            : {}),
      });
      await this.remoteDailyChallengeReleaseHook?.({
        gameId: description.gameId,
        releaseId: description.releaseId,
        service: description,
        approvedModes:
          persistedRelease?.approvedModes ??
          registration.approvedModes ??
          publicModes,
      });
      if (registration.binding)
        this.remoteBindingEndpoints.set(
          releaseKey,
          remoteBindingEndpointFingerprint(registration.binding),
        );
      if (persistedBinding && ready)
        this.remoteBindingLiveRevisions.set(
          releaseKey,
          persistedBinding.revision,
        );
      return installed;
    } catch (error) {
      this.abortGameRegistration(installed);
      throw error;
    }
  }

  /** Atomically selects a ready binding for future admissions. */
  async switchRemoteChannel(
    input: CompareAndSwapChannelInput,
  ): Promise<ChannelRecord> {
    if (
      !this.releaseRegistry ||
      !this.releaseRegistryStore ||
      !this.options.platformId
    )
      throw contractError('NOT_READY', 'platform.remote.registry_unavailable');
    if (input.platformId !== this.options.platformId)
      throw contractError('FORBIDDEN', 'platform.remote.platform_mismatch');
    const binding = await this.releaseRegistryStore.getBinding(
      input.platformId,
      input.targetBackendBindingId,
    );
    if (!binding)
      throw contractError('NOT_FOUND', 'platform.release.unavailable');
    if (binding.gameId !== input.gameId)
      throw contractError('CONFLICT', 'platform.binding.game_mismatch');
    if (binding.status !== 'ready')
      throw contractError('NOT_READY', 'platform.remote.binding_unavailable');
    await this.ensureRemoteBindingLoaded(binding, { requireLive: true });
    const channel = await this.releaseRegistry.compareAndSwapChannel(input);
    await this.syncRemoteGameProjection([input.gameId], {
      deferInfrastructureErrors: true,
    });
    return channel;
  }

  /** Resolves the durable channel before a new room or direct session starts. */
  async channelForNewAdmission(input: {
    readonly gameId: string;
    readonly modeId: string;
    readonly channel: string;
  }): Promise<ChannelRecord> {
    if (
      !this.releaseRegistry ||
      !this.releaseRegistryStore ||
      !this.options.platformId
    )
      throw contractError('NOT_READY', 'platform.remote.registry_unavailable');
    const selected = await this.releaseRegistry.getChannel(
      this.options.platformId,
      input.gameId,
      input.modeId,
      input.channel,
    );
    if (!selected)
      throw contractError('NOT_READY', 'platform.remote.channel_unavailable');
    const binding = await this.releaseRegistryStore.getBinding(
      this.options.platformId,
      selected.targetBackendBindingId,
    );
    if (
      !binding ||
      binding.gameId !== selected.gameId ||
      binding.releaseId !== selected.releaseId ||
      binding.storageBindingId !== selected.storageBindingId ||
      binding.ownershipEpoch !== selected.ownershipEpoch
    )
      throw contractError(
        'CONFLICT',
        'platform.remote.channel_binding_mismatch',
      );
    if (binding.status !== 'ready')
      throw contractError('NOT_READY', 'platform.remote.channel_unavailable');
    await this.ensureRemoteBindingLoaded(binding, { requireLive: true });
    return selected;
  }

  /** Starts a direct session using the durable channel's current release. */
  async createDirectSessionFromChannel(
    principalId: string,
    input: {
      readonly gameId: string;
      readonly modeId: string;
      readonly channel: string;
      readonly setup: JsonValue;
      readonly seed?: string;
      readonly requestId: string;
    },
  ) {
    if (!this.releaseRegistry || !this.options.platformId)
      throw contractError('NOT_READY', 'platform.remote.registry_unavailable');
    const selected = await this.channelForNewAdmission(input);
    return this.admission.createDirectSession(principalId, {
      gameId: input.gameId,
      modeId: input.modeId,
      releaseId: selected.releaseId,
      setup: input.setup,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      requestId: input.requestId,
    });
  }

  /** Rebuilds remote adapters from registry records and injected platform resolvers. */
  async restoreRemoteGames(): Promise<readonly InstalledRemoteGame[]> {
    if (!this.releaseRegistryStore || !this.remoteRuntime)
      throw contractError('NOT_READY', 'platform.remote.restore_unavailable');
    if (!this.options.platformId)
      throw contractError('FORBIDDEN', 'platform.remote.platform_mismatch');
    const bindings = await this.releaseRegistryStore.listBindings(
      this.options.platformId,
    );
    const installed: InstalledRemoteGame[] = [];
    const gameIds = new Set<string>();
    for (const binding of bindings) {
      installed.push(await this.ensureRemoteBindingLoaded(binding));
      gameIds.add(binding.gameId);
    }
    await this.syncRemoteGameProjection([...gameIds]);
    return installed;
  }

  /**
   * Selects the current projection from the durable stable channel only.
   * Retained releases remain available through releaseGame() and exact routes,
   * but never become current merely because they were restored first.
   */
  private async syncRemoteGameProjection(
    gameIds: readonly string[],
    options: {
      readonly deferInfrastructureErrors?: boolean;
      readonly scheduleRecovery?: boolean;
    } = {},
  ): Promise<boolean> {
    if (
      !this.releaseRegistry ||
      !this.releaseRegistryStore ||
      !this.options.platformId
    )
      return true;
    const requestedGameIds = new Set(gameIds);
    if (requestedGameIds.size === 0) return true;
    const deferInfrastructureErrors =
      options.deferInfrastructureErrors === true;
    const scheduleRecovery =
      options.scheduleRecovery === true || deferInfrastructureErrors;
    const generations = new Map<string, number>();
    for (const gameId of requestedGameIds) {
      const generation =
        (this.remoteProjectionGenerations.get(gameId) ?? 0) + 1;
      this.remoteProjectionGenerations.set(gameId, generation);
      generations.set(gameId, generation);
    }
    const isCurrent = (gameId: string): boolean =>
      this.remoteProjectionGenerations.get(gameId) === generations.get(gameId);
    const failInfrastructure = (gameId: string): void => {
      if (!isCurrent(gameId)) return;
      this.clearRemoteGameProjection(gameId, generations.get(gameId));
      if (scheduleRecovery) this.scheduleRemoteProjectionRecovery(gameId);
    };

    let channels: readonly ChannelRecord[];
    try {
      channels = await this.releaseRegistry.listChannels(
        this.options.platformId,
      );
    } catch (error) {
      for (const gameId of requestedGameIds) failInfrastructure(gameId);
      if (deferInfrastructureErrors) return false;
      throw error;
    }
    const selected = new Map<string, ChannelRecord>();
    const ambiguous = new Set<string>();
    for (const channel of channels) {
      if (channel.channel !== 'stable' || !requestedGameIds.has(channel.gameId))
        continue;
      const previous = selected.get(channel.gameId);
      if (
        previous &&
        (previous.releaseId !== channel.releaseId ||
          previous.targetBackendBindingId !== channel.targetBackendBindingId ||
          previous.storageBindingId !== channel.storageBindingId ||
          previous.ownershipEpoch !== channel.ownershipEpoch)
      )
        ambiguous.add(channel.gameId);
      selected.set(channel.gameId, channel);
    }

    let deferredFailure = false;
    for (const gameId of requestedGameIds) {
      if (!isCurrent(gameId)) continue;
      if (ambiguous.has(gameId)) {
        this.clearRemoteGameProjection(gameId, generations.get(gameId));
        this.remoteProjectionRecoveryPending.delete(gameId);
        continue;
      }
      const channel = selected.get(gameId);
      if (!channel) {
        this.clearRemoteGameProjection(gameId, generations.get(gameId));
        this.remoteProjectionRecoveryPending.delete(gameId);
        continue;
      }
      const installed = this.releaseGames.get(
        this.releaseKey(channel.gameId, channel.releaseId),
      );
      if (
        !installed ||
        'host' in installed ||
        installed.backendBindingId !== channel.targetBackendBindingId ||
        installed.storageBindingId !== channel.storageBindingId ||
        installed.ownershipEpoch !== channel.ownershipEpoch
      ) {
        this.clearRemoteGameProjection(gameId, generations.get(gameId));
        this.remoteProjectionRecoveryPending.delete(gameId);
        continue;
      }
      let binding: ReleaseBindingRecord | null;
      try {
        binding = await this.releaseRegistryStore.getBinding(
          this.options.platformId,
          channel.targetBackendBindingId,
        );
      } catch (error) {
        failInfrastructure(gameId);
        if (deferInfrastructureErrors) {
          deferredFailure = true;
          continue;
        }
        throw error;
      }
      if (!isCurrent(gameId)) continue;
      if (
        !binding ||
        binding.status !== 'ready' ||
        binding.gameId !== channel.gameId ||
        binding.releaseId !== channel.releaseId ||
        binding.storageBindingId !== channel.storageBindingId ||
        binding.ownershipEpoch !== channel.ownershipEpoch
      ) {
        this.clearRemoteGameProjection(gameId, generations.get(gameId));
        this.remoteProjectionRecoveryPending.delete(gameId);
        continue;
      }
      this.games.set(gameId, installed);
      this.remoteProjectionRecoveryPending.delete(gameId);
    }
    return !deferredFailure;
  }

  private clearRemoteGameProjection(gameId: string, generation?: number): void {
    if (
      generation !== undefined &&
      this.remoteProjectionGenerations.get(gameId) !== generation
    )
      return;
    const current = this.games.get(gameId);
    if (current && !('host' in current)) this.games.delete(gameId);
  }

  private scheduleRemoteProjectionRecovery(gameId: string): void {
    this.remoteProjectionRecoveryPending.add(gameId);
    if (this.remoteProjectionRecoveryHooks.has(gameId)) return;
    this.remoteProjectionRecoveryHooks.add(gameId);
    this.registerRecoveryHook(`remote-projection:${gameId}`, async () => {
      if (!this.remoteProjectionRecoveryPending.has(gameId)) return;
      await this.syncRemoteGameProjection([gameId], {
        scheduleRecovery: true,
      });
    });
  }

  private async ensureRemoteBindingLoaded(
    binding: ReleaseBindingRecord,
    options: RemoteBindingLoadOptions = {},
  ): Promise<InstalledRemoteGame> {
    if (
      !this.options.platformId ||
      binding.platformId !== this.options.platformId
    )
      throw contractError('FORBIDDEN', 'platform.remote.platform_mismatch');
    const key = this.releaseKey(binding.gameId, binding.releaseId);
    const current = this.releaseGames.get(key);
    const endpointFingerprint = remoteBindingEndpointFingerprint(binding);
    if (current) {
      if (
        !('description' in current) ||
        !current.description ||
        current.backendBindingId !== binding.backendBindingId ||
        current.storageBindingId !== binding.storageBindingId ||
        current.ownershipEpoch !== binding.ownershipEpoch
      )
        throw contractError('CONFLICT', 'platform.release.kind_mismatch');

      const endpointChanged =
        this.remoteBindingEndpoints.get(key) !== undefined &&
        this.remoteBindingEndpoints.get(key) !== endpointFingerprint;
      const firstModeId = current.description.modes[0]?.id;
      const previousStatus = firstModeId
        ? this.remoteBindingStatuses.get(
            this.bindingKey(current.gameId, firstModeId, current.releaseId),
          )
        : undefined;
      if (binding.status === 'retired' && previousStatus !== 'retired') {
        const replacement = this.replaceRemoteBackend(
          current,
          unavailableRemoteBackend(),
        );
        this.remoteBindingEndpoints.set(key, endpointFingerprint);
        this.remoteBindingLiveRevisions.delete(key);
        this.updateRemoteBindingStatus(binding, replacement.description.modes);
        return replacement;
      }
      const needsLiveProbe =
        options.requireLive === true &&
        this.remoteBindingLiveRevisions.get(key) !== binding.revision;
      if (endpointChanged || needsLiveProbe || options.backend) {
        let backend = options.backend;
        if (!backend && endpointChanged) {
          if (!this.releaseRegistryStore || !this.remoteRuntime)
            throw contractError(
              'NOT_READY',
              'platform.remote.restore_unavailable',
            );
          const release = await this.releaseRegistryStore.getRelease(
            binding.platformId,
            binding.gameId,
            binding.releaseId,
          );
          if (!release)
            throw contractError('NOT_FOUND', 'platform.release.unavailable');
          backend = await this.createRemoteBackend(release, binding);
        }
        backend ??= current.backend;
        if (options.requireLive) {
          if (options.ready)
            this.assertRemoteReady(options.ready, current.description);
          else await this.probeRemoteReady(backend, current.description);
        }
        const replacement =
          endpointChanged || options.backend
            ? this.replaceRemoteBackend(current, backend)
            : current;
        this.remoteBindingEndpoints.set(key, endpointFingerprint);
        if (options.requireLive)
          this.remoteBindingLiveRevisions.set(key, binding.revision);
        else if (endpointChanged) this.remoteBindingLiveRevisions.delete(key);
        this.updateRemoteBindingStatus(binding, replacement.description.modes);
        return replacement;
      }
      this.remoteBindingEndpoints.set(key, endpointFingerprint);
      this.updateRemoteBindingStatus(binding, current.description.modes);
      return current;
    }
    if (!this.releaseRegistryStore || !this.remoteRuntime)
      throw contractError('NOT_READY', 'platform.remote.restore_unavailable');
    const release = await this.releaseRegistryStore.getRelease(
      binding.platformId,
      binding.gameId,
      binding.releaseId,
    );
    if (!release)
      throw contractError('NOT_FOUND', 'platform.release.unavailable');
    const policy = await this.remoteRuntime.resolvePolicy(release, binding);
    const backend =
      options.backend ?? (await this.createRemoteBackend(release, binding));
    // Approved modes are immutable release metadata. Binding status controls
    // whether those modes are public; it must not erase the modes while a
    // staged binding is restored, or a later staged -> ready transition would
    // leave the installed release permanently unpublished.
    const publicModes = policy.publicModes ?? release.approvedModes;
    if (publicModes.some((modeId) => !release.approvedModes.includes(modeId)))
      throw contractError('CONFLICT', 'platform.remote.mode_not_approved');
    const installed = await this.registerRemoteGameInternal(
      {
        description: release.service,
        backend,
        identity: policy.identity,
        policy: policy.policy,
        ...(policy.scopes ? { scopes: policy.scopes } : {}),
        publicModes,
        approvedModes: release.approvedModes,
        ...(policy.access ? { access: policy.access } : {}),
        ...(policy.playerCountField
          ? { playerCountField: policy.playerCountField }
          : {}),
        ...(policy.roomCapacity ? { roomCapacity: policy.roomCapacity } : {}),
        manifest: release.manifest,
        approvedFeatures: release.approvedFeatures,
        ...(release.policyBundle === undefined
          ? {}
          : { policyBundle: release.policyBundle }),
        ...(release.approvedPolicyVersions === undefined
          ? {}
          : { approvedPolicyVersions: release.approvedPolicyVersions }),
        binding: {
          deployment: binding.deployment,
          controlEndpoint: binding.controlEndpoint,
          playerEndpoint: binding.playerEndpoint,
          ...(binding.authorizationEndpoint === undefined
            ? {}
            : { authorizationEndpoint: binding.authorizationEndpoint }),
          clientArtifactBaseUrl: binding.clientArtifactBaseUrl,
          serviceCredentialRef: binding.serviceCredentialRef,
        },
      },
      {
        persistRegistry: false,
        probeReady: options.requireLive === true,
        ...(options.ready ? { ready: options.ready } : {}),
      },
    );
    this.remoteBindingEndpoints.set(key, endpointFingerprint);
    if (options.requireLive)
      this.remoteBindingLiveRevisions.set(key, binding.revision);
    this.updateRemoteBindingStatus(binding, release.service.modes);
    return installed;
  }

  private async createRemoteBackend(
    release: ReleaseRecord,
    binding: ReleaseBindingRecord,
  ): Promise<BackendPort> {
    if (binding.status === 'staged' || binding.status === 'retired')
      return unavailableRemoteBackend();
    if (!this.remoteRuntime)
      throw contractError('NOT_READY', 'platform.remote.restore_unavailable');
    const credential = await this.remoteRuntime.resolveCredential(
      release,
      binding,
    );
    return new RemoteBackendAdapter({
      baseUrl: binding.controlEndpoint,
      serviceToken: credential.serviceToken,
      ...(credential.allowInsecureLocalhost !== undefined
        ? { allowInsecureLocalhost: credential.allowInsecureLocalhost }
        : {}),
      ...(credential.timeoutMs !== undefined
        ? { timeoutMs: credential.timeoutMs }
        : {}),
    });
  }

  private updateRemoteBindingStatus(
    binding: ReleaseBindingRecord,
    modes: readonly { readonly id: string }[],
  ): void {
    for (const mode of modes)
      this.remoteBindingStatuses.set(
        this.bindingKey(binding.gameId, mode.id, binding.releaseId),
        binding.status,
      );
  }

  private replaceRemoteBackend(
    current: InstalledRemoteGame,
    backend: BackendPort,
  ): InstalledRemoteGame {
    const replacement: InstalledRemoteGame = {
      ...current,
      backend,
      activeBackend: backend,
    };
    const releaseKey = this.releaseKey(current.gameId, current.releaseId);
    this.releaseGames.set(releaseKey, replacement);
    if (this.games.get(current.gameId) === current)
      this.games.set(current.gameId, replacement);
    for (const [bindingKey, binding] of this.bindings)
      if (
        binding.gameId === current.gameId &&
        binding.releaseId === current.releaseId
      )
        this.bindings.set(bindingKey, { ...binding, backend });
    return replacement;
  }

  private assertRemoteReady(
    ready: ReadyResponse,
    description: GameServiceDescription,
  ): void {
    if (
      !ready.ready ||
      ready.description.protocolMajor !== 1 ||
      !ready.description.features.includes('runtime-description-v1') ||
      canonicalStableStringify(ready.description.service ?? null) !==
        canonicalStableStringify(description)
    )
      throw contractError('NOT_READY', 'platform.remote.description_mismatch');
  }

  private async probeRemoteReady(
    backend: BackendPort,
    description: GameServiceDescription,
  ): Promise<ReadyResponse> {
    let ready: ReadyResponse;
    try {
      ready = await backend.ready({ protocolVersion: 1 });
    } catch (error) {
      if (isPlatformError(error)) throw error;
      throw contractError(
        'NOT_READY',
        'platform.remote.binding_unavailable',
        true,
      );
    }
    this.assertRemoteReady(ready, description);
    return ready;
  }

  registerGame<
    S,
    Setup extends JsonValue,
    Command extends JsonValue,
    View extends JsonValue,
    Event,
    Query extends JsonValue,
    Answer extends JsonValue,
    SystemCommand extends JsonValue,
  >(
    registration: GameRegistration & {
      readonly module: GameModule<
        S,
        Setup,
        Command,
        View,
        Event,
        Query,
        Answer,
        SystemCommand
      >;
    },
  ): InstalledGame {
    if (!this.embeddedGamesEnabled)
      throw contractError('FORBIDDEN', 'platform.embedded.disabled');
    const module = registration.module;
    if (typeof module.turn !== 'function')
      throw contractError('INVALID_REQUEST', 'platform.game.turnRequired');
    if (
      registration.automation?.length &&
      (!module.turn || registration.activeBackend)
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.automation.localHostRequired',
      );
    if (
      registration.metadata.gameId !== module.gameId ||
      this.games.has(module.gameId)
    )
      throw contractError('CONFLICT', 'platform.game.already_registered');
    if (
      [...this.games.values()].some(
        (game) => game.backendBindingId === registration.backendBindingId,
      )
    )
      throw contractError('CONFLICT', 'platform.binding.already_registered');
    this.registry.register(module);
    const host = new GameHost({
      registry: this.registry,
      storage: this.storage,
      backendBindingId: registration.backendBindingId,
      storageBindingId: registration.storageBindingId,
      ...(registration.automation
        ? { automationPolicies: registration.automation }
        : {}),
      ...(registration.resourceStore
        ? { entitlementStore: registration.resourceStore }
        : {}),
      authorize: (access, operation, route, action) =>
        registration.identity.authorizeHost(access, operation, route, action),
    });
    const game = {
      ...registration,
      gameId: module.gameId,
      releaseId: module.releaseId,
      host,
      backend: registration.activeBackend ?? new EmbeddedBackendAdapter(host),
    };
    try {
      this.games.set(module.gameId, game);
      this.releaseGames.set(
        this.releaseKey(module.gameId, module.releaseId),
        game,
      );
      if (registration.access || this.gameAccess)
        this.registerGameAccess(
          registration.access ?? {
            gameId: module.gameId,
            releaseId: module.releaseId,
            entitlements: [
              {
                entitlement: 'play',
                label: 'Play',
                description: 'Access to this game through the platform.',
              },
            ],
          },
        );
      this.gameScopes[module.gameId] = registration.scopes ?? [];
      for (const mode of module.modes)
        this.bindings.set(
          this.bindingKey(module.gameId, mode.id, module.releaseId),
          {
            gameId: module.gameId,
            releaseId: module.releaseId,
            mode,
            backendBindingId: registration.backendBindingId,
            storageBindingId: registration.storageBindingId,
            ownershipEpoch: registration.ownershipEpoch,
            backend: game.backend,
            validateSetup: (setup) =>
              assertMatchesSchema(setup, module.schemas.setup),
          },
        );
      this.views.registerDefault(
        module.gameId,
        module.releaseId,
        this.sessions,
      );
      this.results.registerRelease(module.gameId, module.releaseId);
      return game;
    } catch (error) {
      this.abortGameRegistration(game);
      throw error;
    }
  }

  /** Closes a partially installed game release without touching external services. */
  abortGameRegistration(installed: RegisteredGame): void {
    if (
      this.releaseGames.get(
        this.releaseKey(installed.gameId, installed.releaseId),
      ) !== installed
    )
      return;

    this.releaseGames.delete(
      this.releaseKey(installed.gameId, installed.releaseId),
    );
    if (this.games.get(installed.gameId) === installed) {
      const replacement = [...this.releaseGames.values()].find(
        (game) => game.gameId === installed.gameId,
      );
      if (replacement) this.games.set(installed.gameId, replacement);
      else this.games.delete(installed.gameId);
    }
    this.registry.unregister(installed.gameId, installed.releaseId);
    const accessKey = this.releaseKey(installed.gameId, installed.releaseId);
    if (this.registeredGameAccess.delete(accessKey))
      this.gameAccess?.unregister(installed.gameId, installed.releaseId);
    const remainingScopes = [
      ...new Set(
        [...this.releaseGames.values()]
          .filter((game) => game.gameId === installed.gameId)
          .flatMap((game) => game.scopes ?? []),
      ),
    ];
    if (remainingScopes.length > 0)
      this.gameScopes[installed.gameId] = remainingScopes;
    else delete this.gameScopes[installed.gameId];
    for (const [bindingKey, binding] of this.bindings) {
      if (
        binding.gameId === installed.gameId &&
        binding.releaseId === installed.releaseId
      )
        this.bindings.delete(bindingKey);
    }
    if ('description' in installed && installed.description) {
      for (const mode of installed.description.modes)
        this.remoteBindingStatuses.delete(
          this.bindingKey(installed.gameId, mode.id, installed.releaseId),
        );
    }
    this.commandServiceRegistries.delete(
      this.releaseKey(installed.gameId, installed.releaseId),
    );
    this.remoteBindingEndpoints.delete(
      this.releaseKey(installed.gameId, installed.releaseId),
    );
    this.remoteBindingLiveRevisions.delete(
      this.releaseKey(installed.gameId, installed.releaseId),
    );
    this.views.unregister(installed.gameId, installed.releaseId);
    this.results.unregisterRelease(installed.gameId, installed.releaseId);

    const consumerKeys = [
      this.releaseKey(installed.gameId, installed.releaseId),
      installed.gameId,
    ];
    for (const consumerKey of consumerKeys) {
      const consumerNames = this.gameConsumerNames.get(consumerKey);
      if (!consumerNames) continue;
      for (const name of consumerNames) {
        this.consumers.unregister(name);
        this.consumerNames.delete(name);
      }
      this.gameConsumerNames.delete(consumerKey);
    }
    const recoveryNames = this.gameRecoveryHookNames.get(installed.gameId);
    if (recoveryNames) {
      for (const name of recoveryNames) this.recoveryHooks.delete(name);
      this.gameRecoveryHookNames.delete(installed.gameId);
    }
  }

  game(gameId: string): RegisteredGame {
    const game = this.games.get(gameId);
    if (!game) throw contractError('NOT_FOUND', 'platform.game.unavailable');
    return game;
  }

  /** Resolves one exact release; never falls back to the current game projection. */
  releaseGame(gameId: string, releaseId: string): RegisteredGame {
    const game = this.releaseGames.get(this.releaseKey(gameId, releaseId));
    if (!game) throw contractError('NOT_FOUND', 'platform.release.unavailable');
    return game;
  }

  /** Embedded-only diagnostics fail closed for an independent game process. */
  localGame(gameId: string): InstalledGame {
    const game = this.game(gameId);
    if (!game.host)
      throw contractError(
        'NOT_READY',
        'platform.remote.local_host_unavailable',
      );
    return game;
  }

  accountIdentity(): PlatformAccountIdentity {
    return this.identity;
  }

  registerGameAccess(registration: GameAccessRegistration): void {
    this.releaseGame(registration.gameId, registration.releaseId);
    if (!this.gameAccess)
      throw contractError(
        'NOT_READY',
        'platform.game_access.service_unavailable',
      );
    this.gameAccess.register(registration);
    this.registeredGameAccess.add(
      this.releaseKey(registration.gameId, registration.releaseId),
    );
  }

  catalog() {
    return [...this.bindings.values()]
      .filter((binding) =>
        this.isPublicMode(binding.gameId, binding.mode.id, binding.releaseId),
      )
      .map(({ gameId, releaseId, mode }) => ({
        gameId,
        releaseId,
        mode,
        metadata: this.releaseGame(gameId, releaseId).metadata,
      }));
  }

  publicModeId(gameId: string, modeId: string, releaseId?: string): string {
    if (!this.isPublicMode(gameId, modeId, releaseId))
      throw contractError('INVALID_REQUEST', 'platform.mode.entry_unavailable');
    return modeId;
  }

  private isPublicMode(
    gameId: string,
    modeId: string,
    releaseId?: string,
  ): boolean {
    const game = releaseId
      ? this.releaseGame(gameId, releaseId)
      : this.game(gameId);
    const bindingStatus = this.remoteBindingStatuses.get(
      this.bindingKey(gameId, modeId, game.releaseId),
    );
    if (bindingStatus !== undefined && bindingStatus !== 'ready') return false;
    return game.publicModes
      ? game.publicModes.includes(modeId)
      : this.bindings.has(this.bindingKey(gameId, modeId, game.releaseId));
  }

  private bindingKey(gameId: string, modeId: string, releaseId: string) {
    return JSON.stringify([gameId, modeId, releaseId]);
  }

  private releaseKey(gameId: string, releaseId: string) {
    return JSON.stringify([gameId, releaseId]);
  }

  resolveRelease(
    gameId: string,
    modeId: string,
    releaseId: string,
  ): ReleaseBinding {
    const binding = this.bindings.get(
      this.bindingKey(gameId, modeId, releaseId),
    );
    if (!binding)
      throw contractError('NOT_FOUND', 'platform.release.unavailable');
    return binding;
  }

  resolveBackend(route: SessionRoute): BackendPort {
    const exact = this.releaseGames.get(
      this.releaseKey(route.gameId, route.releaseId),
    );
    if (exact) {
      if (
        route.backendBindingId !== exact.backendBindingId ||
        route.storageBindingId !== exact.storageBindingId ||
        route.ownershipEpoch !== exact.ownershipEpoch
      )
        throw contractError('OWNERSHIP_LOST', 'platform.binding.mismatch');
      return exact.backend;
    }
    const current = this.game(route.gameId);
    if (
      route.backendBindingId === current.backendBindingId &&
      route.releaseId === current.releaseId &&
      route.storageBindingId === current.storageBindingId &&
      route.ownershipEpoch === current.ownershipEpoch
    )
      return current.backend;
    const retained = current.retainedBackends?.get(route.backendBindingId);
    if (!retained)
      throw contractError(
        'NOT_READY',
        'platform.release.host_unavailable',
        true,
      );
    return retained;
  }

  registerCommandServices(
    gameId: string,
    releaseId: string,
    services: GameCommandServiceCollection,
  ): void {
    if (services.gameId !== gameId || services.releaseId !== releaseId)
      throw contractError('CONFLICT', 'platform.command_service.game_mismatch');
    this.releaseGame(gameId, releaseId);
    const registryKey = this.releaseKey(gameId, releaseId);
    if (this.commandServiceRegistries.has(registryKey))
      throw contractError(
        'CONFLICT',
        'platform.command_service.already_registered',
      );
    this.commandServiceRegistries.set(registryKey, services);
  }

  commandServiceRegistry(
    gameId: string,
    releaseId: string,
  ): GameCommandServiceCollection {
    const services = this.commandServiceRegistries.get(
      this.releaseKey(gameId, releaseId),
    );
    if (!services)
      throw contractError('NOT_FOUND', 'platform.command_service.unavailable');
    return services;
  }

  /**
   * Service commands use the same viewer authorization and Host transaction
   * path as ordinary commands. The registry cannot reach storage or a Host
   * head directly.
   */
  async invokeCommandService(
    reference: PlatformIdentityReference,
    sessionId: string,
    key: string,
    request: GameCommandServiceRequest,
  ) {
    const descriptor = await this.sessions.descriptor(reference, sessionId);
    return this.commandServiceRegistry(
      descriptor.route.gameId,
      descriptor.route.releaseId,
    ).invoke(reference, sessionId, key, request);
  }

  registerFactConsumer(
    name: string,
    consume: (envelope: InboxEnvelope) => Promise<void>,
    gameId?: string,
    releaseId?: string,
  ): void {
    this.consumers.registerExternal(name, async (envelope) => {
      if (gameId) {
        if (!envelope.sessionId) return;
        const admission = await this.admissionStore.getAdmission(
          envelope.sessionId,
        );
        if (!admission)
          throw contractError('NOT_FOUND', 'platform.admission.missing');
        if (
          admission.route.gameId !== gameId ||
          (releaseId !== undefined && admission.route.releaseId !== releaseId)
        )
          return;
      }
      await consume(envelope);
    });
    this.consumerNames.add(name);
    if (gameId) {
      const consumerKey = releaseId
        ? this.releaseKey(gameId, releaseId)
        : gameId;
      const names =
        this.gameConsumerNames.get(consumerKey) ?? new Set<string>();
      names.add(name);
      this.gameConsumerNames.set(consumerKey, names);
    }
  }

  onSessionChanged(listener: (sessionId: string, revision: number) => void) {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onAccountChanged(listener: (principalIds: readonly string[]) => void) {
    this.accountChangeListeners.add(listener);
    return () => {
      this.accountChangeListeners.delete(listener);
    };
  }

  notifyAccountsChanged(principalIds: readonly string[]) {
    const unique = [
      ...new Set(
        principalIds.filter(
          (principalId): principalId is string =>
            typeof principalId === 'string' && principalId.length > 0,
        ),
      ),
    ];
    if (unique.length === 0) return;
    for (const listener of this.accountChangeListeners) {
      try {
        listener(unique);
      } catch {
        /* Cache invalidation is a best-effort hint after a committed change. */
      }
    }
  }

  /** Emits a best-effort hint for admission mutations performed by callers. */
  async notifyRoomChanged(roomId: string, actorId?: string): Promise<void> {
    try {
      const [room, access] = await Promise.all([
        this.admissionStore.getRoom(roomId),
        this.admissionStore.getRoomAccess(roomId),
      ]);
      this.notifyAccountsChanged([
        ...(actorId ? [actorId] : []),
        ...(room
          ? [
              room.ownerId,
              ...room.members.flatMap(
                (member) => participantAccountId(member) ?? [],
              ),
            ]
          : []),
        ...(access?.grants.map((grant) => grant.principalId) ?? []),
      ]);
    } catch {
      if (actorId) this.notifyAccountsChanged([actorId]);
    }
  }

  notifyChanged(sessionId: string, revision: number) {
    for (const listener of this.changeListeners) {
      try {
        listener(sessionId, revision);
      } catch {
        /* Polling resumes after a lost hint. */
      }
    }
  }

  async listSessions(
    reference: PlatformIdentityReference,
    scope: 'mine' | 'public',
    options: SessionDirectoryListOptions = {},
  ) {
    const resolved = await this.accountIdentity().resolveCurrent(reference);
    const { identity } = resolved;
    // Public browsing selects one registered game, keeping cursors stable.
    const gameId =
      options.gameId ??
      this.options.defaultGameId ??
      this.games.keys().next().value;
    const page =
      scope === 'mine'
        ? await this.directory.listForPrincipal(identity.principalId, options)
        : await this.directory.listPublic(
            this.game(gameId ?? '').gameId,
            options,
          );
    const admissions = await this.admissionStore.getAdmissions(
      page.items.map((session) => session.sessionId),
    );
    const visible = [];
    for (const session of page.items) {
      const admission = admissions.get(session.sessionId);
      if (
        admission &&
        (await this.releaseGame(
          admission.route.gameId,
          admission.route.releaseId,
        ).identity.authorize(identity, admission, 'view', [], resolved))
      )
        visible.push(session);
    }
    return { ...page, items: visible };
  }

  registerRecoveryHook(
    name: string,
    recover: () => Promise<void>,
    gameId?: string,
  ): void {
    if (this.recoveryHooks.has(name))
      throw contractError('CONFLICT', 'platform.recovery.already_registered');
    this.recoveryHooks.set(name, recover);
    if (gameId) {
      const names = this.gameRecoveryHookNames.get(gameId) ?? new Set<string>();
      names.add(name);
      this.gameRecoveryHookNames.set(gameId, names);
    }
  }

  async recoverOnce() {
    const starts = await this.admission.recoverPending(20);
    const delivery = await this.dispatcher.dispatchOnce();
    const consumers = [];
    for (const name of this.consumerNames)
      consumers.push(await this.consumers.runOnce(name, { limit: 100 }));
    const completions = [];
    if (this.completionStore) {
      for (let index = 0; index < 100; index += 1) {
        const claim = await this.completionStore.claimNext({
          owner: this.completionWorkerId,
        });
        if (!claim) break;
        try {
          await this.completionStore.processClaim(claim, {
            ...(this.settleCompletionHandler
              ? { settle: this.settleCompletionHandler }
              : {}),
          });
          completions.push({
            sessionId: claim.record.sessionId,
            failed: false,
          });
        } catch {
          completions.push({ sessionId: claim.record.sessionId, failed: true });
        }
      }
    }
    const timers = [];
    const resources = [];
    for (const game of this.games.values()) {
      if (!game.host || game.activeBackend) continue;
      timers.push(
        ...(await game.host.tickSystemCommands(
          (route) => game.identity.systemAccess(route),
          100,
          { kind: 'system' },
        )),
      );
      resources.push(...(await game.host.reconcileResources(100)));
    }
    const maintenance = [];
    for (const [name, recover] of this.recoveryHooks) {
      try {
        await recover();
        maintenance.push({ name, failed: false });
      } catch {
        maintenance.push({ name, failed: true });
      }
    }
    return {
      starts,
      delivery,
      consumers,
      completions,
      timers,
      resources,
      maintenance,
    };
  }

  /** Slow policies run separately from clocks, Outbox delivery and maintenance. */
  recoverAutomationOnce(): Promise<readonly SystemTickResult[]> {
    if (this.draining) return Promise.resolve([]);
    if (this.automationRecovery) return this.automationRecovery;
    const games = [...this.games.values()].filter(
      (game): game is InstalledGame =>
        Boolean(game.host) && !game.activeBackend,
    );
    const results: SystemTickResult[][] = new Array(games.length);
    let next = 0;
    const scan = async (): Promise<void> => {
      while (next < games.length) {
        const index = next++;
        const game = games[index];
        if (!game) continue;
        results[index] = [
          ...(await game.host.tickSystemCommands(
            (route) => game.identity.systemAccess(route),
            4,
            { kind: 'automation' },
          )),
        ];
      }
    };
    // Each Host processes its bounded batch serially, so this caps policy
    // computations across installed games while retaining per-session fencing.
    this.automationRecovery = Promise.allSettled(
      Array.from({ length: Math.min(4, games.length) }, scan),
    )
      .then((scans) => {
        const failed = scans.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return results.flat();
      })
      .finally(() => {
        this.automationRecovery = undefined;
      });
    return this.automationRecovery;
  }

  async drain() {
    this.draining = true;
    await this.automationRecovery?.catch(() => undefined);
    await Promise.all(
      [...this.games.values()].flatMap((game) =>
        game.host ? [game.host.drain()] : [],
      ),
    );
  }
}
