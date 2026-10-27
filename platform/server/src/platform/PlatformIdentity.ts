import {
  type AccessContext,
  assertParticipant,
  canonicalStableStringify,
  contractError,
  controlsParticipant,
  type MatchAdmission,
  type Participant,
  type PlatformRoom,
  participantAccountId,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  AdmissionStore,
  PlatformIdentityReference,
  ResolvedIdentity,
  RoomAccessSnapshot,
  RoomManagementAction,
  SessionGatewayOperation,
  StartOperation,
} from '@board-game/core';
import type { HostOperation } from '@board-game/host';
import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { resolveUserRole } from '@/auth/roleResolver.js';

import {
  PlatformAccountIdentity,
  type PlatformIdentityAccount,
} from './PlatformAccountIdentity.js';

export type { PlatformIdentityAccount } from './PlatformAccountIdentity.js';

/**
 * Request-scoped account data produced by PlatformAccountIdentity.resolveCurrent.
 * It is never retained between requests; callers must still resolve the active
 * auth session before constructing this context.
 */
export interface PlatformIdentityAuthorizationContext {
  readonly identity: ResolvedIdentity;
  readonly account: PlatformIdentityAccount;
}

type MaybePromise<T> = T | Promise<T>;

export type PlatformHostPolicyDecision = 'allow' | 'deny' | 'continue';

export interface PlatformHostPolicyInput {
  readonly context: AccessContext;
  readonly operation: HostOperation;
  readonly route: SessionRoute;
  readonly action?: 'pause' | 'resume' | 'cancel';
  readonly start: StartOperation;
  readonly db: NodePgDatabase;
  readonly authorize: (
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: SessionGatewayOperation,
    scopes?: readonly string[],
  ) => Promise<boolean>;
}

/** Game-owned policy hooks layered on the shared account/session boundary. */
export interface PlatformIdentityHooks {
  readonly authorizeLegacySession?: (input: {
    readonly db: NodePgDatabase;
    readonly account: PlatformIdentityAccount;
    readonly sessionId: string;
  }) => MaybePromise<boolean>;
  readonly authorizeScopes?: (input: {
    readonly account: PlatformIdentityAccount;
    readonly identity: ResolvedIdentity;
    readonly admission: MatchAdmission;
    readonly operation: SessionGatewayOperation;
    readonly scopes: readonly string[];
  }) => MaybePromise<boolean>;
  readonly accessScopes?: (input: {
    readonly account: PlatformIdentityAccount | undefined;
    readonly identity: ResolvedIdentity;
    readonly admission: MatchAdmission;
    readonly operation: SessionGatewayOperation;
  }) => MaybePromise<readonly string[]>;
  readonly freezeParticipants?: (input: {
    readonly db: NodePgDatabase;
    readonly room: PlatformRoom;
  }) => MaybePromise<readonly Participant[]>;
  readonly authorizeHistoryRetire?: (input: {
    readonly db: NodePgDatabase;
    readonly route: SessionRoute;
  }) => MaybePromise<boolean>;
  readonly authorizeHost?: (
    input: PlatformHostPolicyInput,
  ) => MaybePromise<PlatformHostPolicyDecision>;
}

const START_PRINCIPAL = 'platform:session-start';
const START_EPOCH = 'platform-start-v1';
const SYSTEM_PRINCIPAL = 'platform:session-scheduler';
const SYSTEM_EPOCH = 'platform-system-v1';
const NOTIFICATION_PRINCIPAL = 'platform:notification-reader';
const NOTIFICATION_EPOCH = 'platform-notification-v1';
const HISTORY_PRINCIPAL = 'platform:history-retention';
const HISTORY_EPOCH = 'platform-history-v1';
const DIAGNOSTIC_PRINCIPAL = 'platform:diagnostic-reader';
const DIAGNOSTIC_EPOCH = 'platform-diagnostic-v1';
/**
 * Shared platform identity boundary for every registered board game.
 *
 * The only account source is the application's users/auth_sessions store. A
 * game supplies policy hooks for game-owned scopes, profiles and Host service
 * principals; it cannot replace the account, session or route checks here.
 */
