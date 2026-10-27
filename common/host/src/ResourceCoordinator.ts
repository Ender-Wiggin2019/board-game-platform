import { createHash } from 'node:crypto';
import {
  assertSessionRoute,
  canonicalStableStringify,
  contractError,
  type SessionRoute,
} from '@board-game/contracts';
import type {
  CommandReceipt,
  SessionHead,
  StorageDriver,
  StorageTransaction,
} from '@board-game/storage';

export interface ResourceRequirement {
  readonly namespace: string;
  readonly asset: string;
  readonly quantity: number;
}

export interface ResourceReservationIntent {
  readonly route: SessionRoute;
  readonly commandDigest: string;
  readonly requirementsDigest: string;
}

export interface ResourceReservationRequest extends ResourceRequirement {
  readonly sessionId: string;
  readonly commandId: string;
  readonly principalId: string;
  readonly intent: ResourceReservationIntent;
  readonly reservationId?: string;
  readonly createdAt?: number;
}

export type ResourceReservationStatus = 'reserved' | 'confirmed' | 'released';

export interface ResourceReservation {
  readonly reservationId: string;
  readonly namespace: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly principalId: string;
  readonly asset: string;
  readonly quantity: number;
  readonly intent: ResourceReservationIntent;
  readonly intentDigest: string;
  readonly status: ResourceReservationStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ResourceReservationReference {
  readonly reservationId: string;
  readonly namespace?: string;
  readonly sessionId?: string;
  readonly commandId?: string;
  readonly principalId?: string;
  readonly asset?: string;
  readonly quantity?: number;
  readonly intentDigest?: string;
}

export type ResourceReservationInput = string | ResourceReservationReference;

export interface ResourcePendingOptions {
  readonly limit: number;
  readonly namespace?: string;
  readonly principalId?: string;
  readonly asset?: string;
  /** Route filters are pushed into the store before applying the bounded page. */
  readonly gameId?: string;
  readonly backendBindingId?: string;
  readonly storageBindingId?: string;
}

/** Structural store contract keeps Host independent from core's ledger package. */
export interface ResourceStore {
  reserve(request: ResourceReservationRequest): Promise<ResourceReservation>;
  getReservation(reservationId: string): Promise<ResourceReservation | null>;
  /** Optional scan used when a duplicate is terminal and state is pruned. */
  getReservationsForCommand?(
    sessionId: string,
    commandId: string,
  ): Promise<readonly ResourceReservation[]>;
  confirm(reference: ResourceReservationInput): Promise<ResourceReservation>;
  release(reference: ResourceReservationInput): Promise<ResourceReservation>;
  listPending(
    options: ResourcePendingOptions,
  ): Promise<readonly ResourceReservation[]>;
}

export interface ResourceCoordinatorOptions {
  readonly store: ResourceStore;
  readonly storage: StorageDriver;
  /** Reconciliation never releases a reservation younger than this grace period. */
  readonly graceMs?: number;
  readonly now?: () => number;
  /** Optional route scope for shared stores; Host always supplies its bindings. */
  readonly gameId?: string;
  readonly backendBindingId?: string;
  readonly storageBindingId?: string;
}

export interface ResourcePreparation {
  readonly reservation: ResourceReservation;
  readonly requirement: ResourceRequirement;
}

export interface ResourcePreparationInput {
  readonly route: SessionRoute;
  readonly commandId: string;
  readonly principalId: string;
  readonly commandDigest: string;
  readonly requirement?: ResourceRequirement;
  /** Duplicate receipt replay may inspect a terminal reservation idempotently. */
  readonly allowTerminal?: boolean;
}

export type ResourceFinalizationOutcome = 'accepted' | 'rejected' | 'unknown';
export type ResourceFinalizationStatus = 'confirmed' | 'released' | 'pending';

export interface ResourceFinalization {
  readonly status: ResourceFinalizationStatus;
  readonly error?: unknown;
}

export interface ResourceReconciliationResult {
  readonly reservationId: string;
  readonly status: 'confirmed' | 'released' | 'deferred' | 'conflict';
}

export class ResourceCoordinatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly definitive: boolean;

  constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly definitive?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ResourceCoordinatorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.definitive = options.definitive ?? false;
  }
}

export function resourceDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalStableStringify(value))
    .digest('hex');
}

