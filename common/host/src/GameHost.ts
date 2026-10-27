import { createHash } from 'node:crypto';
import {
  type AccessContext,
  type ActivateSessionRequest,
  type ActivateSessionResponse,
  type Actor,
  type AutomationFailure,
  assertAccessContext,
  assertControlSessionRequest,
  assertCreateSessionRequest,
  assertGameResult,
  assertGetEventsRequest,
  assertJsonPayloadSize,
  assertMatchesSchema,
  assertParticipant,
  assertProtocolRequest,
  assertSessionRoute,
  assertSubmitCommandRequest,
  assertSubmitSystemCommandRequest,
  assertTurnState,
  type BackendDescription,
  type BackendPort,
  type CommandPrecondition,
  type ControlAction,
  type ControlSessionRequest,
  type ControlSessionResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  canonicalStableStringify,
  contractError,
  controlsParticipant,
  DEFAULT_JSON_LIMITS,
  type DescribeRequest,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type GetPlayerViewRequest,
  type GetSessionSummaryRequest,
  type GetStatusRequest,
  isAutomatedParticipant,
  isErrorCode,
  isJsonValue,
  type JsonValue,
  type OperationStatus,
  type Participant,
  PlatformError,
  type PlayerViewEnvelope,
  type ProjectedEvent,
  type QueryOptionsRequest,
  type QueryOptionsResponse,
  type ReadyRequest,
  type ReadyResponse,
  type ResumeRequest,
  type ResumeResult,
  type RetireSessionHistoryRequest,
  type SafeCommandReceipt,
  type SessionRoute,
  type SessionSummary,
  type SubmitCommandRequest,
  type SubmitCommandResponse,
  type SubmitSystemCommandRequest,
  type SubmitSystemCommandResponse,
  type TurnState,
  type TurnView,
  toErrorEnvelope,
  turnPrecondition,
  type Viewer,
} from '@board-game/contracts';
import {
  type AutomationDecisionInput,
  type AutomationPolicy,
  automationOptions,
} from '@board-game/sdk';
import {
  type AutomationDecision,
  type AutomationTrace,
  type CommandReceipt,
  type DomainEvent,
  isStorageError,
  type OutboxRecord,
  type PrivateCommandTraceKind,
  type SessionDeadline,
  type SessionHead,
  type SessionTransaction,
  type StorageDriver,
} from '@board-game/storage';
import { GameRegistry, type RuntimeModule } from './GameRegistry.js';
import {
  type OfflineAutomationReplayResult,
  replayAutomationTraceOffline,
  runBoundedAutomationDecision,
} from './offlineReplay.js';
import {
  ResourceCoordinator,
  ResourceCoordinatorError,
  type ResourceFinalizationOutcome,
  type ResourcePreparation,
  type ResourceRequirement,
  type ResourceStore,
} from './ResourceCoordinator.js';
import { SessionQueue, type SessionQueueMetrics } from './SessionQueue.js';

export type HostOperation =
  | 'create'
  | 'activate'
  | 'status'
  | 'command'
  | 'system'
  | 'query'
  | 'view'
  | 'events'
  | 'summary'
  | 'control'
  | 'retire-history'
  | 'automation-diagnostics'
  | 'trace-evidence';
export type Authorize = (
  context: AccessContext,
  operation: HostOperation,
  route: SessionRoute,
  action?: ControlAction,
) => Promise<void>;

export type ResolveSystemAccess = (
  route: SessionRoute,
) => Promise<AccessContext>;

export interface SystemTickResult {
  readonly sessionId: string;
  readonly deadlineId: string;
  /** Present once the persisted deadline was classified by the Host. */
  readonly kind?: 'system' | 'automation';
  readonly status: 'accepted' | 'rejected' | 'duplicate' | 'stale' | 'skipped';
  readonly receipt?: SafeCommandReceipt;
}

export interface SystemTickOptions {
  /** Limit recovery to one scheduler partition. */
  readonly kind?: 'system' | 'automation';
}

type HostSystemSchedule = {
  readonly deadlineId: string;
  readonly dueAt: number;
  readonly command: JsonValue;
};

type HostAutomationSchedule = {
  readonly kind: 'automation';
  readonly deadlineId: string;
  readonly dueAt: number;
  readonly decisionId: string;
  readonly commandId: string;
  readonly seatId: string;
  readonly turnId: string;
  readonly turn: TurnState;
  readonly participant: Participant;
  readonly policy: AutomationPolicy;
  readonly options: JsonValue;
};

type HostSchedule =
  | (HostSystemSchedule & { readonly kind: 'system' })
  | HostAutomationSchedule;

type AutomationExecutionOptions = {
  readonly kind: 'automation';
  readonly decision: AutomationDecision;
  readonly turn: TurnState;
  readonly actor: Actor;
};

type CommandExecutionOptions =
  | { readonly kind: 'player' }
  | { readonly kind: 'system' }
  | AutomationExecutionOptions;

export interface GameHostOptions {
  readonly registry: GameRegistry;
  readonly storage: StorageDriver;
  readonly backendBindingId: string;
  readonly storageBindingId: string;
  /** The game runtime declares that retained sessions have game-owned replay data. */
  readonly replayReference?: {
    readonly platformId: string;
    readonly formatVersion: number;
  };
  /** Must recheck current identity/grants. Claimed scopes alone are not authentication. */
  readonly authorize: Authorize;
  readonly now?: () => number;
  readonly maxQueuedPerSession?: number;
  readonly maxQueuedSessions?: number;
  /** Optional durable ledger for one command consumable requirements. */
  readonly entitlementStore?: ResourceStore;
  readonly resourceGraceMs?: number;
  /** Release-scoped AI/automa policies installed by the trusted server. */
  readonly automationPolicies?: readonly AutomationPolicy[];
}

/** Operator-only read of private automation evidence. */
export interface AutomationTraceReadRequest {
  readonly route: SessionRoute;
  readonly accessContext: AccessContext;
  readonly limit?: number;
  readonly afterCreatedAt?: number;
  readonly kind?: PrivateCommandTraceKind;
}

export interface AutomationReplayRequest {
  readonly route: SessionRoute;
  readonly accessContext: AccessContext;
  readonly traceId: string;
}

export interface AutomationTraceSnapshotRequest {
  readonly route: SessionRoute;
  readonly accessContext: AccessContext;
  readonly traceId: string;
}

/** Server-created replay of a report's persisted private evidence. */
export interface AutomationTraceEvidenceReplayRequest {
  readonly route: SessionRoute;
  readonly accessContext: AccessContext;
  readonly trace: AutomationTrace;
}

/** Dry-run result; no command is submitted to the authoritative Host. */
export interface AutomationReplayResult {
  readonly traceKind: PrivateCommandTraceKind;
  readonly traceId: string;
  readonly decisionId: string;
  readonly policyId: string;
  readonly policyVersion?: string;
  readonly command?: JsonValue;
  readonly diagnostics?: JsonValue;
  readonly durationMs: number;
  readonly inputDigest: string;
  readonly legal: boolean;
  readonly error?: {
    readonly code: string;
    readonly messageKey: string;
  };
}

export interface GameHostMetrics extends SessionQueueMetrics {
  readonly ready: boolean;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

function commandTraceId(commandId: string): string {
  return `command:${commandId}`;
}

class AutomationPolicyFailure extends PlatformError {
  constructor(error: unknown) {
    const envelope = toErrorEnvelope(error);
    super(envelope);
    this.name = 'AutomationPolicyFailure';
  }
}
function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw contractError('INVALID_REQUEST', 'host.identifier.invalid');
  }
}

function systemParticipants(
  current: readonly Participant[],
  proposed: readonly Participant[] | undefined,
): readonly Participant[] {
  if (proposed === undefined) return current;
  if (!Array.isArray(proposed) || proposed.length !== current.length)
    throw contractError('INVALID_REQUEST', 'host.system.participants_invalid');
  const next = proposed.map((participant, index) => {
    assertParticipant(participant);
    const previous = current[index];
    if (
      participant.principalId !== previous?.principalId ||
      participant.seatId !== previous?.seatId ||
      participant.teamId !== previous?.teamId ||
      (participant.controller ?? 'human') !==
        (previous?.controller ?? 'human') ||
      participant.controlledBy !== previous?.controlledBy ||
      participant.controllerId !== previous?.controllerId ||
      canonicalStableStringify(participant.controllerOptions ?? null) !==
        canonicalStableStringify(previous?.controllerOptions ?? null)
    )
      throw contractError(
        'INVALID_REQUEST',
        'host.system.participant_identity_changed',
      );
    return copy(participant);
  });
  return next;
}

/** The sole command owner: candidate execution and all durable effects share one commit. */
export class GameHost implements BackendPort {
  private readonly queue: SessionQueue;
  private readonly now: () => number;
  private readonly resources?: ResourceCoordinator;
  private readonly automationPolicies: ReadonlyMap<string, AutomationPolicy>;
  private readyState = true;

  constructor(private readonly options: GameHostOptions) {
    if (
      options.replayReference &&
      (!options.replayReference.platformId ||
        options.replayReference.platformId.length > 256 ||
        !Number.isSafeInteger(options.replayReference.formatVersion) ||
        options.replayReference.formatVersion < 1)
    )
      throw contractError('INVALID_REQUEST', 'host.replay.reference_invalid');
    this.queue = new SessionQueue(
      options.maxQueuedPerSession,
      options.maxQueuedSessions,
    );
    this.now = options.now ?? Date.now;
    const policies = new Map<string, AutomationPolicy>();
    for (const policy of options.automationPolicies ?? []) {
      if (policies.has(policy.id))
        throw contractError('CONFLICT', 'host.automation.policy_duplicate');
      policies.set(policy.id, policy);
    }
    this.automationPolicies = policies;
    this.resources = options.entitlementStore
      ? new ResourceCoordinator({
          store: options.entitlementStore,
          storage: options.storage,
          graceMs: options.resourceGraceMs,
          now: this.now,
          backendBindingId: options.backendBindingId,
          storageBindingId: options.storageBindingId,
        })
      : undefined;
  }

  async describe(request: DescribeRequest): Promise<BackendDescription> {
    assertProtocolRequest(request);
    const modules = this.options.registry.installed();
    return copy({
      protocolMajor: 1,
      protocolMinor: 0,
      features: [
        'session-lifecycle-v1',
        'scoped-auth-v1',
        'command-receipts-v1',
        'snapshot-resume-v1',
      ],
      gameIds: [...new Set(modules.map((module) => module.gameId))],
      releaseIds: modules.map((module) => module.releaseId),
      modes: modules.flatMap((module) => module.modes),
      storageBindingIds: [this.options.storageBindingId],
    });
  }

  async ready(request: ReadyRequest): Promise<ReadyResponse> {
    assertProtocolRequest(request);
    return {
      ready: this.readyState,
      description: await this.describe(request),
      ...(!this.readyState ? { reason: 'draining' } : {}),
    };
  }

  async drain(): Promise<void> {
    this.readyState = false;
    await this.queue.drain();
  }

  /** Bounded operator metrics; no game state or command payload is returned. */
  metrics(): GameHostMetrics {
    return { ready: this.readyState, ...this.queue.metrics() };
  }

  /** Bounded recovery hook for pending consumable reservations. */
  async reconcileResources(limit = 100) {
    return this.resources?.reconcilePending(limit) ?? [];
  }

