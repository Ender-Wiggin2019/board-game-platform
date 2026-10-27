import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AccessContext,
  type AuthorizationVersionAdvanceInput,
  type AuthorizationVersionKey,
  type AuthorizationVersionRecord,
  type AuthorizationVersionRevokeInput,
  type AuthorizationVersionStore,
  assertProtocolRequest,
  assertSessionRoute,
  canonicalStableStringify,
  PLAYER_CREDENTIAL_VERSION,
  type PlayerCredentialClaims,
  type SessionRoute,
} from '@board-game/contracts';

export const DEFAULT_PLAYER_CREDENTIAL_TTL_MS = 5 * 60 * 1_000;
export const MAX_PLAYER_CREDENTIAL_TTL_MS = 5 * 60 * 1_000;
export const MAX_PLAYER_CREDENTIAL_TOKEN_BYTES = 16 * 1024;
export const MAX_PLAYER_CREDENTIAL_PAYLOAD_BYTES = 8 * 1024;
export const MAX_PLAYER_CREDENTIAL_IDENTIFIER_LENGTH = 256;
export const MAX_PLAYER_CREDENTIAL_SCOPES = 32;
export const MAX_PLAYER_CREDENTIAL_SCOPE_LENGTH = 128;
export const DEFAULT_AUTHORIZATION_SCHEMA = 'board_platform_authorization';

const PLAYER_SCOPES = new Set([
  'session:view',
  'session:command',
  'session:spectate',
]);

export type PlayerCredentialPrivateKey = KeyObject | string | Buffer;
export type PlayerCredentialPublicKey = KeyObject | string | Buffer;

export type PlayerCredentialErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_KEY'
  | 'INVALID_TOKEN'
  | 'SIGNATURE_INVALID'
  | 'ISSUER_MISMATCH'
  | 'AUDIENCE_MISMATCH'
  | 'ROUTE_MISMATCH'
  | 'CREDENTIAL_FUTURE'
  | 'CREDENTIAL_EXPIRED'
  | 'SCOPE_UNAUTHORIZED'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_MISMATCH';

export class PlayerCredentialError extends Error {
  readonly name = 'PlayerCredentialError';