export class PlatformIdentity {
  private readonly accounts: PlatformAccountIdentity;
  constructor(
    private readonly baseDb: NodePgDatabase,
    private readonly admission: AdmissionStore,
    private readonly gameId: string,
    private readonly hooks: PlatformIdentityHooks = {},
    private readonly currentDatabase?: () => NodePgDatabase,
  ) {
    this.accounts = new PlatformAccountIdentity(baseDb, currentDatabase);
  }

  private get db(): NodePgDatabase {
    return this.currentDatabase?.() ?? this.baseDb;
  }

  async resolve(
    reference: PlatformIdentityReference,
  ): Promise<ResolvedIdentity> {
    return this.accounts.resolve(reference);
  }

  async resolvePublicAccount(
    principalId: string,
  ): Promise<PlatformIdentityAccount> {
    return this.accounts.resolvePublicAccount(principalId);
  }

  async authorizeLegacySession(
    reference: PlatformIdentityReference,
    sessionId: string,
  ): Promise<boolean> {
    const { account } = await this.resolveCurrent(reference);
    return (
      (await this.hooks.authorizeLegacySession?.({
        db: this.db,
        account,
        sessionId,
      })) ?? false
    );
  }

  private resolveCurrent(reference: PlatformIdentityReference) {
    return this.accounts.resolveCurrent(reference);
  }

  async authorize(
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: SessionGatewayOperation,
    scopes: readonly string[] = [],
    authorizationContext?: PlatformIdentityAuthorizationContext,
  ): Promise<boolean> {
    if (admission.route.gameId !== this.gameId) return false;
    if (
      admission.participants.some(
        (member) =>
          member.principalId === identity.principalId &&
          isSyntheticParticipant(member),
      )
    )
      return false;
    let account: PlatformIdentityAccount;
    if (authorizationContext) {
      if (
        authorizationContext.identity.principalId !== identity.principalId ||
        authorizationContext.identity.authEpoch !== identity.authEpoch ||
        authorizationContext.account.id !== identity.principalId ||
        authorizationContext.account.accountStatus !== 'active'
      )
        return false;
      account = authorizationContext.account;
    } else {
      const reference = epochReference(
        identity.principalId,
        identity.authEpoch,
      );
      const current = await this.resolveCurrent(reference);
      if (current.identity.authEpoch !== identity.authEpoch) return false;
      account = current.account;
    }
    if (
      this.hooks.authorizeScopes &&
      !(await this.hooks.authorizeScopes({
        account,
        identity,
        admission,
        operation,
        scopes,
      }))
    )
      return false;
    const participant = admission.participants.some((member) =>
      controlsParticipant(member, identity.principalId),
    );
    if (operation === 'command')
      return (
        participant && can(resolveUserRole(account), ECapability.GAME_PLAY)
      );
    return (
      participant ||
      admission.visibility === 'public' ||
      can(resolveUserRole(account), ECapability.GAME_INSPECT_ANY)
    );
  }

  async accessScopes(
    identity: ResolvedIdentity,
    admission: MatchAdmission,
    operation: SessionGatewayOperation,
  ): Promise<readonly string[]> {
    if (admission.route.gameId !== this.gameId) return [];
    const participant = admission.participants.some((member) =>
      controlsParticipant(member, identity.principalId),
    );
    if (
      admission.participants.some(
        (member) =>
          member.principalId === identity.principalId &&
          isSyntheticParticipant(member),
      )
    )
      return [];
    const scopes =
      operation === 'command'
        ? ['session:command']
        : participant
          ? ['session:view']
          : ['session:view', 'session:spectate'];
    const extra = await this.hooks.accessScopes?.({
      account: await this.account(identity.principalId),
      identity,
      admission,
      operation,
    });
    return [
      ...scopes,
      ...(extra ?? []).filter((scope) => !scope.startsWith('session:')),
    ];
  }