  /**
   * Processes a bounded set of persisted deadlines. The scanner is intentionally
   * read-only; the command and its receipt are committed through submitSystemCommand.
   */
  async tickSystemCommands(
    resolveAccess: ResolveSystemAccess,
    limit = 100,
    options: SystemTickOptions = {},
  ): Promise<readonly SystemTickResult[]> {
    if (typeof resolveAccess !== 'function')
      throw contractError(
        'INVALID_REQUEST',
        'host.system.accessResolver.invalid',
      );
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw contractError('INVALID_REQUEST', 'host.system.limit.invalid');
    const due = await this.storageCall(() =>
      this.options.storage.readDueSessions({
        limit,
        now: this.now(),
        backendBindingId: this.options.backendBindingId,
        storageBindingId: this.options.storageBindingId,
        ...(options.kind ? { deadlineKind: options.kind } : {}),
      }),
    );
    const results: SystemTickResult[] = [];
    for (const candidate of due) {
      const base = {
        sessionId: candidate.sessionId,
        deadlineId: candidate.deadline.deadlineId,
      };
      // readDueSessions is filtered by this Host's bindings, but retain the
      // explicit check because a custom driver is still an untrusted boundary.
      if (
        candidate.route.backendBindingId !== this.options.backendBindingId ||
        candidate.route.storageBindingId !== this.options.storageBindingId
      ) {
        results.push({ ...base, status: 'skipped' });
        continue;
      }
      try {
        const head = await this.storageCall(() =>
          this.options.storage.getHead(candidate.sessionId),
        );
        if (!head) {
          results.push({ ...base, status: 'stale' });
          continue;
        }
        if (
          canonicalStableStringify(head.route) !==
            canonicalStableStringify(candidate.route) ||
          head.status !== 'active' ||
          head.revision !== candidate.revision ||
          head.deadline?.deadlineId !== candidate.deadline.deadlineId ||
          head.deadline?.dueAt !== candidate.deadline.dueAt
        ) {
          results.push({ ...base, status: 'stale' });
          continue;
        }
        const module = this.options.registry.resolve(head.route);
        const state = module.rules.decode(
          copy(head.encodedState),
          head.schemaVersion,
        );
        const schedule = this.schedule(
          module,
          state,
          head.participants,
          head.route.sessionId,
          head.logicalTime,
          { revision: head.revision, deadline: candidate.deadline },
        );
        if (
          !schedule ||
          schedule.deadlineId !== candidate.deadline.deadlineId ||
          schedule.dueAt !== candidate.deadline.dueAt
        ) {
          results.push({ ...base, status: 'stale' });
          continue;
        }
        const accessContext = copy(await resolveAccess(copy(head.route)));
        let response: SubmitSystemCommandResponse;
        if (schedule.kind === 'automation') {
          await this.authorize(
            { accessContext, route: copy(head.route) },
            'system',
            'session:system',
          );
          try {
            response = await this.runAutomation(
              head,
              module,
              schedule,
              accessContext,
            );
          } catch (error) {
            if (!(error instanceof AutomationPolicyFailure)) throw error;
            response = await this.recordAutomationFailure(
              head,
              module,
              schedule,
              error,
            );
          }
        } else {
          response = await this.submitSystemCommand({
            protocolVersion: 1,
            accessContext,
            route: copy(head.route),
            commandId: `system:${head.route.sessionId}:deadline:${schedule.deadlineId}`,
            expectedRevision: head.revision,
            command: copy(schedule.command),
            deadlineId: schedule.deadlineId,
          });
        }
        const status = response.receipt.status;
        results.push({
          ...base,
          kind: schedule.kind,
          status:
            status === 'accepted' ||
            status === 'rejected' ||
            status === 'duplicate'
              ? status
              : 'skipped',
          receipt: response.receipt,
        });
      } catch (error) {
        // A changed owner/revision or an unavailable module must not make a
        // bounded scan fail the other sessions in the batch.
        const code =
          error && typeof error === 'object' && 'envelope' in error
            ? (error as { envelope?: { code?: string } }).envelope?.code
            : undefined;
        results.push({
          ...base,
          status:
            code === 'STALE_REVISION' || code === 'OWNERSHIP_LOST'
              ? 'stale'
              : 'skipped',
        });
      }
    }
    return results;
  }

  private async runAutomation(
    head: SessionHead,
    module: RuntimeModule,
    schedule: HostAutomationSchedule,
    accessContext: AccessContext,
  ): Promise<SubmitSystemCommandResponse> {
    const previous = await this.storageCall(() =>
      this.options.storage.getReceipt(head.route.sessionId, schedule.commandId),
    );
    if (previous) {
      // A rejected automation receipt is terminal for this deadline.  Clear
      // the due marker on recovery so an old receipt cannot make every scan
      // repeat the same failed decision forever.
      if (previous.status === 'rejected')
        await this.disableAutomationDeadline(
          head,
          module,
          schedule,
          previous.error?.messageKey ?? 'host.automation.rejected',
        );
      return { receipt: this.safeReceipt(previous, true) };
    }
    let decision = await this.readAutomationDecision(
      head.route,
      schedule.decisionId,
    );
    if (!decision) {
      let command: JsonValue;
      let diagnostics: JsonValue | undefined;
      let automationInput: AutomationDecisionInput | undefined;
      const startedAt = this.now();
      try {
        const state = module.rules.decode(
          copy(head.encodedState),
          head.schemaVersion,
        );
        const viewer: Viewer = {
          principalId: schedule.participant.principalId,
          seatId: schedule.participant.seatId,
          audience: `player:${schedule.participant.seatId}`,
          epoch: head.route.ownershipEpoch,
          scopes: [],
        };
        const actor = this.actorForParticipant(schedule.participant);
        const view = this.projectAutomationView(module, state, viewer);
        automationInput = {
          view,
          actor,
          turn: this.automationTurn(schedule.turn),
          seed: digest({
            sessionId: head.route.sessionId,
            startDigest: head.startDigest,
            turnId: schedule.turnId,
            seatId: schedule.seatId,
          }),
          options: schedule.options,
        };
        const result = await this.decideAutomation(
          schedule.policy,
          automationInput,
        );
        command = result.command;
        diagnostics = result.diagnostics;
        assertMatchesSchema(command, module.schemas.command);
      } catch (error) {
        if (automationInput) {
          try {
            await this.persistAutomationTrace(head.route, {
              kind: 'automation',
              sessionId: head.route.sessionId,
              traceId: schedule.decisionId,
              decisionId: schedule.decisionId,
              commandId: schedule.commandId,
              deadlineId: schedule.deadlineId,
              releaseId: head.route.releaseId,
              policyId: schedule.policy.id,
              ...(schedule.policy.version
                ? { policyVersion: schedule.policy.version }
                : {}),
              expectedRevision: head.revision,
              seatId: schedule.seatId,
              turnId: schedule.turnId,
              state: copy(head.encodedState),
              input: automationInput as unknown as JsonValue,
              schemaVersion: head.schemaVersion,
              options: schedule.options,
              outcome: this.automationTraceOutcome(error),
              startedAt,
              finishedAt: this.now(),
              createdAt: startedAt,
            });
          } catch {
            // A trace must never mask the authoritative automation failure.
          }
        }
        throw new AutomationPolicyFailure(error);
      }
      const trace: AutomationTrace = {
        kind: 'automation',
        sessionId: head.route.sessionId,
        traceId: schedule.decisionId,
        decisionId: schedule.decisionId,
        commandId: schedule.commandId,
        deadlineId: schedule.deadlineId,
        releaseId: head.route.releaseId,
        policyId: schedule.policy.id,
        ...(schedule.policy.version
          ? { policyVersion: schedule.policy.version }
          : {}),
        expectedRevision: head.revision,
        seatId: schedule.seatId,
        turnId: schedule.turnId,
        state: copy(head.encodedState),
        input: automationInput as unknown as JsonValue,
        schemaVersion: head.schemaVersion,
        options: schedule.options,
        command,
        ...(diagnostics === undefined ? {} : { diagnostics }),
        outcome: 'decided',
        startedAt,
        finishedAt: this.now(),
        createdAt: startedAt,
      };
      decision = await this.persistAutomationDecision(
        head.route,
        {
          sessionId: head.route.sessionId,
          decisionId: schedule.decisionId,
          commandId: schedule.commandId,
          deadlineId: schedule.deadlineId,
          expectedRevision: head.revision,
          seatId: schedule.seatId,
          turnId: schedule.turnId,
          command,
          createdAt: this.now(),
        },
        trace,
      );
    }
    if (
      decision.sessionId !== head.route.sessionId ||
      decision.decisionId !== schedule.decisionId ||
      decision.commandId !== schedule.commandId ||
      decision.deadlineId !== schedule.deadlineId ||
      decision.expectedRevision !== head.revision ||
      decision.seatId !== schedule.seatId ||
      decision.turnId !== schedule.turnId
    ) {
      await this.storageCall(() =>
        this.options.storage.transaction(
          head.route.sessionId,
          { ownershipEpoch: head.route.ownershipEpoch },
          (tx) => tx.deleteAutomationDecision(schedule.decisionId),
        ),
      );
      throw contractError('STALE_REVISION', 'host.automation.stale');
    }
    const request: SubmitSystemCommandRequest = {
      protocolVersion: 1,
      accessContext: copy(accessContext),
      route: copy(head.route),
      commandId: decision.commandId,
      expectedRevision: decision.expectedRevision,
      command: copy(decision.command),
      deadlineId: decision.deadlineId,
    };
    try {
      const response = await this.executeCommand(request, {
        kind: 'automation',
        decision,
        turn: schedule.turn,
        actor: this.actorForParticipant(schedule.participant),
      });
      await this.finishAutomationTrace(
        head.route,
        schedule.decisionId,
        response.receipt.status === 'accepted' ? 'executed' : 'rejected',
      );
      return response as SubmitSystemCommandResponse;
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      if (
        envelope.retryable ||
        envelope.code === 'STALE_REVISION' ||
        envelope.code === 'OWNERSHIP_LOST' ||
        envelope.messageKey.startsWith('host.storage.')
      )
        throw error;
      throw new AutomationPolicyFailure(error);
    }
  }

  /**
   * A policy failure is terminal for this deadline.  There is no durable
   * retry-attempt field in SessionDeadline, so leaving it due would make every
   * recovery scan rerun the same policy forever.
   */
  private async recordAutomationFailure(
    head: SessionHead,
    module: RuntimeModule,
    schedule: HostAutomationSchedule,
    error: unknown,
  ): Promise<SubmitSystemCommandResponse> {
    const failure: AutomationFailure = {
      seatId: schedule.seatId,
      messageKey: this.automationFailureMessage(error),
    };
    const inputHash = digest({
      kind: 'automation-failure',
      route: head.route,
      deadlineId: schedule.deadlineId,
      decisionId: schedule.decisionId,
      commandId: schedule.commandId,
      seatId: schedule.seatId,
      turnId: schedule.turnId,
      messageKey: failure.messageKey,
    });
    const response = await this.storageCall(() =>
      this.options.storage.transaction(
        head.route.sessionId,
        { ownershipEpoch: head.route.ownershipEpoch },
        async (tx) => {
          const current = await tx.getHead();
          if (
            current.status !== 'active' ||
            current.revision !== head.revision ||
            current.deadline?.deadlineId !== schedule.deadlineId
          )
            throw contractError('STALE_REVISION', 'host.automation.stale');
          const previous = await tx.getReceipt(schedule.commandId);
          if (previous) {
            if (previous.status === 'rejected') {
              await tx.deleteAutomationDecision(schedule.decisionId);
              const next = this.automationFailureHead(
                current,
                module,
                module.rules.decode(
                  copy(current.encodedState),
                  current.schemaVersion,
                ),
                failure,
              );
              await tx.setHead(next);
              await tx.appendOutbox(
                this.outbox(
                  next,
                  'SessionSummaryChanged',
                  { summary: next.summary, status: next.status },
                  0,
                ),
              );
            }
            return { receipt: this.safeReceipt(previous, true) };
          }
          const state = module.rules.decode(
            copy(current.encodedState),
            current.schemaVersion,
          );
          const receipt: CommandReceipt = {
            sessionId: head.route.sessionId,
            commandId: schedule.commandId,
            actorPrincipalId: schedule.participant.principalId,
            inputHash,
            status: 'rejected',
            resultRetention: this.receiptRetention(module, head.route),
            persistedRevision: current.revision,
            persistedAt: this.nextTime(current),
            error: {
              code: toErrorEnvelope(error).code,
              messageKey: failure.messageKey,
              retryable: false,
            },
          };
          const saved = await tx.putReceipt(receipt);
          await tx.deleteAutomationDecision(schedule.decisionId);
          const next = this.automationFailureHead(
            current,
            module,
            state,
            failure,
          );
          await tx.setHead(next);
          await tx.appendOutbox(
            this.outbox(
              next,
              'SessionSummaryChanged',
              { summary: next.summary, status: next.status },
              0,
            ),
          );
          return { receipt: this.safeReceipt(saved) };
        },
      ),
    );
    await this.finishAutomationTrace(
      head.route,
      schedule.decisionId,
      this.automationTraceOutcome(error),
    );
    return response;
  }

  private automationFailureMessage(error: unknown): string {
    return this.safeAutomationMessage(toErrorEnvelope(error).messageKey);
  }

  private safeAutomationMessage(messageKey: string): string {
    return /^[a-z][A-Za-z0-9._:-]{0,255}$/.test(messageKey)
      ? messageKey
      : 'host.automation.failed';
  }

  private eventSource(
    options: CommandExecutionOptions,
    commandId: string,
  ): EventSource {
    if (options.kind === 'automation')
      return {
        kind: options.actor.controller === 'automa' ? 'automa' : 'ai',
        seatId: options.decision.seatId,
        traceId: options.decision.decisionId,
      };
    if (options.kind === 'system') return { kind: 'system' };
    return { kind: 'human', traceId: commandTraceId(commandId) };
  }

  private async readAutomationDecision(
    route: SessionRoute,
    decisionId: string,
  ): Promise<AutomationDecision | null> {
    return this.storageCall(() =>
      this.options.storage.transaction(
        route.sessionId,
        { ownershipEpoch: route.ownershipEpoch },
        (tx) => tx.getAutomationDecision(decisionId),
      ),
    );
  }

