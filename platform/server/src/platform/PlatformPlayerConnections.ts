import {
  type AuthorizationVersionAdvanceInput,
  type AuthorizationVersionKey,
  type AuthorizationVersionRecord,
  type AuthorizationVersionRevokeInput,
  type AuthorizationVersionStore,
  canonicalStableStringify,
  contractError,
  controlsParticipant,
  type MatchAdmission,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  AdmissionStore,
  PlatformIdentityReference,
  ResolvedIdentity,
  SessionGateway,
  SessionGatewayOperation,
} from '@board-game/core';
import {
  AuthorizationTransportError,
  AuthorizationVersionStoreError,
  type AuthorizationVersionSynchronizer,
  issuePlayerCredential,
  type PlayerCredentialPrivateKey,
} from '@board-game/server';

type MaybePromise<T> = T | Promise<T>;

export type PlatformPlayerConnectionMode = 'player' | 'viewer';

export interface PlatformPlayerIdentityPort {
  /** Resolves the server-authenticated account/session reference. */
  readonly resolve: (
    reference: PlatformIdentityReference,
  ) => MaybePromise<ResolvedIdentity>;
  /** Rechecks the current platform policy for the frozen admission. */
  readonly authorize: (
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: Extract<SessionGatewayOperation, 'view' | 'command'>,
  ) => MaybePromise<boolean>;
  /** Produces server-owned session and game scopes. */
  readonly accessScopes: (
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: Extract<SessionGatewayOperation, 'view' | 'command'>,
  ) => MaybePromise<readonly string[]>;
}

export interface PlatformPlayerConnectionClient {
  readonly endpoint: string;
  readonly route: SessionRoute;
}

export interface PlatformPlayerConnection {
  readonly playerEndpoint: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly route: SessionRoute;
  readonly client: PlatformPlayerConnectionClient;
}

export interface PlatformPlayerRevokeResult {
  readonly route: SessionRoute;
  readonly authorizationRevision: number;
  readonly revokedAt: number;
}

export interface PlatformPlayerConnectionsOptions {
  readonly platformId: string;
  readonly audience: string;
  readonly sessions: Pick<SessionGateway, 'descriptor'>;
  readonly admission: Pick<AdmissionStore, 'getAdmission'>;
  readonly identity: PlatformPlayerIdentityPort;
  /** Platform-side durable authorization authority. */
  readonly authorizationStore: AuthorizationVersionStore;
  /** Resolves the game-side sync channel for the exact frozen route. */
  readonly resolveAuthorizationSync: (
    route: SessionRoute,
  ) => MaybePromise<AuthorizationVersionSynchronizer>;
  /** Resolves only the public game player endpoint; no service credential crosses this API. */
  readonly resolvePlayerEndpoint: (route: SessionRoute) => MaybePromise<string>;
  readonly privateKey: PlayerCredentialPrivateKey;
  readonly approvedGameScopes?: readonly string[];
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const MAX_REVISION_RETRIES = 3;
const PLAYER_SESSION_SCOPES = new Set([
  'session:view',
  'session:command',
  'session:spectate',
]);

function copy<T>(value: T): T {
  return structuredClone(value);
}

function sameRoute(left: SessionRoute, right: SessionRoute): boolean {
  return canonicalStableStringify(left) === canonicalStableStringify(right);
}

function sameAuthorizationContent(
  left: Pick<
    AuthorizationVersionRecord,
    | 'platformId'
    | 'sessionId'
    | 'principalId'
    | 'route'
    | 'seatId'
    | 'scopes'
    | 'authEpoch'
  >,
  right: Pick<
    AuthorizationVersionRecord,
    | 'platformId'
    | 'sessionId'
    | 'principalId'
    | 'route'
    | 'seatId'
    | 'scopes'
    | 'authEpoch'
  >,
): boolean {
  return (
    canonicalStableStringify({
      platformId: left.platformId,
      sessionId: left.sessionId,
      principalId: left.principalId,
      route: left.route,
      ...(left.seatId === undefined ? {} : { seatId: left.seatId }),
      scopes: left.scopes,
      authEpoch: left.authEpoch,
    }) ===
    canonicalStableStringify({
      platformId: right.platformId,
      sessionId: right.sessionId,
      principalId: right.principalId,
      route: right.route,
      ...(right.seatId === undefined ? {} : { seatId: right.seatId }),
      scopes: right.scopes,
      authEpoch: right.authEpoch,
    })
  );
}

function keyFor(
  platformId: string,
  sessionId: string,
  principalId: string,
): AuthorizationVersionKey {
  return { platformId, sessionId, principalId };
}

function inputFromRecord(
  record: AuthorizationVersionRecord,
): AuthorizationVersionAdvanceInput {
  return {
    platformId: record.platformId,
    sessionId: record.sessionId,
    principalId: record.principalId,
    authenticatedPlatformId: record.platformId,
    route: copy(record.route),
    ...(record.seatId === undefined ? {} : { seatId: record.seatId }),
    scopes: [...record.scopes],
    authEpoch: record.authEpoch,
    authorizationRevision: record.authorizationRevision,
  };
}

function revokeInputFromRecord(
  record: AuthorizationVersionRecord,
): AuthorizationVersionRevokeInput {
  return {
    platformId: record.platformId,
    sessionId: record.sessionId,
    principalId: record.principalId,
    authenticatedPlatformId: record.platformId,
    authorizationRevision: record.authorizationRevision,
  };
}

function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048)
    throw contractError('INVALID_REQUEST', 'platform.player.endpoint.invalid');
  return value;
}