  async authorizeRoom(
    principalId: string,
    room: PlatformRoom,
    action: RoomManagementAction | 'start' | 'cancel',
    access?: RoomAccessSnapshot,
  ): Promise<boolean> {
    if (room.gameId !== this.gameId) return false;
    if (
      room.members.some(
        (member) =>
          member.principalId === principalId && isSyntheticParticipant(member),
      )
    )
      return false;
    const account = await this.account(principalId);
    if (!account || account.accountStatus !== 'active') return false;
    const member = room.members.some((participant) =>
      controlsParticipant(participant, principalId),
    );
    if (action === 'read')
      return (
        member ||
        room.visibility === 'public' ||
        access?.grants.some(
          (grant) =>
            grant.principalId === principalId &&
            (grant.state === 'pending' || grant.state === 'accepted'),
        ) === true ||
        can(resolveUserRole(account), ECapability.GAME_INSPECT_ANY)
      );
    if (action === 'read-invitation' || action === 'decline')
      return (
        access?.grants.some(
          (grant) =>
            grant.principalId === principalId && grant.state === 'pending',
        ) === true
      );
    if (!can(resolveUserRole(account), ECapability.GAME_PLAY)) return false;
    if (action === 'join')
      return member || room.visibility === 'public' || access !== undefined;
    return member;
  }

  async authorizeRoomInvite(
    ownerId: string,
    inviteeId: string,
    room: PlatformRoom,
  ): Promise<boolean> {
    if (
      room.gameId !== this.gameId ||
      ownerId !== room.ownerId ||
      ownerId === inviteeId
    )
      return false;
    if (
      room.members.some(
        (member) =>
          member.principalId === ownerId && isSyntheticParticipant(member),
      )
    )
      return false;
    const account = await this.account(inviteeId);
    if (
      !account ||
      account.accountStatus !== 'active' ||
      !can(resolveUserRole(account), ECapability.GAME_PLAY)
    )
      return false;
    return this.accounts.areFriends(ownerId, inviteeId);
  }

  async freezeParticipants(
    room: PlatformRoom,
  ): Promise<readonly Participant[]> {
    if (!room.members.length) return [];
    const syntheticMembers = room.members.filter(
      (member) => (member.controller ?? 'human') !== 'human',
    );
    const humanRoom =
      syntheticMembers.length === 0
        ? room
        : {
            ...room,
            members: room.members.filter(
              (member) => (member.controller ?? 'human') === 'human',
            ),
          };
    const frozen = this.hooks.freezeParticipants
      ? await this.hooks.freezeParticipants({ db: this.db, room: humanRoom })
      : await this.freezeHumanParticipants(humanRoom);
    if (!Array.isArray(frozen) || frozen.length !== humanRoom.members.length)
      throw contractError('INVALID_REQUEST', 'platform.start.roster');
    for (let index = 0; index < humanRoom.members.length; index += 1) {
      const participant = frozen[index];
      const member = humanRoom.members[index];
      assertParticipant(participant);
      if (!isFrozenParticipantShape(participant))
        throw contractError('INVALID_REQUEST', 'platform.start.roster');
      if (!sameParticipantIdentity(participant, member))
        throw contractError('INVALID_REQUEST', 'platform.start.roster');
    }
    const frozenByPrincipal = new Map(
      frozen.map((participant) => [participant.principalId, participant]),
    );
    return room.members.flatMap((member) => {
      const participant =
        (member.controller ?? 'human') !== 'human'
          ? syntheticParticipant(member)
          : frozenByPrincipal.get(member.principalId);
      if (!participant) return [];
      return [
        {
          ...participant,
          ...(member.controller !== undefined
            ? { controller: member.controller }
            : {}),
        },
      ];
    });
  }

  private async freezeHumanParticipants(
    room: PlatformRoom,
  ): Promise<readonly Participant[]> {
    const names = await this.accounts.publicNames(
      room.members.map((member) => member.principalId),
    );
    return room.members.map((member) => {
      const displayName = names.get(member.principalId);
      const publicProfile = {
        ...(member.publicProfile ?? {}),
        ...(displayName !== undefined ? { displayName } : {}),
      };
      return {
        principalId: member.principalId,
        seatId: member.seatId,
        ...(member.teamId ? { teamId: member.teamId } : {}),
        ...(member.controller !== undefined
          ? { controller: member.controller }
          : {}),
        ...(Object.keys(publicProfile).length > 0 ? { publicProfile } : {}),
      };
    });
  }