  private async persistAutomationDecision(
    route: SessionRoute,
    decision: AutomationDecision,
    trace?: AutomationTrace,
  ): Promise<AutomationDecision> {
    try {
      return await this.options.storage.transaction(
        route.sessionId,
        { ownershipEpoch: route.ownershipEpoch },
        async (tx) => {
          const head = await tx.getHead();
          if (
            head.status !== 'active' ||
            head.revision !== decision.expectedRevision ||
            head.deadline?.deadlineId !== decision.deadlineId
          )
            throw contractError('STALE_REVISION', 'host.automation.stale');
          if (trace) await tx.putAutomationTrace(trace);
          return tx.putAutomationDecision(decision);
        },
      );
    } catch (error) {
      if (isStorageError(error) && error.code === 'IDEMPOTENCY_CONFLICT') {
        const existing = await this.readAutomationDecision(
          route,
          decision.decisionId,
        );
        if (existing) return existing;
      }
      return this.storageCall(async () => {
        throw error;
      });
    }
  }

  private async decideAutomation(
    policy: AutomationPolicy,
    input: Parameters<AutomationPolicy['decide']>[0],
  ): Promise<{
    readonly command: JsonValue;
    readonly diagnostics?: JsonValue;
    readonly durationMs: number;
  }> {
    return runBoundedAutomationDecision(policy, input, { now: this.now });
  }

  private automationTraceOutcome(error: unknown): AutomationTrace['outcome'] {
    const messageKey = toErrorEnvelope(error).messageKey;
    return messageKey.includes('timeout') || messageKey.includes('aborted')
      ? 'timeout'
      : 'failed';
  }

  private async persistAutomationTrace(
    route: SessionRoute,
    trace: AutomationTrace,
  ): Promise<void> {
    await this.storageCall(() =>
      this.options.storage.transaction(
        route.sessionId,
        { ownershipEpoch: route.ownershipEpoch },
        (tx) => tx.putAutomationTrace(trace).then(() => undefined),
      ),
    );
  }

  private commandTrace(
    head: SessionHead,
    request: SubmitCommandRequest,
    actor: Actor,
    details: {
      readonly outcome: AutomationTrace['outcome'];
      readonly startedAt: number;
      readonly finishedAt: number;
      readonly eventSequenceStart?: number;
      readonly eventSequenceCount?: number;
    },
  ): AutomationTrace {
    const traceId = commandTraceId(request.commandId);
    return {
      kind: 'command',
      sessionId: head.route.sessionId,
      traceId,
      decisionId: traceId,
      commandId: request.commandId,
      deadlineId: traceId,
      releaseId: head.route.releaseId,
      policyId: 'player-command',
      expectedRevision: head.revision,
      seatId: actor.seatId ?? 'unassigned',
      turnId: `revision:${head.revision}`,
      state: copy(head.encodedState),
      input: {
        kind: 'command',
        actor: copy(actor) as unknown as JsonValue,
        ...(request.precondition === undefined
          ? {}
          : { precondition: copy(request.precondition) as JsonValue }),
      } as unknown as JsonValue,
      schemaVersion: head.schemaVersion,
      options: null,
      command: copy(request.command),
      outcome: details.outcome,
      startedAt: details.startedAt,
      finishedAt: details.finishedAt,
      createdAt: details.startedAt,
      ...(details.eventSequenceStart === undefined
        ? {}
        : { eventSequenceStart: details.eventSequenceStart }),
      ...(details.eventSequenceCount === undefined
        ? {}
        : { eventSequenceCount: details.eventSequenceCount }),
    };
  }

  private async finishAutomationTrace(
    route: SessionRoute,
    traceId: string,
    outcome: AutomationTrace['outcome'],
  ): Promise<void> {
    try {
      await this.storageCall(() =>
        this.options.storage.transaction(
          route.sessionId,
          { ownershipEpoch: route.ownershipEpoch },
          async (tx) => {
            const trace = await tx.getAutomationTrace(traceId);
            if (!trace) return;
            await tx.putAutomationTrace({
              ...trace,
              outcome,
              finishedAt: this.now(),
            });
          },
        ),
      );
    } catch {
      // The command receipt is authoritative; diagnostics must not cause a
      // completed automation command to be retried.
    }
  }

  async createSession(
    input: CreateSessionRequest,
  ): Promise<CreateSessionResponse> {
    assertCreateSessionRequest(input);
    const request = this.request(input);
    await this.authorize(request, 'create', 'session:create');
    const module = this.options.registry.resolve(request.route);
    const mode = this.mode(module, request.route);
    assertMatchesSchema(request.setup, module.schemas.setup);
    if (
      request.participants.length < mode.minPlayers ||
      request.participants.length > mode.maxPlayers ||
      new Set(request.participants.map((p) => p.seatId)).size !==
        request.participants.length ||
      new Set(request.participants.map((p) => p.principalId)).size !==
        request.participants.length
    ) {
      throw contractError('INVALID_REQUEST', 'host.participants.invalid');
    }
    this.validateAutomationParticipants(request.participants);
    const startDigest = digest({
      principalId: request.accessContext.principalId,
      route: request.route,
      startId: request.startId,
      startGeneration: request.startGeneration,
      setup: request.setup,
      participants: request.participants,
      seed: request.seed,
    });
    return this.queue.run(request.route.sessionId, async () => {
      await this.authorize(request, 'create', 'session:create');
      const existing = await this.storageCall(() =>
        this.options.storage.getHead(request.route.sessionId),
      );
      if (existing) {
        this.assertRoute(existing, request.route);
        if (
          existing.startDigest !== startDigest ||
          existing.startId !== request.startId ||
          (existing.startGeneration ?? 0) !== request.startGeneration
        ) {
          throw contractError('IDEMPOTENCY_CONFLICT', 'host.start.conflict');
        }
        return this.creationResponse(existing);
      }
      const logicalTime = this.now();
      const state = module.rules.create(copy(request.setup), {
        sessionId: request.route.sessionId,
        modeId: request.route.modeId,
        seed: request.seed,
        logicalTime,
        participants: request.participants.map((participant) => ({
          ...participant,
          kind: 'player' as const,
        })),
      });
      const encodedState = this.encode(module, state);
      const summary = this.summary(module, state);
      const initialEvents = this.initialEvents(
        module,
        state,
        request.route,
        request.participants,
        request.accessContext.authEpoch,
        logicalTime,
      );
      const head: SessionHead = {
        route: request.route,
        startId: request.startId,
        startGeneration: request.startGeneration,
        startDigest,
        status: 'suspended',
        revision: 0,
        eventSequence: initialEvents.length,
        encodedState,
        schemaVersion: module.stateSchemaVersion,
        participants: request.participants,
        summary,
        logicalTime,
        deadline: this.persistedSchedule(
          this.schedule(
            module,
            state,
            request.participants,
            request.route.sessionId,
            logicalTime,
            { revision: 0 },
          ),
        ),
      };
      // A start receipt lives in the head; its summary event commits atomically with it.
      const persisted = await this.storageCall(() =>
        this.options.storage.createSession(head, {
          initialOutbox: [
            this.outbox(
              head,
              'SessionCreated',
              {
                summary,
                participants: copy(head.participants) as unknown as JsonValue,
                status: head.status,
              } as unknown as JsonValue,
              0,
            ),
          ],
          ...(initialEvents.length > 0 ? { initialEvents } : {}),
        }),
      );
      return this.creationResponse(persisted);
    });
  }

  async activateSession(
    input: ActivateSessionRequest,
  ): Promise<ActivateSessionResponse> {
    const request = this.request(input);
    requireId(request.startId);
    await this.authorize(request, 'activate', 'session:create');
    return this.queue.run(request.route.sessionId, () =>
      this.transaction(request, async (tx, head) => {
        await this.authorize(request, 'activate', 'session:create');
        this.options.registry.resolve(head.route);
        if (head.startId !== request.startId)
          throw contractError('IDEMPOTENCY_CONFLICT', 'host.start.conflict');
        if (head.activatedAt !== undefined && head.status === 'active')
          return {
            sessionId: head.route.sessionId,
            startId: head.startId,
            status: 'active',
            activatedAt: head.activatedAt,
          };
        if (head.status !== 'suspended')
          throw contractError('SESSION_CLOSED', 'host.session.closed');
        const logicalTime = this.nextTime(head);
        const module = this.options.registry.resolve(head.route);
        const preparedState = module.rules.decode(
          copy(head.encodedState),
          head.schemaVersion,
        );
        const initialize =
          head.activatedAt === undefined ? module.rules.activate : undefined;
        const state = initialize
          ? initialize(preparedState, { logicalTime })
          : preparedState;
        const next: SessionHead = {
          ...head,
          status: 'active',
          revision: head.revision + 1,
          activatedAt: logicalTime,
          logicalTime,
          ...(initialize
            ? {
                encodedState: this.encode(module, state),
                summary: this.summary(module, state),
              }
            : {}),
          deadline: this.persistedSchedule(
            this.schedule(
              module,
              state,
              head.participants,
              head.route.sessionId,
              logicalTime,
              { revision: head.revision + 1 },
            ),
          ),
        };
        await tx.setHead(next);
        await tx.appendOutbox(
          this.outbox(
            next,
            'SessionActivated',
            { summary: next.summary, status: next.status },
            0,
          ),
        );
        return {
          sessionId: head.route.sessionId,
          startId: head.startId,
          status: 'active',
          activatedAt: logicalTime,
        };
      }),
    );
  }

  async submitCommand(
    input: SubmitCommandRequest,
  ): Promise<SubmitCommandResponse> {
    assertSubmitCommandRequest(input);
    const request = this.request(input);
    await this.authorize(request, 'command', 'session:command');
    return this.executeCommand(request, { kind: 'player' });
  }

  async submitSystemCommand(
    input: SubmitSystemCommandRequest,
  ): Promise<SubmitSystemCommandResponse> {
    assertSubmitSystemCommandRequest(input);
    const request = this.request(input);
    await this.authorize(request, 'system', 'session:system');
    return this.executeCommand(request, { kind: 'system' });
  }