function selectedSeat(
  admission: MatchAdmission,
  reference: PlatformIdentityReference,
  identity: ResolvedIdentity,
): string | undefined {
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
    throw contractError('FORBIDDEN', 'platform.player.seat_required');
  return selected?.seatId;
}

function scopes(
  value: readonly string[],
  approvedGameScopes: readonly string[] = [],
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw contractError('FORBIDDEN', 'platform.player.scopes_missing');
  const approved = new Set(approvedGameScopes);
  for (const scope of value) {
    if (typeof scope !== 'string' || scope.length === 0 || scope === '*')
      throw contractError('FORBIDDEN', 'platform.player.scopes_invalid');
    if (scope.startsWith('session:')) {
      if (!PLAYER_SESSION_SCOPES.has(scope))
        throw contractError('FORBIDDEN', 'platform.player.scopes_invalid');
    } else if (!approved.has(scope)) {
      throw contractError('FORBIDDEN', 'platform.player.scopes_unapproved');
    }
  }
  return [...new Set(value)].sort();
}

/**
 * Platform-owned player credential issuance.  The connection never accepts a
 * browser route, principal or access context: all three are derived or
 * checked from the authenticated reference and the frozen admission.
 */
export class PlatformPlayerConnections {
  private readonly now: () => number;

  constructor(private readonly options: PlatformPlayerConnectionsOptions) {
    if (!options || typeof options !== 'object')
      throw contractError('INVALID_REQUEST', 'platform.player.options.invalid');
    if (
      typeof options.platformId !== 'string' ||
      options.platformId.length === 0 ||
      typeof options.audience !== 'string' ||
      options.audience.length === 0
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.player.identity.invalid',
      );
    if (!options.authorizationStore)
      throw contractError(
        'NOT_READY',
        'platform.player.authorization_store_unavailable',
      );
    this.now = options.now ?? Date.now;
  }