  publicNames(
    principalIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.accounts.publicNames(principalIds);
  }

  async startAccess(operation: StartOperation): Promise<AccessContext> {
    const room = await this.admission.getRoom(operation.roomId);
    if (!room) throw contractError('NOT_FOUND', 'platform.room.not_found');
    if (room.gameId !== this.gameId)
      throw contractError('FORBIDDEN', 'platform.admission.denied');
    // Cancellation must remain recoverable even after an account loses play access.
    if (operation.state !== 'cancelling') {
      const accountIds = new Set(
        operation.admission.participants
          .map(participantAccountId)
          .filter((id): id is string => id !== undefined),
      );
      for (const accountId of accountIds)
        if (!(await this.authorizeRoom(accountId, room, 'start')))
          throw contractError('FORBIDDEN', 'platform.admission.denied');
    }
    return {
      principalId: START_PRINCIPAL,
      authEpoch: START_EPOCH,
      scopes: ['session:create', 'session:control', 'session:view'],
    };
  }

  /** Service authority is scoped to one already admitted, pinned session. */
  async systemAccess(route: SessionRoute): Promise<AccessContext> {
    this.assertGameRoute(route, 'platform.system.route_denied');
    const start = await this.admission.getStartBySession(route.sessionId);
    if (
      !start ||
      start.state !== 'active' ||
      canonicalStableStringify(start.route) !== canonicalStableStringify(route)
    )
      throw contractError('FORBIDDEN', 'platform.system.route_denied');
    return {
      principalId: SYSTEM_PRINCIPAL,
      authEpoch: SYSTEM_EPOCH,
      scopes: ['session:system'],
    };
  }

  async notificationAccess(route: SessionRoute): Promise<AccessContext> {
    this.assertGameRoute(route, 'platform.notification.route_denied');
    const start = await this.admission.getStartBySession(route.sessionId);
    if (
      !start ||
      start.state !== 'active' ||
      canonicalStableStringify(start.route) !== canonicalStableStringify(route)
    )
      throw contractError('FORBIDDEN', 'platform.notification.route_denied');
    return {
      principalId: NOTIFICATION_PRINCIPAL,
      authEpoch: NOTIFICATION_EPOCH,
      scopes: ['session:view', 'session:spectate'],
    };
  }

  async historyAccess(route: SessionRoute): Promise<AccessContext> {
    await this.notificationAccess(route);
    return {
      principalId: HISTORY_PRINCIPAL,
      authEpoch: HISTORY_EPOCH,
      scopes: ['session:view', 'session:spectate', 'session:history:retire'],
    };
  }

  /** Issued only by the report/admin service after its access guard succeeds. */
  async diagnosticAccess(route: SessionRoute): Promise<AccessContext> {
    await this.notificationAccess(route);
    return {
      principalId: DIAGNOSTIC_PRINCIPAL,
      authEpoch: DIAGNOSTIC_EPOCH,
      scopes: ['session:view', 'session:spectate'],
    };
  }

  /**
   * Issues a short-lived, server-created Host context for an authenticated
   * operator. The browser never supplies this context or its scopes.
   */
  async adminAccess(
    reference: PlatformIdentityReference,
    route: SessionRoute,
  ): Promise<AccessContext> {
    if (route.gameId !== this.gameId)
      throw contractError('FORBIDDEN', 'platform.admin.game_denied');
    const { account, identity } = await this.resolveCurrent(reference);
    const role = resolveUserRole(account);
    if (
      !can(role, ECapability.ADMIN_ACCESS) ||
      !can(role, ECapability.GAME_MODIFY_ANY)
    )
      throw contractError('FORBIDDEN', 'platform.admin.denied');
    const start = await this.admission.getStartBySession(route.sessionId);
    if (
      !start ||
      canonicalStableStringify(start.route) !== canonicalStableStringify(route)
    )
      throw contractError('NOT_FOUND', 'platform.session.not_found');
    if (start.state !== 'active')
      throw contractError('CONFLICT', 'platform.admin.session_not_active');
    return {
      principalId: identity.principalId,
      authEpoch: identity.authEpoch,
      scopes: ['session:admin', 'session:view', 'session:control'],
    };
  }