  private async executeCommand(
    request: SubmitCommandRequest | SubmitSystemCommandRequest,
    options: CommandExecutionOptions,
  ): Promise<SubmitCommandResponse | SubmitSystemCommandResponse> {
    const traceStartedAt = this.now();
    const inputHash =
      options.kind === 'automation'
        ? digest({
            kind: 'automation',
            route: request.route,
            decisionId: options.decision.decisionId,
            commandId: request.commandId,
            expectedRevision: options.decision.expectedRevision,
            deadlineId: options.decision.deadlineId,
            seatId: options.decision.seatId,
            turnId: options.decision.turnId,
            command: options.decision.command,
          })
        : digest(
            options.kind === 'system'
              ? {
                  kind: 'system',
                  principalId: request.accessContext.principalId,
                  route: request.route,
                  commandId: request.commandId,
                  expectedRevision: (request as SubmitSystemCommandRequest)
                    .expectedRevision,
                  deadlineId: (request as SubmitSystemCommandRequest)
                    .deadlineId,
                  command: request.command,
                }
              : {
                  kind: 'player',
                  principalId: request.accessContext.principalId,
                  ...(request.accessContext.seatId === undefined
                    ? {}
                    : { seatId: request.accessContext.seatId }),
                  route: request.route,
                  commandId: request.commandId,
                  precondition: (request as SubmitCommandRequest).precondition,
                  command: request.command,
                },
          );
    return this.queue.run(request.route.sessionId, async () => {
      let preparation: ResourcePreparation | null = null;
      if (options.kind === 'player') {
        try {
          preparation = await this.prepareResources(
            request as SubmitCommandRequest,
            inputHash,
          );
        } catch (error) {
          if (error instanceof ResourceCoordinatorError && error.definitive)
            return this.rejectResource(
              request as SubmitCommandRequest,
              inputHash,
            );
          throw this.mapResourceError(error);
        }
      }
      try {
        const execution = await this.transaction(request, async (tx, head) => {
          const operation = options.kind === 'player' ? 'command' : 'system';
          const scope =
            options.kind === 'player' ? 'session:command' : 'session:system';
          await this.authorize(request, operation, scope);
          const actor =
            options.kind === 'automation'
              ? options.actor
              : options.kind === 'system'
                ? this.systemActor(request.accessContext)
                : this.actor(head, request.accessContext);
          const previous = await tx.getReceipt(request.commandId);
          if (previous) {
            this.assertReceipt(previous, inputHash, actor.principalId);
            if (options.kind === 'automation')
              await tx.deleteAutomationDecision(options.decision.decisionId);
            return {
              response: { receipt: this.safeReceipt(previous, true) },
              resourceOutcome: this.resourceOutcome(previous),
            };
          }
          this.assertActive(head);
          const module = this.options.registry.resolve(head.route);
          const state = module.rules.decode(
            copy(head.encodedState),
            head.schemaVersion,
          );
          let systemSchedule: HostSystemSchedule | undefined;
          if (options.kind === 'system') {
            const systemRequest = request as SubmitSystemCommandRequest;
            if (!module.executeSystem || !module.schemas.systemCommand)
              throw contractError('NOT_READY', 'host.system.unsupported');
            if (systemRequest.expectedRevision !== head.revision)
              throw contractError('STALE_REVISION', 'host.revision.stale');
            assertMatchesSchema(
              systemRequest.command,
              module.schemas.systemCommand,
            );
            systemSchedule = this.systemScheduleValue(
              module,
              state,
              head.logicalTime,
            );
            if (systemRequest.deadlineId !== undefined)
              this.assertSystemDeadline(head, systemSchedule, systemRequest);
          } else if (options.kind === 'automation') {
            const automationRequest = request as SubmitSystemCommandRequest;
            if (
              automationRequest.expectedRevision !== head.revision ||
              head.deadline?.deadlineId !== options.decision.deadlineId
            ) {
              await tx.deleteAutomationDecision(options.decision.decisionId);
              throw contractError('STALE_REVISION', 'host.automation.stale');
            }
            assertMatchesSchema(
              automationRequest.command,
              module.schemas.command,
            );
            try {
              this.assertAutomationTurn(
                module,
                state,
                head,
                options.actor,
                options.turn,
              );
            } catch (error) {
              await tx.deleteAutomationDecision(options.decision.decisionId);
              throw error;
            }
          } else {
            const playerRequest = request as SubmitCommandRequest;
            assertMatchesSchema(playerRequest.command, module.schemas.command);
            this.assertPrecondition(module, state, head, actor, playerRequest);
          }
          const requirement =
            options.kind === 'player' || options.kind === 'automation'
              ? this.resourceRequirement(
                  module,
                  state,
                  request as SubmitCommandRequest,
                  actor,
                )
              : undefined;
          if (options.kind === 'automation' && requirement) {
            const receipt = this.resourceRejectedReceipt(
              head,
              request.commandId,
              actor.principalId,
              inputHash,
              'host.resource.automation_unsupported',
              this.receiptRetention(module, head.route),
            );
            await tx.putReceipt(receipt);
            await tx.deleteAutomationDecision(options.decision.decisionId);
            const next = this.automationFailureHead(head, module, state, {
              seatId: options.decision.seatId,
              messageKey: 'host.resource.automation_unsupported',
            });
            await tx.setHead(next);
            await tx.appendOutbox(
              this.outbox(
                next,
                'SessionSummaryChanged',
                { summary: next.summary, status: next.status },
                0,
              ),
            );
            return {
              response: { receipt: this.safeReceipt(receipt) },
              resourceOutcome: 'rejected' as const,
            };
          }
          if (options.kind === 'player' && this.resources && preparation) {
            try {
              this.resources.assertCurrent(preparation, {
                route: head.route,
                commandId: request.commandId,
                principalId: actor.principalId,
                commandDigest: inputHash,
                requirement: requirement ?? undefined,
              });
            } catch {
              const receipt = this.resourceRejectedReceipt(
                head,
                request.commandId,
                actor.principalId,
                inputHash,
                'host.resource.stale',
              );
              await tx.putReceipt(receipt);
              await tx.putAutomationTrace(
                this.commandTrace(
                  head,
                  request as SubmitCommandRequest,
                  actor,
                  {
                    outcome: 'rejected',
                    startedAt: traceStartedAt,
                    finishedAt: this.now(),
                  },
                ),
              );
              return {
                response: { receipt: this.safeReceipt(receipt) },
                resourceOutcome: 'rejected' as const,
              };
            }
          } else if (options.kind === 'player' && requirement) {
            if (!this.resources)
              throw contractError('NOT_READY', 'host.resource.unconfigured');
            const receipt = this.resourceRejectedReceipt(
              head,
              request.commandId,
              actor.principalId,
              inputHash,
              'host.resource.missing',
            );
            await tx.putReceipt(receipt);
            await tx.putAutomationTrace(
              this.commandTrace(head, request as SubmitCommandRequest, actor, {
                outcome: 'rejected',
                startedAt: traceStartedAt,
                finishedAt: this.now(),
              }),
            );
            return {
              response: { receipt: this.safeReceipt(receipt) },
              resourceOutcome: 'rejected' as const,
            };
          }
          const before = module.rules.decode(
            copy(head.encodedState),
            head.schemaVersion,
          );
          const logicalTime = this.nextTime(head);
          let transition: ReturnType<RuntimeModule['rules']['execute']>;
          if (options.kind === 'system') {
            if (!module.executeSystem)
              throw contractError('NOT_READY', 'host.system.unsupported');
            const systemRequest = request as SubmitSystemCommandRequest;
            transition = module.executeSystem(
              state,
              copy(systemRequest.command),
              {
                actor,
                logicalTime,
                participants: head.participants,
                ...(systemRequest.deadlineId
                  ? { deadlineId: systemRequest.deadlineId }
                  : {}),
              },
            );
          } else if (options.kind === 'automation') {
            const automationRequest = request as SubmitSystemCommandRequest;
            transition = module.rules.execute(
              state,
              copy(automationRequest.command),
              { actor, logicalTime },
            );
          } else {
            const playerRequest = request as SubmitCommandRequest;
            transition = module.rules.execute(
              state,
              copy(playerRequest.command),
              { actor, logicalTime },
            );
          }
          const retention =
            this.mode(module, head.route).history === 'summary-and-replay'
              ? 'replayable'
              : 'ephemeral-result';
          if (!transition.ok) {
            const messageKey =
              options.kind === 'automation'
                ? this.safeAutomationMessage(transition.error.messageKey)
                : transition.error.messageKey;
            const receipt: CommandReceipt = {
              sessionId: head.route.sessionId,
              commandId: request.commandId,
              actorPrincipalId: actor.principalId,
              inputHash,
              status: 'rejected',
              resultRetention: retention,
              persistedRevision: head.revision,
              persistedAt: logicalTime,
              error: {
                code: 'INVALID_REQUEST',
                messageKey,
                retryable: false,
              },
            };
            await tx.putReceipt(receipt);
            if (options.kind === 'player')
              await tx.putAutomationTrace(
                this.commandTrace(
                  head,
                  request as SubmitCommandRequest,
                  actor,
                  {
                    outcome: 'rejected',
                    startedAt: traceStartedAt,
                    finishedAt: this.now(),
                  },
                ),
              );
            if (options.kind === 'automation')
              await tx.deleteAutomationDecision(options.decision.decisionId);
            if (options.kind === 'automation') {
              const next = this.automationFailureHead(head, module, state, {
                seatId: options.decision.seatId,
                messageKey,
              });
              await tx.setHead(next);
              await tx.appendOutbox(
                this.outbox(
                  next,
                  'SessionSummaryChanged',
                  { summary: next.summary, status: next.status },
                  0,
                ),
              );
            }
            return {
              response: { receipt: this.safeReceipt(receipt) },
              resourceOutcome: 'rejected' as const,
            };
          }
          if (
            options.kind !== 'system' &&
            transition.publicParticipants !== undefined
          )
            throw contractError(
              'INVALID_REQUEST',
              'host.player.public_participants_forbidden',
            );
          const participants =
            options.kind === 'system'
              ? systemParticipants(
                  head.participants,
                  transition.publicParticipants,
                )
              : head.participants;
          const encodedState = this.encode(module, transition.state);
          const candidate = () =>
            module.rules.decode(copy(encodedState), module.stateSchemaVersion);
          const complete = module.completion(candidate());
          if (complete.finished && complete.cancelled)
            throw contractError('INVALID_REQUEST', 'host.completion.invalid');
          const terminal = complete.finished || complete.cancelled === true;
          const result = complete.finished
            ? module.result?.(candidate())
            : undefined;
          if (result !== undefined) assertGameResult(result, head.participants);
          if (
            complete.finished &&
            this.mode(module, head.route).platformRating &&
            result?.kind !== 'competitive'
          )
            throw contractError(
              'INVALID_REQUEST',
              'host.result.competitive_required',
            );
          const summary = this.summary(module, candidate());
          assertJsonPayloadSize(
            transition.events,
            DEFAULT_JSON_LIMITS.viewBytes,
          );
          const events = copy(transition.events);
          const facts = module.collectFacts(before, {
            ok: true,
            state: candidate(),
            events: copy(events),
          });
          assertJsonPayloadSize(facts, DEFAULT_JSON_LIMITS.viewBytes);
          if (complete.progress !== undefined)
            assertJsonPayloadSize(
              complete.progress,
              DEFAULT_JSON_LIMITS.viewBytes,
            );
          const scheduled = terminal
            ? undefined
            : this.schedule(
                module,
                candidate(),
                participants,
                head.route.sessionId,
                logicalTime,
                { revision: head.revision + 1 },
              );
          const next: SessionHead = {
            ...head,
            participants,
            encodedState,
            status: complete.cancelled
              ? 'cancelled'
              : complete.finished
                ? 'completed'
                : 'active',
            revision: head.revision + 1,
            eventSequence: head.eventSequence + events.length,
            summary,
            logicalTime,
            deadline: this.persistedSchedule(scheduled),
            automationFailure: undefined,
          };
          const view =
            options.kind === 'player'
              ? this.project(module, candidate(), next, request.accessContext)
              : undefined;
          for (const participant of head.participants) {
            const viewer: Viewer = {
              principalId: participant.principalId,
              seatId: participant.seatId,
              audience: `player:${participant.seatId}`,
              epoch: request.accessContext.authEpoch,
              scopes: [...request.accessContext.scopes],
            };
            for (const event of events)
              assertJsonPayloadSize(
                module.rules.projectEvent(copy(event), viewer),
                DEFAULT_JSON_LIMITS.viewBytes,
              );
          }
          const clearPrivate = terminal && retention === 'ephemeral-result';
          await tx.setHead(
            clearPrivate ? { ...next, encodedState: null } : next,
          );
          if (clearPrivate) await tx.clearPrivateState();
          else if (events.length > 0)
            await tx.appendEvents(
              events.map((event, index) => ({
                eventId: `${head.route.sessionId}:event:${head.eventSequence + index + 1}`,
                sessionId: head.route.sessionId,
                producerId: this.producer(head),
                aggregateSequence: head.eventSequence + index + 1,
                schemaVersion: 1,
                sourceRelease: head.route.releaseId,
                payload: event as JsonValue,
                source: this.eventSource(options, request.commandId),
                logicalTime,
              })),
            );
          await tx.appendOutboxMany([
            this.outbox(
              next,
              complete.cancelled
                ? 'SessionControlled'
                : complete.finished
                  ? 'SessionCompleted'
                  : 'SessionSummaryChanged',
              {
                summary,
                ...(transition.publicParticipants !== undefined
                  ? {
                      participants: copy(participants) as unknown as JsonValue,
                    }
                  : {}),
                ...(complete.cancelled
                  ? {
                      action: 'cancel',
                      status: 'cancelled',
                      principalId: actor.principalId,
                    }
                  : {}),
                ...(result !== undefined
                  ? { result, resultRevision: 1, endedAt: logicalTime }
                  : {}),
                ...(complete.finished &&
                !complete.cancelled &&
                retention === 'replayable' &&
                this.options.replayReference
                  ? {
                      replayRef: {
                        platformId: this.options.replayReference.platformId,
                        gameId: next.route.gameId,
                        sessionId: next.route.sessionId,
                        replayId: next.route.sessionId,
                        releaseId: next.route.releaseId,
                        storageBindingId: next.route.storageBindingId,
                        formatVersion:
                          this.options.replayReference.formatVersion,
                      },
                    }
                  : {}),
                ...(complete.progress !== undefined
                  ? { progress: complete.progress }
                  : {}),
              },
              0,
            ),
            ...facts.map((fact, index) =>
              this.outbox(next, 'GameFact', fact, index + 1),
            ),
          ]);
          if (options.kind === 'player')
            await tx.putAutomationTrace(
              this.commandTrace(head, request as SubmitCommandRequest, actor, {
                outcome: 'executed',
                startedAt: traceStartedAt,
                finishedAt: this.now(),
                ...(clearPrivate || events.length === 0
                  ? { eventSequenceCount: 0 }
                  : {
                      eventSequenceStart: head.eventSequence + 1,
                      eventSequenceCount: events.length,
                    }),
              }),
            );
          const receipt: CommandReceipt = {
            sessionId: head.route.sessionId,
            commandId: request.commandId,
            actorPrincipalId: actor.principalId,
            inputHash,
            status: 'accepted',
            resultRetention: retention,
            persistedRevision: next.revision,
            persistedAt: logicalTime,
          };
          await tx.putReceipt(receipt);
          await tx.clearAutomationDecisions();
          return {
            response: {
              receipt: this.safeReceipt(receipt),
              ...(view ? { view } : {}),
            },
            resourceOutcome: 'accepted' as const,
          };
        });
        if (preparation && this.resources)
          await this.resources.finalize(preparation, execution.resourceOutcome);
        return execution.response;
      } catch (error) {
        throw this.mapResourceError(error);
      }
    }) as Promise<SubmitCommandResponse | SubmitSystemCommandResponse>;
  }