  constructor(
    readonly code: PlayerCredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type AuthorizationVersionStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHORIZATION_NOT_FOUND'
  | 'AUTHORIZATION_CONFLICT'
  | 'AUTHORIZATION_STALE';

export class AuthorizationVersionStoreError extends Error {
  readonly name = 'AuthorizationVersionStoreError';

  constructor(
    readonly code: AuthorizationVersionStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface IssuePlayerCredentialOptions {
  readonly privateKey: PlayerCredentialPrivateKey;
  readonly platformId: string;
  readonly audience: string;
  readonly route: SessionRoute;
  readonly principalId: string;
  readonly seatId?: string;
  readonly scopes: readonly string[];
  readonly authEpoch: string;
  readonly authorizationRevision: number;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly ttlMs?: number;
  readonly now?: number;
  /** Non-session scopes must be explicitly approved by the platform. */
  readonly approvedGameScopes?: readonly string[];
}

export interface VerifyPlayerCredentialOptions {
  readonly token: string;
  readonly publicKey: PlayerCredentialPublicKey;
  readonly expectedPlatformId: string;
  readonly expectedAudience: string;
  readonly expectedRoute: SessionRoute;
  readonly now?: number;
  readonly authorizationStore: AuthorizationVersionStore;
  /** Non-session scopes must be explicitly approved by the game service. */
  readonly approvedGameScopes?: readonly string[];
}

/** Structural PostgreSQL boundary; applications provide their configured pg Pool. */
export interface PostgresAuthorizationQueryResult {
  readonly rows: readonly Record<string, unknown>[];
}

export interface PostgresAuthorizationPoolClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<PostgresAuthorizationQueryResult>;
  release(): void;
}

export interface PostgresAuthorizationPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<PostgresAuthorizationQueryResult>;
  connect(): Promise<PostgresAuthorizationPoolClient>;
}

function fail(code: PlayerCredentialErrorCode, message: string): never {
  throw new PlayerCredentialError(code, message);
}

function storeFail(
  code: AuthorizationVersionStoreErrorCode,
  message: string,
): never {
  throw new AuthorizationVersionStoreError(code, message);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function requireObject(value: unknown, name: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_ARGUMENT', `${name} must be an object`);
}

function requireStoreObject(
  value: unknown,
  name: string,
): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    storeFail('INVALID_ARGUMENT', `${name} must be an object`);
}

function requireString(
  value: unknown,
  name: string,
  maxLength = MAX_PLAYER_CREDENTIAL_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    fail(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${maxLength} characters`,
    );
}

function requireStoreString(
  value: unknown,
  name: string,
  maxLength = MAX_PLAYER_CREDENTIAL_IDENTIFIER_LENGTH,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    storeFail(
      'INVALID_ARGUMENT',
      `${name} must be a non-empty string of at most ${maxLength} characters`,
    );
}

function requireInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
}

function requireStoreInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    storeFail('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
}

function requireTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail('INVALID_ARGUMENT', `${name} must be a non-negative safe integer`);
}

function requireStoreTimestamp(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    storeFail(
      'INVALID_ARGUMENT',
      `${name} must be a non-negative safe integer`,
    );
}

function validateRoute(value: unknown): SessionRoute {
  try {
    assertSessionRoute(value);
  } catch {
    fail('ROUTE_MISMATCH', 'credential route is invalid');
  }
  const route = value as SessionRoute;
  for (const [name, routeValue] of Object.entries(route))
    requireString(routeValue, `route.${name}`);
  return copy(route);
}

function validateStoreRoute(value: unknown): SessionRoute {
  try {
    assertSessionRoute(value);
  } catch {
    storeFail('INVALID_ARGUMENT', 'authorization route is invalid');
  }
  const route = value as SessionRoute;
  for (const [name, routeValue] of Object.entries(route))
    requireStoreString(routeValue, `route.${name}`);
  return copy(route);
}

function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}

function validateApprovedGameScopes(
  scopes: readonly string[] | undefined,
): Set<string> {
  if (scopes === undefined) return new Set();
  if (!Array.isArray(scopes) || scopes.length > MAX_PLAYER_CREDENTIAL_SCOPES)
    fail('INVALID_ARGUMENT', 'approvedGameScopes has too many entries');
  const result = new Set<string>();
  for (const scope of scopes) {
    requireString(
      scope,
      'approvedGameScopes[]',
      MAX_PLAYER_CREDENTIAL_SCOPE_LENGTH,
    );
    if (scope.startsWith('session:'))
      fail(
        'SCOPE_UNAUTHORIZED',
        'approvedGameScopes cannot contain session scopes',
      );
    if (result.has(scope))
      fail('INVALID_ARGUMENT', 'approvedGameScopes must be unique');
    result.add(scope);
  }
  return result;
}

function validateScopes(
  scopes: unknown,
  approvedGameScopes: Set<string> | undefined,
  requireGameApproval: boolean,
): string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > MAX_PLAYER_CREDENTIAL_SCOPES
  )
    fail('INVALID_ARGUMENT', 'scopes must contain between 1 and 32 entries');
  const result = new Set<string>();
  for (const scope of scopes) {
    requireString(scope, 'scopes[]', MAX_PLAYER_CREDENTIAL_SCOPE_LENGTH);
    if (result.has(scope)) fail('INVALID_ARGUMENT', 'scopes must be unique');
    result.add(scope);
    if (scope.startsWith('session:')) {
      if (!PLAYER_SCOPES.has(scope))
        fail(
          'SCOPE_UNAUTHORIZED',
          `scope ${scope} is reserved for platform internals`,
        );
    } else if (requireGameApproval && !approvedGameScopes?.has(scope)) {
      fail('SCOPE_UNAUTHORIZED', `game scope ${scope} is not approved`);
    }
  }
  return [...result].sort();
}

function validateStoreScopes(scopes: unknown): string[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > MAX_PLAYER_CREDENTIAL_SCOPES
  )
    storeFail(
      'INVALID_ARGUMENT',
      'scopes must contain between 1 and 32 entries',
    );
  const result = new Set<string>();
  for (const scope of scopes) {
    requireStoreString(scope, 'scopes[]', MAX_PLAYER_CREDENTIAL_SCOPE_LENGTH);
    if (result.has(scope))
      storeFail('INVALID_ARGUMENT', 'scopes must be unique');
    result.add(scope);
    if (scope.startsWith('session:') && !PLAYER_SCOPES.has(scope))
      storeFail(
        'INVALID_ARGUMENT',
        `scope ${scope} is reserved for platform internals`,
      );
  }
  return [...result].sort();
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.length < required.length ||
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(
      'INVALID_TOKEN',
      'credential payload contains unknown or missing fields',
    );
}

function validateClaims(
  value: unknown,
  approvedGameScopes: Set<string> | undefined,
  requireGameApproval: boolean,
): PlayerCredentialClaims {
  requireObject(value, 'credential payload');
  const claims = value as Record<string, unknown>;
  exactKeys(
    claims,
    [
      'version',
      'issuer',
      'audience',
      'route',
      'principalId',
      'scopes',
      'authEpoch',
      'authorizationRevision',
      'issuedAt',
      'expiresAt',
    ],
    ['seatId'],
  );
  if (claims.version !== PLAYER_CREDENTIAL_VERSION)
    fail('INVALID_TOKEN', 'unsupported player credential version');
  requireString(claims.issuer, 'issuer');
  requireString(claims.audience, 'audience');
  const route = validateRoute(claims.route);
  requireString(claims.principalId, 'principalId');
  if (claims.seatId !== undefined) requireString(claims.seatId, 'seatId');
  const scopes = validateScopes(
    claims.scopes,
    approvedGameScopes,
    requireGameApproval,
  );
  requireString(claims.authEpoch, 'authEpoch');
  requireInteger(claims.authorizationRevision, 'authorizationRevision');
  requireTimestamp(claims.issuedAt, 'issuedAt');
  requireTimestamp(claims.expiresAt, 'expiresAt');
  if (claims.expiresAt <= claims.issuedAt)
    fail('INVALID_ARGUMENT', 'expiresAt must be after issuedAt');
  if (claims.expiresAt - claims.issuedAt > MAX_PLAYER_CREDENTIAL_TTL_MS)
    fail(
      'INVALID_ARGUMENT',
      'player credential TTL exceeds the 5 minute maximum',
    );
  return {
    version: PLAYER_CREDENTIAL_VERSION,
    issuer: claims.issuer,
    audience: claims.audience,
    route,
    principalId: claims.principalId,
    ...(claims.seatId === undefined ? {} : { seatId: claims.seatId }),
    scopes,
    authEpoch: claims.authEpoch,
    authorizationRevision: claims.authorizationRevision,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

function privateKeyObject(input: PlayerCredentialPrivateKey): KeyObject {
  try {
    const key = input instanceof KeyObject ? input : createPrivateKey(input);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')
      fail('INVALID_KEY', 'player credentials require an Ed25519 private key');
    return key;
  } catch (error) {
    if (error instanceof PlayerCredentialError) throw error;
    fail('INVALID_KEY', 'player credential private key is invalid');
  }
}

function publicKeyObject(input: PlayerCredentialPublicKey): KeyObject {
  try {
    if (input instanceof KeyObject) {
      if (input.type !== 'public' || input.asymmetricKeyType !== 'ed25519')
        fail('INVALID_KEY', 'player credentials require an Ed25519 public key');
      return input;
    }
    try {
      const privateKey = createPrivateKey(input);
      if (privateKey.type === 'private')
        fail('INVALID_KEY', 'verification requires a public key');
    } catch (error) {
      if (error instanceof PlayerCredentialError) throw error;
    }
    const key = createPublicKey(input);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519')
      fail('INVALID_KEY', 'player credentials require an Ed25519 public key');
    return key;
  } catch (error) {
    if (error instanceof PlayerCredentialError) throw error;
    fail('INVALID_KEY', 'player credential public key is invalid');
  }
}

function decodeBase64Url(
  value: string,
  name: string,
  maxBytes: number,
): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1)
    fail('INVALID_TOKEN', `${name} is not canonical base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.length === 0 ||
    decoded.length > maxBytes ||
    decoded.toString('base64url') !== value
  )
    fail('INVALID_TOKEN', `${name} is invalid or too large`);
  return decoded;
}

function encodeToken(payload: Buffer, signature: Buffer): string {
  const token = `${payload.toString('base64url')}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(token, 'utf8') > MAX_PLAYER_CREDENTIAL_TOKEN_BYTES)
    fail('INVALID_ARGUMENT', 'player credential token is too large');
  return token;
}

function parseToken(token: string): {
  readonly payload: Buffer;
  readonly signature: Buffer;
} {
  requireString(token, 'token', MAX_PLAYER_CREDENTIAL_TOKEN_BYTES);
  if (Buffer.byteLength(token, 'utf8') > MAX_PLAYER_CREDENTIAL_TOKEN_BYTES)
    fail('INVALID_TOKEN', 'player credential token is too large');
  const parts = token.split('.');
  if (parts.length !== 2)
    fail('INVALID_TOKEN', 'player credential token has an invalid format');
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (!payloadPart || !signaturePart)
    fail('INVALID_TOKEN', 'player credential token has an invalid format');
  const payload = decodeBase64Url(
    payloadPart,
    'payload',
    MAX_PLAYER_CREDENTIAL_PAYLOAD_BYTES,
  );
  const signature = decodeBase64Url(signaturePart, 'signature', 64);
  if (signature.length !== 64)
    fail('INVALID_TOKEN', 'Ed25519 signature has an invalid length');
  return { payload, signature };
}

function contentOf(
  record: Pick<
    AuthorizationVersionRecord,
    | 'platformId'
    | 'sessionId'
    | 'principalId'
    | 'route'
    | 'seatId'
    | 'scopes'
    | 'authEpoch'
    | 'authorizationRevision'
  >,
): unknown {
  return {
    platformId: record.platformId,
    sessionId: record.sessionId,
    principalId: record.principalId,
    route: record.route,
    ...(record.seatId === undefined ? {} : { seatId: record.seatId }),
    scopes: record.scopes,
    authEpoch: record.authEpoch,
    authorizationRevision: record.authorizationRevision,
  };
}

function sameAuthorization(
  left: AuthorizationVersionRecord,
  right: AuthorizationVersionRecord,
): boolean {
  return (
    canonicalStableStringify(contentOf(left)) ===
    canonicalStableStringify(contentOf(right))
  );
}

function storeKey(key: AuthorizationVersionKey): string {
  return JSON.stringify([key.platformId, key.sessionId, key.principalId]);
}

function validateStoreKey(input: AuthorizationVersionKey): void {
  requireStoreObject(input, 'authorization key');
  requireStoreString(input.platformId, 'platformId');
  requireStoreString(input.sessionId, 'sessionId');
  requireStoreString(input.principalId, 'principalId');
}

function validateAdvanceInput(input: AuthorizationVersionAdvanceInput): void {
  requireStoreObject(input, 'authorization advance');
  validateStoreKey(input);
  requireStoreString(input.authenticatedPlatformId, 'authenticatedPlatformId');
  if (input.authenticatedPlatformId !== input.platformId)
    storeFail(
      'AUTHENTICATION_REQUIRED',
      'authenticated caller does not match platform',
    );
  const route = validateStoreRoute(input.route);
  if (route.sessionId !== input.sessionId)
    storeFail(
      'INVALID_ARGUMENT',
      'authorization route session does not match key',
    );
  if (input.seatId !== undefined) requireStoreString(input.seatId, 'seatId');
  validateStoreScopes(input.scopes);
  requireStoreString(input.authEpoch, 'authEpoch');
  requireStoreInteger(input.authorizationRevision, 'authorizationRevision');
}

function validateRevokeInput(input: AuthorizationVersionRevokeInput): void {
  requireStoreObject(input, 'authorization revoke');
  validateStoreKey(input);
  requireStoreString(input.authenticatedPlatformId, 'authenticatedPlatformId');
  if (input.authenticatedPlatformId !== input.platformId)
    storeFail(
      'AUTHENTICATION_REQUIRED',
      'authenticated caller does not match platform',
    );
  requireStoreInteger(input.authorizationRevision, 'authorizationRevision');
}

function rowJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function jsonParameter(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function recordFromRow(
  row: Record<string, unknown>,
): AuthorizationVersionRecord {
  const route = validateStoreRoute(rowJson(row.route));
  const scopes = validateStoreScopes(rowJson(row.scopes));
  const revokedAt =
    row.revoked_at === null || row.revoked_at === undefined
      ? undefined
      : Number(row.revoked_at);
  if (revokedAt !== undefined) requireStoreTimestamp(revokedAt, 'revokedAt');
  const record = {
    platformId: String(row.platform_id),
    sessionId: String(row.session_id),
    principalId: String(row.principal_id),
    route,
    ...(row.seat_id === null || row.seat_id === undefined
      ? {}
      : { seatId: String(row.seat_id) }),
    scopes,
    authEpoch: String(row.auth_epoch),
    authorizationRevision: Number(row.authorization_revision),
    ...(revokedAt === undefined ? {} : { revokedAt }),
    updatedAt: Number(row.updated_at),
  };
  assertRecord(record);
  return record;
}

function assertRecord(record: AuthorizationVersionRecord): void {
  validateStoreKey(record);
  const route = validateStoreRoute(record.route);
  if (route.sessionId !== record.sessionId)
    storeFail(
      'INVALID_ARGUMENT',
      'authorization route session does not match key',
    );
  validateStoreScopes(record.scopes);
  requireStoreString(record.authEpoch, 'authEpoch');
  requireStoreInteger(record.authorizationRevision, 'authorizationRevision');
  requireStoreTimestamp(record.updatedAt, 'updatedAt');
  if (record.revokedAt !== undefined)
    requireStoreTimestamp(record.revokedAt, 'revokedAt');
}

/** In-process store for development only; production must use Postgres. */
export class MemoryAuthorizationVersionStore
  implements AuthorizationVersionStore
{
  readonly capabilities = { durable: false } as const;
  private readonly records = new Map<string, AuthorizationVersionRecord>();
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  private async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async get(
    input: AuthorizationVersionKey,
  ): Promise<AuthorizationVersionRecord | null> {
    validateStoreKey(input);
    const record = this.records.get(storeKey(input));
    return record ? copy(record) : null;
  }

  async advance(
    input: AuthorizationVersionAdvanceInput,
  ): Promise<AuthorizationVersionRecord> {
    validateAdvanceInput(input);
    const candidate: AuthorizationVersionRecord = {
      platformId: input.platformId,
      sessionId: input.sessionId,
      principalId: input.principalId,
      route: copy(input.route),
      ...(input.seatId === undefined ? {} : { seatId: input.seatId }),
      scopes: [...validateStoreScopes(input.scopes)],
      authEpoch: input.authEpoch,
      authorizationRevision: input.authorizationRevision,
      updatedAt: this.now(),
    };
    assertRecord(candidate);
    return this.run(async () => {
      const key = storeKey(candidate);
      const existing = this.records.get(key);
      if (existing) {
        if (candidate.authorizationRevision < existing.authorizationRevision)
          storeFail(
            'AUTHORIZATION_STALE',
            'authorization revision is older than the stored version',
          );
        if (
          candidate.authorizationRevision === existing.authorizationRevision
        ) {
          if (!sameAuthorization(existing, candidate))
            storeFail(
              'AUTHORIZATION_CONFLICT',
              'authorization revision has different content',
            );
          return copy(existing);
        }
      }
      this.records.set(key, candidate);
      return copy(candidate);
    });
  }

  async revoke(
    input: AuthorizationVersionRevokeInput,
  ): Promise<AuthorizationVersionRecord> {
    validateRevokeInput(input);
    const now = this.now();
    requireStoreTimestamp(now, 'now');
    return this.run(async () => {
      const key = storeKey(input);
      const existing = this.records.get(key);
      if (!existing)
        storeFail(
          'AUTHORIZATION_NOT_FOUND',
          'authorization version is not known',
        );
      if (input.authorizationRevision !== existing.authorizationRevision)
        storeFail(
          'AUTHORIZATION_STALE',
          'authorization revision is not current',
        );
      if (existing.revokedAt !== undefined) return copy(existing);
      const revoked = { ...existing, revokedAt: now, updatedAt: now };
      this.records.set(key, revoked);
      return copy(revoked);
    });
  }

  async close(): Promise<void> {
    // Memory storage owns no external resource.
  }
}

export interface PostgresAuthorizationVersionStoreOptions {
  readonly pool: PostgresAuthorizationPool;
  readonly schema?: string;
  readonly now?: () => number;
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema))
    storeFail(
      'INVALID_ARGUMENT',
      'authorization schema must be a lower-case SQL identifier',
    );
}

function tableName(schema: string): string {
  assertSchemaName(schema);
  return `"${schema}"."versions"`;
}

export function authorizationVersionMigrationStatements(
  schema = DEFAULT_AUTHORIZATION_SCHEMA,
): readonly string[] {
  assertSchemaName(schema);
  const table = tableName(schema);
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}"`,
    `CREATE TABLE IF NOT EXISTS ${table} (
      platform_id text NOT NULL,
      session_id text NOT NULL,
      principal_id text NOT NULL,
      route jsonb NOT NULL,
      seat_id text,
      scopes jsonb NOT NULL,
      auth_epoch text NOT NULL,
      authorization_revision bigint NOT NULL CHECK (authorization_revision >= 1),
      revoked_at double precision,
      updated_at double precision NOT NULL,
      PRIMARY KEY (platform_id, session_id, principal_id)
    )`,
    `CREATE INDEX IF NOT EXISTS "${schema}_versions_session_idx"
      ON ${table} (platform_id, session_id, updated_at DESC)`,
  ];
}

async function lockAuthorization(
  client: PostgresAuthorizationPoolClient,
  input: AuthorizationVersionKey,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    storeKey(input),
  ]);
}

