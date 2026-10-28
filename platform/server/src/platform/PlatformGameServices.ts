import {
  assertGameResult,
  canonicalStableStringify,
  contractError,
  isAutomatedParticipant,
  type JsonValue,
  type PlatformCompletionRecord,
  participantAccountId,
  type SessionRoute,
} from '@board-game/contracts';
import {
  AwardRewardRunner,
  type InboxEnvelope,
  PostgresAwardStore,
  PostgresEntitlementStore,
  PostgresRatingStore,
  type RatingPolicy,
  RatingSettlementService,
} from '@board-game/core';
import type {
  GameAccessRegistration,
  IPlatformShellSummary,
} from '@board-platform/contracts';
import { and, count as countRows, eq, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { FriendRepository } from '../persistence/repository/FriendRepository.js';
import {
  globalMessages,
  userMessageReads,
} from '../persistence/schema/messages.js';
import {
  type GameCapabilityRegistration,
  GameCapabilityRegistry,
  GameCapabilityService,
  type GameCompletionInput,
  type GameStatisticsCapability,
  PostgresGameAchievementStore,
} from './capabilities/index.js';
import { createRemoteDailyChallengeRegistration } from './daily-challenge/remote.js';
import { DailyChallengeRewardRunner } from './daily-challenge/rewards.js';
import { PlatformDailyChallengeService } from './daily-challenge/service.js';
import type { DailyChallengeRewardPolicy } from './daily-challenge/types.js';
import type { GameAccessService } from './game-access/service.js';
import { NativeShellSummaryReader } from './NativeShellSummary.js';
import type {
  PlatformApplicationRuntime,
  RemoteDailyChallengeReleaseInput,
  RemoteSettlementReleaseInput,
} from './PlatformApplicationRuntime.js';
import {
  type GameMessageTemplate,
  PlatformMessageService,
  postgresGameMessageWriter,
} from './PlatformMessageService.js';
import {
  createRemoteSettlementHandler,
  type RemoteSettlementHandler,
  type RemoteSettlementPolicyBundle,
} from './remote-settlement.js';

const DIRECTORY_SESSIONS_TABLE =
  '"board_platform_directory"."sessions"' as const;
const ADMISSION_ROOM_GRANTS_TABLE =
  '"board_platform_admission"."room_grants"' as const;
const ADMISSION_ROOMS_TABLE = '"board_platform_admission"."rooms"' as const;

type StatisticsRow = Readonly<Record<string, unknown>>;

export interface GameServiceRegistration {
  readonly ratingPolicies?: readonly RatingPolicy[];
  /** Legacy adapters can keep their existing authoritative settlement consumers. */
  readonly settleCompletions?: boolean;
  readonly messages?: Readonly<Record<string, GameMessageTemplate>>;
  readonly completionMessage?: {
    readonly templateId: string;
    readonly payload: (completion: GameCompletionInput) => JsonValue;
  };
}

interface RemoteRatingPolicyDefinition {
  readonly gameId: string;
  readonly key: string;
  readonly signature: string;
  readonly policy: RatingPolicy;
}

function ratingPolicyKey(
  policyVersion: string,
  progressionPolicyVersion: string,
): string {
  return canonicalStableStringify([policyVersion, progressionPolicyVersion]);
}

/** Shared persistence and trusted completion processing for registered games. */
export class PlatformGameServices {
  readonly gameAccess?: GameAccessService;
  readonly registry = new GameCapabilityRegistry();
  readonly ratings: PostgresRatingStore;
  readonly achievements: PostgresGameAchievementStore;
  readonly capabilities: GameCapabilityService;
  readonly messages: PlatformMessageService;
  readonly dailyChallenges: PlatformDailyChallengeService;
  private readonly nativeShellSummary: NativeShellSummaryReader;
  private readonly db: NodePgDatabase;
  private readonly pool: Pool;
  private readonly policies = new Map<string, RatingPolicy>();
  private readonly remotePolicyDefinitions = new Map<
    string,
    { readonly gameId: string; readonly signature: string }
  >();
  private readonly remoteSettlements = new Map<
    string,
    RemoteSettlementHandler
  >();
  private readonly remoteDailyReleases = new Set<string>();
  private readonly remoteStatisticsReleases = new Set<string>();
  private readonly remoteDailyRewards = new Map<
    string,
    DailyChallengeRewardPolicy
  >();

  constructor(private readonly platform: PlatformApplicationRuntime) {
    this.gameAccess = platform.gameAccess;
    const { db, pool } = platform.options;
    this.db = db;
    this.pool = pool;
    this.nativeShellSummary = new NativeShellSummaryReader(pool, this.registry);
    const awards = new PostgresAwardStore({ pool });
    const entitlements = new PostgresEntitlementStore({ pool });
    this.ratings = new PostgresRatingStore({ pool });
    this.achievements = new PostgresGameAchievementStore(db);
    this.messages = new PlatformMessageService(
      postgresGameMessageWriter(db, (principalId) => {
        platform.notifyAccountsChanged([principalId]);
      }),
    );
    this.capabilities = new GameCapabilityService({
      registry: this.registry,
      awards,
      entitlements,
      ratings: new RatingSettlementService({
        store: this.ratings,
        admissions: platform.admissionStore,
        policies: {
          get: (version, progression) =>
            this.policies.get(ratingPolicyKey(version, progression)) ?? null,
        },
      }),
    });
    const rewards = new AwardRewardRunner({ awards, entitlements });
    this.dailyChallenges = new PlatformDailyChallengeService(
      platform,
      pool,
      new DailyChallengeRewardRunner({ awards, delivery: rewards }),
    );
    platform.registerRecoveryHook('platform:game-rewards:v1', async () => {
      await rewards.deliverPending({ limit: 100 });
    });
    const runtimeHooks = platform as PlatformApplicationRuntime & {
      readonly setPublicReplayAuthorization?: (
        hook: (route: SessionRoute, principalId: string) => Promise<boolean>,
      ) => void;
      readonly setRemoteDailyChallengeReleaseHook?: (
        hook: (input: RemoteDailyChallengeReleaseInput) => Promise<void> | void,
      ) => void;
      readonly setRemoteSettlementReleaseHook?: (
        hook: (input: RemoteSettlementReleaseInput) => Promise<void> | void,
      ) => void;
      readonly setSettlementHandler?: (
        handler: (record: PlatformCompletionRecord) => Promise<void>,
      ) => void;
    };
    runtimeHooks.setRemoteSettlementReleaseHook?.((input) =>
      this.installRemoteSettlement(input),
    );
    runtimeHooks.setRemoteDailyChallengeReleaseHook?.((input) =>
      this.installRemoteDailyChallenge(input),
    );
    runtimeHooks.setPublicReplayAuthorization?.((route, principalId) =>
      this.dailyChallenges.canReplay(route, principalId),
    );
    runtimeHooks.setSettlementHandler?.((record) =>
      this.settleCompletion(record),
    );
  }

  /** Registers a game-scoped catalog for games installed through this facade. */
  registerAccess(registration: GameAccessRegistration): void {
    this.platform.registerGameAccess(registration);
  }

  private remoteSettlementKey(gameId: string, releaseId: string): string {
    return `${gameId}\u0000${releaseId}`;
  }

  private installRemoteDailyChallenge(
    input: RemoteDailyChallengeReleaseInput,
  ): void {
    const daily = input.service.dailyChallenge;
    if (!daily || !input.approvedModes.includes(daily.modeId)) return;
    const key = this.remoteSettlementKey(input.gameId, input.releaseId);
    if (this.remoteDailyReleases.has(key)) return;
    const registration = createRemoteDailyChallengeRegistration({
      description: input.service,
      backend: {
        dailyChallenge: (request) => {
          const backend = this.platform.releaseGame(
            input.gameId,
            input.releaseId,
          ).backend;
          if (!backend.dailyChallenge)
            throw contractError(
              'NOT_READY',
              'platform.daily.unavailable',
              true,
            );
          return backend.dailyChallenge(request);
        },
      },
    });
    const rewardPolicy = this.remoteDailyRewards.get(key);
    this.dailyChallenges.register({
      ...registration,
      ...(rewardPolicy ? { rewardPolicy } : {}),
    });
    this.remoteDailyReleases.add(key);
  }

  private remoteStatisticsCapability(
    input: RemoteSettlementReleaseInput,
  ): GameStatisticsCapability | undefined {
    const description = input.service.statistics;
    if (!description) return undefined;
    if (
      input.approvedFeatures !== undefined &&
      !input.approvedFeatures.includes('statistics')
    )
      return undefined;
    return {
      description,
      query: async (request) => {
        const backend = this.platform.releaseGame(
          input.gameId,
          input.releaseId,
        ).backend;
        if (!backend.statistics)
          throw contractError(
            'NOT_READY',
            'platform.game.capability.statistics_unavailable',
            true,
          );
        return backend.statistics(request);
      },
    };
  }

  private async installRemoteSettlement(
    input: RemoteSettlementReleaseInput,
  ): Promise<void> {
    const key = this.remoteSettlementKey(input.gameId, input.releaseId);
    const statistics = this.remoteStatisticsCapability(input);
    if (input.policyBundle === undefined) {
      if (!statistics || this.remoteStatisticsReleases.has(key)) return;
      this.registerInternal(
        {
          metadata: structuredClone(input.metadata),
          releaseId: input.releaseId,
          capabilities: ['statistics'],
          policyVersions: [],
          assets: [],
          statistics,
        },
        {},
      );
      this.remoteStatisticsReleases.add(key);
      return;
    }
    const alreadyInstalled = this.remoteSettlements.has(key);
    const policyBundle =
      input.policyBundle as unknown as RemoteSettlementPolicyBundle;
    const handler = createRemoteSettlementHandler({
      bundle: policyBundle,
      approval: {
        gameId: input.gameId,
        releaseId: input.releaseId,
        approvedModes: input.approvedModes,
        approvedDailyModes: input.service.dailyChallenge
          ? input.approvedModes.filter(
              (modeId) => modeId === input.service.dailyChallenge?.modeId,
            )
          : [],
        approvedPolicyVersions: input.approvedPolicyVersions,
      },
      metadata: input.metadata,
      services: {
        achievements: this.achievements,
        ratings: this.ratings,
        capabilities: this.capabilities,
        messages: this.messages,
      },
      admission: (record) =>
        this.platform.admissionStore.getAdmission(record.sessionId),
    });
    if (
      policyBundle.dailyChallengeRewards &&
      policyBundle.dailyChallengeRewards.modeId !==
        input.service.dailyChallenge?.modeId
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.reward_mode');
    const approvedRatedModes = input.service.modes
      .filter(
        (mode) => mode.platformRating && input.approvedModes.includes(mode.id),
      )
      .map((mode) => mode.id);
    if (
      approvedRatedModes.some(
        (modeId) => !policyBundle.approvedModes.includes(modeId),
      )
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.remote.settlement_policy_mode_approval_required',
      );
    const remoteDefinitions = this.remoteRatingPolicyDefinitions(
      input.gameId,
      policyBundle,
      handler.ratingPolicies,
    );
    if (alreadyInstalled) {
      this.prepareRemotePolicies(remoteDefinitions);
      return;
    }
    this.registerInternal(
      statistics
        ? {
            ...handler.registration,
            capabilities: [
              ...handler.registration.capabilities,
              'statistics' as const,
            ],
            statistics,
          }
        : handler.registration,
      {
        ratingPolicies: handler.ratingPolicies,
        messages: handler.messages,
      },
      remoteDefinitions,
    );
    this.remoteSettlements.set(key, handler);
    if (statistics) this.remoteStatisticsReleases.add(key);
    if (policyBundle.dailyChallengeRewards)
      this.remoteDailyRewards.set(
        key,
        structuredClone(policyBundle.dailyChallengeRewards),
      );
  }

  private async settleCompletion(
    record: PlatformCompletionRecord,
  ): Promise<void> {
    const handler = this.remoteSettlements.get(
      this.remoteSettlementKey(record.route.gameId, record.route.releaseId),
    );
    if (handler) {
      await handler.settleCompletion(record);
      return;
    }
    if (this.platform.options.settleCompletion) {
      await this.platform.options.settleCompletion(record);
    }
  }

  register(
    registration: GameCapabilityRegistration,
    options: GameServiceRegistration = {},
  ): void {
    this.registerInternal(registration, options);
  }

  private registerInternal(
    registration: GameCapabilityRegistration,
    options: GameServiceRegistration,
    remoteDefinitions?: readonly RemoteRatingPolicyDefinition[],
  ): void {
    const gameId = registration.metadata.gameId;
    const game = this.platform.releaseGame(gameId, registration.releaseId);
    if (game.releaseId !== registration.releaseId)
      throw contractError(
        'CONFLICT',
        'platform.game.registration.release_mismatch',
      );
    const policies =
      remoteDefinitions === undefined
        ? this.preparePolicies(options.ratingPolicies ?? [])
        : this.prepareRemotePolicies(remoteDefinitions);
    if (
      options.completionMessage &&
      !options.messages?.[options.completionMessage.templateId]
    )
      throw contractError('INVALID_REQUEST', 'platform.messages.template');
    if (
      registration.dailyChallenge &&
      (registration.dailyChallenge.gameId !== gameId ||
        registration.dailyChallenge.releaseId !== registration.releaseId)
    )
      throw contractError(
        'CONFLICT',
        'platform.daily.registration_release_mismatch',
      );
    this.registry.register({
      ...registration,
      metadata: game.metadata,
      statistics:
        registration.statistics ??
        this.defaultStatistics(gameId, registration.releaseId),
    });
    if (registration.dailyChallenge)
      this.dailyChallenges.register(registration.dailyChallenge);
    this.installPolicies(policies);
    if (options.messages && !this.messages.hasGame(gameId))
      this.messages.registerGame(gameId, options.messages);
    if (options.settleCompletions) {
      this.platform.registerFactConsumer(
        `platform:${gameId}:${registration.releaseId}:capabilities:v1`,
        async (envelope) => {
          if (envelope.kind !== 'SessionCompleted') return;
          const completion = await this.completion(envelope);
          const hasSyntheticParticipant =
            completion.admission.participants.some(
              (participant) =>
                isAutomatedParticipant(participant) ||
                participant.controller === 'hotseat',
            );
          const isDailyChallenge = this.dailyChallenges.isDailyChallenge(
            completion.route.gameId,
            completion.route.releaseId,
            completion.route.modeId,
          );
          // Daily scores have their own idempotent leaderboard; never fan them
          // into ranked, wallet or shared reward settlement.
          if (!hasSyntheticParticipant && !isDailyChallenge)
            await this.capabilities.complete(completion);
          if (options.completionMessage) {
            const accountIds = new Set(
              completion.admission.participants
                .map(participantAccountId)
                .filter(
                  (accountId): accountId is string => accountId !== undefined,
                ),
            );
            for (const principalId of accountIds)
              await this.messages.publish({
                gameId,
                templateId: options.completionMessage.templateId,
                principalId,
                sourceId: `${completion.route.sessionId}:${completion.resultRevision}`,
                payload: options.completionMessage.payload(completion),
              });
          }
        },
        gameId,
        registration.releaseId,
      );
    }
    for (const definition of remoteDefinitions ?? [])
      this.remotePolicyDefinitions.set(definition.key, {
        gameId: definition.gameId,
        signature: definition.signature,
      });
  }

  /** Reads the one account-level snapshot consumed by the platform shell. */
  async readShellSummary(principalId: string): Promise<IPlatformShellSummary> {
    const [
      friendPendingCount,
      unreadCount,
      nativeInvitations,
      nativeAttention,
    ] = await Promise.all([
      new FriendRepository(this.db).countIncomingPendingForUser(principalId),
      this.countUnreadMessages(principalId),
      this.countNativeGameInvitations(principalId),
      this.nativeShellSummary.read(principalId),
    ]);
    const currentGames = this.registry.list().filter((entry) => {
      try {
        return (
          this.platform.releaseGame(entry.metadata.gameId, entry.releaseId)
            .releaseId === entry.releaseId
        );
      } catch {
        return false;
      }
    });
    const byGame = await Promise.all(
      currentGames.map(async (entry) => {
        const registration = this.registry.resolve(
          entry.metadata.gameId,
          entry.releaseId,
        );
        const value = registration.shellSummary
          ? await registration.shellSummary.read(principalId)
          : { gameInvitations: 0, actionRequired: 0, waitingReady: 0 };
        const native = nativeAttention.get(entry.metadata.gameId) ?? {
          actionRequired: 0,
          waitingReady: 0,
        };
        return {
          gameId: entry.metadata.gameId,
          gameInvitations: countValue(
            value.gameInvitations +
              (nativeInvitations.get(entry.metadata.gameId) ?? 0),
            'gameInvitations',
          ),
          actionRequired: countValue(
            value.actionRequired + native.actionRequired,
            'actionRequired',
          ),
          waitingReady: countValue(
            value.waitingReady + native.waitingReady,
            'waitingReady',
          ),
        };
      }),
    );
    return {
      notifications: {
        friendRequests: {
          incoming: countValue(friendPendingCount, 'friendRequests'),
        },
        gameInvitations: {
          pending: byGame.reduce(
            (total, game) => total + game.gameInvitations,
            0,
          ),
        },
        messages: { unread: countValue(unreadCount, 'messages') },
      },
      games: {
        actionRequired: byGame.reduce(
          (total, game) => total + game.actionRequired,
          0,
        ),
        waitingReady: byGame.reduce(
          (total, game) => total + game.waitingReady,
          0,
        ),
      },
      byGame,
    };
  }

  private async countUnreadMessages(principalId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: countRows() })
      .from(globalMessages)
      .leftJoin(
        userMessageReads,
        and(
          eq(userMessageReads.messageId, globalMessages.id),
          eq(userMessageReads.userId, principalId),
        ),
      )
      .where(
        and(
          isNull(userMessageReads.readAt),
          or(
            isNull(globalMessages.recipientUserId),
            eq(globalMessages.recipientUserId, principalId),
          ),
        ),
      );
    return Number(row?.value ?? 0);
  }

  private async countNativeGameInvitations(
    principalId: string,
  ): Promise<ReadonlyMap<string, number>> {
    const result = await this.pool.query<{
      game_id: string | null;
      invitation_count: string | number;
    }>(
      `SELECT room_row.room->>'gameId' AS game_id,
              count(*)::integer AS invitation_count
         FROM ${ADMISSION_ROOM_GRANTS_TABLE} grant_row
         JOIN ${ADMISSION_ROOMS_TABLE} room_row
           ON room_row.id = grant_row.room_id
        WHERE grant_row.principal_id = $1
          AND grant_row.state = 'pending'
          AND grant_row.room_id NOT LIKE 'direct:%'
          AND room_row.room->>'status' = 'open'
        GROUP BY room_row.room->>'gameId'`,
      [principalId],
    );
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      if (!row.game_id) continue;
      counts.set(
        row.game_id,
        countValue(row.invitation_count, `gameInvitations:${row.game_id}`),
      );
    }
    return counts;
  }

  /**
   * Register an exact capability adapter for a release whose Host/backend is
   * retained by the current game registration. The current release must be
   * registered first; its completion consumer and inbox templates are reused.
   */
  registerRetainedRelease(
    registration: GameCapabilityRegistration,
    ratingPolicies: readonly RatingPolicy[] = [],
  ): void {
    const gameId = registration.metadata.gameId;
    const game = this.platform.releaseGame(gameId, registration.releaseId);
    const currentGame = this.platform.game(gameId);
    if (
      registration.dailyChallenge &&
      (registration.dailyChallenge.gameId !== gameId ||
        registration.dailyChallenge.releaseId !== registration.releaseId)
    )
      throw contractError(
        'CONFLICT',
        'platform.daily.registration_release_mismatch',
      );
    if (!this.registry.get(gameId, currentGame.releaseId))
      throw contractError(
        'CONFLICT',
        'platform.game.registration.current_missing',
      );
    const policies = this.preparePolicies(ratingPolicies);
    this.registry.register({
      ...registration,
      metadata: game.metadata,
      statistics:
        registration.statistics ??
        this.defaultStatistics(gameId, registration.releaseId),
    });
    if (registration.dailyChallenge)
      this.dailyChallenges.register(registration.dailyChallenge);
    this.installPolicies(policies);
  }

  private preparePolicies(
    policies: readonly RatingPolicy[],
  ): readonly (readonly [string, RatingPolicy])[] {
    const pending = new Map<string, RatingPolicy>();
    for (const policy of policies) {
      const key = ratingPolicyKey(
        policy.policyVersion,
        policy.progressionPolicyVersion,
      );
      if (this.policies.has(key) || pending.has(key))
        throw contractError(
          'CONFLICT',
          'platform.game.rating_policy_registered',
        );
      pending.set(key, policy);
    }
    return [...pending.entries()];
  }

  private prepareRemotePolicies(
    definitions: readonly RemoteRatingPolicyDefinition[],
  ): readonly (readonly [string, RatingPolicy])[] {
    const pending = new Map<string, RatingPolicy>();
    for (const definition of definitions) {
      const existing = this.remotePolicyDefinitions.get(definition.key);
      if (existing) {
        if (
          existing.gameId !== definition.gameId ||
          existing.signature !== definition.signature
        )
          throw contractError(
            'CONFLICT',
            'platform.game.rating_policy_registered',
          );
        continue;
      }
      if (this.policies.has(definition.key) || pending.has(definition.key))
        throw contractError(
          'CONFLICT',
          'platform.game.rating_policy_registered',
        );
      pending.set(definition.key, definition.policy);
    }
    return [...pending.entries()];
  }

  private remoteRatingPolicyDefinitions(
    gameId: string,
    bundle: RemoteSettlementPolicyBundle,
    policies: readonly RatingPolicy[],
  ): readonly RemoteRatingPolicyDefinition[] {
    const specs = [
      {
        poolId: bundle.rating.poolId,
        policyVersion: bundle.rating.policyVersion,
        progressionPolicyVersion: bundle.rating.progressionPolicyVersion,
      },
      ...(bundle.rating.policies ?? []),
    ];
    if (specs.length !== policies.length)
      throw contractError('CONFLICT', 'platform.game.rating_policy_registered');
    return policies.map((policy, index) => {
      const spec = specs[index];
      if (
        !spec ||
        policy.policyVersion !== spec.policyVersion ||
        policy.progressionPolicyVersion !== spec.progressionPolicyVersion
      )
        throw contractError(
          'CONFLICT',
          'platform.game.rating_policy_registered',
        );
      return {
        gameId,
        key: ratingPolicyKey(spec.policyVersion, spec.progressionPolicyVersion),
        signature: canonicalStableStringify({
          gameId,
          spec: {
            poolId: spec.poolId,
            policyVersion: spec.policyVersion,
            progressionPolicyVersion: spec.progressionPolicyVersion,
          },
          algorithm: bundle.rating.algorithm,
          parameters: bundle.rating.parameters,
          stars: bundle.rating.stars,
        }),
        policy,
      };
    });
  }

  private installPolicies(
    policies: readonly (readonly [string, RatingPolicy])[],
  ): void {
    for (const [key, policy] of policies) this.policies.set(key, policy);
  }

  private defaultStatistics(
    gameId: string,
    releaseId: string,
  ): NonNullable<GameCapabilityRegistration['statistics']> {
    return {
      read: async (principalId) => {
        const result = await this.pool.query<StatisticsRow>(
          `SELECT
             count(*)::text AS total_sessions,
             count(*) FILTER (WHERE status = 'active')::text AS active_sessions,
             count(*) FILTER (WHERE status = 'paused')::text AS paused_sessions,
             count(*) FILTER (WHERE status = 'suspended')::text AS suspended_sessions,
             count(*) FILTER (WHERE status = 'completed')::text AS completed_sessions,
             count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled_sessions
           FROM ${DIRECTORY_SESSIONS_TABLE}
           WHERE game_id = $1 AND release_id = $2`,
          [gameId, releaseId],
        );
        const row = result.rows[0] ?? {};
        const base = {
          gameId,
          releaseId,
          totalSessions: count(row, 'total_sessions'),
          activeSessions: count(row, 'active_sessions'),
          pausedSessions: count(row, 'paused_sessions'),
          suspendedSessions: count(row, 'suspended_sessions'),
          completedSessions: count(row, 'completed_sessions'),
          cancelledSessions: count(row, 'cancelled_sessions'),
        };
        if (!principalId) return base;
        const playerResult = await this.pool.query<StatisticsRow>(
          `SELECT
             count(*)::text AS played_sessions,
             count(*) FILTER (WHERE status = 'completed')::text AS completed_sessions,
             count(*) FILTER (
               WHERE status = 'completed' AND (
                 (
                   result->>'kind' = 'solo'
                   AND result->>'outcome' = 'won'
                   AND result->'participantIds' ? $3
                 ) OR (
                   result->>'kind' = 'competitive'
                   AND EXISTS (
                     SELECT 1
                       FROM jsonb_array_elements(result->'rankGroups'->0->'teams') AS winning_team,
                            jsonb_array_elements_text(winning_team->'participantIds') AS winning_participant,
                            jsonb_array_elements(participants) AS participant
                      WHERE winning_participant = participant->>'principalId'
                        AND (
                          (
                            COALESCE(participant->>'controller', 'human') = 'hotseat'
                            AND participant->>'controlledBy' = $3
                          ) OR (
                            COALESCE(participant->>'controller', 'human') NOT IN ('ai', 'automa', 'bot', 'hotseat')
                            AND participant->>'principalId' = $3
                          )
                        )
                   )
                 )
               )
             )::text AS wins
           FROM ${DIRECTORY_SESSIONS_TABLE}
           WHERE game_id = $1 AND release_id = $2
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(participants) AS participant
                WHERE (
                  COALESCE(participant->>'controller', 'human') = 'hotseat'
                  AND participant->>'controlledBy' = $3
                ) OR (
                  COALESCE(participant->>'controller', 'human') NOT IN ('ai', 'automa', 'bot', 'hotseat')
                  AND participant->>'principalId' = $3
                )
             )`,
          [gameId, releaseId, principalId],
        );
        const player = playerResult.rows[0] ?? {};
        const playedSessions = count(player, 'played_sessions');
        return {
          ...base,
          ...(playedSessions > 0
            ? {
                playedSessions,
                playerCompletedSessions: count(player, 'completed_sessions'),
                wins: count(player, 'wins'),
              }
            : {}),
        };
      },
    };
  }

  private async completion(
    envelope: InboxEnvelope,
  ): Promise<GameCompletionInput> {
    const admission = envelope.sessionId
      ? await this.platform.admissionStore.getAdmission(envelope.sessionId)
      : null;
    const payload = envelope.payload;
    if (
      !admission ||
      admission.route.releaseId !== envelope.sourceRelease ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    )
      throw contractError('INVALID_REQUEST', 'platform.completion.invalid');
    const { result, resultRevision, endedAt } = payload as Readonly<
      Record<string, JsonValue>
    >;
    if (
      typeof resultRevision !== 'number' ||
      !Number.isSafeInteger(resultRevision) ||
      resultRevision < 1 ||
      typeof endedAt !== 'number' ||
      !Number.isFinite(endedAt) ||
      endedAt < 0
    )
      throw contractError('INVALID_REQUEST', 'platform.completion.invalid');
    assertGameResult(result, admission.participants);
    const achievementSources = readAchievementSources(
      (payload as Readonly<Record<string, JsonValue>>).progress,
      admission.participants.map((participant) => participant.principalId),
    );
    return {
      route: admission.route,
      admission,
      result,
      resultRevision,
      occurredAt: endedAt,
      ...(achievementSources ? { achievementSources } : {}),
    };
  }
}