  async connect(
    reference: PlatformIdentityReference,
    sessionId: string,
    input: {
      readonly mode?: PlatformPlayerConnectionMode;
    } = {},
  ): Promise<PlatformPlayerConnection> {
    const descriptor = await this.options.sessions.descriptor(
      copy(reference),
      sessionId,
    );
    const route = copy(descriptor.route);
    if (route.sessionId !== sessionId)
      throw contractError('OWNERSHIP_LOST', 'platform.player.route_mismatch');
    const admission = await this.options.admission.getAdmission(sessionId);
    if (!admission)
      throw contractError('NOT_FOUND', 'platform.player.admission_missing');
    if (!sameRoute(admission.route, route))
      throw contractError('OWNERSHIP_LOST', 'platform.player.route_mismatch');
    const identity = await this.options.identity.resolve(copy(reference));
    if (!identity.active || identity.principalId !== reference.principalId)
      throw contractError(
        'UNAUTHENTICATED',
        'platform.player.identity_invalid',
      );
    const mode = input.mode ?? 'player';
    if (mode !== 'player' && mode !== 'viewer')
      throw contractError('INVALID_REQUEST', 'platform.player.mode_invalid');
    const seatId = selectedSeat(admission, reference, identity);
    if (!(await this.options.identity.authorize(identity, admission, 'view')))
      throw contractError('FORBIDDEN', 'platform.player.view_denied');
    const viewScopes = scopes(
      await this.options.identity.accessScopes(identity, admission, 'view'),
      this.options.approvedGameScopes,
    );
    let grantedScopes = viewScopes;
    if (mode === 'player') {
      if (seatId === undefined)
        throw contractError(
          'FORBIDDEN',
          'platform.player.participant_required',
        );
      if (
        !(await this.options.identity.authorize(identity, admission, 'command'))
      )
        throw contractError('FORBIDDEN', 'platform.player.command_denied');
      const commandScopes = scopes(
        await this.options.identity.accessScopes(
          identity,
          admission,
          'command',
        ),
        this.options.approvedGameScopes,
      );
      grantedScopes = scopes(
        [...viewScopes, ...commandScopes],
        this.options.approvedGameScopes,
      );
    }
    const playerEndpoint = endpoint(
      await this.options.resolvePlayerEndpoint(route),
    );
    const authorization = await this.ensureAuthorization({
      route,
      identity,
      seatId: mode === 'player' ? seatId : undefined,
      scopes: grantedScopes,
    });
    const sync = await this.options.resolveAuthorizationSync(route);
    if (!sync || typeof sync.advance !== 'function')
      throw contractError(
        'NOT_READY',
        'platform.player.sync_unavailable',
        true,
      );
    await this.syncAdvance(sync, authorization);
    const issuedAt = this.now();
    const expiresAt = issuedAt + (this.options.ttlMs ?? 5 * 60 * 1_000);
    const token = issuePlayerCredential({
      privateKey: this.options.privateKey,
      platformId: this.options.platformId,
      audience: this.options.audience,
      route,
      principalId: identity.principalId,
      ...(authorization.seatId === undefined
        ? {}
        : { seatId: authorization.seatId }),
      scopes: authorization.scopes,
      authEpoch: authorization.authEpoch,
      authorizationRevision: authorization.authorizationRevision,
      issuedAt,
      expiresAt,
      ...(this.options.approvedGameScopes
        ? { approvedGameScopes: this.options.approvedGameScopes }
        : {}),
    });
    return {
      playerEndpoint,
      token,
      expiresAt,
      route: copy(route),
      client: { endpoint: playerEndpoint, route: copy(route) },
    };
  }