/** Durable authorization versions used while the platform itself is offline. */
export class PostgresAuthorizationVersionStore
  implements AuthorizationVersionStore
{
  readonly capabilities = { durable: true } as const;
  readonly schema: string;
  private readonly pool: PostgresAuthorizationPool;
  private readonly now: () => number;

  constructor(options: PostgresAuthorizationVersionStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? DEFAULT_AUTHORIZATION_SCHEMA;
    this.now = options.now ?? Date.now;
    assertSchemaName(this.schema);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`board-game-authorization:migrations:${this.schema}`],
      );
      for (const statement of authorizationVersionMigrationStatements(
        this.schema,
      ))
        await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    input: AuthorizationVersionKey,
  ): Promise<AuthorizationVersionRecord | null> {
    validateStoreKey(input);
    const result = await this.pool.query(
      `SELECT * FROM ${tableName(this.schema)}
       WHERE platform_id = $1 AND session_id = $2 AND principal_id = $3`,
      [input.platformId, input.sessionId, input.principalId],
    );
    return result.rows.length === 0 ? null : recordFromRow(result.rows[0]);
  }

  async advance(
    input: AuthorizationVersionAdvanceInput,
  ): Promise<AuthorizationVersionRecord> {
    validateAdvanceInput(input);
    const candidate: AuthorizationVersionRecord = {
      platformId: input.platformId,
      sessionId: input.sessionId,
      principalId: input.principalId,
      route: copy(input.route),
      ...(input.seatId === undefined ? {} : { seatId: input.seatId }),
      scopes: [...validateStoreScopes(input.scopes)],
      authEpoch: input.authEpoch,
      authorizationRevision: input.authorizationRevision,
      updatedAt: this.now(),
    };
    assertRecord(candidate);
    const client = await this.pool.connect();
    const table = tableName(this.schema);
    try {
      await client.query('BEGIN');
      await lockAuthorization(client, candidate);
      const existingResult = await client.query(
        `SELECT * FROM ${table}
          WHERE platform_id = $1 AND session_id = $2 AND principal_id = $3
          FOR UPDATE`,
        [candidate.platformId, candidate.sessionId, candidate.principalId],
      );
      if (existingResult.rows.length > 0) {
        const existing = recordFromRow(existingResult.rows[0]);
        if (candidate.authorizationRevision < existing.authorizationRevision)
          storeFail(
            'AUTHORIZATION_STALE',
            'authorization revision is older than the stored version',
          );
        if (
          candidate.authorizationRevision === existing.authorizationRevision
        ) {
          if (!sameAuthorization(existing, candidate))
            storeFail(
              'AUTHORIZATION_CONFLICT',
              'authorization revision has different content',
            );
          await client.query('COMMIT');
          return existing;
        }
        const updated = await client.query(
          `UPDATE ${table}
             SET route = $4::jsonb, seat_id = $5, scopes = $6::jsonb,
                 auth_epoch = $7, authorization_revision = $8,
                 revoked_at = NULL, updated_at = $9
           WHERE platform_id = $1 AND session_id = $2 AND principal_id = $3
           RETURNING *`,
          [
            candidate.platformId,
            candidate.sessionId,
            candidate.principalId,
            jsonParameter(candidate.route),
            candidate.seatId ?? null,
            jsonParameter(candidate.scopes),
            candidate.authEpoch,
            candidate.authorizationRevision,
            candidate.updatedAt,
          ],
        );
        await client.query('COMMIT');
        return recordFromRow(updated.rows[0]);
      }
      const inserted = await client.query(
        `INSERT INTO ${table}
          (platform_id, session_id, principal_id, route, seat_id, scopes,
           auth_epoch, authorization_revision, revoked_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,NULL,$9)
         RETURNING *`,
        [
          candidate.platformId,
          candidate.sessionId,
          candidate.principalId,
          jsonParameter(candidate.route),
          candidate.seatId ?? null,
          jsonParameter(candidate.scopes),
          candidate.authEpoch,
          candidate.authorizationRevision,
          candidate.updatedAt,
        ],
      );
      await client.query('COMMIT');
      return recordFromRow(inserted.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(
    input: AuthorizationVersionRevokeInput,
  ): Promise<AuthorizationVersionRecord> {
    validateRevokeInput(input);
    const now = this.now();
    requireStoreTimestamp(now, 'now');
    const client = await this.pool.connect();
    const table = tableName(this.schema);
    try {
      await client.query('BEGIN');
      await lockAuthorization(client, input);
      const existingResult = await client.query(
        `SELECT * FROM ${table}
          WHERE platform_id = $1 AND session_id = $2 AND principal_id = $3
          FOR UPDATE`,
        [input.platformId, input.sessionId, input.principalId],
      );
      if (existingResult.rows.length === 0)
        storeFail(
          'AUTHORIZATION_NOT_FOUND',
          'authorization version is not known',
        );
      const existing = recordFromRow(existingResult.rows[0]);
      if (input.authorizationRevision !== existing.authorizationRevision)
        storeFail(
          'AUTHORIZATION_STALE',
          'authorization revision is not current',
        );
      if (existing.revokedAt !== undefined) {
        await client.query('COMMIT');
        return existing;
      }
      const revoked = await client.query(
        `UPDATE ${table}
            SET revoked_at = $4, updated_at = $4
          WHERE platform_id = $1 AND session_id = $2 AND principal_id = $3
          RETURNING *`,
        [input.platformId, input.sessionId, input.principalId, now],
      );
      await client.query('COMMIT');
      return recordFromRow(revoked.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    // The caller owns the pool, matching other common storage adapters.
  }
}

export type AuthorizationTransportOperation = 'advance' | 'revoke';

export interface AuthorizationTransportCredential {
  readonly token: string;
  readonly platformId: string;
}

export interface AuthorizationVersionSynchronizer {
  advance(
    input: AuthorizationVersionAdvanceInput,
  ): Promise<AuthorizationVersionRecord>;
  revoke(
    input: AuthorizationVersionRevokeInput,
  ): Promise<AuthorizationVersionRecord>;
}

export type AuthorizationTransportErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'CONFLICT'
  | 'STALE'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PROTOCOL';

export class AuthorizationTransportError extends Error {
  readonly name = 'AuthorizationTransportError';

  constructor(
    readonly code: AuthorizationTransportErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface HttpAuthorizationVersionServerOptions {
  readonly store: AuthorizationVersionStore;
  /** Service credentials are mapped to platform identities; body identity is ignored. */
  readonly credentials: readonly AuthorizationTransportCredential[];
  /** Route ownership is checked by the game runner before mutating its store. */
  readonly authorizeRoute?: (route: SessionRoute) => boolean | Promise<boolean>;
  readonly path?: string;
  readonly host?: string;
  readonly port?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export interface HttpAuthorizationVersionClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly platformId: string;
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /** Plain HTTP is allowed only for explicit loopback development clients. */
  readonly allowInsecureLocalhost?: boolean;
}

const DEFAULT_AUTHORIZATION_HTTP_PATH = '/internal/v1/authorization';
const DEFAULT_AUTHORIZATION_HTTP_MAX_BYTES = 256 * 1024;
const DEFAULT_AUTHORIZATION_HTTP_TIMEOUT_MS = 10_000;

function authTransportError(
  code: AuthorizationTransportErrorCode,
  message: string,
  retryable = false,
): never {
  throw new AuthorizationTransportError(code, message, retryable);
}

function authHttpLimit(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    authTransportError('INVALID_REQUEST', `${name} is invalid`);
  return value;
}

function authHttpTokenMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function authorizationBearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (typeof value !== 'string') return null;
  return /^Bearer ([^\s]+)$/u.exec(value)?.[1] ?? null;
}

function authorizationExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.length < required.length ||
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    authTransportError(
      'INVALID_REQUEST',
      'authorization request fields invalid',
    );
}

function authorizationWireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    authTransportError('INVALID_REQUEST', `${name} is invalid`);
  return value as Record<string, unknown>;
}

function authorizationWireString(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_PLAYER_CREDENTIAL_IDENTIFIER_LENGTH
  )
    authTransportError('INVALID_REQUEST', `${name} is invalid`);
  return value;
}

function authorizationWireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    authTransportError('INVALID_REQUEST', 'authorizationRevision is invalid');
  return value as number;
}

function authorizationWireRoute(value: unknown): SessionRoute {
  try {
    assertSessionRoute(value);
  } catch {
    authTransportError('INVALID_REQUEST', 'authorization route is invalid');
  }
  return structuredClone(value as SessionRoute);
}

function parseAuthorizationAdvance(
  value: unknown,
): Omit<AuthorizationVersionAdvanceInput, 'authenticatedPlatformId'> {
  const input = authorizationWireObject(value, 'authorization');
  authorizationExactKeys(
    input,
    [
      'platformId',
      'sessionId',
      'principalId',
      'route',
      'scopes',
      'authEpoch',
      'authorizationRevision',
    ],
    ['seatId'],
  );
  const scopes = input.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > MAX_PLAYER_CREDENTIAL_SCOPES ||
    scopes.some(
      (scope) =>
        typeof scope !== 'string' ||
        scope.trim().length === 0 ||
        scope.length > MAX_PLAYER_CREDENTIAL_SCOPE_LENGTH,
    )
  )
    authTransportError('INVALID_REQUEST', 'authorization scopes are invalid');
  const route = authorizationWireRoute(input.route);
  const platformId = authorizationWireString(input.platformId, 'platformId');
  const sessionId = authorizationWireString(input.sessionId, 'sessionId');
  const principalId = authorizationWireString(input.principalId, 'principalId');
  if (route.sessionId !== sessionId)
    authTransportError(
      'INVALID_REQUEST',
      'authorization route session mismatch',
    );
  return {
    platformId,
    sessionId,
    principalId,
    route,
    ...(input.seatId === undefined
      ? {}
      : { seatId: authorizationWireString(input.seatId, 'seatId') }),
    scopes: [...scopes] as string[],
    authEpoch: authorizationWireString(input.authEpoch, 'authEpoch'),
    authorizationRevision: authorizationWireRevision(
      input.authorizationRevision,
    ),
  };
}

