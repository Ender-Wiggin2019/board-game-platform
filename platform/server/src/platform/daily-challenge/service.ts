import { createHash, randomUUID } from 'node:crypto';
import {
  assertGameResult,
  assertJsonPayloadSize,
  canonicalStableStringify,
  contractError,
  isJsonValue,
  isPlatformError,
  type JsonValue,
  type MatchAdmission,
  type Participant,
  type PlatformCompletionRecord,
  type PublicStartStatus,
  participantAccountId,
  type SessionRoute,
} from '@board-game/contracts';
import type { InboxEnvelope } from '@board-game/core';
import type {
  IPlatformDailyChallengeAttempt,
  IPlatformDailyChallengeGrinderLeaderboardEntry,
  IPlatformDailyChallengeLeaderboardResponse,
  IPlatformDailyChallengeLeaderboardsResponse,
  IPlatformDailyChallengeScoreLeaderboardEntry,
  IPlatformDailyChallengeSettings,
  IPlatformDailyChallengeSettingsPatch,
  IPlatformDailyChallengeSnapshot,
  IPlatformDailyChallengeStartResponse,
  IPlatformDailyChallengeTodayResponse,
} from '@board-platform/contracts';
import type { Pool } from 'pg';
import type { PlatformApplicationRuntime } from '../PlatformApplicationRuntime.js';
import {
  assertDailyChallengeRewardPolicy,
  type DailyChallengeRewardRunner,
} from './rewards.js';
import {
  PostgresDailyChallengeStore,
  type ReserveDailyChallengeAttemptInput,
} from './store.js';
import { dailyChallengeWindow } from './time.js';
import type {
  DailyChallengeAttemptRecord,
  DailyChallengeRegistration,
  DailyChallengeScore,
  DailyChallengeSnapshotRecord,
} from './types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LEADERBOARD_LIMIT = 100;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateSettings(
  registration: DailyChallengeRegistration,
  settings: JsonValue,
): void {
  try {
    const result = registration.settings.validate(clone(settings));
    if (result && typeof result.then === 'function')
      throw contractError('NOT_READY', 'platform.daily.settings_async', true);
  } catch (error) {
    if (isPlatformError(error)) throw error;
    throw contractError('INVALID_REQUEST', 'platform.daily.settings');
  }
}

async function validateSettingsAsync(
  registration: DailyChallengeRegistration,
  settings: JsonValue,
): Promise<void> {
  try {
    await registration.settings.validate(clone(settings));
    await registration.settings.validateAsync?.(clone(settings));
  } catch (error) {
    if (isPlatformError(error)) throw error;
    throw contractError('INVALID_REQUEST', 'platform.daily.settings');
  }
}

async function projectPublicSettings(
  registration: DailyChallengeRegistration,
  settings: JsonValue,
): Promise<JsonValue | undefined> {
  if (!registration.publicSettings) return undefined;
  let projected: JsonValue;
  try {
    projected = await registration.publicSettings(clone(settings));
  } catch (error) {
    if (isPlatformError(error)) throw error;
    throw contractError('INVALID_REQUEST', 'platform.daily.public_settings');
  }
  if (!isJsonValue(projected))
    throw contractError('INVALID_REQUEST', 'platform.daily.public_settings');
  assertJsonPayloadSize(projected, 128 * 1024, 'daily public settings');
  return clone(projected);
}

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    throw contractError('INVALID_REQUEST', `platform.daily.${field}`);
}

function validateDate(value: string): void {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value))
    throw contractError('INVALID_REQUEST', 'platform.daily.date');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw contractError('INVALID_REQUEST', 'platform.daily.date');
}

export function validateDailyChallengeDate(value: string): void {
  validateDate(value);
}

function finiteSeed(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    throw contractError('INVALID_REQUEST', 'platform.daily.seed');
  return value;
}

function finiteScore(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw contractError('INVALID_REQUEST', 'platform.daily.score');
  return value;
}

function participantKey(participant: Participant): string {
  return `${participant.principalId}:${participant.seatId}`;
}

function principalRoomKey(principalId: string): string {
  return createHash('sha256').update(principalId).digest('hex');
}