  /** Rechecks the current account/session for operator jobs without a route. */
  async assertCurrentAdmin(
    reference: PlatformIdentityReference,
  ): Promise<void> {
    const { account } = await this.resolveCurrent(reference);
    const role = resolveUserRole(account);
    if (
      !can(role, ECapability.ADMIN_ACCESS) ||
      !can(role, ECapability.GAME_MODIFY_ANY)
    )
      throw contractError('FORBIDDEN', 'platform.admin.denied');
  }

  /** Host rechecks current identity after queue admission and before each transaction. */
  async authorizeHost(
    context: AccessContext,
    operation: HostOperation,
    route: SessionRoute,
    action?: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    this.assertGameRoute(route, 'platform.route.denied');
    const start = await this.admission.getStartBySession(route.sessionId);
    if (
      !start ||
      canonicalStableStringify(start.route) !== canonicalStableStringify(route)
    )
      throw contractError('FORBIDDEN', 'platform.route.denied');
    if (context.principalId === START_PRINCIPAL) {
      if (context.authEpoch !== START_EPOCH)
        throw contractError('UNAUTHENTICATED', 'platform.start.identity');
      const allowed =
        (operation === 'create' &&
          [
            'creating',
            'activating',
            'active',
            'cancelling',
            'cancelled',
          ].includes(start.state)) ||
        (operation === 'activate' &&
          ['activating', 'active'].includes(start.state)) ||
        (operation === 'control' && start.state === 'cancelling') ||
        operation === 'status';
      if (!allowed)
        throw contractError('FORBIDDEN', 'platform.start.operation');
      await this.startAccess(start);
      return;
    }
    if (context.principalId === SYSTEM_PRINCIPAL) {
      if (
        context.authEpoch !== SYSTEM_EPOCH ||
        operation !== 'system' ||
        !exactScopes(context.scopes, ['session:system'])
      )
        throw contractError('FORBIDDEN', 'platform.system.operation_denied');
      await this.systemAccess(route);
      return;
    }
    if (context.principalId === NOTIFICATION_PRINCIPAL) {
      if (
        context.authEpoch !== NOTIFICATION_EPOCH ||
        operation !== 'summary' ||
        !exactScopes(context.scopes, ['session:view', 'session:spectate'])
      )
        throw contractError(
          'FORBIDDEN',
          'platform.notification.operation_denied',
        );
      await this.notificationAccess(route);
      return;
    }
    if (context.principalId === HISTORY_PRINCIPAL) {
      if (
        context.authEpoch !== HISTORY_EPOCH ||
        !['summary', 'retire-history'].includes(operation) ||
        !exactScopes(context.scopes, [
          'session:view',
          'session:spectate',
          'session:history:retire',
        ])
      )
        throw contractError('FORBIDDEN', 'platform.history.operation_denied');
      await this.historyAccess(route);
      if (operation === 'retire-history') {
        const allowed = await this.hooks.authorizeHistoryRetire?.({
          db: this.db,
          route,
        });
        if (allowed !== true)
          throw contractError(
            'FORBIDDEN',
            'platform.history.purge_not_pending',
          );
      }
      return;
    }
    if (context.principalId === DIAGNOSTIC_PRINCIPAL) {
      if (
        context.authEpoch !== DIAGNOSTIC_EPOCH ||
        !['summary', 'events', 'trace-evidence'].includes(operation) ||
        !exactScopes(context.scopes, ['session:view', 'session:spectate'])
      )
        throw contractError(
          'FORBIDDEN',
          'platform.diagnostic.operation_denied',
        );
      await this.diagnosticAccess(route);
      return;
    }
    if (context.scopes.includes('session:admin')) {
      const current = await this.resolveCurrent(
        epochReference(context.principalId, context.authEpoch),
      );
      if (
        context.authEpoch !== current.identity.authEpoch ||
        !['control', 'automation-diagnostics'].includes(operation) ||
        (operation === 'control' &&
          !context.scopes.includes('session:control')) ||
        start.state !== 'active'
      )
        throw contractError('FORBIDDEN', 'platform.admin.operation_denied');
      const role = resolveUserRole(current.account);
      if (
        !can(role, ECapability.ADMIN_ACCESS) ||
        !can(role, ECapability.GAME_MODIFY_ANY)
      )
        throw contractError('FORBIDDEN', 'platform.admin.denied');
      return;
    }

    const decision = await this.hooks.authorizeHost?.({
      context,
      operation,
      route,
      ...(action ? { action } : {}),
      start,
      db: this.db,
      authorize: (identity, admission, authorizationOperation, scopes) =>
        this.authorize(identity, admission, authorizationOperation, scopes),
    });
    if (decision === 'allow') {
      if (start.state !== 'active')
        throw contractError('FORBIDDEN', 'platform.session.denied');
      return;
    }
    if (decision === 'deny')
      throw contractError('FORBIDDEN', 'platform.host.game_denied');

    if (
      ['create', 'activate', 'control', 'system', 'retire-history'].includes(
        operation,
      )
    )
      throw contractError('FORBIDDEN', 'platform.control.denied');
    if (start.state !== 'active')
      throw contractError('NOT_READY', 'platform.session.starting', true);
    if (
      !(await this.authorize(
        {
          principalId: context.principalId,
          authEpoch: context.authEpoch,
          active: true,
        },
        start.admission,
        operation as SessionGatewayOperation,
        context.scopes,
      ))
    )
      throw contractError('FORBIDDEN', 'platform.session.denied');
  }