function parseAuthorizationRevoke(
  value: unknown,
): Omit<AuthorizationVersionRevokeInput, 'authenticatedPlatformId'> {
  const input = authorizationWireObject(value, 'authorization revoke');
  authorizationExactKeys(input, [
    'platformId',
    'sessionId',
    'principalId',
    'authorizationRevision',
  ]);
  return {
    platformId: authorizationWireString(input.platformId, 'platformId'),
    sessionId: authorizationWireString(input.sessionId, 'sessionId'),
    principalId: authorizationWireString(input.principalId, 'principalId'),
    authorizationRevision: authorizationWireRevision(
      input.authorizationRevision,
    ),
  };
}

function authorizationRequestBody(value: unknown): {
  readonly protocolVersion: 1;
  readonly body: unknown;
} {
  const body = authorizationWireObject(value, 'request');
  authorizationExactKeys(body, ['protocolVersion', 'authorization']);
  try {
    assertProtocolRequest(body);
  } catch {
    authTransportError('INVALID_REQUEST', 'authorization protocol is invalid');
  }
  return { protocolVersion: 1, body: body.authorization };
}

function readAuthorizationBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(
        new AuthorizationTransportError(
          'TIMEOUT',
          'authorization request timed out',
          true,
        ),
      );
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        finish(
          new AuthorizationTransportError(
            'INVALID_REQUEST',
            'authorization request is too large',
          ),
        );
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on('end', () => finish());
    request.on('aborted', () =>
      finish(
        new AuthorizationTransportError(
          'NETWORK',
          'authorization request was aborted',
          true,
        ),
      ),
    );
    request.on('error', (error) => finish(error));
  });
}

function authorizationJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  maxBytes: number,
): void {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ protocolVersion: 1, error: { code: 'NOT_READY' } }),
    );
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded, 'utf8'),
    'cache-control': 'no-store',
  });
  response.end(encoded);
}

function authorizationStoreHttpError(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
} {
  if (error instanceof AuthorizationVersionStoreError) {
    switch (error.code) {
      case 'AUTHORIZATION_CONFLICT':
        return { status: 409, code: 'CONFLICT', retryable: false };
      case 'AUTHORIZATION_STALE':
        return { status: 409, code: 'STALE', retryable: false };
      case 'AUTHORIZATION_NOT_FOUND':
        return { status: 404, code: 'NOT_FOUND', retryable: false };
      case 'AUTHENTICATION_REQUIRED':
        return { status: 403, code: 'FORBIDDEN', retryable: false };
      default:
        return { status: 400, code: 'INVALID_REQUEST', retryable: false };
    }
  }
  if (error instanceof AuthorizationTransportError)
    return {
      status:
        error.code === 'UNAUTHENTICATED'
          ? 401
          : error.code === 'FORBIDDEN'
            ? 403
            : error.code === 'INVALID_REQUEST'
              ? 400
              : error.code === 'CONFLICT' || error.code === 'STALE'
                ? 409
                : error.code === 'NOT_FOUND'
                  ? 404
                  : 503,
      code: error.code,
      retryable: error.retryable,
    };
  return { status: 503, code: 'NOT_READY', retryable: true };
}