function validateParticipants(
  participants: readonly Participant[],
  expectedCount: number,
): readonly Participant[] {
  if (
    !Array.isArray(participants) ||
    participants.length !== expectedCount ||
    participants.length === 0
  )
    throw contractError('INVALID_REQUEST', 'platform.daily.participants');
  const keys = new Set<string>();
  const principals = new Set<string>();
  for (const participant of participants) {
    if (
      !participant ||
      typeof participant.principalId !== 'string' ||
      participant.principalId.length === 0 ||
      typeof participant.seatId !== 'string' ||
      participant.seatId.length === 0 ||
      keys.has(participantKey(participant)) ||
      principals.has(participant.principalId)
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.participants');
    keys.add(participantKey(participant));
    principals.add(participant.principalId);
  }
  return clone(participants);
}

function accountIds(participants: readonly Participant[]): readonly string[] {
  return participants
    .map(participantAccountId)
    .filter((principalId): principalId is string => principalId !== undefined);
}

function publicStart(
  status: PublicStartStatus,
): IPlatformDailyChallengeStartResponse['start'] {
  return {
    startId: status.startId,
    sessionId: status.sessionId,
    roomId: status.roomId,
    state: status.state,
  };
}

function assertMatchedStart(
  status: PublicStartStatus,
  attempt: Pick<
    DailyChallengeAttemptRecord,
    'roomId' | 'sessionId' | 'gameId' | 'releaseId' | 'modeId'
  >,
): void {
  if (
    status.roomId !== attempt.roomId ||
    status.sessionId !== attempt.sessionId ||
    status.route.sessionId !== attempt.sessionId ||
    status.route.gameId !== attempt.gameId ||
    status.route.releaseId !== attempt.releaseId ||
    status.route.modeId !== attempt.modeId
  )
    throw contractError('CONFLICT', 'platform.daily.start_mismatch', true);
}

/** Platform-owned daily orchestration with game-owned setup and scoring. */
export class PlatformDailyChallengeService {
  readonly store: PostgresDailyChallengeStore;
  private readonly registrations = new Map<
    string,
    DailyChallengeRegistration
  >();
  private readonly consumerGames = new Set<string>();

  public constructor(
    private readonly platform: PlatformApplicationRuntime,
    pool: Pool,
    private readonly rewardRunner?: DailyChallengeRewardRunner,
  ) {
    this.store = new PostgresDailyChallengeStore(pool);
  }

  public register(registration: DailyChallengeRegistration): void {
    requireIdentifier(registration.gameId, 'game_id');
    requireIdentifier(registration.releaseId, 'release_id');
    requireIdentifier(registration.modeId, 'mode_id');
    if (
      !Number.isSafeInteger(registration.playerCount) ||
      registration.playerCount < 1
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.player_count');
    validateSettings(registration, registration.settings.defaults);
    if (registration.rewardPolicy) {
      assertDailyChallengeRewardPolicy(registration.rewardPolicy);
      if (registration.rewardPolicy.modeId !== registration.modeId)
        throw contractError('INVALID_REQUEST', 'platform.daily.reward_mode');
    }
    // Do not project public settings during bootstrap. A remote release may
    // be restored while its control endpoint is unavailable; the first daily
    // read validates the projection through projectPublicSettings instead.
    const key = this.key(registration.gameId, registration.releaseId);
    if (this.registrations.has(key))
      throw contractError('CONFLICT', 'platform.daily.registration_duplicate');
    this.registrations.set(key, registration);
    if (!this.consumerGames.has(registration.gameId)) {
      this.platform.registerFactConsumer(
        `platform:${registration.gameId}:daily-challenge:v1`,
        (envelope) =>
          this.consumeCompletionForGame(registration.gameId, envelope),
        registration.gameId,
      );
      this.platform.registerRecoveryHook(
        `platform:${registration.gameId}:daily-challenge:v1`,
        () => this.refresh(registration.gameId, new Date()),
        registration.gameId,
      );
      this.consumerGames.add(registration.gameId);
    }
  }

  /** Embedded/legacy lookup; new remote dates resolve the approved stable channel. */
  public getRegistration(gameId: string): DailyChallengeRegistration | null {
    const current = this.platform.game(gameId);
    return this.registrations.get(this.key(gameId, current.releaseId)) ?? null;
  }

  public isDailyChallenge(
    gameId: string,
    releaseId: string,
    modeId: string,
  ): boolean {
    return (
      this.registrations.get(this.key(gameId, releaseId))?.modeId === modeId
    );
  }

  /** Extra spectator access is granted only through the dedicated replay gateway. */
  public async canReplay(
    route: SessionRoute,
    principalId: string,
  ): Promise<boolean> {
    const eligible = await this.store.getReplayEligibility(
      route.sessionId,
      principalId,
    );
    if (
      !eligible ||
      eligible.attempt.gameId !== route.gameId ||
      eligible.attempt.releaseId !== route.releaseId ||
      eligible.attempt.modeId !== route.modeId
    )
      return false;
    const platformId = this.platform.options?.platformId;
    const record = platformId
      ? await this.platform.completionStore?.get(platformId, route.sessionId)
      : undefined;
    const replay = record?.replayRef;
    return Boolean(
      record?.status === 'completed' &&
        replay &&
        replay.formatVersion === 1 &&
        canonicalStableStringify(record.route) ===
          canonicalStableStringify(route) &&
        replay.platformId === platformId &&
        replay.gameId === route.gameId &&
        replay.sessionId === route.sessionId &&
        replay.releaseId === route.releaseId &&
        replay.storageBindingId === route.storageBindingId,
    );
  }

  public async getToday(
    gameId: string,
    principalId: string,
    now = new Date(),
  ): Promise<IPlatformDailyChallengeTodayResponse> {
    await this.refresh(gameId, now);
    const challenge = await this.challenge(gameId, now);
    const { registration, snapshot } = challenge;
    const attempts = await this.store.listAttempts(
      registration.gameId,
      snapshot.challengeDate,
      principalId,
    );
    const active = attempts.find(
      (attempt) =>
        attempt.status === 'starting' || attempt.status === 'started',
    );
    const latest = attempts.at(-1);
    const displayedAttempt = active ?? latest;
    const leaderboards = await this.projectLeaderboards(
      gameId,
      snapshot.challengeDate,
      principalId,
    );
    return {
      challenge: this.publicSnapshot(snapshot),
      ...(active ? { activeAttempt: this.publicAttempt(active) } : {}),
      ...(latest ? { latestAttempt: this.publicAttempt(latest) } : {}),
      ...(displayedAttempt
        ? { attempt: this.publicAttempt(displayedAttempt) }
        : {}),
      attempts: attempts.map((attempt) => this.publicAttempt(attempt)),
      attemptCount: attempts.length,
      leaderboards,
      historyDates: await this.store.listHistoryDates(gameId),
      nextRefreshAt: dailyChallengeWindow(
        now,
        registration.timezone,
      ).nextRefreshAt.toISOString(),
    };
  }

  public async start(
    gameId: string,
    principalId: string,
    now = new Date(),
    requestedId?: string,
  ): Promise<IPlatformDailyChallengeStartResponse> {
    if (requestedId !== undefined) requireIdentifier(requestedId, 'request_id');
    if (requestedId !== undefined) {
      const previous = await this.store.getAttemptByRequest(
        gameId,
        principalId,
        requestedId,
      );
      if (previous) {
        const snapshot = await this.store.getSnapshot(
          gameId,
          previous.challengeDate,
        );
        if (!snapshot)
          throw contractError('CONFLICT', 'platform.daily.snapshot_missing');
        return this.resumeAttempt(
          this.snapshotRegistration(snapshot),
          snapshot,
          previous,
          now,
        );
      }
    }
    const challenge = await this.challenge(gameId, now);
    const { registration, snapshot } = challenge;
    const active = await this.store.getActiveAttempt(
      gameId,
      snapshot.challengeDate,
      principalId,
    );
    if (
      !active &&
      this.platform.gameAccess &&
      !(await this.platform.gameAccess.allows(
        gameId,
        registration.releaseId,
        principalId,
      ))
    )
      throw contractError('FORBIDDEN', 'platform.game_access.required');
    const attemptId = randomUUID();
    const sessionId = randomUUID();
    const requestId = requestedId ?? randomUUID();
    const roomId = `daily:${registration.gameId}:${snapshot.challengeDate}:${principalRoomKey(principalId)}:${attemptId}`;
    let candidateParticipants: readonly Participant[];
    try {
      candidateParticipants = await registration.participants({
        principalId,
        attemptId,
        sessionId,
        challengeDate: snapshot.challengeDate,
        setup: clone(snapshot.setup),
        settings: clone(snapshot.settings),
      });
    } catch (error) {
      if (isPlatformError(error)) throw error;
      throw contractError('INVALID_REQUEST', 'platform.daily.participants');
    }
    const participants = validateParticipants(
      candidateParticipants,
      registration.playerCount,
    );
    const humans = accountIds(participants);
    if (humans.length !== 1 || humans[0] !== principalId)
      throw contractError('INVALID_REQUEST', 'platform.daily.participants');
    const publicNames = await this.platform
      .accountIdentity()
      .publicNames(humans);
    const frozenParticipants = participants.map((participant) => {
      const accountId = participantAccountId(participant);
      const displayName = accountId ? publicNames.get(accountId) : undefined;
      if (displayName === undefined) return participant;
      return {
        ...participant,
        publicProfile: {
          ...(participant.publicProfile ?? {}),
          displayName,
        },
      };
    });
    const input: ReserveDailyChallengeAttemptInput = {
      attemptId,
      gameId: registration.gameId,
      releaseId: registration.releaseId,
      modeId: registration.modeId,
      challengeDate: snapshot.challengeDate,
      principalId,
      roomId,
      requestId,
      sessionId,
      participants: frozenParticipants,
      now,
    };
    const attempt = await this.store.reserveAttempt(input);
    if (attempt.challengeDate !== snapshot.challengeDate) {
      const previous = await this.store.getSnapshot(
        gameId,
        attempt.challengeDate,
      );
      if (!previous)
        throw contractError('CONFLICT', 'platform.daily.snapshot_missing');
      return this.resumeAttempt(
        this.snapshotRegistration(previous),
        previous,
        attempt,
        now,
      );
    }
    return this.resumeAttempt(registration, snapshot, attempt, now);
  }

  private async resumeAttempt(
    registration: DailyChallengeRegistration,
    snapshot: DailyChallengeSnapshotRecord,
    attempt: DailyChallengeAttemptRecord,
    now: Date,
  ): Promise<IPlatformDailyChallengeStartResponse> {
    const existingStart = await this.platform.admissionStore.getStart(
      attempt.roomId,
    );
    if (existingStart) {
      const recovered = await this.platform.admission.recoverStart(
        attempt.roomId,
      );
      assertMatchedStart(recovered, attempt);
      if (attempt.status === 'completed' || attempt.status === 'abandoned')
        return {
          challenge: this.publicSnapshot(snapshot),
          attempt: this.publicAttempt(attempt),
          start: publicStart(recovered),
        };
      if (recovered.state !== 'active')
        throw contractError(
          'CONFLICT',
          'platform.daily.start_unavailable',
          true,
        );
      const started = await this.store.markStarted(
        attempt.attemptId,
        recovered.startId,
        now,
      );
      return {
        challenge: this.publicSnapshot(snapshot),
        attempt: this.publicAttempt(started),
        start: publicStart(recovered),
      };
    }
    if (attempt.status === 'completed' || attempt.status === 'abandoned')
      throw contractError('CONFLICT', 'platform.daily.terminal_start_missing');
    if (!attempt.sessionId)
      throw contractError('CONFLICT', 'platform.daily.session_missing');
    const status = await this.platform.admission.createMatchedSession({
      roomId: attempt.roomId,
      sessionId: attempt.sessionId,
      requestId: attempt.requestId,
      gameId: registration.gameId,
      modeId: registration.modeId,
      releaseId: registration.releaseId,
      setup: snapshot.setup,
      seed: finiteSeed(snapshot.seed),
      participants: attempt.participants,
      policy: {
        rating: null,
        validityPolicyVersion:
          registration.validityPolicyVersion ??
          `${registration.gameId}-daily-challenge-v1`,
      },
    });
    assertMatchedStart(status, attempt);
    if (status.state !== 'active')
      throw contractError('CONFLICT', 'platform.daily.start_unavailable', true);
    const started = await this.store.markStarted(
      attempt.attemptId,
      status.startId,
      now,
    );
    return {
      challenge: this.publicSnapshot(snapshot),
      attempt: this.publicAttempt(started),
      start: publicStart(status),
    };
  }

  public async leaderboard(
    gameId: string,
    now = new Date(),
    requestedDate?: string,
  ): Promise<IPlatformDailyChallengeLeaderboardResponse> {
    const boards = await this.getLeaderboards(
      gameId,
      undefined,
      requestedDate,
      now,
    );
    return {
      ...boards,
      challengeDate: boards.date,
      entries: boards.overall.top,
    };
  }

  public async getAttempts(
    gameId: string,
    principalId: string,
    requestedDate?: string,
    now = new Date(),
  ) {
    const date = await this.readDate(gameId, requestedDate, now);
    await this.refresh(gameId, now);
    const attempts = await this.store.listAttempts(gameId, date, principalId);
    return {
      date,
      attempts: attempts.map((attempt) => this.publicAttempt(attempt)),
    };
  }

  public async updatePublication(
    gameId: string,
    principalId: string,
    sessionId: string,
    patch: { readonly publicationState: 'public' | 'anonymous' },
    now = new Date(),
  ): Promise<IPlatformDailyChallengeAttempt> {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => key !== 'publicationState') ||
      (patch.publicationState !== 'public' &&
        patch.publicationState !== 'anonymous')
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.publication');
    const attempt = await this.store.getAttemptBySession(sessionId);
    if (
      !attempt ||
      attempt.gameId !== gameId ||
      attempt.principalId !== principalId
    )
      throw contractError('NOT_FOUND', 'platform.daily.attempt');
    if (attempt.status !== 'completed')
      throw contractError('CONFLICT', 'platform.daily.attempt_not_completed');
    return this.publicAttempt(
      await this.store.publishAttempt({
        attemptId: attempt.attemptId,
        publicationState: patch.publicationState,
        publicationSelectedAt: now,
      }),
    );
  }

  public async getLeaderboards(
    gameId: string,
    principalId?: string,
    requestedDate?: string,
    now = new Date(),
  ): Promise<IPlatformDailyChallengeLeaderboardsResponse> {
    const date = await this.readDate(gameId, requestedDate, now);
    await this.refresh(gameId, now);
    return this.projectLeaderboards(gameId, date, principalId);
  }

  private async readDate(
    gameId: string,
    requestedDate: string | undefined,
    now: Date,
  ): Promise<string> {
    requireIdentifier(gameId, 'game_id');
    if (requestedDate !== undefined) {
      validateDate(requestedDate);
      // Historical dates are read-only: never create a past snapshot from today's template.
      if (await this.store.getSnapshot(gameId, requestedDate))
        return requestedDate;
    }
    const registration = await this.registration(gameId);
    const date = dailyChallengeWindow(now, registration.timezone).challengeDate;
    if (requestedDate !== undefined && requestedDate !== date)
      return requestedDate;
    await this.challenge(gameId, now);
    return date;
  }

  private async refresh(gameId: string, now: Date): Promise<void> {
    if (!Number.isFinite(now.getTime()))
      throw contractError('INVALID_REQUEST', 'platform.daily.date');
    await this.store.finalizeDue(now, gameId);
    await this.store.publishDue(now);
    if (this.rewardRunner) {
      const pending = await this.store.listPendingRewardSnapshots(gameId);
      for (const snapshot of pending) {
        const plan = await this.store.freezeRewardPlan(
          gameId,
          snapshot.challengeDate,
        );
        if (!plan) continue;
        await this.rewardRunner.settle(plan);
        await this.store.markRewardsSettled({
          gameId,
          challengeDate: snapshot.challengeDate,
          planDigest: plan.digest,
          settledAt: now,
        });
      }
    }
  }

  private async projectLeaderboards(
    gameId: string,
    date: string,
    principalId?: string,
  ): Promise<IPlatformDailyChallengeLeaderboardsResponse> {
    const boards = await this.store.listLeaderboards({
      gameId,
      challengeDate: date,
      principalId,
      limit: DEFAULT_LEADERBOARD_LIMIT,
    });
    const all = [
      ...boards.firstLook.top,
      ...boards.overall.top,
      ...boards.grinder.top,
      boards.firstLook.me,
      boards.overall.me,
      boards.grinder.me,
    ];
    const publicIds = [
      ...new Set(
        all.flatMap((entry) =>
          entry?.publicationState === 'public' && entry.principalId
            ? [entry.principalId]
            : [],
        ),
      ),
    ];
    const names = publicIds.length
      ? await this.platform.accountIdentity().publicNames(publicIds)
      : new Map<string, string>();
    const identity = (
      entry:
        | IPlatformDailyChallengeScoreLeaderboardEntry
        | IPlatformDailyChallengeGrinderLeaderboardEntry,
    ) => ({
      rank: entry.rank,
      entryKey: entry.entryKey,
      publicationState: entry.publicationState,
      displayName:
        entry.publicationState === 'anonymous'
          ? 'player'
          : entry.principalId
            ? (names.get(entry.principalId) ?? 'player')
            : 'player',
      ...(entry.principalId === principalId && principalId !== undefined
        ? { isCurrentUser: true }
        : {}),
      ...(entry.publicationState === 'public' && entry.principalId
        ? { principalId: entry.principalId }
        : {}),
    });
    const replayAccess = new Map<string, Promise<boolean>>();
    const replayAllowed = (sessionId: string): Promise<boolean> => {
      let pending = replayAccess.get(sessionId);
      if (!pending) {
        pending = (async () => {
          const platformId = this.platform.options?.platformId;
          const record = platformId
            ? await this.platform.completionStore?.get(platformId, sessionId)
            : undefined;
          return Boolean(
            record && (await this.canReplay(record.route, principalId ?? '')),
          );
        })();
        replayAccess.set(sessionId, pending);
      }
      return pending;
    };
    const score = async (
      entry: IPlatformDailyChallengeScoreLeaderboardEntry,
    ): Promise<IPlatformDailyChallengeScoreLeaderboardEntry> => ({
      ...identity(entry),
      attemptNumber: entry.attemptNumber,
      score: entry.score,
      completedAt: entry.completedAt,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.publicationState === 'public' && entry.result !== undefined
        ? { result: clone(entry.result) }
        : {}),
      ...(entry.rank <= 3 &&
      entry.sessionId &&
      (entry.publicationState === 'public' ||
        entry.principalId === principalId) &&
      (await replayAllowed(entry.sessionId))
        ? { sessionId: entry.sessionId, replayAvailable: true }
        : {}),
    });
    const grinder = (
      entry: IPlatformDailyChallengeGrinderLeaderboardEntry,
    ): IPlatformDailyChallengeGrinderLeaderboardEntry => ({
      ...identity(entry),
      attemptCount: entry.attemptCount,
      completedCount: entry.completedCount,
      ...(entry.bestScore === undefined ? {} : { bestScore: entry.bestScore }),
      ...(entry.latestCompletedAt
        ? { latestCompletedAt: entry.latestCompletedAt }
        : {}),
    });
    return {
      date,
      firstLook: {
        date,
        top: await Promise.all(boards.firstLook.top.map(score)),
        ...(boards.firstLook.me
          ? { me: await score(boards.firstLook.me) }
          : {}),
      },
      overall: {
        date,
        top: await Promise.all(boards.overall.top.map(score)),
        ...(boards.overall.me ? { me: await score(boards.overall.me) } : {}),
      },
      grinder: {
        date,
        top: boards.grinder.top.map(grinder),
        ...(boards.grinder.me ? { me: grinder(boards.grinder.me) } : {}),
      },
    };
  }

  public async getSettings(
    gameId: string,
  ): Promise<IPlatformDailyChallengeSettings> {
    const registration = await this.registration(gameId);
    const current = await this.store.getSettings(
      registration.gameId,
      registration.releaseId,
    );
    if (current)
      return {
        gameId: current.gameId,
        releaseId: current.releaseId,
        settings: clone(current.settings),
        revision: current.revision,
        updatedAt: current.updatedAt,
      };
    return {
      gameId: registration.gameId,
      releaseId: registration.releaseId,
      settings: clone(registration.settings.defaults),
      revision: 1,
      updatedAt: new Date(0).toISOString(),
    };
  }

  public async updateSettings(
    gameId: string,
    patch: IPlatformDailyChallengeSettingsPatch,
    now = new Date(),
  ): Promise<IPlatformDailyChallengeSettings> {
    const registration = await this.registration(gameId);
    if (
      !patch ||
      typeof patch !== 'object' ||
      !Object.hasOwn(patch, 'settings')
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.settings');
    if (
      patch.expectedRevision !== undefined &&
      (!Number.isSafeInteger(patch.expectedRevision) ||
        patch.expectedRevision < 1)
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.daily.settings_revision',
      );
    if (!isJsonValue(patch.settings))
      throw contractError('INVALID_REQUEST', 'platform.daily.settings');
    assertJsonPayloadSize(patch.settings, 128 * 1024, 'daily settings');
    await validateSettingsAsync(registration, patch.settings);
    if (patch.expectedRevision !== undefined) {
      const current = await this.store.getSettings(
        registration.gameId,
        registration.releaseId,
      );
      const revision = current?.revision ?? 1;
      if (patch.expectedRevision !== revision)
        throw contractError(
          'STALE_REVISION',
          'platform.daily.settings_revision',
        );
    }
    // Freeze today's tuple before changing the template; updates only affect
    // dates whose snapshot has not yet been created.
    const date = dailyChallengeWindow(now, registration.timezone).challengeDate;
    await this.snapshot(registration, now);
    try {
      const updated = await this.store.updateSettings({
        gameId: registration.gameId,
        releaseId: registration.releaseId,
        challengeDate: date,
        settings: patch.settings,
        expectedRevision: patch.expectedRevision,
        defaults: registration.settings.defaults,
        now,
      });
      return {
        gameId: updated.gameId,
        releaseId: updated.releaseId,
        settings: clone(updated.settings),
        revision: updated.revision,
        updatedAt: updated.updatedAt,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'DAILY_SETTINGS_REVISION_CONFLICT'
      )
        throw contractError(
          'STALE_REVISION',
          'platform.daily.settings_revision',
        );
      throw error;
    }
  }

  private async snapshot(registration: DailyChallengeRegistration, now: Date) {
    const window = dailyChallengeWindow(now, registration.timezone);
    const date = window.challengeDate;
    const existing = await this.store.getSnapshot(registration.gameId, date);
    if (existing) return existing;
    for (let retry = 0; retry < 3; retry += 1) {
      const existingSettings = await this.store.getSettings(
        registration.gameId,
        registration.releaseId,
      );
      const settings =
        existingSettings?.settings ?? registration.settings.defaults;
      await validateSettingsAsync(registration, settings);
      let setup: JsonValue;
      let seed: string;
      let preparedPublicSettings: JsonValue | undefined;
      try {
        if (registration.prepare) {
          const prepared = await registration.prepare(date, clone(settings));
          setup = prepared.setup;
          seed = prepared.seed;
          preparedPublicSettings = prepared.publicSettings;
        } else {
          setup = await registration.setupForDate(date, clone(settings));
          seed = await registration.seedForDate(date, clone(settings));
        }
      } catch (error) {
        if (isPlatformError(error)) throw error;
        throw contractError('INVALID_REQUEST', 'platform.daily.setup');
      }
      if (!isJsonValue(setup))
        throw contractError('INVALID_REQUEST', 'platform.daily.setup');
      assertJsonPayloadSize(setup, 128 * 1024, 'daily setup');
      try {
        await registration.validateSetup(setup);
      } catch (error) {
        if (isPlatformError(error)) throw error;
        throw contractError('INVALID_REQUEST', 'platform.daily.setup');
      }
      try {
        seed = finiteSeed(seed);
      } catch (error) {
        if (isPlatformError(error)) throw error;
        throw contractError('INVALID_REQUEST', 'platform.daily.seed');
      }
      try {
        const publicSettings =
          preparedPublicSettings === undefined
            ? await projectPublicSettings(registration, settings)
            : preparedPublicSettings;
        if (publicSettings !== undefined) {
          if (!isJsonValue(publicSettings))
            throw contractError(
              'INVALID_REQUEST',
              'platform.daily.public_settings',
            );
          assertJsonPayloadSize(
            publicSettings,
            128 * 1024,
            'daily public settings',
          );
        }
        return await this.store.ensureSnapshot({
          gameId: registration.gameId,
          releaseId: registration.releaseId,
          modeId: registration.modeId,
          challengeDate: date,
          defaults: clone(registration.settings.defaults),
          settingsRevision: existingSettings?.revision ?? 1,
          seed,
          setup,
          ...(publicSettings === undefined ? {} : { publicSettings }),
          eligibilityCutoffAt: window.eligibilityCutoffAt,
          ...(registration.rewardPolicy
            ? { rewardPolicy: registration.rewardPolicy }
            : {}),
          now,
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== 'DAILY_SETTINGS_CHANGED' ||
          retry === 2
        )
          throw error;
      }
    }
    throw contractError('CONFLICT', 'platform.daily.settings_changed', true);
  }

  private async challenge(
    gameId: string,
    now: Date,
  ): Promise<{
    readonly registration: DailyChallengeRegistration;
    readonly snapshot: DailyChallengeSnapshotRecord;
  }> {
    const current = await this.registration(gameId);
    const date = dailyChallengeWindow(now, current.timezone).challengeDate;
    const existing = await this.store.getSnapshot(gameId, date);
    const snapshot = existing ?? (await this.snapshot(current, now));
    return { registration: this.snapshotRegistration(snapshot), snapshot };
  }

  private snapshotRegistration(
    snapshot: DailyChallengeSnapshotRecord,
  ): DailyChallengeRegistration {
    const registration = this.registrations.get(
      this.key(snapshot.gameId, snapshot.releaseId),
    );
    if (!registration)
      throw contractError(
        'NOT_READY',
        'platform.daily.snapshot_release_unavailable',
        true,
      );
    if (registration.modeId !== snapshot.modeId)
      throw contractError('CONFLICT', 'platform.daily.snapshot_registration');
    return registration;
  }

  private async consumeCompletionForGame(
    gameId: string,
    envelope: InboxEnvelope,
  ): Promise<void> {
    if (!envelope.sessionId) return;
    if (envelope.kind === 'SessionControlled') {
      const payload = envelope.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return;
      const control = payload as Record<string, JsonValue>;
      if (
        control.action !== 'cancel' ||
        (control.status !== undefined && control.status !== 'cancelled')
      )
        return;
      const attempt = await this.store.getAttemptBySession(envelope.sessionId);
      if (
        !attempt ||
        attempt.gameId !== gameId ||
        attempt.releaseId !== envelope.sourceRelease
      )
        return;
      const admission = await this.platform.admissionStore.getAdmission(
        envelope.sessionId,
      );
      if (
        !admission ||
        admission.route.gameId !== gameId ||
        admission.route.releaseId !== attempt.releaseId ||
        admission.route.modeId !== attempt.modeId ||
        admission.route.sessionId !== envelope.sessionId ||
        canonicalStableStringify(admission.participants) !==
          canonicalStableStringify(attempt.participants)
      )
        throw contractError('INVALID_REQUEST', 'platform.daily.completion');
      const canonical = await this.acceptCompletionFact(envelope, admission);
      if (canonical && canonical.status !== 'cancelled')
        throw contractError('INVALID_REQUEST', 'platform.daily.completion');
      const endedAt = canonical?.endedAt ?? envelope.occurredAt;
      if (
        typeof endedAt !== 'number' ||
        !Number.isFinite(endedAt) ||
        endedAt < 0
      )
        throw contractError('INVALID_REQUEST', 'platform.daily.completion');
      if (attempt.status !== 'completed')
        await this.store.abandonAttempt(attempt.attemptId, new Date(endedAt));
      return;
    }
    if (envelope.kind !== 'SessionCompleted') return;
    const registration = this.registrations.get(
      this.key(gameId, envelope.sourceRelease),
    );
    if (!registration) {
      // A retained daily attempt must wait for its exact release adapter; a
      // normal session from an unknown release is unrelated to daily scoring.
      const attempt = await this.store.getAttemptBySession(envelope.sessionId);
      if (attempt)
        throw contractError(
          'NOT_READY',
          'platform.daily.snapshot_release_unavailable',
          true,
        );
      return;
    }
    await this.consumeCompletion(registration, envelope);
  }

  private async consumeCompletion(
    registration: DailyChallengeRegistration,
    envelope: InboxEnvelope,
  ): Promise<void> {
    if (
      envelope.kind !== 'SessionCompleted' ||
      envelope.sourceRelease !== registration.releaseId ||
      !envelope.sessionId
    )
      return;
    const attempt = await this.store.getAttemptBySession(envelope.sessionId);
    if (
      !attempt ||
      attempt.gameId !== registration.gameId ||
      attempt.releaseId !== registration.releaseId ||
      attempt.modeId !== registration.modeId
    )
      return;
    const admission = await this.platform.admissionStore.getAdmission(
      envelope.sessionId,
    );
    const admissionAccountIds = admission
      ? accountIds(admission.participants)
      : [];
    const payload = envelope.payload;
    if (
      !admission ||
      admission.route.gameId !== registration.gameId ||
      admission.route.releaseId !== registration.releaseId ||
      admission.route.modeId !== registration.modeId ||
      admission.route.sessionId !== envelope.sessionId ||
      canonicalStableStringify(attempt.participants) !==
        canonicalStableStringify(admission.participants) ||
      admissionAccountIds.length !== 1 ||
      admissionAccountIds[0] !== attempt.principalId ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.completion');
    const data = payload as Record<string, JsonValue>;
    const canonical = await this.acceptCompletionFact(envelope, admission);
    if (canonical && canonical.status !== 'completed')
      throw contractError('INVALID_REQUEST', 'platform.daily.completion');
    const resultRevision = canonical?.resultRevision ?? data.resultRevision;
    const endedAt = canonical?.endedAt ?? data.endedAt;
    if (
      !canonical &&
      (typeof resultRevision !== 'number' ||
        resultRevision !== 1 ||
        typeof endedAt !== 'number' ||
        !Number.isFinite(endedAt))
    )
      throw contractError('INVALID_REQUEST', 'platform.daily.completion');
    const result = canonical?.result ?? data.result;
    const completedAt = new Date(endedAt as number);
    if (!Number.isFinite(completedAt.getTime()))
      throw contractError('INVALID_REQUEST', 'platform.daily.completion');
    assertGameResult(result, admission.participants);
    let score: DailyChallengeScore | null;
    try {
      score = await registration.score(result, admission);
    } catch (error) {
      if (isPlatformError(error)) throw error;
      throw contractError('INVALID_REQUEST', 'platform.daily.score');
    }
    if (!score) throw contractError('INVALID_REQUEST', 'platform.daily.score');
    finiteScore(score.score);
    if (score.result !== undefined) {
      if (!isJsonValue(score.result))
        throw contractError('INVALID_REQUEST', 'platform.daily.result');
      assertJsonPayloadSize(score.result, 128 * 1024, 'daily result');
    }
    await this.store.completeAttempt({
      sessionId: envelope.sessionId,
      score: score.score,
      ...(score.result === undefined ? {} : { result: score.result }),
      completedAt,
      resultDigest:
        canonical?.digest ??
        createHash('sha256')
          .update(
            canonicalStableStringify({
              result,
              resultRevision,
              endedAt,
            }),
          )
          .digest('hex'),
    });
  }

  /**
   * Completion records are the authority for remote facts.  Embedded legacy
   * runtimes do not have a record store, but still require a source revision
   * so an out-of-order or malformed fact cannot mutate a daily attempt.
   */
  private async acceptCompletionFact(
    envelope: InboxEnvelope,
    admission: MatchAdmission,
  ): Promise<PlatformCompletionRecord | undefined> {
    if (!this.platform.completionStore) {
      if (
        !Number.isSafeInteger(envelope.aggregateSequence) ||
        (envelope.aggregateSequence as number) < 1
      )
        throw contractError('INVALID_REQUEST', 'platform.daily.completion');
      if (
        envelope.kind === 'SessionControlled' &&
        (typeof envelope.occurredAt !== 'number' ||
          !Number.isFinite(envelope.occurredAt) ||
          envelope.occurredAt < 0)
      )
        throw contractError('INVALID_REQUEST', 'platform.daily.completion');
      return undefined;
    }
    const platformId = this.platform.options?.platformId;
    if (!platformId)
      throw contractError('NOT_READY', 'platform.results.store_unavailable');
    return (await this.platform.completionStore.accept(envelope, admission))
      .record;
  }

  private async registration(
    gameId: string,
  ): Promise<DailyChallengeRegistration> {
    requireIdentifier(gameId, 'game_id');
    const releaseId = await this.currentReleaseId(gameId);
    const registration = this.registrations.get(this.key(gameId, releaseId));
    if (!registration)
      throw contractError('NOT_FOUND', 'platform.daily.unavailable');
    return registration;
  }

  /** Resolve the release selected for new daily snapshots, not the legacy game projection. */
  private async currentReleaseId(gameId: string): Promise<string> {
    const platformId = this.platform.options?.platformId;
    const releaseRegistry = this.platform.releaseRegistry;
    if (releaseRegistry && platformId) {
      const modeId = this.registrations
        .values()
        .find((registration) => registration.gameId === gameId)?.modeId;
      if (!modeId)
        throw contractError('NOT_FOUND', 'platform.daily.unavailable');
      const channel = await releaseRegistry.getChannel(
        platformId,
        gameId,
        modeId,
        'stable',
      );
      if (!channel)
        throw contractError(
          'NOT_READY',
          'platform.remote.channel_unavailable',
          true,
        );
      const binding = await releaseRegistry.getBinding(
        platformId,
        channel.targetBackendBindingId,
      );
      if (
        !binding ||
        binding.status !== 'ready' ||
        binding.gameId !== gameId ||
        binding.releaseId !== channel.releaseId ||
        binding.storageBindingId !== channel.storageBindingId ||
        binding.ownershipEpoch !== channel.ownershipEpoch
      )
        throw contractError(
          'NOT_READY',
          'platform.remote.channel_unavailable',
          true,
        );
      return channel.releaseId;
    }
    return this.platform.game(gameId).releaseId;
  }

  private key(gameId: string, releaseId: string): string {
    return JSON.stringify([gameId, releaseId]);
  }

  private publicSnapshot(
    snapshot: DailyChallengeSnapshotRecord,
  ): IPlatformDailyChallengeSnapshot {
    return {
      gameId: snapshot.gameId,
      releaseId: snapshot.releaseId,
      modeId: snapshot.modeId,
      challengeDate: snapshot.challengeDate,
      seed: snapshot.seed,
      setup: clone(snapshot.setup),
      ...(snapshot.publicSettings === undefined
        ? {}
        : { publicSettings: clone(snapshot.publicSettings) }),
      settingsRevision: snapshot.settingsRevision,
      createdAt: snapshot.createdAt,
      ...(snapshot.eligibilityCutoffAt
        ? { eligibilityCutoffAt: snapshot.eligibilityCutoffAt }
        : {}),
      ...(snapshot.finalizedAt ? { finalizedAt: snapshot.finalizedAt } : {}),
    };
  }

  private publicAttempt(
    attempt: DailyChallengeAttemptRecord,
  ): IPlatformDailyChallengeAttempt {
    return {
      attemptId: attempt.attemptId,
      challengeDate: attempt.challengeDate,
      attemptNumber: attempt.attemptNumber,
      publicationState: attempt.publicationState,
      ...(attempt.autoPublishAt
        ? { autoPublishAt: attempt.autoPublishAt }
        : {}),
      ...(attempt.publicationSelectedAt
        ? { publicationSelectedAt: attempt.publicationSelectedAt }
        : {}),
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
      status: attempt.status,
      ...(attempt.score === undefined ? {} : { score: attempt.score }),
      ...(attempt.result === undefined
        ? {}
        : { result: clone(attempt.result) }),
      ...(attempt.startedAt ? { startedAt: attempt.startedAt } : {}),
      ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
      updatedAt: attempt.updatedAt,
    };
  }
}