  async getPlayerView(
    input: GetPlayerViewRequest,
  ): Promise<PlayerViewEnvelope> {
    const request = this.request(input);
    await this.authorize(request, 'view', 'session:view');
    return this.transaction(request, async (_tx, head) => {
      await this.authorize(request, 'view', 'session:view');
      this.viewer(head, request.accessContext);
      if (head.encodedState === null && this.terminal(head))
        throw contractError('SESSION_CLOSED', 'host.result.notRetained');
      const module = this.options.registry.resolve(head.route);
      return this.project(
        module,
        module.rules.decode(copy(head.encodedState), head.schemaVersion),
        head,
        request.accessContext,
      );
    });
  }

  async getEvents(input: GetEventsRequest): Promise<GetEventsResponse> {
    const request = this.request(input);
    assertGetEventsRequest(request);
    await this.authorize(request, 'events', 'session:view');
    const head = await this.storageCall(async () => {
      const current = await this.options.storage.getHead(
        request.route.sessionId,
      );
      if (!current) throw contractError('NOT_FOUND', 'host.session.notFound');
      return current;
    });
    this.assertRoute(head, request.route);
    const viewer = this.viewer(head, request.accessContext);
    const audienceKey = digest({
      principalId: request.accessContext.principalId,
      audience: viewer.audience,
      epoch: viewer.epoch,
    });
    const identity = {
      gameId: head.route.gameId,
      sessionId: head.route.sessionId,
      releaseId: head.route.releaseId,
      audienceKey,
      viewEpoch: viewer.epoch,
    } as const;
    if (request.viewEpoch !== undefined && request.viewEpoch !== viewer.epoch) {
      return {
        ...identity,
        nextSequence: request.afterSequence,
        hasMore: false,
        events: [],
        resetRequired: true,
      };
    }
    // Ephemeral terminal sessions deliberately have no private event history.
    if (head.encodedState === null && this.terminal(head)) {
      return {
        ...identity,
        nextSequence: request.afterSequence,
        hasMore: false,
        events: [],
        resetRequired: false,
      };
    }
    const module = this.options.registry.resolve(head.route);
    // Read one sentinel record so the returned cursor never skips unreturned data.
    const rawEvents = await this.storageCall(() =>
      this.options.storage.readEvents(head.route.sessionId, {
        afterSequence: request.afterSequence,
        limit: request.limit + 1,
      }),
    );
    const page = rawEvents.slice(0, request.limit);
    const events: ProjectedEvent[] = [];
    for (const event of page) {
      const payload = module.rules.projectEvent(copy(event.payload), viewer);
      if (payload === null) continue;
      assertJsonPayloadSize(payload, DEFAULT_JSON_LIMITS.viewBytes);
      events.push({
        sequence: event.aggregateSequence,
        eventId: event.eventId,
        payload: copy(payload),
        ...(event.source === undefined ? {} : { source: copy(event.source) }),
      });
    }
    return {
      ...identity,
      nextSequence:
        page.length > 0
          ? page[page.length - 1].aggregateSequence
          : request.afterSequence,
      hasMore: rawEvents.length > request.limit,
      events,
      resetRequired: false,
    };
  }