function authServerPath(path: string): string {
  if (!path.startsWith('/') || path.length > 256 || path.endsWith('/'))
    authTransportError('INVALID_REQUEST', 'authorization path is invalid');
  return path;
}

/** Internal game-process authorization endpoint. It never accepts browser credentials. */
export class HttpAuthorizationVersionServer {
  readonly server: Server;
  private readonly path: string;
  private readonly credentials: readonly AuthorizationTransportCredential[];
  private readonly authorizeRoute?: (
    route: SessionRoute,
  ) => boolean | Promise<boolean>;
  private readonly host: string;
  private readonly port: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;
  private listening = false;

  constructor(private readonly options: HttpAuthorizationVersionServerOptions) {
    if (
      !options?.store ||
      typeof options.store.get !== 'function' ||
      typeof options.store.advance !== 'function' ||
      typeof options.store.revoke !== 'function'
    )
      authTransportError('INVALID_REQUEST', 'authorization store is required');
    if (!Array.isArray(options.credentials) || options.credentials.length === 0)
      authTransportError(
        'INVALID_REQUEST',
        'authorization credentials required',
      );
    const tokens = new Set<string>();
    this.credentials = options.credentials.map((credential) => {
      if (
        !credential ||
        typeof credential.token !== 'string' ||
        credential.token.length < 32 ||
        credential.token.length > MAX_PLAYER_CREDENTIAL_TOKEN_BYTES ||
        typeof credential.platformId !== 'string' ||
        credential.platformId.length === 0 ||
        credential.platformId.length >
          MAX_PLAYER_CREDENTIAL_IDENTIFIER_LENGTH ||
        tokens.has(credential.token)
      )
        authTransportError(
          'INVALID_REQUEST',
          'authorization credential invalid',
        );
      tokens.add(credential.token);
      return structuredClone(credential);
    });
    this.path = authServerPath(options.path ?? DEFAULT_AUTHORIZATION_HTTP_PATH);
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    if (!Number.isSafeInteger(this.port) || this.port < 0 || this.port > 65_535)
      authTransportError('INVALID_REQUEST', 'authorization port is invalid');
    this.maxRequestBytes = authHttpLimit(
      options.maxRequestBytes ?? DEFAULT_AUTHORIZATION_HTTP_MAX_BYTES,
      'maxRequestBytes',
      8 * 1024 * 1024,
    );
    this.maxResponseBytes = authHttpLimit(
      options.maxResponseBytes ?? DEFAULT_AUTHORIZATION_HTTP_MAX_BYTES,
      'maxResponseBytes',
      8 * 1024 * 1024,
    );
    this.timeoutMs = authHttpLimit(
      options.timeoutMs ?? DEFAULT_AUTHORIZATION_HTTP_TIMEOUT_MS,
      'timeoutMs',
      300_000,
    );
    this.authorizeRoute = options.authorizeRoute;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = this.timeoutMs;
    this.server.headersTimeout = this.timeoutMs;
  }