export function requirementsDigest(requirement: ResourceRequirement): string {
  return resourceDigest({
    namespace: requirement.namespace,
    asset: requirement.asset,
    quantity: requirement.quantity,
  });
}

export function resourceReservationId(
  namespace: string,
  sessionId: string,
  commandId: string,
): string {
  return `reservation_${resourceDigest({ namespace, sessionId, commandId })}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRequirement(requirement: ResourceRequirement): void {
  if (!requirement || typeof requirement !== 'object')
    throw contractError('INVALID_REQUEST', 'host.resource.invalid');
  if (
    typeof requirement.namespace !== 'string' ||
    requirement.namespace.trim().length === 0 ||
    typeof requirement.asset !== 'string' ||
    requirement.asset.trim().length === 0 ||
    !Number.isSafeInteger(requirement.quantity) ||
    requirement.quantity < 1
  )
    throw contractError('INVALID_REQUEST', 'host.resource.invalid');
}

function assertRoute(route: SessionRoute, sessionId: string): void {
  assertSessionRoute(route);
  if (route.sessionId !== sessionId)
    throw contractError('OWNERSHIP_LOST', 'host.binding.mismatch');
}

function errorCode(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : 'DATABASE_ERROR';
}

function errorRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable === true;
}

function intentDigest(intent: ResourceReservationIntent): string {
  return resourceDigest({
    route: intent.route,
    commandDigest: intent.commandDigest,
    requirementsDigest: intent.requirementsDigest,
  });
}

function assertReservationMatches(
  reservation: ResourceReservation,
  input: ResourcePreparationInput,
  requirement?: ResourceRequirement,
): void {
  assertRoute(input.route, input.route.sessionId);
  if (
    reservation.sessionId !== input.route.sessionId ||
    reservation.commandId !== input.commandId ||
    reservation.principalId !== input.principalId ||
    reservation.intent.commandDigest !== input.commandDigest ||
    intentDigest(reservation.intent) !== reservation.intentDigest ||
    resourceDigest(reservation.intent.route) !== resourceDigest(input.route)
  )
    throw new ResourceCoordinatorError(
      'IDEMPOTENCY_CONFLICT',
      'resource reservation does not match the command intent',
    );
  if (requirement) {
    assertRequirement(requirement);
    if (
      reservation.namespace !== requirement.namespace ||
      reservation.asset !== requirement.asset ||
      reservation.quantity !== requirement.quantity ||
      reservation.intent.requirementsDigest !== requirementsDigest(requirement)
    )
      throw new ResourceCoordinatorError(
        'IDEMPOTENCY_CONFLICT',
        'resource reservation does not match the recomputed requirement',
      );
  }
}

function sameRequirement(
  left: ResourceRequirement,
  right: ResourceRequirement | undefined,
): boolean {
  return (
    right !== undefined &&
    left.namespace === right.namespace &&
    left.asset === right.asset &&
    left.quantity === right.quantity
  );
}

function toCoordinatorError(error: unknown): ResourceCoordinatorError {
  const code = errorCode(error);
  return new ResourceCoordinatorError(code, 'resource reservation failed', {
    retryable: errorRetryable(error),
    definitive: code === 'INSUFFICIENT_BALANCE',
  });
}

function outcomeForReceipt(
  receipt: CommandReceipt,
): ResourceFinalizationOutcome | 'defer' {
  if (receipt.status === 'accepted') return 'accepted';
  if (receipt.status === 'rejected' || receipt.status === 'tombstone')
    return 'rejected';
  return 'defer';
}

/**
 * Coordinates the external consumable ledger around the session head commit.
 * No ledger call is made while a StorageDriver transaction is open.
 */
export class ResourceCoordinator {
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(private readonly options: ResourceCoordinatorOptions) {
    if (!options || typeof options !== 'object')
      throw new Error('Resource coordinator options are required');
    if (!options.store || !options.storage)
      throw new Error('Resource coordinator store and storage are required');
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? 30_000;
    if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 0)
      throw new Error(
        'Resource coordinator graceMs must be a non-negative integer',
      );
  }

  async prepare(
    input: ResourcePreparationInput,
  ): Promise<ResourcePreparation | null> {
    assertRoute(input.route, input.route.sessionId);
    if (input.requirement) assertRequirement(input.requirement);
    const existingRows = this.options.store.getReservationsForCommand
      ? await this.options.store.getReservationsForCommand(
          input.route.sessionId,
          input.commandId,
        )
      : input.requirement
        ? await this.options.store
            .getReservation(
              resourceReservationId(
                input.requirement.namespace,
                input.route.sessionId,
                input.commandId,
              ),
            )
            .then((value) => (value ? [value] : []))
        : [];
    if (existingRows.length > 1)
      throw new ResourceCoordinatorError(
        'IDEMPOTENCY_CONFLICT',
        'command has multiple resource reservations',
      );
    const existing = existingRows[0];
    // A duplicate receipt may be replayed after the original reservation was
    // created. Without knowing the old requirement, find it by command below.
    if (existing) {
      if (!input.allowTerminal && !input.requirement)
        throw new ResourceCoordinatorError(
          'IDEMPOTENCY_CONFLICT',
          'an existing reservation requires an authoritative requirement',
        );
      assertReservationMatches(existing, input, input.requirement);
      if (existing.status !== 'reserved' && !input.allowTerminal)
        throw new ResourceCoordinatorError(
          'IDEMPOTENCY_CONFLICT',
          `resource reservation is already ${existing.status}`,
        );
      return {
        reservation: clone(existing),
        requirement: {
          namespace: existing.namespace,
          asset: existing.asset,
          quantity: existing.quantity,
        },
      };
    }
    if (!input.requirement) return null;
    const requirement = input.requirement;
    const request: ResourceReservationRequest = {
      ...requirement,
      sessionId: input.route.sessionId,
      commandId: input.commandId,
      principalId: input.principalId,
      intent: {
        route: clone(input.route),
        commandDigest: input.commandDigest,
        requirementsDigest: requirementsDigest(requirement),
      },
      reservationId: resourceReservationId(
        requirement.namespace,
        input.route.sessionId,
        input.commandId,
      ),
    };
    try {
      const reservation = await this.options.store.reserve(request);
      assertReservationMatches(reservation, input, requirement);
      if (reservation.status !== 'reserved')
        throw new ResourceCoordinatorError(
          'IDEMPOTENCY_CONFLICT',
          `resource reservation is already ${reservation.status}`,
        );
      return {
        reservation: clone(reservation),
        requirement: clone(requirement),
      };
    } catch (error) {
      if (error instanceof ResourceCoordinatorError) throw error;
      throw toCoordinatorError(error);
    }
  }

  async finalize(
    preparation: ResourcePreparation,
    outcome: ResourceFinalizationOutcome,
  ): Promise<ResourceFinalization> {
    if (outcome === 'unknown') return { status: 'pending' };
    try {
      const result =
        outcome === 'accepted'
          ? await this.options.store.confirm({
              reservationId: preparation.reservation.reservationId,
              principalId: preparation.reservation.principalId,
              sessionId: preparation.reservation.sessionId,
              commandId: preparation.reservation.commandId,
              intentDigest: preparation.reservation.intentDigest,
            })
          : await this.options.store.release({
              reservationId: preparation.reservation.reservationId,
              principalId: preparation.reservation.principalId,
              sessionId: preparation.reservation.sessionId,
              commandId: preparation.reservation.commandId,
              intentDigest: preparation.reservation.intentDigest,
            });
      return {
        status: result.status === 'confirmed' ? 'confirmed' : 'released',
      };
    } catch (error) {
      // The head receipt is authoritative. A failed post-commit transition is
      // recoverable through listPending and must never rewrite an accepted head.
      return { status: 'pending', error };
    }
  }

  assertCurrent(
    preparation: ResourcePreparation,
    input: ResourcePreparationInput,
  ): void {
    if (!sameRequirement(preparation.requirement, input.requirement))
      throw new ResourceCoordinatorError(
        'IDEMPOTENCY_CONFLICT',
        'resource requirement changed before the head commit',
      );
    assertReservationMatches(preparation.reservation, input, input.requirement);
  }

  async reconcilePending(
    limit = 100,
  ): Promise<readonly ResourceReconciliationResult[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw contractError('INVALID_REQUEST', 'host.resource.limit');
    const pending = await this.options.store.listPending({
      limit,
      ...(this.options.gameId !== undefined
        ? { gameId: this.options.gameId }
        : {}),
      ...(this.options.backendBindingId !== undefined
        ? { backendBindingId: this.options.backendBindingId }
        : {}),
      ...(this.options.storageBindingId !== undefined
        ? { storageBindingId: this.options.storageBindingId }
        : {}),
    });
    const results: ResourceReconciliationResult[] = [];
    for (const reservation of pending) {
      const route = reservation.intent.route;
      if (
        (this.options.gameId !== undefined &&
          route.gameId !== this.options.gameId) ||
        (this.options.backendBindingId !== undefined &&
          route.backendBindingId !== this.options.backendBindingId) ||
        (this.options.storageBindingId !== undefined &&
          route.storageBindingId !== this.options.storageBindingId)
      ) {
        results.push({
          reservationId: reservation.reservationId,
          status: 'conflict',
        });
        continue;
      }
      if (this.now() - reservation.createdAt < this.graceMs) {
        results.push({
          reservationId: reservation.reservationId,
          status: 'deferred',
        });
        continue;
      }
      const current = await this.options.storage.getHead(reservation.sessionId);
      if (!current) {
        results.push({
          reservationId: reservation.reservationId,
          status: 'deferred',
        });
        continue;
      }
      if (
        canonicalStableStringify(current.route) !==
        canonicalStableStringify(reservation.intent.route)
      ) {
        results.push({
          reservationId: reservation.reservationId,
          status: 'conflict',
        });
        continue;
      }
      try {
        const outcome = await this.options.storage.transaction(
          reservation.sessionId,
          { ownershipEpoch: reservation.intent.route.ownershipEpoch },
          async (tx) => {
            const fresh = await tx.getHead();
            if (
              canonicalStableStringify(fresh.route) !==
              canonicalStableStringify(reservation.intent.route)
            )
              throw new ResourceCoordinatorError(
                'OWNERSHIP_LOST',
                'resource reservation route is no longer authoritative',
                { retryable: true },
              );
            return this.reconcileInHead(tx, fresh, reservation);
          },
        );
        if (outcome === 'defer') {
          results.push({
            reservationId: reservation.reservationId,
            status: 'deferred',
          });
          continue;
        }
        const finalization = await this.finalize(
          {
            reservation,
            requirement: {
              namespace: reservation.namespace,
              asset: reservation.asset,
              quantity: reservation.quantity,
            },
          },
          outcome,
        );
        results.push({
          reservationId: reservation.reservationId,
          status:
            finalization.status === 'confirmed'
              ? 'confirmed'
              : finalization.status === 'released'
                ? 'released'
                : 'deferred',
        });
      } catch (error) {
        // Ownership changes and transient storage failures leave the pending
        // reservation for the current owner/retry loop; never release here.
        results.push({
          reservationId: reservation.reservationId,
          status:
            errorCode(error) === 'IDEMPOTENCY_CONFLICT' ||
            errorCode(error) === 'OWNERSHIP_LOST'
              ? 'conflict'
              : 'deferred',
        });
      }
    }
    return results;
  }

  private async reconcileInHead(
    tx: StorageTransaction,
    head: SessionHead,
    reservation: ResourceReservation,
  ): Promise<ResourceFinalizationOutcome | 'defer'> {
    const receipt = await tx.getReceipt(reservation.commandId);
    if (receipt) {
      if (
        receipt.actorPrincipalId !== reservation.principalId ||
        receipt.inputHash !== reservation.intent.commandDigest
      )
        throw new ResourceCoordinatorError(
          'IDEMPOTENCY_CONFLICT',
          'receipt does not match the resource reservation intent',
        );
      return outcomeForReceipt(receipt);
    }
    const logicalTime = Math.max(this.now(), head.logicalTime);
    const rejected: CommandReceipt = {
      sessionId: head.route.sessionId,
      commandId: reservation.commandId,
      actorPrincipalId: reservation.principalId,
      inputHash: reservation.intent.commandDigest,
      status: 'rejected',
      resultRetention: 'replayable',
      persistedRevision: head.revision,
      persistedAt: logicalTime,
      error: {
        code: 'STALE_OPERATION',
        messageKey: 'host.resource.stale',
        retryable: false,
      },
    };
    await tx.putReceipt(rejected);
    return 'rejected';
  }
}