  /**
   * Reads private command/automation traces for an already-authorized operator.
   * The regular SessionGateway never exposes this method or its payload.
   */
  async readAutomationTraces(
    input: AutomationTraceReadRequest,
  ): Promise<readonly AutomationTrace[]> {
    assertSessionRoute(input.route);
    assertAccessContext(input.accessContext);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw contractError('INVALID_REQUEST', 'host.automation.trace_limit');
    if (
      input.afterCreatedAt !== undefined &&
      (!Number.isFinite(input.afterCreatedAt) || input.afterCreatedAt < 0)
    )
      throw contractError('INVALID_REQUEST', 'host.automation.trace_cursor');
    await this.authorize(
      { accessContext: input.accessContext, route: input.route },
      'automation-diagnostics',
      'session:admin',
    );
    const head = await this.storageCall(() =>
      this.options.storage.getHead(input.route.sessionId),
    );
    if (!head) throw contractError('NOT_FOUND', 'host.session.notFound');
    this.assertRoute(head, input.route);
    return this.storageCall(() =>
      this.options.storage.readAutomationTraces(input.route.sessionId, {
        limit,
        ...(input.afterCreatedAt === undefined
          ? {}
          : { afterCreatedAt: input.afterCreatedAt }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        now: this.now(),
      }),
    );
  }

  /** Internal report-ingestion read; it is not part of the public gateway. */
  async readAutomationTraceSnapshot(
    input: AutomationTraceSnapshotRequest,
  ): Promise<AutomationTrace | null> {
    assertSessionRoute(input.route);
    assertAccessContext(input.accessContext);
    requireId(input.traceId);
    await this.authorize(
      { accessContext: input.accessContext, route: input.route },
      'trace-evidence',
      'session:view',
    );
    const head = await this.storageCall(() =>
      this.options.storage.getHead(input.route.sessionId),
    );
    if (!head) throw contractError('NOT_FOUND', 'host.session.notFound');
    this.assertRoute(head, input.route);
    const trace = (
      await this.storageCall(() =>
        this.options.storage.readAutomationTraces(input.route.sessionId, {
          limit: 200,
          now: this.now(),
        }),
      )
    ).find((candidate) => candidate.traceId === input.traceId);
    return trace && trace.releaseId === input.route.releaseId ? trace : null;
  }

  /**
   * Re-runs the current installed policy against the exact private state and
   * actor input captured before a decision.  It is a dry run: no command,
   * receipt, state, or deadline is written.
   */
  async replayAutomationDecision(
    input: AutomationReplayRequest,
  ): Promise<AutomationReplayResult> {
    assertSessionRoute(input.route);
    assertAccessContext(input.accessContext);
    if (typeof input.traceId !== 'string' || input.traceId.length === 0)
      throw contractError('INVALID_REQUEST', 'host.automation.trace_id');
    await this.authorize(
      { accessContext: input.accessContext, route: input.route },
      'automation-diagnostics',
      'session:admin',
    );
    const head = await this.storageCall(() =>
      this.options.storage.getHead(input.route.sessionId),
    );
    if (!head) throw contractError('NOT_FOUND', 'host.session.notFound');
    this.assertRoute(head, input.route);
    const trace = (
      await this.storageCall(() =>
        this.options.storage.readAutomationTraces(input.route.sessionId, {
          limit: 200,
          now: this.now(),
        }),
      )
    ).find((candidate) => candidate.traceId === input.traceId);
    if (!trace || trace.releaseId !== input.route.releaseId)
      throw contractError('NOT_FOUND', 'host.automation.trace_not_found');
    return this.replayTrace(input.route, trace);
  }

  /**
   * Replays a report's persisted private evidence after the bounded live trace
   * has expired. The platform calls this with a server-created diagnostic
   * context; it never appears in the player gateway.
   */
  async replayAutomationTraceEvidence(
    input: AutomationTraceEvidenceReplayRequest,
  ): Promise<AutomationReplayResult> {
    assertSessionRoute(input.route);
    assertAccessContext(input.accessContext);
    if (!input.trace || typeof input.trace !== 'object')
      throw contractError('INVALID_REQUEST', 'host.automation.trace_invalid');
    await this.authorize(
      { accessContext: input.accessContext, route: input.route },
      'trace-evidence',
      'session:view',
    );
    const head = await this.storageCall(() =>
      this.options.storage.getHead(input.route.sessionId),
    );
    if (!head) throw contractError('NOT_FOUND', 'host.session.notFound');
    this.assertRoute(head, input.route);
    if (
      input.trace.sessionId !== input.route.sessionId ||
      input.trace.releaseId !== input.route.releaseId
    )
      throw contractError('NOT_FOUND', 'host.automation.trace_not_found');
    return this.replayTrace(input.route, input.trace);
  }

  private async replayTrace(
    route: SessionRoute,
    trace: AutomationTrace,
  ): Promise<AutomationReplayResult> {
    if (trace.kind === 'command') return this.replayCommandTrace(route, trace);
    const policy = this.automationPolicies.get(trace.policyId);
    if (!policy)
      throw contractError('NOT_READY', 'host.automation.policy_missing');
    const module = this.options.registry.resolve(route);
    const result = await replayAutomationTraceOffline({
      module,
      trace,
      currentPolicy: policy,
      now: this.now,
    });
    return this.offlineReplayResult(result);
  }

  private async replayCommandTrace(
    route: SessionRoute,
    trace: AutomationTrace,
  ): Promise<AutomationReplayResult> {
    const module = this.options.registry.resolve(route);
    const result = await replayAutomationTraceOffline({
      module,
      trace,
      now: this.now,
    });
    return this.offlineReplayResult(result);
  }

  private offlineReplayResult(
    result: OfflineAutomationReplayResult,
  ): AutomationReplayResult {
    const command = result.newCommand ?? result.command;
    return {
      traceKind: result.traceKind,
      traceId: result.traceId,
      decisionId: result.decisionId,
      policyId: result.policyId,
      ...(result.policyVersion === undefined
        ? {}
        : { policyVersion: result.policyVersion }),
      ...(command === undefined ? {} : { command: copy(command) }),
      ...(result.diagnostics === undefined
        ? {}
        : { diagnostics: copy(result.diagnostics) }),
      durationMs: result.durationMs,
      inputDigest: result.inputDigest,
      legal: result.legal,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  async resume(input: ResumeRequest): Promise<ResumeResult> {
    const request = this.request(input);
    const view = await this.getPlayerView(request);
    if (
      request.viewerEpoch !== undefined &&
      request.viewerEpoch !== view.viewEpoch
    ) {
      return { kind: 'resync-required', reason: 'audience-changed', view };
    }
    if (
      request.streamCursor !== undefined &&
      request.streamCursor !== view.streamCursor
    ) {
      return { kind: 'resync-required', reason: 'cursor-expired', view };
    }
    // Snapshot recovery is bounded by the current head, regardless of history length.
    return { kind: 'snapshot', view };
  }

  async queryOptions(
    input: QueryOptionsRequest,
  ): Promise<QueryOptionsResponse> {
    const request = this.request(input);
    assertJsonPayloadSize(request.query, DEFAULT_JSON_LIMITS.queryBytes);
    if (!Number.isSafeInteger(request.revision) || request.revision < 0)
      throw contractError('INVALID_REQUEST', 'host.revision.invalid');
    await this.authorize(request, 'query', 'session:view');
    return this.transaction(request, async (_tx, head) => {
      await this.authorize(request, 'query', 'session:view');
      const viewer = this.viewer(head, request.accessContext);
      this.assertQueryable(head);
      if (head.revision !== request.revision)
        throw contractError('STALE_REVISION', 'host.revision.stale');
      const module = this.options.registry.resolve(head.route);
      if (!module.rules.query || !module.schemas.query)
        throw contractError('INVALID_REQUEST', 'host.query.unsupported');
      assertMatchesSchema(request.query, module.schemas.query);
      const state = module.rules.decode(
        copy(head.encodedState),
        head.schemaVersion,
      );
      const before = digest(module.rules.encode(state));
      const answer = module.rules.query(state, copy(request.query), viewer);
      assertJsonPayloadSize(answer, DEFAULT_JSON_LIMITS.viewBytes);
      if (before !== digest(module.rules.encode(state)))
        throw contractError('INTERNAL', 'host.query.mutatedState');
      return {
        route: copy(head.route),
        revision: head.revision,
        answer: copy(answer),
      };
    });
  }

  async getSessionSummary(
    input: GetSessionSummaryRequest,
  ): Promise<SessionSummary> {
    const request = this.request(input);
    await this.authorize(request, 'summary', 'session:view');
    return this.transaction(request, async (_tx, head) => {
      await this.authorize(request, 'summary', 'session:view');
      this.viewer(head, request.accessContext);
      return {
        route: copy(head.route),
        status: head.status,
        sourceRevision: head.revision,
        eventSequence: head.eventSequence,
        updatedAt: head.logicalTime,
        summary: copy(head.summary),
        historyAvailable: head.encodedState !== null,
      };
    });
  }

  async retireSessionHistory(
    input: RetireSessionHistoryRequest,
  ): Promise<SessionSummary> {
    const request = this.request(input);
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0
    )
      throw contractError('INVALID_REQUEST', 'host.revision.invalid');
    await this.authorize(request, 'retire-history', 'session:history:retire');
    return this.queue.run(request.route.sessionId, () =>
      this.transaction(request, async (tx, head) => {
        await this.authorize(
          request,
          'retire-history',
          'session:history:retire',
        );
        if (head.status !== 'completed' && head.status !== 'cancelled')
          throw contractError('CONFLICT', 'host.history.terminal_required');
        if (head.revision !== request.expectedRevision)
          throw contractError('STALE_REVISION', 'host.revision.stale');
        await tx.clearPrivateState();
        return {
          route: copy(head.route),
          status: head.status,
          sourceRevision: head.revision,
          eventSequence: head.eventSequence,
          updatedAt: head.logicalTime,
          summary: copy(head.summary),
          historyAvailable: false,
        };
      }),
    );
  }

  async getStatus(input: GetStatusRequest): Promise<OperationStatus> {
    const request = this.request(input);
    if (request.startId !== undefined) requireId(request.startId);
    if (request.commandId !== undefined) requireId(request.commandId);
    await this.authorize(request, 'status', 'session:view');
    const observed = await this.storageCall(() =>
      this.options.storage.getHead(request.route.sessionId),
    );
    if (!observed) {
      return request.commandId
        ? {
            kind: 'command',
            commandId: request.commandId,
            sessionId: request.route.sessionId,
            status: 'unknown',
          }
        : {
            kind: 'start',
            ...(request.startId ? { startId: request.startId } : {}),
            sessionId: request.route.sessionId,
            status: 'unknown',
          };
    }
    return this.transaction(request, async (tx, head) => {
      await this.authorize(request, 'status', 'session:view');
      if (!request.accessContext.scopes.includes('session:create'))
        this.viewer(head, request.accessContext);
      if (request.commandId) {
        const actorPrincipalId =
          request.accessContext.seatId !== undefined ||
          this.controlledParticipants(head, request.accessContext).length > 0
            ? this.actor(head, request.accessContext).principalId
            : request.accessContext.principalId;
        const receipt = await tx.getReceipt(
          request.commandId,
          actorPrincipalId,
        );
        return {
          kind: 'command',
          commandId: request.commandId,
          sessionId: head.route.sessionId,
          status:
            receipt?.status === 'accepted'
              ? 'accepted'
              : receipt?.status === 'rejected'
                ? 'rejected'
                : 'unknown',
        };
      }
      return {
        kind: 'start',
        startId: request.startId ?? head.startId,
        sessionId: head.route.sessionId,
        status:
          request.startId && request.startId !== head.startId
            ? 'unknown'
            : head.status === 'suspended'
              ? 'pending'
              : head.status === 'paused'
                ? 'accepted'
                : head.status,
      };
    });
  }

  async controlSession(
    input: ControlSessionRequest,
  ): Promise<ControlSessionResponse> {
    assertControlSessionRequest(input);
    const request = this.request(input);
    const controlScopes =
      request.action === 'cancel'
        ? ['session:control', 'session:control:cancel']
        : ['session:control'];
    await this.authorize(request, 'control', controlScopes, request.action);
    const inputHash = digest({
      principalId: request.accessContext.principalId,
      route: request.route,
      commandId: request.commandId,
      expectedRevision: request.expectedRevision,
      action: request.action,
    });
    return this.queue.run(request.route.sessionId, () =>
      this.transaction(request, async (tx, head) => {
        await this.authorize(request, 'control', controlScopes, request.action);
        const previous = await tx.getReceipt(request.commandId);
        if (previous) {
          this.assertReceipt(
            previous,
            inputHash,
            request.accessContext.principalId,
          );
          return {
            route: copy(head.route),
            status: head.status,
            receipt: this.safeReceipt(previous, true),
          };
        }
        if (head.revision !== request.expectedRevision)
          throw contractError('STALE_REVISION', 'host.revision.stale');
        if (
          (request.action === 'pause' || request.action === 'resume') &&
          head.deadline !== undefined
        )
          throw contractError(
            'NOT_READY',
            'host.control.timerSemanticsUnavailable',
          );
        if (
          this.terminal(head) ||
          (request.action === 'resume' && head.status !== 'paused') ||
          (request.action === 'pause' && head.status !== 'active')
        )
          throw contractError('SESSION_CLOSED', 'host.control.invalidState');
        const status =
          request.action === 'pause'
            ? 'paused'
            : request.action === 'resume'
              ? 'active'
              : 'cancelled';
        const next: SessionHead = {
          ...head,
          status,
          revision: head.revision + 1,
          logicalTime: this.nextTime(head),
          ...(status === 'cancelled' ? { deadline: undefined } : {}),
          ...(status === 'cancelled' ? { automationFailure: undefined } : {}),
        };
        const mode = this.mode(
          this.options.registry.resolve(head.route),
          head.route,
        );
        const clearPrivate =
          status === 'cancelled' && mode.history !== 'summary-and-replay';
        await tx.setHead(clearPrivate ? { ...next, encodedState: null } : next);
        if (clearPrivate) await tx.clearPrivateState();
        else if (status === 'cancelled') await tx.clearAutomationDecisions();
        await tx.appendOutbox(
          this.outbox(
            next,
            'SessionControlled',
            {
              action: request.action,
              principalId: request.accessContext.principalId,
              summary: next.summary,
              status,
            },
            0,
          ),
        );
        const receipt: CommandReceipt = {
          sessionId: head.route.sessionId,
          commandId: request.commandId,
          actorPrincipalId: request.accessContext.principalId,
          inputHash,
          status: 'accepted',
          persistedRevision: next.revision,
          persistedAt: next.logicalTime,
          resultRetention:
            mode.history === 'summary-and-replay'
              ? 'replayable'
              : 'ephemeral-result',
        };
        await tx.putReceipt(receipt);
        return {
          route: copy(head.route),
          status,
          receipt: this.safeReceipt(receipt),
        };
      }),
    );
  }

  private request<
    T extends { accessContext: AccessContext; route: SessionRoute },
  >(input: T): T {
    if (!this.readyState)
      throw contractError('NOT_READY', 'host.draining', true);
    assertProtocolRequest(input);
    assertAccessContext(input.accessContext);
    assertSessionRoute(input.route);
    assertJsonPayloadSize(input, DEFAULT_JSON_LIMITS.setupBytes);
    return copy(input);
  }

  private async authorize(
    request: { accessContext: AccessContext; route: SessionRoute },
    operation: HostOperation,
    scopes: string | readonly string[],
    action?: ControlAction,
  ): Promise<void> {
    assertSessionRoute(request.route);
    if (
      request.route.backendBindingId !== this.options.backendBindingId ||
      request.route.storageBindingId !== this.options.storageBindingId
    )
      throw contractError('OWNERSHIP_LOST', 'host.binding.mismatch');
    const requiredScopes = typeof scopes === 'string' ? [scopes] : scopes;
    if (
      !requiredScopes.some((scope) =>
        request.accessContext.scopes.includes(scope),
      )
    )
      throw contractError('FORBIDDEN', 'host.scope.denied');
    await this.options.authorize(
      copy(request.accessContext),
      operation,
      copy(request.route),
      action,
    );
  }

  private async transaction<T>(
    request: { route: SessionRoute },
    work: (tx: SessionTransaction, head: SessionHead) => Promise<T>,
  ): Promise<T> {
    return this.storageCall(() =>
      this.options.storage.transaction(
        request.route.sessionId,
        { ownershipEpoch: request.route.ownershipEpoch },
        async (tx) => {
          const head = await tx.getHead();
          this.assertRoute(head, request.route);
          return work(tx, head);
        },
      ),
    );
  }

  private async prepareResources(
    request: SubmitCommandRequest,
    inputHash: string,
  ): Promise<ResourcePreparation | null> {
    if (!this.resources) return null;
    const head = await this.storageCall(async () => {
      const current = await this.options.storage.getHead(
        request.route.sessionId,
      );
      if (!current) throw contractError('NOT_FOUND', 'host.session.notFound');
      return current;
    });
    this.assertRoute(head, request.route);
    await this.authorize(request, 'command', 'session:command');
    const actor = this.actor(head, request.accessContext);
    const previous = await this.storageCall(() =>
      this.options.storage.getReceipt(
        request.route.sessionId,
        request.commandId,
      ),
    );
    if (previous) {
      this.assertReceipt(previous, inputHash, actor.principalId);
      // A duplicate may be terminal and have no decodable state. The ledger
      // lookup is by session/command so it can still confirm/release it.
      return this.resources.prepare({
        route: head.route,
        commandId: request.commandId,
        principalId: actor.principalId,
        commandDigest: inputHash,
        allowTerminal: true,
      });
    }
    this.assertActive(head);
    const module = this.options.registry.resolve(head.route);
    assertMatchesSchema(request.command, module.schemas.command);
    const state = module.rules.decode(
      copy(head.encodedState),
      head.schemaVersion,
    );
    this.assertPrecondition(module, state, head, actor, request);
    const requirement = this.resourceRequirement(module, state, request, actor);
    return this.resources.prepare({
      route: head.route,
      commandId: request.commandId,
      principalId: actor.principalId,
      commandDigest: inputHash,
      ...(requirement ? { requirement } : {}),
    });
  }

  private initialEvents(
    module: RuntimeModule,
    state: Readonly<unknown>,
    route: SessionRoute,
    participants: readonly {
      readonly principalId: string;
      readonly seatId: string;
    }[],
    viewEpoch: string,
    logicalTime: number,
  ): readonly DomainEvent[] {
    if (
      !module.initialEvents ||
      this.mode(module, route).history !== 'summary-and-replay'
    )
      return [];
    // Rule state may contain class instances or non-cloneable helpers. The
    // codec gives the setup hook a fresh, JSON-backed candidate state.
    const candidate = module.rules.decode(
      copy(module.rules.encode(state)),
      module.stateSchemaVersion,
    );
    const before = digest(module.rules.encode(candidate));
    const emitted = module.initialEvents(candidate);
    if (before !== digest(module.rules.encode(candidate)))
      throw contractError('INTERNAL', 'host.initialEvents.mutatedState');
    if (!Array.isArray(emitted))
      throw contractError('INVALID_REQUEST', 'host.initialEvents.invalid');
    const producerId = `game:${route.gameId}:session:${route.sessionId}`;
    return emitted.map((event, index) => {
      assertJsonPayloadSize(event as JsonValue, DEFAULT_JSON_LIMITS.viewBytes);
      for (const participant of participants) {
        const viewer: Viewer = {
          principalId: participant.principalId,
          seatId: participant.seatId,
          audience: `player:${participant.seatId}`,
          epoch: viewEpoch,
          scopes: [],
        };
        assertJsonPayloadSize(
          module.rules.projectEvent(copy(event), viewer),
          DEFAULT_JSON_LIMITS.viewBytes,
        );
      }
      return {
        eventId: `${route.sessionId}:event:${index + 1}`,
        sessionId: route.sessionId,
        producerId,
        aggregateSequence: index + 1,
        schemaVersion: 1,
        sourceRelease: route.releaseId,
        payload: event as JsonValue,
        logicalTime,
        occurredAt: logicalTime,
      };
    });
  }

  private resourceRequirement(
    module: RuntimeModule,
    state: Readonly<unknown>,
    request: SubmitCommandRequest,
    actor: Actor,
  ): ResourceRequirement | undefined {
    const hook = module.commandResourceRequirement;
    if (!hook) return undefined;
    // Rule state may be a class instance or contain non-cloneable helpers.
    // Use the module codec for an isolated candidate instead of structuredClone.
    const candidate = module.rules.decode(
      copy(module.rules.encode(state)),
      module.stateSchemaVersion,
    );
    const before = digest(module.rules.encode(candidate));
    const value = hook(candidate, copy(request.command), copy(actor));
    if (before !== digest(module.rules.encode(candidate)))
      throw contractError('INTERNAL', 'host.resource.hookMutatedState');
    if (value === null || value === undefined) return undefined;
    if (
      typeof value !== 'object' ||
      Object.keys(value).some(
        (key) => !['namespace', 'asset', 'quantity'].includes(key),
      ) ||
      typeof value.namespace !== 'string' ||
      value.namespace.trim().length === 0 ||
      typeof value.asset !== 'string' ||
      value.asset.trim().length === 0 ||
      !Number.isSafeInteger(value.quantity) ||
      value.quantity < 1
    )
      throw contractError('INVALID_REQUEST', 'host.resource.invalid');
    return {
      namespace: value.namespace,
      asset: value.asset,
      quantity: value.quantity,
    };
  }

  private resourceOutcome(
    receipt: CommandReceipt,
  ): ResourceFinalizationOutcome {
    if (receipt.status === 'accepted') return 'accepted';
    if (receipt.status === 'rejected' || receipt.status === 'tombstone')
      return 'rejected';
    return 'unknown';
  }

  private receiptRetention(module: RuntimeModule, route: SessionRoute) {
    return this.mode(module, route).history === 'summary-and-replay'
      ? ('replayable' as const)
      : ('ephemeral-result' as const);
  }

  private resourceRejectedReceipt(
    head: SessionHead,
    commandId: string,
    actorPrincipalId: string,
    inputHash: string,
    messageKey: string,
    resultRetention: 'replayable' | 'ephemeral-result' = 'replayable',
  ): CommandReceipt {
    const persistedAt = this.nextTime(head);
    return {
      sessionId: head.route.sessionId,
      commandId,
      actorPrincipalId,
      inputHash,
      status: 'rejected',
      resultRetention,
      persistedRevision: head.revision,
      persistedAt,
      error: {
        code: 'CONFLICT',
        messageKey,
        retryable: false,
      },
    };
  }

  private async rejectResource(
    request: SubmitCommandRequest,
    inputHash: string,
  ): Promise<SubmitCommandResponse> {
    return this.transaction(request, async (tx, head) => {
      await this.authorize(request, 'command', 'session:command');
      const actor = this.actor(head, request.accessContext);
      const previous = await tx.getReceipt(request.commandId);
      if (previous) {
        this.assertReceipt(previous, inputHash, actor.principalId);
        return { receipt: this.safeReceipt(previous, true) };
      }
      this.assertActive(head);
      const module = this.options.registry.resolve(head.route);
      assertMatchesSchema(request.command, module.schemas.command);
      const state = module.rules.decode(
        copy(head.encodedState),
        head.schemaVersion,
      );
      this.assertPrecondition(module, state, head, actor, request);
      const receipt = this.resourceRejectedReceipt(
        head,
        request.commandId,
        actor.principalId,
        inputHash,
        'host.resource.insufficient',
        this.receiptRetention(module, head.route),
      );
      await tx.putReceipt(receipt);
      await tx.putAutomationTrace(
        this.commandTrace(head, request, actor, {
          outcome: 'rejected',
          startedAt: this.now(),
          finishedAt: this.now(),
        }),
      );
      return { receipt: this.safeReceipt(receipt) };
    });
  }

  private mapResourceError(error: unknown): unknown {
    if (error instanceof ResourceCoordinatorError) {
      if (error.code === 'IDEMPOTENCY_CONFLICT')
        return contractError('IDEMPOTENCY_CONFLICT', 'host.resource.conflict');
      if (error.code === 'INSUFFICIENT_BALANCE')
        return contractError('CONFLICT', 'host.resource.insufficient');
      return contractError(
        'INTERNAL',
        'host.resource.unavailable',
        error.retryable,
      );
    }
    return error;
  }

  private async storageCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isStorageError(error)) throw error;
      const code =
        error.code === 'SESSION_NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'STALE_OWNERSHIP'
            ? 'OWNERSHIP_LOST'
            : error.code === 'STALE_REVISION'
              ? 'STALE_REVISION'
              : error.code === 'IDEMPOTENCY_CONFLICT' ||
                  error.code === 'DUPLICATE_SESSION' ||
                  error.code === 'DUPLICATE_ID'
                ? 'IDEMPOTENCY_CONFLICT'
                : error.code === 'TRANSACTION_CONFLICT'
                  ? 'CONFLICT'
                  : 'INTERNAL';
      throw contractError(
        code,
        `host.storage.${code.toLowerCase()}`,
        error.retryable,
      );
    }
  }

  private assertRoute(head: SessionHead, route: SessionRoute): void {
    if (
      canonicalStableStringify(head.route) !== canonicalStableStringify(route)
    )
      throw contractError('OWNERSHIP_LOST', 'host.route.mismatch');
  }

  private persistedSchedule(
    schedule: HostSchedule | undefined,
  ): SessionDeadline | undefined {
    return schedule
      ? { deadlineId: schedule.deadlineId, dueAt: schedule.dueAt }
      : undefined;
  }

  private schedule(
    module: RuntimeModule,
    state: Readonly<unknown>,
    participants: readonly Participant[],
    sessionId: string,
    logicalTime: number,
    options: {
      readonly revision?: number;
      readonly deadline?: SessionDeadline;
    } = {},
  ): HostSchedule | undefined {
    const candidates: HostSchedule[] = [];
    const system = this.systemScheduleValue(module, state, logicalTime);
    if (system) candidates.push({ kind: 'system', ...system });
    const turn = this.turnState(module, state, participants);
    const revision = options.revision ?? 0;
    if (turn) {
      for (const seatId of turn.activeSeatIds) {
        const participant = participants.find(
          (candidate) => candidate.seatId === seatId,
        );
        if (!participant || !isAutomatedParticipant(participant)) continue;
        if (participant.controller === 'bot') continue;
        let policy: AutomationPolicy;
        let policyOptions: JsonValue;
        try {
          policy = this.policyForParticipant(participant);
          policyOptions = automationOptions(
            policy,
            participant.controllerOptions,
          );
        } catch (error) {
          if (!options.deadline) throw error;
          policy = this.unavailableAutomationPolicy(participant, error);
          policyOptions = null;
        }
        const opportunity = turn.inputOpportunities?.[seatId];
        const identity = digest({
          sessionId,
          releaseId: module.releaseId,
          seatId,
          turnId: turn.id,
          participantInputRevision:
            opportunity?.participantInputRevision ?? null,
          revision,
          policyId: policy.id,
        });
        const deadlineId = `automation:${identity}`;
        const dueAt =
          options.deadline?.deadlineId === deadlineId
            ? options.deadline.dueAt
            : logicalTime + (policy.delayMs ?? 0);
        candidates.push({
          kind: 'automation',
          deadlineId,
          dueAt,
          decisionId: identity,
          commandId: `automation:${identity}`,
          seatId,
          turnId: turn.id,
          turn: copy(turn),
          participant: copy(participant),
          policy,
          options: policyOptions,
        });
      }
    }
    candidates.sort(
      (left, right) =>
        left.dueAt - right.dueAt ||
        left.deadlineId.localeCompare(right.deadlineId),
    );
    return candidates[0];
  }

  private unavailableAutomationPolicy(
    participant: Participant,
    error: unknown,
  ): AutomationPolicy {
    return {
      id: participant.controllerId ?? 'missing-automation-policy',
      kind: participant.controller === 'automa' ? 'automa' : 'ai',
      label: 'Unavailable automation policy',
      timeoutMs: 1,
      decide: () => {
        throw error;
      },
    };
  }

  private policyForParticipant(participant: Participant): AutomationPolicy {
    if (
      (participant.controller !== 'ai' &&
        participant.controller !== 'automa') ||
      !participant.controllerId
    )
      throw contractError('NOT_READY', 'host.automation.policy_missing');
    const policy = this.automationPolicies.get(participant.controllerId);
    if (!policy || policy.kind !== participant.controller)
      throw contractError('NOT_READY', 'host.automation.policy_missing');
    return policy;
  }

  private validateAutomationParticipants(
    participants: readonly Participant[],
  ): void {
    for (const participant of participants) {
      if (participant.controller === 'hotseat') {
        if (!participant.controlledBy)
          throw contractError('INVALID_REQUEST', 'host.hotseat.controller');
        continue;
      }
      if (
        participant.controller === 'ai' ||
        participant.controller === 'automa'
      ) {
        const policy = this.policyForParticipant(participant);
        automationOptions(policy, participant.controllerOptions);
        continue;
      }
      if (
        participant.controlledBy !== undefined ||
        participant.controllerId !== undefined ||
        participant.controllerOptions !== undefined
      )
        throw contractError('INVALID_REQUEST', 'host.participant.controller');
    }
  }

  private turnState(
    module: RuntimeModule,
    state: Readonly<unknown>,
    participants: readonly Participant[],
  ): TurnState | null {
    if (!module.turn) return null;
    const candidate = module.rules.decode(
      copy(module.rules.encode(state)),
      module.stateSchemaVersion,
    );
    const before = digest(module.rules.encode(candidate));
    const turn = module.turn(candidate, { participants: copy(participants) });
    if (before !== digest(module.rules.encode(candidate)))
      throw contractError('INTERNAL', 'host.turn.mutatedState');
    if (turn === null) return null;
    assertTurnState(turn, participants);
    return copy(turn);
  }

  /** Keep prompt identifiers out of the policy input. */
  private automationTurn(turn: TurnState): TurnView {
    return {
      id: turn.id,
      mode: turn.mode,
      activeSeatIds: [...turn.activeSeatIds],
    };
  }

  private assertAutomationTurn(
    module: RuntimeModule,
    state: Readonly<unknown>,
    head: SessionHead,
    actor: Actor,
    expected: TurnState,
  ): void {
    if (!actor.seatId)
      throw contractError('CONFLICT', 'host.automation.stale', true);
    const turn = this.turnState(module, state, head.participants);
    const opportunity = turn?.inputOpportunities?.[actor.seatId];
    const expectedOpportunity = expected.inputOpportunities?.[actor.seatId];
    if (
      !turn ||
      turn.id !== expected.id ||
      !turn.activeSeatIds.includes(actor.seatId) ||
      opportunity?.promptId !== expectedOpportunity?.promptId ||
      opportunity?.participantInputRevision !==
        expectedOpportunity?.participantInputRevision
    )
      throw contractError('STALE_REVISION', 'host.automation.stale');
  }

  private actorForParticipant(participant: Participant): Actor {
    return {
      principalId: participant.principalId,
      seatId: participant.seatId,
      kind: 'player',
      ...(participant.controller ? { controller: participant.controller } : {}),
      ...(participant.controlledBy
        ? { controlledBy: participant.controlledBy }
        : {}),
      ...(participant.controllerId
        ? { controllerId: participant.controllerId }
        : {}),
      ...(participant.controllerOptions !== undefined
        ? { controllerOptions: copy(participant.controllerOptions) }
        : {}),
      ...(participant.publicProfile
        ? { publicProfile: copy(participant.publicProfile) }
        : {}),
    };
  }

  private projectAutomationView(
    module: RuntimeModule,
    state: Readonly<unknown>,
    viewer: Viewer,
  ): JsonValue {
    const candidate = module.rules.decode(
      copy(module.rules.encode(state)),
      module.stateSchemaVersion,
    );
    const before = digest(module.rules.encode(candidate));
    const view = module.projectAutomationView
      ? module.projectAutomationView(candidate, copy(viewer))
      : module.rules.project(candidate, copy(viewer));
    if (before !== digest(module.rules.encode(candidate)))
      throw contractError('INTERNAL', 'host.automation.viewMutatedState');
    assertJsonPayloadSize(view, DEFAULT_JSON_LIMITS.viewBytes);
    return copy(view);
  }

  private systemActor(context: AccessContext): Actor {
    return { principalId: context.principalId, kind: 'system' };
  }

  private systemScheduleValue(
    module: RuntimeModule,
    state: Readonly<unknown>,
    logicalTime: number,
  ): HostSystemSchedule | undefined {
    if (!module.systemSchedule) return undefined;
    const candidate = module.rules.decode(
      copy(module.rules.encode(state)),
      module.stateSchemaVersion,
    );
    return this.systemScheduleCandidate(module, candidate, logicalTime);
  }

  private systemDeadline(
    module: RuntimeModule,
    state: Readonly<unknown>,
    logicalTime: number,
  ): SessionDeadline | undefined {
    const schedule = this.systemScheduleValue(module, state, logicalTime);
    return schedule
      ? this.persistedSchedule({ kind: 'system', ...schedule })
      : undefined;
  }

  private automationFailureHead(
    head: SessionHead,
    module: RuntimeModule,
    state: Readonly<unknown>,
    failure: AutomationFailure,
  ): SessionHead {
    const logicalTime = this.nextTime(head);
    return {
      ...head,
      revision: head.revision + 1,
      logicalTime,
      deadline: this.systemDeadline(module, state, logicalTime),
      automationFailure: copy(failure),
    };
  }

  private async disableAutomationDeadline(
    head: SessionHead,
    module: RuntimeModule,
    schedule: HostAutomationSchedule,
    messageKey: string,
  ): Promise<void> {
    await this.storageCall(() =>
      this.options.storage.transaction(
        head.route.sessionId,
        { ownershipEpoch: head.route.ownershipEpoch },
        async (tx) => {
          const current = await tx.getHead();
          if (
            current.status !== 'active' ||
            current.revision !== head.revision ||
            current.deadline?.deadlineId !== schedule.deadlineId
          )
            return;
          const state = module.rules.decode(
            copy(current.encodedState),
            current.schemaVersion,
          );
          const next = this.automationFailureHead(current, module, state, {
            seatId: schedule.seatId,
            messageKey: this.safeAutomationMessage(messageKey),
          });
          await tx.setHead(next);
          await tx.appendOutbox(
            this.outbox(
              next,
              'SessionSummaryChanged',
              { summary: next.summary, status: next.status },
              0,
            ),
          );
        },
      ),
    );
  }

  private systemScheduleCandidate(
    module: RuntimeModule,
    candidate: Readonly<unknown>,
    logicalTime: number,
  ): HostSystemSchedule | undefined {
    if (!module.systemSchedule) return undefined;
    const before = digest(module.rules.encode(candidate));
    const value = module.systemSchedule(candidate, { logicalTime });
    if (before !== digest(module.rules.encode(candidate)))
      throw contractError('INTERNAL', 'host.systemSchedule.mutatedState');
    if (value === null || value === undefined) return undefined;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !isJsonValue(value) ||
      Object.keys(value).some(
        (key) => !['deadlineId', 'dueAt', 'command'].includes(key),
      ) ||
      typeof value.deadlineId !== 'string' ||
      value.deadlineId.length === 0 ||
      value.deadlineId.length > 256 ||
      value.deadlineId.startsWith('automation:') ||
      typeof value.dueAt !== 'number' ||
      !Number.isFinite(value.dueAt) ||
      value.dueAt < 0 ||
      !isJsonValue(value.command)
    )
      throw contractError('INVALID_REQUEST', 'host.systemSchedule.invalid');
    if (!module.schemas.systemCommand)
      throw contractError('NOT_READY', 'host.system.unsupported');
    assertMatchesSchema(value.command, module.schemas.systemCommand);
    assertJsonPayloadSize(
      value.command,
      DEFAULT_JSON_LIMITS.commandBytes,
      'systemSchedule.command',
    );
    return {
      deadlineId: value.deadlineId,
      dueAt: value.dueAt,
      command: copy(value.command),
    };
  }

  private assertSystemDeadline(
    head: SessionHead,
    schedule: HostSystemSchedule | undefined,
    request: SubmitSystemCommandRequest,
  ): void {
    if (request.expectedRevision !== head.revision)
      throw contractError('STALE_REVISION', 'host.revision.stale');
    if (
      !head.deadline ||
      !schedule ||
      request.deadlineId !== head.deadline.deadlineId ||
      schedule.deadlineId !== head.deadline.deadlineId ||
      schedule.dueAt !== head.deadline.dueAt ||
      digest(schedule.command) !== digest(request.command)
    )
      throw contractError('CONFLICT', 'host.system.deadline.stale', true);
    if (head.deadline.dueAt > this.now())
      throw contractError('CONFLICT', 'host.system.deadline.notDue', true);
  }

  private mode(module: RuntimeModule, route: SessionRoute) {
    const mode = module.modes.find(
      (candidate) => candidate.id === route.modeId,
    );
    if (!mode) throw contractError('NOT_FOUND', 'host.mode.notInstalled');
    return mode;
  }
  private nextTime(head: SessionHead): number {
    return Math.max(this.now(), head.logicalTime + 1);
  }
  private terminal(head: SessionHead): boolean {
    return head.status === 'completed' || head.status === 'cancelled';
  }
  private assertActive(head: SessionHead): void {
    if (head.status === 'suspended')
      throw contractError('SESSION_SUSPENDED', 'host.session.suspended');
    if (head.status !== 'active')
      throw contractError('SESSION_CLOSED', 'host.session.notActive');
  }
  /**
   * Read-only module queries may inspect a retained terminal candidate. A
   * purged terminal head has no decodable game state and must stay a tombstone;
   * no query may reopen it or infer state from the public summary.
   */
  private assertQueryable(head: SessionHead): void {
    if (head.status === 'completed') {
      if (head.encodedState === null)
        throw contractError('SESSION_CLOSED', 'host.result.notRetained');
      return;
    }
    this.assertActive(head);
  }
  private actor(head: SessionHead, context: AccessContext): Actor {
    const participant = this.selectedParticipant(head, context);
    if (participant) {
      if (isAutomatedParticipant(participant))
        throw contractError('FORBIDDEN', 'host.participant.required');
      return this.actorForParticipant(participant);
    }
    if (context.scopes.includes('session:system'))
      return { principalId: context.principalId, kind: 'system' };
    throw contractError('FORBIDDEN', 'host.participant.required');
  }
  private viewer(head: SessionHead, context: AccessContext): Viewer {
    const participant = this.selectedParticipant(head, context);
    if (participant)
      return {
        principalId: participant.principalId,
        seatId: participant.seatId,
        audience: `player:${participant.seatId}`,
        epoch: context.authEpoch,
        scopes: [...context.scopes],
      };
    if (context.scopes.includes('session:spectate'))
      return {
        principalId: context.principalId,
        audience: 'spectator',
        epoch: context.authEpoch,
        scopes: [...context.scopes],
      };
    throw contractError('FORBIDDEN', 'host.viewer.denied');
  }

  private selectedParticipant(
    head: SessionHead,
    context: AccessContext,
  ): Participant | undefined {
    const controlled = this.controlledParticipants(head, context);
    if (context.seatId !== undefined) {
      const selected = head.participants.find(
        (participant) => participant.seatId === context.seatId,
      );
      if (
        !selected ||
        !controlled.some((item) => item.seatId === selected.seatId)
      )
        throw contractError('FORBIDDEN', 'host.participant.required');
      return selected;
    }
    if (controlled.length > 1)
      throw contractError('INVALID_REQUEST', 'host.seat.required');
    return controlled[0];
  }

  private controlledParticipants(
    head: SessionHead,
    context: AccessContext,
  ): readonly Participant[] {
    return head.participants.filter(
      (participant) =>
        !isAutomatedParticipant(participant) &&
        controlsParticipant(participant, context.principalId),
    );
  }
  private encode(module: RuntimeModule, state: Readonly<unknown>): JsonValue {
    const encoded = module.rules.encode(state);
    assertJsonPayloadSize(encoded, DEFAULT_JSON_LIMITS.viewBytes);
    return copy(encoded);
  }
  private summary(module: RuntimeModule, state: Readonly<unknown>): JsonValue {
    const summary = module.summarize(state);
    assertJsonPayloadSize(summary, DEFAULT_JSON_LIMITS.queryBytes);
    return copy(summary);
  }
  private project(
    module: RuntimeModule,
    state: Readonly<unknown>,
    head: SessionHead,
    context: AccessContext,
  ): PlayerViewEnvelope {
    const viewer = this.viewer(head, context);
    // Callers provide a fresh decoded candidate so a faulty renderer cannot
    // change committed state or another hook's candidate.
    const payload = module.rules.project(state, viewer);
    assertJsonPayloadSize(payload, DEFAULT_JSON_LIMITS.viewBytes);
    const turn = this.turnState(module, state, head.participants);
    const controlledSeats = this.controlledParticipants(head, context);
    const actionPrecondition = turn
      ? this.actionPrecondition(module, state, head, viewer, turn)
      : undefined;
    const audienceKey = digest({
      principalId: context.principalId,
      audience: viewer.audience,
      epoch: viewer.epoch,
    });
    return {
      gameId: head.route.gameId,
      sessionId: head.route.sessionId,
      releaseId: head.route.releaseId,
      viewSchemaVersion: module.viewSchemaVersion,
      audienceKey,
      viewEpoch: viewer.epoch,
      baseRevision: head.revision,
      revision: head.revision,
      eventSequence: head.eventSequence,
      streamCursor: `${audienceKey}:${head.revision}`,
      kind: 'snapshot',
      payload: copy(payload),
      ...(turn
        ? {
            turn: {
              id: turn.id,
              mode: turn.mode,
              activeSeatIds: [...turn.activeSeatIds],
            },
            ...(viewer.seatId ? { actingSeatId: viewer.seatId } : {}),
            ...(actionPrecondition ? { actionPrecondition } : {}),
          }
        : {}),
      ...(head.automationFailure
        ? { automationFailure: copy(head.automationFailure) }
        : {}),
      ...(controlledSeats.length > 0
        ? { controlledSeats: copy(controlledSeats) }
        : {}),
    };
  }
  private actionPrecondition(
    module: RuntimeModule,
    state: Readonly<unknown>,
    head: SessionHead,
    viewer: Viewer,
    turn: TurnState,
  ): CommandPrecondition | undefined {
    const mode = this.mode(module, head.route);
    if (turn.mode === 'simultaneous')
      return turnPrecondition(turn, viewer.seatId, head.revision);
    if (mode.concurrency !== 'prompt')
      return turnPrecondition(turn, viewer.seatId, head.revision);
    const participant = head.participants.find(
      (candidate) => candidate.seatId === viewer.seatId,
    );
    const opportunity =
      turn.inputOpportunities?.[viewer.seatId ?? ''] ??
      (participant && module.inputOpportunity
        ? module.inputOpportunity(state, this.actorForParticipant(participant))
        : undefined);
    return opportunity ? { kind: 'prompt', ...opportunity } : undefined;
  }
  private assertPrecondition(
    module: RuntimeModule,
    state: Readonly<unknown>,
    head: SessionHead,
    actor: Actor,
    request: SubmitCommandRequest,
  ): void {
    const mode = this.mode(module, head.route);
    const precondition = request.precondition;
    const turn = this.turnState(module, state, head.participants);
    if (turn && precondition.kind === 'revision') {
      if (precondition.expectedRevision !== head.revision)
        throw contractError('STALE_REVISION', 'host.revision.stale');
      return;
    }
    if (turn && precondition.kind === 'prompt') {
      if (
        !actor.seatId ||
        !turn.activeSeatIds.includes(actor.seatId) ||
        (turn.mode === 'sequential' && turn.activeSeatIds[0] !== actor.seatId)
      )
        throw contractError('STALE_REVISION', 'host.turn.inactive');
    }
    const promptMode = !turn && mode.concurrency === 'prompt';
    if (promptMode && precondition.kind !== 'prompt')
      throw contractError('INVALID_REQUEST', 'host.precondition.kind');
    if (!promptMode && !turn && precondition.kind !== 'revision')
      throw contractError('INVALID_REQUEST', 'host.precondition.kind');
    if (precondition.kind === 'revision') {
      if (precondition.expectedRevision !== head.revision)
        throw contractError('STALE_REVISION', 'host.revision.stale');
    } else {
      const opportunity =
        turn?.inputOpportunities?.[actor.seatId ?? ''] ??
        module.inputOpportunity?.(state, actor);
      if (
        !opportunity ||
        opportunity.promptId !== precondition.promptId ||
        opportunity.participantInputRevision !==
          precondition.participantInputRevision
      ) {
        throw contractError('STALE_REVISION', 'host.prompt.stale');
      }
    }
  }
  private assertReceipt(
    receipt: CommandReceipt,
    inputHash: string,
    principalId: string,
  ): void {
    if (
      receipt.inputHash !== inputHash ||
      receipt.actorPrincipalId !== principalId
    )
      throw contractError('IDEMPOTENCY_CONFLICT', 'host.command.conflict');
  }
  private safeReceipt(
    receipt: CommandReceipt,
    duplicate = false,
  ): SafeCommandReceipt {
    return {
      commandId: receipt.commandId,
      sessionId: receipt.sessionId,
      status:
        duplicate && receipt.status === 'accepted'
          ? 'duplicate'
          : receipt.status === 'rejected'
            ? 'rejected'
            : receipt.status === 'accepted'
              ? 'accepted'
              : 'unknown',
      resultRetention: receipt.resultRetention,
      ...(receipt.persistedRevision !== undefined
        ? { persistedRevision: receipt.persistedRevision }
        : {}),
      ...(receipt.persistedAt !== undefined
        ? { persistedAt: receipt.persistedAt }
        : {}),
      ...(receipt.error
        ? {
            error: {
              code: isErrorCode(receipt.error.code)
                ? receipt.error.code
                : ('INVALID_REQUEST' as const),
              messageKey: receipt.error.messageKey,
              retryable: receipt.error.retryable,
            },
          }
        : {}),
    };
  }
  private creationResponse(head: SessionHead): CreateSessionResponse {
    return {
      sessionId: head.route.sessionId,
      startId: head.startId,
      status: head.status,
      route: copy(head.route),
      creationReceiptId: head.startId,
    };
  }
  private producer(head: SessionHead): string {
    return `game:${head.route.gameId}:session:${head.route.sessionId}`;
  }
  private outbox(
    head: SessionHead,
    kind: string,
    payload: JsonValue,
    index: number,
  ): OutboxRecord {
    return {
      outboxId: `${head.route.sessionId}:${head.revision}:${index}`,
      sessionId: head.route.sessionId,
      producerId: this.producer(head),
      kind,
      schemaVersion: 1,
      sourceRelease: head.route.releaseId,
      aggregateSequence: head.revision,
      payload: copy(payload),
      createdAt: head.logicalTime,
      attempts: 0,
    };
  }
}
