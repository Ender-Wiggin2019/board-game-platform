import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { URL } from 'node:url';
import {
  type AccessContext,
  assertMatchesSchema,
  contractError,
  type GameServiceDescription,
  isJsonValue,
  type JsonValue,
  participantAccountId,
  type SessionRoute,
  toErrorEnvelope,
} from '@board-game/contracts';
import {
  AdmissionCoordinator,
  type AdmissionStore,
  type FactDelivery,
  type FactDeliveryAck,
  type InboxStore,
  MemoryAdmissionStore,
  MemoryInboxStore,
  MemorySessionDirectory,
  type PlatformIdentityReference,
  PostgresAdmissionStore,
  PostgresInboxStore,
  PostgresSessionDirectory,
  type ResolvedIdentity,
  type SessionDirectoryEnvelope,
  type SessionDirectoryStore,
  SessionGateway,
} from '@board-game/core';
import type { GameHostOptions } from '@board-game/host';
import {
  createGameServerRunner,
  type GameServerDefinition,
  type GameServerManifest,
  type GameServerRunner,
} from '@board-game/server';
import {
  MemoryStorageDriver,
  PostgresStorageDriver,
  type StorageDriver,
} from '@board-game/storage';
import type {
  DevelopmentAccount,
  DevelopmentHost,
  DevelopmentHostOptions,
  DevelopmentIdentity,
  DevelopmentScenario,
  DevelopmentScenarioCommand,
} from './types.js';

const LOOPBACK_HOST = '127.0.0.1' as const;
const DEFAULT_PORT = 0;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DIRECTORY_FACTS = new Set([
  'SessionCreated',
  'SessionActivated',
  'SessionSummaryChanged',
  'SessionCompleted',
  'SessionControlled',
]);

const UI_ASSETS = {
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/assets/dev-host.js': {
    file: 'dev-host.js',
    contentType: 'text/javascript; charset=utf-8',
  },
  '/assets/dev-host.css': {
    file: 'dev-host.css',
    contentType: 'text/css; charset=utf-8',
  },
} as const;

const ACCOUNT_DEFINITIONS: readonly DevelopmentAccount[] = [
  { principalId: 'player1', role: 'player', displayName: 'Player 1' },
  { principalId: 'player2', role: 'player', displayName: 'Player 2' },
  { principalId: 'player3', role: 'player', displayName: 'Player 3' },
  { principalId: 'player4', role: 'player', displayName: 'Player 4' },
  { principalId: 'observer', role: 'observer', displayName: 'Observer' },
  { principalId: 'admin', role: 'admin', displayName: 'Admin' },
];

type AccountState = DevelopmentAccount & {
  epoch: number;
  token?: string;
};

function copy<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw contractError('INVALID_REQUEST', key);
  return value;
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw contractError('INVALID_REQUEST', key);
  return value;
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, key);
}

function requireInteger(value: unknown, key: string, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw contractError('INVALID_REQUEST', key);
  return value;
}

function jsonValue(value: unknown, key: string): JsonValue {
  if (!isJsonValue(value)) throw contractError('INVALID_REQUEST', key);
  return value;
}

function statusForError(
  code: ReturnType<typeof toErrorEnvelope>['code'],
): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'SESSION_CLOSED':
      return 410;
    case 'NOT_READY':
      return 503;
    case 'STALE_REVISION':
    case 'IDEMPOTENCY_CONFLICT':
    case 'OWNERSHIP_LOST':
    case 'CONFLICT':
      return 409;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function sendAsset(
  response: ServerResponse,
  contentType: string,
  body: Buffer,
): void {
  response.statusCode = 200;
  response.setHeader('content-type', contentType);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', body.byteLength);
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw contractError('PAYLOAD_TOO_LARGE', 'dev-host.request.body');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw contractError('INVALID_REQUEST', 'dev-host.request.json');
  }
}

function queryInteger(
  url: URL,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw contractError('INVALID_REQUEST', `dev-host.query.${name}`);
  return value;
}

function ack(envelope: {
  readonly envelopeKey: string;
  readonly producerId: string;
  readonly eventId: string;
  readonly digest: string;
}): FactDeliveryAck {
  return {
    envelopeKey: envelope.envelopeKey,
    producerId: envelope.producerId,
    eventId: envelope.eventId,
    digest: envelope.digest,
  };
}

class DevelopmentAccounts {
  private readonly states = new Map<string, AccountState>(
    ACCOUNT_DEFINITIONS.map((account) => [
      account.principalId,
      { ...account, epoch: 0 },
    ]),
  );
  private readonly tokens = new Map<string, AccountState>();

  get all(): readonly DevelopmentAccount[] {
    return ACCOUNT_DEFINITIONS;
  }

  get(principalId: string): AccountState {
    const account = this.states.get(principalId);
    if (!account) throw contractError('NOT_FOUND', 'dev-host.account.notFound');
    return account;
  }

  select(principalId: string): {
    readonly token: string;
    readonly account: DevelopmentAccount;
    readonly authEpoch: string;
  } {
    const account = this.get(principalId);
    if (account.token) this.tokens.delete(account.token);
    account.epoch += 1;
    const token = randomBytes(32).toString('base64url');
    account.token = token;
    this.tokens.set(token, account);
    return {
      token,
      account: this.publicAccount(account),
      authEpoch: this.epoch(account),
    };
  }