  async listen(): Promise<AddressInfo> {
    if (!this.listening) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off('error', onError);
          this.listening = true;
          resolve();
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(this.port, this.host);
      });
    }
    const address = this.server.address();
    if (!address || typeof address === 'string')
      authTransportError(
        'NOT_READY',
        'authorization server address unavailable',
      );
    return address;
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    this.listening = false;
  }

  private credential(token: string): AuthorizationTransportCredential | null {
    return (
      this.credentials.find((candidate) =>
        authHttpTokenMatches(candidate.token, token),
      ) ?? null
    );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const operation =
        url.pathname === `${this.path}/advance`
          ? 'advance'
          : url.pathname === `${this.path}/revoke`
            ? 'revoke'
            : undefined;
      if (!operation || request.method !== 'POST')
        authTransportError('NOT_FOUND', 'authorization endpoint unavailable');
      const token = authorizationBearerToken(request);
      const credential = token ? this.credential(token) : null;
      if (!credential)
        authTransportError(
          'UNAUTHENTICATED',
          'authorization credential invalid',
        );
      if (
        request.headers['content-type'] === undefined ||
        typeof request.headers['content-type'] !== 'string' ||
        !/^application\/json(?:\s*;|\s*$)/iu.test(
          request.headers['content-type'],
        )
      )
        authTransportError(
          'INVALID_REQUEST',
          'authorization content type invalid',
        );
      const rawBody = await readAuthorizationBody(
        request,
        this.maxRequestBytes,
        this.timeoutMs,
      );
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        authTransportError('INVALID_REQUEST', 'authorization JSON invalid');
      }
      const body = authorizationRequestBody(parsedBody);
      const record =
        operation === 'advance'
          ? await this.advance(body.body, credential.platformId)
          : await this.revoke(body.body, credential.platformId);
      authorizationJson(
        response,
        200,
        { protocolVersion: 1, record },
        this.maxResponseBytes,
      );
    } catch (error) {
      const failure = authorizationStoreHttpError(error);
      authorizationJson(
        response,
        failure.status,
        {
          protocolVersion: 1,
          error: { code: failure.code, retryable: failure.retryable },
        },
        this.maxResponseBytes,
      );
    }
  }

  private async advance(
    value: unknown,
    authenticatedPlatformId: string,
  ): Promise<AuthorizationVersionRecord> {
    const parsed = parseAuthorizationAdvance(value);
    if (parsed.platformId !== authenticatedPlatformId)
      authTransportError('FORBIDDEN', 'authorization platform mismatch');
    if (this.authorizeRoute && !(await this.authorizeRoute(parsed.route)))
      authTransportError('FORBIDDEN', 'authorization route denied');
    return this.options.store.advance({
      ...parsed,
      authenticatedPlatformId,
    });
  }

  private async revoke(
    value: unknown,
    authenticatedPlatformId: string,
  ): Promise<AuthorizationVersionRecord> {
    const parsed = parseAuthorizationRevoke(value);
    if (parsed.platformId !== authenticatedPlatformId)
      authTransportError('FORBIDDEN', 'authorization platform mismatch');
    if (this.authorizeRoute) {
      const current = await this.options.store.get(parsed);
      if (current && !(await this.authorizeRoute(current.route)))
        authTransportError('FORBIDDEN', 'authorization route denied');
    }
    return this.options.store.revoke({
      ...parsed,
      authenticatedPlatformId,
    });
  }
}

function authorizationClientUrl(
  options: HttpAuthorizationVersionClientOptions,
): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    authTransportError('INVALID_REQUEST', 'authorization base URL is invalid');
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(options.allowInsecureLocalhost && loopback)
  )
    authTransportError('INVALID_REQUEST', 'authorization HTTPS is required');
  return url;
}