  private assertGameRoute(route: SessionRoute, messageKey: string): void {
    if (route.gameId !== this.gameId)
      throw contractError('FORBIDDEN', messageKey);
  }

  private account(
    principalId: string,
  ): Promise<PlatformIdentityAccount | undefined> {
    return this.accounts.account(principalId);
  }
}

function exactScopes(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    expected.every((scope) => actual.includes(scope))
  );
}

function syntheticParticipant(
  member: PlatformRoom['members'][number],
): Participant {
  const { ready: _ready, ...participant } = member;
  return structuredClone(participant);
}

function isSyntheticParticipant(
  participant: Pick<Participant, 'controller'>,
): boolean {
  return (participant.controller ?? 'human') !== 'human';
}

function isFrozenParticipantShape(value: Participant): boolean {
  return Object.keys(value).every((key) =>
    [
      'principalId',
      'seatId',
      'teamId',
      'controller',
      'controlledBy',
      'controllerId',
      'controllerOptions',
      'publicProfile',
    ].includes(key),
  );
}

function sameParticipantIdentity(
  left: Participant,
  right: Participant,
): boolean {
  return (
    canonicalStableStringify([
      left.principalId,
      left.seatId,
      left.teamId ?? null,
      left.controller ?? 'human',
      left.controlledBy ?? null,
      left.controllerId ?? null,
      left.controllerOptions ?? null,
    ]) ===
    canonicalStableStringify([
      right.principalId,
      right.seatId,
      right.teamId ?? null,
      right.controller ?? 'human',
      right.controlledBy ?? null,
      right.controllerId ?? null,
      right.controllerOptions ?? null,
    ])
  );
}

function epochReference(
  principalId: string,
  epoch: string,
): PlatformIdentityReference {
  try {
    const value: unknown = JSON.parse(epoch);
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      typeof value[0] === 'string' &&
      value[0].length > 0 &&
      value.slice(1).every((part) => Number.isSafeInteger(part) && part >= 0)
    )
      return { principalId, authSessionId: value[0] };
  } catch {
    // The public API never accepts an auth epoch; malformed internal assertions fail closed.
  }
  throw contractError('UNAUTHENTICATED', 'platform.identity.epoch');
}