  ensure(principalId: string): string {
    const account = this.get(principalId);
    return account.token ?? this.select(principalId).token;
  }

  resolveToken(token: string): AccountState {
    const account = this.tokens.get(token);
    if (!account || account.token !== token)
      throw contractError('UNAUTHENTICATED', 'dev-host.auth.invalid');
    return account;
  }

  resolveReference(reference: PlatformIdentityReference): ResolvedIdentity {
    const account = this.resolveToken(reference.authSessionId);
    if (account.principalId !== reference.principalId)
      throw contractError('UNAUTHENTICATED', 'dev-host.auth.principal');
    return {
      principalId: account.principalId,
      authEpoch: this.epoch(account),
      active: true,
    };
  }

  reference(principalId: string, seatId?: string): DevelopmentIdentity {
    const account = this.get(principalId);
    const token = this.ensure(principalId);
    return {
      account: this.publicAccount(account),
      principalId,
      authSessionId: token,
      ...(seatId !== undefined ? { seatId } : {}),
    };
  }

  access(principalId: string, scopes: readonly string[]): AccessContext {
    const account = this.get(principalId);
    return {
      principalId,
      authEpoch: this.epoch(account),
      scopes: [...scopes],
    };
  }

  rotateAll(): void {
    for (const account of this.states.values()) {
      if (account.token) this.tokens.delete(account.token);
      account.token = undefined;
      account.epoch += 1;
    }
  }

  private epoch(account: AccountState): string {
    return `dev:${account.principalId}:${account.epoch}`;
  }

  private publicAccount(account: AccountState): DevelopmentAccount {
    return {
      principalId: account.principalId,
      role: account.role,
      displayName: account.displayName,
    };
  }
}

function postgresSchemaPrefix(gameId: string, releaseId: string): string {
  const digest = createHash('sha256')
    .update(`${gameId}\0${releaseId}`)
    .digest('hex')
    .slice(0, 20);
  return `bgp_dev_${digest}`;
}

interface DurableStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

type DefinitionFor<
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
> = GameServerDefinition<
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