/** Platform-side client for internal authorization synchronization. */
export class HttpAuthorizationVersionClient
  implements AuthorizationVersionSynchronizer
{
  private readonly baseUrl: URL;
  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpAuthorizationVersionClientOptions) {
    if (!options || typeof options !== 'object')
      authTransportError(
        'INVALID_REQUEST',
        'authorization client options invalid',
      );
    if (
      typeof options.token !== 'string' ||
      options.token.length < 32 ||
      options.token.length > MAX_PLAYER_CREDENTIAL_TOKEN_BYTES ||
      typeof options.platformId !== 'string' ||
      options.platformId.length === 0
    )
      authTransportError(
        'INVALID_REQUEST',
        'authorization client credentials invalid',
      );
    this.baseUrl = authorizationClientUrl(options);
    this.path = authServerPath(options.path ?? DEFAULT_AUTHORIZATION_HTTP_PATH);
    this.timeoutMs = authHttpLimit(
      options.timeoutMs ?? DEFAULT_AUTHORIZATION_HTTP_TIMEOUT_MS,
      'timeoutMs',
      300_000,
    );
    this.maxRequestBytes = authHttpLimit(
      options.maxRequestBytes ?? DEFAULT_AUTHORIZATION_HTTP_MAX_BYTES,
      'maxRequestBytes',
      8 * 1024 * 1024,
    );
    this.maxResponseBytes = authHttpLimit(
      options.maxResponseBytes ?? DEFAULT_AUTHORIZATION_HTTP_MAX_BYTES,
      'maxResponseBytes',
      8 * 1024 * 1024,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  advance(
    input: AuthorizationVersionAdvanceInput,
  ): Promise<AuthorizationVersionRecord> {
    if (input.authenticatedPlatformId !== this.options.platformId)
      authTransportError('FORBIDDEN', 'authorization platform mismatch');
    const { authenticatedPlatformId: _authenticatedPlatformId, ...body } =
      input;
    void _authenticatedPlatformId;
    return this.post('advance', body);
  }

  revoke(
    input: AuthorizationVersionRevokeInput,
  ): Promise<AuthorizationVersionRecord> {
    if (input.authenticatedPlatformId !== this.options.platformId)
      authTransportError('FORBIDDEN', 'authorization platform mismatch');
    const { authenticatedPlatformId: _authenticatedPlatformId, ...body } =
      input;
    void _authenticatedPlatformId;
    return this.post('revoke', body);
  }

  private async post(
    operation: AuthorizationTransportOperation,
    body: unknown,
  ): Promise<AuthorizationVersionRecord> {
    const request = JSON.stringify({ protocolVersion: 1, authorization: body });
    if (Buffer.byteLength(request, 'utf8') > this.maxRequestBytes)
      authTransportError(
        'INVALID_REQUEST',
        'authorization request is too large',
      );
    const url = new URL(this.baseUrl.toString());
    const prefix =
      this.baseUrl.pathname === '/'
        ? ''
        : this.baseUrl.pathname.replace(/\/$/u, '');
    url.pathname = `${prefix}${this.path}/${operation}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: request,
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted)
        authTransportError('TIMEOUT', 'authorization request timed out', true);
      if (error instanceof Error && error.name === 'AbortError')
        authTransportError('TIMEOUT', 'authorization request aborted', true);
      authTransportError('NETWORK', 'authorization request failed', true);
    } finally {
      clearTimeout(timeout);
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes)
      authTransportError('PROTOCOL', 'authorization response is too large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      authTransportError('PROTOCOL', 'authorization response is invalid');
    }
    const envelope = authorizationWireObject(parsed, 'response');
    if (envelope.protocolVersion !== 1)
      authTransportError('PROTOCOL', 'authorization response version invalid');
    if (!response.ok) {
      const error = authorizationWireObject(envelope.error, 'response.error');
      const code = error.code;
      const mapped: AuthorizationTransportErrorCode =
        code === 'UNAUTHENTICATED' ||
        code === 'FORBIDDEN' ||
        code === 'INVALID_REQUEST' ||
        code === 'CONFLICT' ||
        code === 'STALE' ||
        code === 'NOT_FOUND' ||
        code === 'NOT_READY'
          ? code
          : 'PROTOCOL';
      authTransportError(
        mapped,
        'authorization request rejected',
        mapped === 'NOT_READY',
      );
    }
    const record = authorizationWireObject(envelope.record, 'response.record');
    return structuredClone(record) as unknown as AuthorizationVersionRecord;
  }
}

export function issuePlayerCredential(
  options: IssuePlayerCredentialOptions,
): string {
  requireObject(options, 'issue options');
  const now = options.now ?? Date.now();
  requireTimestamp(now, 'now');
  requireString(options.platformId, 'platformId');
  requireString(options.audience, 'audience');
  const route = validateRoute(options.route);
  requireString(options.principalId, 'principalId');
  if (options.seatId !== undefined) requireString(options.seatId, 'seatId');
  const approvedGameScopes = validateApprovedGameScopes(
    options.approvedGameScopes,
  );
  const scopes = validateScopes(options.scopes, approvedGameScopes, true);
  requireString(options.authEpoch, 'authEpoch');
  requireInteger(options.authorizationRevision, 'authorizationRevision');
  const issuedAt = options.issuedAt ?? now;
  requireTimestamp(issuedAt, 'issuedAt');
  if (issuedAt > now) fail('CREDENTIAL_FUTURE', 'issuedAt is in the future');
  if (options.expiresAt !== undefined && options.ttlMs !== undefined)
    fail('INVALID_ARGUMENT', 'expiresAt and ttlMs cannot both be supplied');
  let expiresAt: number;
  if (options.expiresAt !== undefined) {
    requireTimestamp(options.expiresAt, 'expiresAt');
    expiresAt = options.expiresAt;
  } else {
    const ttlMs = options.ttlMs ?? DEFAULT_PLAYER_CREDENTIAL_TTL_MS;
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > MAX_PLAYER_CREDENTIAL_TTL_MS
    )
      fail('INVALID_ARGUMENT', 'ttlMs must be between 1 and 5 minutes');
    expiresAt = issuedAt + ttlMs;
  }
  const claims = validateClaims(
    {
      version: PLAYER_CREDENTIAL_VERSION,
      issuer: options.platformId,
      audience: options.audience,
      route,
      principalId: options.principalId,
      ...(options.seatId === undefined ? {} : { seatId: options.seatId }),
      scopes,
      authEpoch: options.authEpoch,
      authorizationRevision: options.authorizationRevision,
      issuedAt,
      expiresAt,
    },
    approvedGameScopes,
    true,
  );
  const payload = Buffer.from(canonicalStableStringify(claims), 'utf8');
  if (payload.length > MAX_PLAYER_CREDENTIAL_PAYLOAD_BYTES)
    fail('INVALID_ARGUMENT', 'player credential payload is too large');
  const signature = sign(null, payload, privateKeyObject(options.privateKey));
  return encodeToken(payload, signature);
}

export async function verifyPlayerCredential(
  options: VerifyPlayerCredentialOptions,
): Promise<AccessContext> {
  requireObject(options, 'verify options');
  if (
    !options.authorizationStore ||
    typeof options.authorizationStore.get !== 'function'
  )
    fail('INVALID_ARGUMENT', 'authorizationStore.get is required');
  requireString(options.expectedPlatformId, 'expectedPlatformId');
  requireString(options.expectedAudience, 'expectedAudience');
  const expectedRoute = validateRoute(options.expectedRoute);
  const now = options.now ?? Date.now();
  requireTimestamp(now, 'now');
  const approvedGameScopes = validateApprovedGameScopes(
    options.approvedGameScopes,
  );
  const parsed = parseToken(options.token);
  let valid = false;
  try {
    valid = verify(
      null,
      parsed.payload,
      publicKeyObject(options.publicKey),
      parsed.signature,
    );
  } catch (error) {
    if (error instanceof PlayerCredentialError) throw error;
    fail('SIGNATURE_INVALID', 'player credential signature is invalid');
  }
  if (!valid)
    fail('SIGNATURE_INVALID', 'player credential signature is invalid');
  const text = parsed.payload.toString('utf8');
  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(text);
  } catch {
    fail('INVALID_TOKEN', 'credential payload is not valid JSON');
  }
  let canonical: string;
  try {
    canonical = canonicalStableStringify(rawClaims);
  } catch {
    fail('INVALID_TOKEN', 'credential payload is not strict JSON');
  }
  if (canonical !== text)
    fail('INVALID_TOKEN', 'credential payload is not canonical JSON');
  const claims = validateClaims(rawClaims, approvedGameScopes, true);
  if (claims.issuer !== options.expectedPlatformId)
    fail(
      'ISSUER_MISMATCH',
      'player credential issuer does not match the platform',
    );
  if (claims.audience !== options.expectedAudience)
    fail(
      'AUDIENCE_MISMATCH',
      'player credential audience does not match the game service',
    );
  if (!sameRoute(claims.route, expectedRoute))
    fail(
      'ROUTE_MISMATCH',
      'player credential route does not match the expected route',
    );
  if (claims.issuedAt > now)
    fail('CREDENTIAL_FUTURE', 'player credential is not valid yet');
  if (claims.expiresAt <= now)
    fail('CREDENTIAL_EXPIRED', 'player credential has expired');
  const stored = await options.authorizationStore.get({
    platformId: claims.issuer,
    sessionId: claims.route.sessionId,
    principalId: claims.principalId,
  });
  if (!stored)
    fail('AUTHORIZATION_NOT_FOUND', 'player authorization is not known');
  if (stored.revokedAt !== undefined)
    fail('AUTHORIZATION_REVOKED', 'player authorization has been revoked');
  if (
    stored.authorizationRevision !== claims.authorizationRevision ||
    !sameRoute(stored.route, claims.route) ||
    stored.principalId !== claims.principalId ||
    stored.seatId !== claims.seatId ||
    stored.authEpoch !== claims.authEpoch ||
    canonicalStableStringify(stored.scopes) !==
      canonicalStableStringify(claims.scopes)
  )
    fail(
      'AUTHORIZATION_MISMATCH',
      'player credential is not the current authorization version',
    );
  return {
    principalId: claims.principalId,
    scopes: [...claims.scopes],
    authEpoch: claims.authEpoch,
    ...(claims.seatId === undefined ? {} : { seatId: claims.seatId }),
  };
}