function readAchievementSources(
  progress: JsonValue | undefined,
  participantIds: readonly string[],
): GameCompletionInput['achievementSources'] | undefined {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress))
    return undefined;
  const envelope = (progress as Record<string, JsonValue>).achievementFacts;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    return undefined;
  const value = envelope as Record<string, JsonValue>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'seti:completed-achievement-facts'
  )
    return undefined;
  if (!Array.isArray(value.facts))
    throw contractError('INVALID_REQUEST', 'platform.completion.invalid');
  const participants = new Set(participantIds);
  const seen = new Set<string>();
  return value.facts.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw contractError('INVALID_REQUEST', 'platform.completion.invalid');
    const row = entry as Record<string, JsonValue>;
    if (
      typeof row.userId !== 'string' ||
      !participants.has(row.userId) ||
      seen.has(row.userId) ||
      !Array.isArray(row.facts)
    )
      throw contractError('INVALID_REQUEST', 'platform.completion.invalid');
    seen.add(row.userId);
    return { principalId: row.userId, facts: row.facts };
  });
}

function count(row: StatisticsRow, field: string): number {
  const value = Number(row[field] ?? 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid platform statistics count: ${field}`);
  return value;
}

function countValue(value: unknown, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0)
    throw new Error(`Invalid platform shell count: ${field}`);
  return normalized;
}