  async revoke(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<PlatformPlayerRevokeResult> {
    const descriptor = await this.options.sessions.descriptor(
      copy(reference),
      sessionId,
    );
    const route = copy(descriptor.route);
    const identity = await this.options.identity.resolve(copy(reference));
    if (!identity.active || identity.principalId !== reference.principalId)
      throw contractError(
        'UNAUTHENTICATED',
        'platform.player.identity_invalid',
      );
    return this.revokePrincipal({
      route,
      principalId: identity.principalId,
    });
  }

  /**
   * Revokes an account's game authorization from a trusted platform hook.
   * Unlike the browser-facing overload above, this path deliberately does not
   * resolve a live login session so logout/revocation can invalidate tokens
   * after the account session has already been closed.
   */
  async revokePrincipal(input: {
    readonly route: SessionRoute;
    readonly principalId: string;
  }): Promise<PlatformPlayerRevokeResult> {
    if (typeof input.principalId !== 'string' || input.principalId.length === 0)
      throw contractError(
        'INVALID_REQUEST',
        'platform.player.principal_invalid',
      );
    const route = copy(input.route);
    const key = keyFor(
      this.options.platformId,
      route.sessionId,
      input.principalId,
    );
    const current = await this.options.authorizationStore.get(key);
    if (!current)
      throw contractError('NOT_FOUND', 'platform.player.authorization_missing');
    if (!sameRoute(current.route, route))
      throw contractError('OWNERSHIP_LOST', 'platform.player.route_mismatch');
    const revoked = await this.options.authorizationStore.revoke({
      ...key,
      authenticatedPlatformId: this.options.platformId,
      authorizationRevision: current.authorizationRevision,
    });
    let synced: AuthorizationVersionRecord;
    try {
      const sync = await this.options.resolveAuthorizationSync(route);
      if (!sync || typeof sync.revoke !== 'function')
        throw contractError(
          'NOT_READY',
          'platform.player.sync_unavailable',
          true,
        );
      synced = await sync.revoke(revokeInputFromRecord(revoked));
    } catch (error) {
      if (
        error instanceof AuthorizationTransportError &&
        ['NETWORK', 'TIMEOUT', 'NOT_READY'].includes(error.code)
      )
        throw contractError(
          'NOT_READY',
          'platform.player.revocation_pending',
          true,
        );
      throw error;
    }
    if (revoked.revokedAt === undefined)
      throw contractError('INTERNAL', 'platform.player.revoke_timestamp');
    if (
      synced.authorizationRevision !== revoked.authorizationRevision ||
      !sameRoute(synced.route, revoked.route) ||
      synced.revokedAt === undefined
    )
      throw contractError('CONFLICT', 'platform.player.sync_mismatch');
    return {
      route,
      authorizationRevision: revoked.authorizationRevision,
      revokedAt: revoked.revokedAt,
    };
  }

  private async ensureAuthorization(input: {
    readonly route: SessionRoute;
    readonly identity: ResolvedIdentity;
    readonly seatId?: string;
    readonly scopes: readonly string[];
  }): Promise<AuthorizationVersionRecord> {
    const key = keyFor(
      this.options.platformId,
      input.route.sessionId,
      input.identity.principalId,
    );
    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const current = await this.options.authorizationStore.get(key);
      const candidate = {
        platformId: this.options.platformId,
        sessionId: input.route.sessionId,
        principalId: input.identity.principalId,
        route: copy(input.route),
        ...(input.seatId === undefined ? {} : { seatId: input.seatId }),
        scopes: [...input.scopes],
        authEpoch: input.identity.authEpoch,
      };
      const authorizationRevision =
        current &&
        current.revokedAt === undefined &&
        sameAuthorizationContent(current, candidate)
          ? current.authorizationRevision
          : (current?.authorizationRevision ?? 0) + 1;
      try {
        return await this.options.authorizationStore.advance({
          ...candidate,
          authenticatedPlatformId: this.options.platformId,
          authorizationRevision,
        });
      } catch (error) {
        if (
          !(error instanceof AuthorizationVersionStoreError) ||
          (error.code !== 'AUTHORIZATION_CONFLICT' &&
            error.code !== 'AUTHORIZATION_STALE') ||
          attempt === MAX_REVISION_RETRIES - 1
        )
          throw error;
      }
    }
    throw contractError('CONFLICT', 'platform.player.authorization_race', true);
  }

  private async syncAdvance(
    sync: AuthorizationVersionSynchronizer,
    record: AuthorizationVersionRecord,
  ): Promise<void> {
    const synced = await sync.advance(inputFromRecord(record));
    if (
      synced.authorizationRevision !== record.authorizationRevision ||
      !sameAuthorizationContent(synced, record)
    )
      throw contractError('CONFLICT', 'platform.player.sync_mismatch');
  }
}