class DevelopmentHostImpl<
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
> implements DevelopmentHost<Command>
{
  readonly admission: AdmissionStore;
  readonly directory: SessionDirectoryStore;
  readonly inbox: InboxStore;
  readonly runner: GameServerRunner<Command>;
  readonly sessionGateway: SessionGateway;
  readonly coordinator: AdmissionCoordinator;
  readonly accounts: readonly DevelopmentAccount[];
  readonly metadata: {
    readonly mode: 'development';
    readonly host: '127.0.0.1';
    readonly storageProfile: 'memory' | 'postgres';
    readonly clientModuleUrl?: string;
  };

  private readonly definition: DefinitionFor<
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
  private readonly description: GameServiceDescription;
  private readonly accountsState = new DevelopmentAccounts();
  private readonly scenarios: readonly DevelopmentScenario<Command, Setup>[];
  private readonly scenarioByRoom = new Map<string, string>();
  private readonly scenarioSeedByRoom = new Map<string, string>();
  private readonly seed: string;
  private readonly port: number;
  private readonly storage: StorageDriver;
  private readonly migrateStores: readonly DurableStore[];
  private readonly closeStores: readonly Pick<DurableStore, 'close'>[];
  private server?: Server;
  private started = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private baseUrl?: string;

  constructor(
    options: DevelopmentHostOptions<
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
    if (options.mode === 'production')
      throw contractError('INVALID_REQUEST', 'dev-host.production_unsupported');
    const storageProfile = options.storageProfile ?? 'memory';
    if (storageProfile === 'postgres' && !options.databaseUrl?.trim())
      throw contractError(
        'NOT_READY',
        'dev-host.postgres_database_url_required',
      );
    if (options.port !== undefined) {
      if (
        !Number.isSafeInteger(options.port) ||
        options.port < 0 ||
        options.port > 65_535
      )
        throw contractError('INVALID_REQUEST', 'dev-host.port.invalid');
    }
    this.definition = options.definition;
    this.description = copy(options.description);
    this.scenarios = copy(options.scenarios ?? []);
    this.seed = options.seed ?? 'development-seed-v1';
    this.port = options.port ?? DEFAULT_PORT;
    this.accounts = this.accountsState.all;
    this.metadata = {
      mode: 'development',
      host: LOOPBACK_HOST,
      storageProfile,
      ...(options.clientModuleUrl !== undefined
        ? { clientModuleUrl: options.clientModuleUrl }
        : {}),
    };
    this.validateScenarios();

    if (storageProfile === 'postgres') {
      const schemaPrefix = postgresSchemaPrefix(
        this.description.gameId,
        this.description.releaseId,
      );
      const connectionString = options.databaseUrl as string;
      const admission = new PostgresAdmissionStore({
        connectionString,
        schema: `${schemaPrefix}_admission`,
      });
      const inbox = new PostgresInboxStore({
        connectionString,
        schema: `${schemaPrefix}_inbox`,
      });
      const storage = new PostgresStorageDriver({
        connectionString,
        schema: `${schemaPrefix}_storage`,
      });
      const directory = new PostgresSessionDirectory({
        connectionString,
        schema: `${schemaPrefix}_directory`,
        admission,
        retentionResolver: (admissionValue) =>
          admissionValue.historyPolicy ?? 'summary-and-replay',
      });
      this.admission = admission;
      this.inbox = inbox;
      this.directory = directory;
      this.storage = storage;
      this.migrateStores = [admission, inbox, storage, directory];
      // GameServerRunner owns storage and inbox and closes them during runner.close().
      // The dev host owns the admission and directory stores.
      this.closeStores = [admission, directory];
    } else {
      const admission = new MemoryAdmissionStore();
      const inbox = new MemoryInboxStore();
      const directory = new MemorySessionDirectory({
        admission,
        retentionResolver: (admissionValue) =>
          admissionValue.historyPolicy ?? 'summary-and-replay',
      });
      this.admission = admission;
      this.inbox = inbox;
      this.directory = directory;
      this.storage = new MemoryStorageDriver();
      this.migrateStores = [];
      this.closeStores = [directory];
    }

    const resolveMode = (modeId: string) => {
      const mode = this.description.modes.find(
        (candidate) => candidate.id === modeId,
      );
      if (!mode) throw contractError('NOT_FOUND', 'dev-host.mode.notFound');
      return mode;
    };
    const resolveRelease = (
      gameId: string,
      modeId: string,
      releaseId: string,
    ) => {
      const mode = resolveMode(modeId);
      if (
        gameId !== this.description.gameId ||
        releaseId !== this.description.releaseId
      )
        throw contractError('NOT_FOUND', 'dev-host.release.notFound');
      return {
        gameId: this.description.gameId,
        releaseId: this.description.releaseId,
        mode,
        backendBindingId: this.description.backendBindingId,
        storageBindingId: this.description.storageBindingId,
        ownershipEpoch: this.description.ownershipEpoch,
        backend: this.runner.backend,
        validateSetup: (setup: JsonValue) =>
          assertMatchesSchema(setup, this.description.setupSchema),
      };
    };
    const resolveBackend = (route: SessionRoute) => {
      if (
        route.gameId !== this.description.gameId ||
        route.releaseId !== this.description.releaseId ||
        route.backendBindingId !== this.description.backendBindingId ||
        route.storageBindingId !== this.description.storageBindingId ||
        route.ownershipEpoch !== this.description.ownershipEpoch
      )
        throw contractError('OWNERSHIP_LOST', 'dev-host.route.mismatch');
      resolveMode(route.modeId);
      return this.runner.backend;
    };

    const authorize: GameHostOptions['authorize'] = async (
      context,
      operation,
      route,
    ) => {
      if (
        route.gameId !== this.description.gameId ||
        route.releaseId !== this.description.releaseId ||
        route.backendBindingId !== this.description.backendBindingId ||
        route.storageBindingId !== this.description.storageBindingId ||
        route.ownershipEpoch !== this.description.ownershipEpoch
      )
        throw contractError('OWNERSHIP_LOST', 'dev-host.route.mismatch');
      const account = this.accountsState.get(context.principalId);
      if (
        context.authEpoch !==
        this.accountsState.access(account.principalId, []).authEpoch
      )
        throw contractError('UNAUTHENTICATED', 'dev-host.auth.epoch');
      if (operation === 'developer-console') {
        if (
          account.role !== 'admin' ||
          context.scopes.length !== 2 ||
          !context.scopes.includes('session:admin') ||
          !context.scopes.includes('session:developer')
        )
          throw contractError('FORBIDDEN', 'dev-host.developer.denied');
        return;
      }
      const scope =
        operation === 'create' || operation === 'activate'
          ? 'session:create'
          : operation === 'system'
            ? 'session:system'
            : operation === 'command'
              ? 'session:command'
              : 'session:view';
      if (!context.scopes.includes(scope))
        throw contractError('FORBIDDEN', 'dev-host.auth.scope');
    };

    const systemAccess = async (route: SessionRoute): Promise<AccessContext> =>
      this.accountsState.access('admin', [
        'session:system',
        'session:create',
        'session:command',
        'session:view',
      ]);

    const factReceiver = {
      ingest: async (delivery: FactDelivery): Promise<FactDeliveryAck> => {
        const envelope = await this.inbox.accept(delivery.fact);
        if (DIRECTORY_FACTS.has(envelope.kind))
          await this.directory.applyFact(envelope as SessionDirectoryEnvelope);
        return ack(envelope);
      },
    };

    this.runner = createGameServerRunner({
      definition: this.definition,
      description: this.description,
      mode: 'development',
      storage: this.storage,
      inbox: this.inbox,
      factReceiver,
      authorize,
      systemAccess,
    });

    this.sessionGateway = new SessionGateway({
      admission: this.admission,
      resolveIdentity: (reference) =>
        this.accountsState.resolveReference(reference),
      authorize: async (identity, admission, operation) => {
        const participant = admission.participants.some(
          (candidate) =>
            participantAccountId(candidate) === identity.principalId,
        );
        if (operation === 'command') return participant;
        return (
          participant ||
          identity.principalId === 'observer' ||
          identity.principalId === 'admin'
        );
      },
      createAccess: (identity, admission, operation) => {
        const participant = admission.participants.some(
          (candidate) =>
            participantAccountId(candidate) === identity.principalId,
        );
        return participant
          ? ['session:view', 'session:command']
          : ['session:view', 'session:spectate'];
      },
      resolveBackend,
    });

    this.coordinator = new AdmissionCoordinator({
      store: this.admission,
      resolveRelease,
      resolveBackend,
      authorize: async (principalId) => {
        this.accountsState.get(principalId);
        return true;
      },
      freezePolicy: async (room) => {
        const mode = resolveMode(room.modeId);
        return {
          rating: mode.platformRating
            ? {
                poolId: `dev:${this.description.gameId}:${mode.id}`,
                policyVersion: 'development-v1',
                progressionPolicyVersion: 'development-v1',
                seasonId: null,
              }
            : null,
          validityPolicyVersion: 'development-v1',
        };
      },
      freezeSeed: async (room) =>
        `${this.scenarioSeedByRoom.get(room.id) ?? this.seed}:${room.id}`,
      freezeParticipants: async (room) =>
        room.members.map(({ ready: _ready, ...participant }) => participant),
      automaticStart: () => false,
      accessForStart: async (operation) => systemAccess(operation.route),
    });
  }

  get baseURL(): string | undefined {
    return this.baseUrl;
  }

  async start(): Promise<string> {
    if (this.closed) throw contractError('NOT_READY', 'dev-host.closed');
    if (this.started && this.baseUrl) return this.baseUrl;
    this.started = true;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    try {
      for (const store of this.migrateStores) await store.migrate();
      await this.runner.start();
      await new Promise<void>((resolve, reject) => {
        const server = this.server;
        if (!server)
          return reject(new Error('development host server missing'));
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: LOOPBACK_HOST, port: this.port });
      });
      const address = this.server.address();
      if (!address || typeof address === 'string')
        throw contractError('NOT_READY', 'dev-host.address');
      this.baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
      return this.baseUrl;
    } catch (error) {
      await this.runner.close();
      await Promise.all(this.closeStores.map((store) => store.close())).catch(
        () => undefined,
      );
      this.started = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.server) {
        const server = this.server;
        await new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        });
        this.server = undefined;
      }
      await this.runner.close();
      await Promise.all(this.closeStores.map((store) => store.close()));
      this.baseUrl = undefined;
    })();
    return this.closePromise;
  }

  private validateScenarios(): void {
    const ids = new Set<string>();
    for (const scenario of this.scenarios) {
      if (
        !isRecord(scenario) ||
        typeof scenario.id !== 'string' ||
        scenario.id.length === 0 ||
        ids.has(scenario.id) ||
        !isJsonValue(scenario.setup)
      )
        throw contractError('INVALID_REQUEST', 'dev-host.scenario.invalid');
      ids.add(scenario.id);
      if (scenario.seed !== undefined)
        requireString(scenario.seed, 'dev-host.scenario.seed');
      for (const command of scenario.commands ?? []) {
        if (!isRecord(command) || !isJsonValue(command.command))
          throw contractError('INVALID_REQUEST', 'dev-host.scenario.command');
        if (command.principalId !== undefined)
          this.accountsState.get(command.principalId);
      }
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.method === 'GET') {
        // The cockpit is a public, identity-free asset; the API guard below
        // protects every bearer-bearing or state-changing request.
        const asset =
          UI_ASSETS[request.url?.split('?')[0] as keyof typeof UI_ASSETS];
        if (asset) {
          const body = await readFile(
            new URL(`../assets/${asset.file}`, import.meta.url),
          );
          sendAsset(response, asset.contentType, body);
          return;
        }
      }
      this.assertRequestOrigin(request);
      const result = await this.route(request);
      sendJson(response, 200, result ?? { ok: true });
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      sendJson(response, statusForError(envelope.code), { error: envelope });
    }
  }

  private assertRequestOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.baseUrl)
      throw contractError('FORBIDDEN', 'dev-host.origin.denied');
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site')
      throw contractError('FORBIDDEN', 'dev-host.origin.denied');
    if (request.method === 'OPTIONS')
      throw contractError('FORBIDDEN', 'dev-host.cors.unsupported');
  }

  private async route(request: IncomingMessage): Promise<unknown> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    if (method === 'GET' && url.pathname === '/v1/health')
      return { ready: !this.closed, mode: 'development', host: LOOPBACK_HOST };
    if (method === 'GET' && url.pathname === '/v1/ready')
      return this.runner.backend.ready({ protocolVersion: 1 });
    if (method === 'GET' && url.pathname === '/v1/accounts')
      return { accounts: this.accounts };
    if (method === 'POST' && parts.join('/') === 'v1/auth/select')
      return this.selectAccount(await readJson(request));
    if (method === 'GET' && url.pathname === '/v1/metadata')
      return {
        metadata: copy(this.description.metadata),
        description: copy(this.description),
        ...copy(this.metadata),
      };
    if (method === 'GET' && url.pathname === '/v1/scenarios')
      return { scenarios: copy(this.scenarios) };

    const identity = this.identityFromRequest(request);
    if (method === 'GET' && parts.join('/') === 'v1/rooms')
      return this.coordinator.listRooms(identity.principalId, {
        gameId: this.description.gameId,
      });
    if (method === 'POST' && parts.join('/') === 'v1/rooms')
      return this.createRoom(identity, await readJson(request));
    if (parts[0] === 'v1' && parts[1] === 'rooms' && parts[2])
      return this.roomRoute(method, parts[2], identity, request);
    if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2])
      return this.sessionRoute(
        method,
        parts[2],
        parts.slice(3),
        identity,
        request,
        url,
      );
    throw contractError('NOT_FOUND', 'dev-host.route.notFound');
  }

  private selectAccount(value: unknown): unknown {
    const body = requireRecord(value, 'dev-host.auth.body');
    const principalId = requireString(
      body.principalId,
      'dev-host.auth.principal',
    );
    const selected = this.accountsState.select(principalId);
    return {
      token: selected.token,
      authSessionId: selected.token,
      authEpoch: selected.authEpoch,
      account: selected.account,
    };
  }

  private identityFromRequest(
    request: IncomingMessage,
    seatId?: string,
  ): DevelopmentIdentity {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      throw contractError('UNAUTHENTICATED', 'dev-host.auth.required');
    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0)
      throw contractError('UNAUTHENTICATED', 'dev-host.auth.required');
    const account = this.accountsState.resolveToken(token);
    return {
      account: {
        principalId: account.principalId,
        role: account.role,
        displayName: account.displayName,
      },
      principalId: account.principalId,
      authSessionId: token,
      ...(seatId !== undefined ? { seatId } : {}),
    };
  }

  private async createRoom(
    identity: DevelopmentIdentity,
    value: unknown,
  ): Promise<unknown> {
    const body = requireRecord(value, 'dev-host.room.body');
    const modeId =
      optionalString(body.modeId, 'dev-host.room.mode') ??
      this.description.modes[0]?.id;
    if (!modeId) throw contractError('NOT_FOUND', 'dev-host.mode.notFound');
    const mode = this.description.modes.find(
      (candidate) => candidate.id === modeId,
    );
    if (!mode) throw contractError('NOT_FOUND', 'dev-host.mode.notFound');
    const scenarioId = optionalString(
      body.scenarioId,
      'dev-host.room.scenario',
    );
    const scenario = scenarioId
      ? this.scenarios.find((candidate) => candidate.id === scenarioId)
      : undefined;
    if (scenarioId && !scenario)
      throw contractError('NOT_FOUND', 'dev-host.scenario.notFound');
    const setup = jsonValue(
      body.setup ?? scenario?.setup ?? {},
      'dev-host.room.setup',
    );
    const visibility = body.visibility ?? 'public';
    if (visibility !== 'public' && visibility !== 'private')
      throw contractError('INVALID_REQUEST', 'dev-host.room.visibility');
    const requestedSeed = optionalString(body.seed, 'dev-host.room.seed');
    const seed =
      requestedSeed ?? (mode.platformRating ? undefined : scenario?.seed);
    if (mode.entry === 'direct-solo') {
      const requestId =
        optionalString(body.requestId, 'dev-host.start.requestId') ??
        `dev-direct:${randomUUID()}`;
      const start = await this.coordinator.createDirectSession(
        identity.principalId,
        {
          gameId: this.description.gameId,
          modeId,
          releaseId: this.description.releaseId,
          setup,
          requestId,
          ...(seed !== undefined ? { seed } : {}),
        },
      );
      await this.runner.recoverOnce();
      const room = await this.admission.getRoom(start.roomId);
      if (!room) throw contractError('NOT_FOUND', 'dev-host.room.notFound');
      if (scenario) await this.applyScenario(start.sessionId, scenario);
      return {
        room,
        start,
        ...(scenario ? { scenarioId: scenario.id } : {}),
      };
    }
    const room = await this.coordinator.createRoom(identity.principalId, {
      gameId: this.description.gameId,
      modeId,
      releaseId: this.description.releaseId,
      visibility,
      setup,
      ...(seed !== undefined ? { seed } : {}),
    });
    if (scenario) {
      this.scenarioByRoom.set(room.id, scenario.id);
      if (
        scenario.seed !== undefined &&
        mode.platformRating &&
        requestedSeed === undefined
      )
        this.scenarioSeedByRoom.set(room.id, scenario.seed);
    }
    return { room, ...(scenario ? { scenarioId: scenario.id } : {}) };
  }

  private async roomRoute(
    method: string,
    roomId: string,
    identity: DevelopmentIdentity,
    request: IncomingMessage,
  ): Promise<unknown> {
    if (method === 'GET')
      return this.coordinator.getRoom(identity.principalId, roomId);
    const body = requireRecord(await readJson(request), 'dev-host.room.body');
    if (method === 'POST' && request.url?.includes('/join'))
      return this.coordinator.joinRoom(
        identity.principalId,
        roomId,
        requireInteger(body.expectedRevision, 'dev-host.room.revision'),
      );
    if (method === 'POST' && request.url?.includes('/ready')) {
      const ready = body.ready === undefined ? true : body.ready;
      if (typeof ready !== 'boolean')
        throw contractError('INVALID_REQUEST', 'dev-host.room.ready');
      return this.coordinator.ready(
        identity.principalId,
        roomId,
        requireInteger(body.expectedRevision, 'dev-host.room.revision'),
        ready,
      );
    }
    if (method === 'POST' && request.url?.includes('/start')) {
      const expectedRevision = requireInteger(
        body.expectedRevision,
        'dev-host.room.revision',
      );
      const requestId =
        optionalString(body.requestId, 'dev-host.start.requestId') ??
        `dev-start:${roomId}:${expectedRevision}`;
      const existingRoom = await this.admission.getRoom(roomId);
      const existingMode = existingRoom
        ? this.description.modes.find(
            (candidate) => candidate.id === existingRoom.modeId,
          )
        : undefined;
      if (existingRoom && existingMode?.entry === 'direct-solo') {
        const start = await this.admission.getStart(roomId);
        if (!start) throw contractError('NOT_FOUND', 'dev-host.start.notFound');
        const resumed = await this.coordinator.createDirectSession(
          identity.principalId,
          {
            gameId: this.description.gameId,
            modeId: existingRoom.modeId,
            releaseId: existingRoom.releaseId,
            setup: existingRoom.setup,
            requestId: start.requestId,
            ...(existingRoom.seed !== undefined
              ? { seed: existingRoom.seed }
              : {}),
          },
        );
        await this.runner.recoverOnce();
        return { start: resumed, room: await this.admission.getRoom(roomId) };
      }
      const start = await this.coordinator.startRoom(
        identity.principalId,
        roomId,
        expectedRevision,
        requestId,
      );
      await this.runner.recoverOnce();
      const room = await this.admission.getRoom(roomId);
      const scenarioId =
        optionalString(body.scenarioId, 'dev-host.start.scenario') ??
        this.scenarioByRoom.get(roomId);
      const scenario = scenarioId
        ? this.scenarios.find((candidate) => candidate.id === scenarioId)
        : undefined;
      if (scenarioId && !scenario)
        throw contractError('NOT_FOUND', 'dev-host.scenario.notFound');
      if (scenario) await this.applyScenario(start.sessionId, scenario);
      this.scenarioByRoom.delete(roomId);
      this.scenarioSeedByRoom.delete(roomId);
      return {
        start,
        room,
        ...(scenario ? { scenarioId: scenario.id } : {}),
      };
    }
    if (method === 'POST' && request.url?.includes('/cancel'))
      return this.coordinator.cancelStart(identity.principalId, roomId);
    throw contractError('NOT_FOUND', 'dev-host.room.routeNotFound');
  }

  private async sessionRoute(
    method: string,
    sessionId: string,
    tail: readonly string[],
    identity: DevelopmentIdentity,
    request: IncomingMessage,
    url: URL,
  ): Promise<unknown> {
    const selectedSeat = url.searchParams.get('seatId') ?? undefined;
    const reference: PlatformIdentityReference = {
      principalId: identity.principalId,
      authSessionId: identity.authSessionId,
      ...(selectedSeat !== undefined
        ? { seatId: requireString(selectedSeat, 'dev-host.seat') }
        : identity.seatId !== undefined
          ? { seatId: identity.seatId }
          : {}),
    };
    if (tail[0] === 'developer-console') {
      if (identity.account.role !== 'admin')
        throw contractError('FORBIDDEN', 'dev-host.developer.denied');
      const admission = await this.admission.getAdmission(sessionId);
      if (!admission)
        throw contractError('NOT_FOUND', 'dev-host.session.notFound');
      const operatorRequest = {
        protocolVersion: 1 as const,
        route: admission.route,
        accessContext: this.accountsState.access(identity.principalId, [
          'session:admin',
          'session:developer',
        ]),
      };
      if (method === 'GET' && tail.length === 1) {
        if (!this.runner.backend.getDeveloperConsole)
          throw contractError('NOT_READY', 'dev-host.developer.unavailable');
        return this.runner.backend.getDeveloperConsole(operatorRequest);
      }
      if (method === 'POST' && tail.length === 2 && tail[1] === 'commands') {
        if (!this.runner.backend.submitDeveloperCommand)
          throw contractError('NOT_READY', 'dev-host.developer.unavailable');
        const body = requireRecord(
          await readJson(request),
          'dev-host.developer.body',
        );
        if (
          Object.keys(body).some(
            (key) =>
              !['commandId', 'expectedRevision', 'command'].includes(key),
          )
        )
          throw contractError('INVALID_REQUEST', 'dev-host.developer.body');
        const command = requireRecord(
          body.command,
          'dev-host.developer.command',
        );
        if (
          Object.keys(command).some((key) => !['name', 'input'].includes(key))
        )
          throw contractError('INVALID_REQUEST', 'dev-host.developer.command');
        const result = await this.runner.backend.submitDeveloperCommand({
          ...operatorRequest,
          commandId: requireString(
            body.commandId,
            'dev-host.developer.commandId',
          ),
          expectedRevision: requireInteger(
            body.expectedRevision,
            'dev-host.developer.revision',
          ),
          command: {
            name: requireString(command.name, 'dev-host.developer.name'),
            input: jsonValue(command.input, 'dev-host.developer.input'),
          },
        });
        await this.runner.recoverOnce();
        return result;
      }
      throw contractError('NOT_FOUND', 'dev-host.developer.routeNotFound');
    }
    if (method === 'GET' && tail[0] === 'view')
      return this.sessionGateway.view(reference, sessionId);
    if (method === 'GET' && tail[0] === 'summary')
      return this.sessionGateway.summary(reference, sessionId);
    if (method === 'GET' && tail[0] === 'status')
      return this.sessionGateway.status(reference, sessionId, {
        ...(url.searchParams.get('startId')
          ? { startId: url.searchParams.get('startId') ?? undefined }
          : {}),
        ...(url.searchParams.get('commandId')
          ? { commandId: url.searchParams.get('commandId') ?? undefined }
          : {}),
      });
    if (method === 'GET' && tail[0] === 'events')
      return this.sessionGateway.events(reference, sessionId, {
        afterSequence: queryInteger(url, 'afterSequence', 0, 1_000_000),
        limit: queryInteger(url, 'limit', 100, 100),
        ...(url.searchParams.get('viewEpoch')
          ? { viewEpoch: url.searchParams.get('viewEpoch') ?? undefined }
          : {}),
      });
    if (method === 'POST' && tail[0] === 'events') {
      const body = requireRecord(
        await readJson(request),
        'dev-host.events.body',
      );
      return this.sessionGateway.events(reference, sessionId, {
        afterSequence: requireInteger(
          body.afterSequence,
          'dev-host.events.afterSequence',
        ),
        limit: requireInteger(body.limit, 'dev-host.events.limit', 1),
        ...(body.viewEpoch === undefined
          ? {}
          : {
              viewEpoch: optionalString(
                body.viewEpoch,
                'dev-host.events.viewEpoch',
              ),
            }),
      });
    }
    if (method === 'POST' && tail[0] === 'resume') {
      const body = requireRecord(
        await readJson(request),
        'dev-host.resume.body',
      );
      return this.sessionGateway.resume(reference, sessionId, {
        ...(body.viewerEpoch === undefined
          ? {}
          : {
              viewerEpoch: optionalString(
                body.viewerEpoch,
                'dev-host.resume.viewerEpoch',
              ),
            }),
        ...(body.streamCursor === undefined
          ? {}
          : {
              streamCursor: optionalString(
                body.streamCursor,
                'dev-host.resume.streamCursor',
              ),
            }),
      });
    }
    if (method === 'POST' && (tail[0] === 'command' || tail[0] === 'commands'))
      return this.submitCommand(reference, sessionId, await readJson(request));
    if (method === 'POST' && (tail[0] === 'query' || tail[0] === 'queries'))
      return this.submitQuery(reference, sessionId, await readJson(request));
    if (method === 'GET' && (tail[0] === 'result' || tail[0] === 'terminal'))
      return this.result(reference, sessionId);
    if (method === 'GET' && tail[0] === 'replay' && tail[1] === 'manifest')
      return this.replayManifest(reference, sessionId);
    if (method === 'GET' && tail[0] === 'replay' && tail[1] === 'frames')
      return this.replayFrames(reference, sessionId, url);
    if (method === 'POST' && tail[0] === 'reset')
      return this.resetSession(identity, sessionId);
    throw contractError('NOT_FOUND', 'dev-host.session.routeNotFound');
  }

  private async submitCommand(
    reference: PlatformIdentityReference,
    sessionId: string,
    value: unknown,
  ): Promise<unknown> {
    const body = requireRecord(value, 'dev-host.command.body');
    const commandId = requireString(
      body.commandId,
      'dev-host.command.commandId',
    );
    const precondition = body.precondition;
    if (!isRecord(precondition))
      throw contractError('INVALID_REQUEST', 'dev-host.command.precondition');
    const command = jsonValue(body.command, 'dev-host.command.command');
    const seatId = optionalString(body.seatId, 'dev-host.command.seat');
    const commandReference = {
      ...reference,
      ...(seatId !== undefined ? { seatId } : {}),
    };
    const response = await this.sessionGateway.command(
      commandReference,
      sessionId,
      {
        commandId,
        precondition: precondition as never,
        command,
      },
    );
    await this.runner.recoverOnce();
    return response;
  }

  private async submitQuery(
    reference: PlatformIdentityReference,
    sessionId: string,
    value: unknown,
  ): Promise<unknown> {
    const body = requireRecord(value, 'dev-host.query.body');
    const revision = requireInteger(body.revision, 'dev-host.query.revision');
    const query = jsonValue(body.query, 'dev-host.query.query');
    return this.sessionGateway.query(reference, sessionId, { revision, query });
  }

  private async result(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const summary = await this.sessionGateway.summary(reference, sessionId);
    await this.runner.recoverOnce();
    const record = await this.directory.getSession(sessionId);
    return {
      sessionId,
      status: summary.status,
      summary: summary.summary,
      ...(record?.result !== undefined ? { result: record.result } : {}),
      ...(record ? { directory: record } : {}),
    };
  }

  private async replayManifest(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<unknown> {
    const replay = this.description.replay;
    if (!replay)
      throw contractError('NOT_FOUND', 'dev-host.replay.unsupported');
    const summary = await this.sessionGateway.summary(reference, sessionId);
    return this.sessionGateway.query(reference, sessionId, {
      revision: summary.sourceRevision,
      query: copy(replay.manifestQuery),
    });
  }

  private async replayFrames(
    reference: PlatformIdentityReference,
    sessionId: string,
    url: URL,
  ): Promise<unknown> {
    const replay = this.description.replay;
    if (!replay)
      throw contractError('NOT_FOUND', 'dev-host.replay.unsupported');
    const summary = await this.sessionGateway.summary(reference, sessionId);
    const from = queryInteger(url, 'from', 0, 1_000_000);
    const limit = queryInteger(url, 'limit', 100, 100);
    return this.sessionGateway.query(reference, sessionId, {
      revision: summary.sourceRevision,
      query: {
        type: replay.framesQueryType,
        from,
        limit,
      },
    });
  }

  private async resetSession(
    identity: DevelopmentIdentity,
    sessionId: string,
  ): Promise<unknown> {
    const start = await this.admission.getStartBySession(sessionId);
    if (!start) throw contractError('NOT_FOUND', 'dev-host.session.notFound');
    const room = await this.admission.getRoom(start.roomId);
    if (
      !room ||
      (room.ownerId !== identity.principalId &&
        identity.account.role !== 'admin')
    )
      throw contractError('FORBIDDEN', 'dev-host.reset.denied');
    const mode = this.description.modes.find(
      (candidate) => candidate.id === start.route.modeId,
    );
    if (!mode) throw contractError('NOT_FOUND', 'dev-host.mode.notFound');
    const newSessionId = randomUUID();
    const resetSeed = `${this.seed}:reset:${newSessionId}`;
    const status = await this.coordinator.createMatchedSession({
      roomId: `reset:${sessionId}:${newSessionId}`,
      sessionId: newSessionId,
      requestId: `reset:${sessionId}:${newSessionId}`,
      gameId: start.route.gameId,
      modeId: start.route.modeId,
      releaseId: start.route.releaseId,
      setup: copy(start.setup),
      seed: resetSeed,
      participants: copy(start.admission.participants),
      policy: {
        rating: mode.platformRating
          ? {
              poolId: `dev:${this.description.gameId}:${mode.id}`,
              policyVersion: 'development-v1',
              progressionPolicyVersion: 'development-v1',
              seasonId: null,
            }
          : null,
        validityPolicyVersion: 'development-v1',
      },
    });
    await this.runner.recoverOnce();
    this.accountsState.rotateAll();
    return {
      previousSessionId: sessionId,
      sessionId: status.sessionId,
      start: status,
      authRequired: true,
    };
  }

  private async applyScenario(
    sessionId: string,
    scenario: DevelopmentScenario<Command, Setup>,
  ): Promise<void> {
    for (const [index, entry] of (scenario.commands ?? []).entries()) {
      const principalId = await this.resolveScenarioPrincipal(sessionId, entry);
      const accountReference = this.accountsState.reference(
        principalId,
        entry.seatId,
      );
      const reference: PlatformIdentityReference = {
        principalId: accountReference.principalId,
        authSessionId: accountReference.authSessionId,
        ...(accountReference.seatId !== undefined
          ? { seatId: accountReference.seatId }
          : {}),
      };
      const summary = await this.sessionGateway.summary(reference, sessionId);
      const command = this.scenarioCommand(entry);
      await this.sessionGateway.command(reference, sessionId, {
        commandId: `scenario:${scenario.id}:${index}`,
        precondition: {
          kind: 'revision',
          expectedRevision: summary.sourceRevision,
        },
        command,
      });
      await this.runner.recoverOnce();
    }
  }

  private scenarioCommand(entry: DevelopmentScenarioCommand<Command>): Command {
    const value = entry.command;
    if (isRecord(value) && typeof value.key === 'string' && 'input' in value) {
      return {
        type: '@board-game/service-command',
        key: value.key,
        input: value.input,
      } as unknown as Command;
    }
    return copy(value) as Command;
  }

  private async resolveScenarioPrincipal(
    sessionId: string,
    entry: DevelopmentScenarioCommand<Command>,
  ): Promise<string> {
    if (entry.principalId) return entry.principalId;
    const start = await this.admission.getStartBySession(sessionId);
    const principal = start?.admission.participants[0]
      ? participantAccountId(start.admission.participants[0])
      : undefined;
    if (!principal)
      throw contractError('FORBIDDEN', 'dev-host.scenario.principal');
    return principal;
  }
}

export function createDevelopmentHost<
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
  options: DevelopmentHostOptions<
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
): DevelopmentHost<Command> {
  return new DevelopmentHostImpl(options);
}
