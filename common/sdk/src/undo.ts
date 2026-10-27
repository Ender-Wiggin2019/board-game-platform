/**
 * A small mechanism for rule-owned undo checkpoints.
 *
 * The SDK deliberately does not infer ownership, turn boundaries, or hidden
 * information. Games provide those predicates so an undo remains an
 * ordinary rule transition rather than a Host head rewind.
 */
export type UndoUnavailableReason =
  | 'disabled'
  | 'missing-checkpoint'
  | 'not-owner'
  | 'ineligible'
  | 'hidden-information';

export interface UndoCheckpoint<Snapshot, Context> {
  readonly snapshot: Snapshot;
  readonly context: Context;
}

export interface UndoStatus {
  readonly available: boolean;
  readonly reason?: UndoUnavailableReason;
}

export interface UndoPolicyDefinition<State, Snapshot, Context> {
  /** Defaults to true. Dynamic game options can use isEnabled instead. */
  readonly enabled?: boolean;
  readonly isEnabled?: (context: Context) => boolean;
  /** Must omit any checkpoint field from the returned snapshot. */
  readonly snapshot: (state: Readonly<State>) => Snapshot;
  readonly restore: (snapshot: Readonly<Snapshot>) => State;
  readonly isOwner: (
    checkpoint: UndoCheckpoint<Snapshot, Context>,
    context: Context,
  ) => boolean;
  readonly isEligible: (
    checkpoint: UndoCheckpoint<Snapshot, Context>,
    context: Context,
  ) => boolean;
  /** True when the checkpoint crossed a game-owned information boundary. */
  readonly hasHiddenInformationBarrier: (
    checkpoint: UndoCheckpoint<Snapshot, Context>,
    context: Context,
  ) => boolean;
}

export interface UndoPolicy<State, Snapshot, Context>
  extends Required<
    Pick<
      UndoPolicyDefinition<State, Snapshot, Context>,
      | 'snapshot'
      | 'restore'
      | 'isOwner'
      | 'isEligible'
      | 'hasHiddenInformationBarrier'
    >
  > {
  readonly enabled: boolean;
  readonly isEnabled: (context: Context) => boolean;
}

export function createUndoPolicy<State, Snapshot, Context>(
  definition: UndoPolicyDefinition<State, Snapshot, Context>,
): UndoPolicy<State, Snapshot, Context> {
  if (!definition || typeof definition !== 'object')
    throw new TypeError('UNDO_POLICY_REQUIRED');
  for (const key of [
    'snapshot',
    'restore',
    'isOwner',
    'isEligible',
    'hasHiddenInformationBarrier',
  ] as const) {
    if (typeof definition[key] !== 'function')
      throw new TypeError(`UNDO_POLICY_${key.toUpperCase()}_REQUIRED`);
  }
  if (
    definition.enabled !== undefined &&
    typeof definition.enabled !== 'boolean'
  )
    throw new TypeError('UNDO_POLICY_ENABLED_INVALID');
  if (
    definition.isEnabled !== undefined &&
    typeof definition.isEnabled !== 'function'
  )
    throw new TypeError('UNDO_POLICY_IS_ENABLED_REQUIRED');
  return Object.freeze({
    enabled: definition.enabled ?? true,
    isEnabled: definition.isEnabled ?? (() => true),
    snapshot: definition.snapshot,
    restore: definition.restore,
    isOwner: definition.isOwner,
    isEligible: definition.isEligible,
    hasHiddenInformationBarrier: definition.hasHiddenInformationBarrier,
  });
}

export function createUndoCheckpoint<State, Snapshot, Context>(
  policy: UndoPolicy<State, Snapshot, Context>,
  state: Readonly<State>,
  context: Context,
): UndoCheckpoint<Snapshot, Context> | null {
  if (!policy.enabled || !policy.isEnabled(context)) return null;
  return Object.freeze({
    snapshot: policy.snapshot(state),
    context,
  });
}

export function getUndoStatus<State, Snapshot, Context>(
  policy: UndoPolicy<State, Snapshot, Context>,
  checkpoint: UndoCheckpoint<Snapshot, Context> | null | undefined,
  context: Context,
): UndoStatus {
  if (!policy.enabled || !policy.isEnabled(context))
    return { available: false, reason: 'disabled' };
  if (!checkpoint) return { available: false, reason: 'missing-checkpoint' };
  if (!policy.isOwner(checkpoint, context))
    return { available: false, reason: 'not-owner' };
  if (!policy.isEligible(checkpoint, context))
    return { available: false, reason: 'ineligible' };
  if (policy.hasHiddenInformationBarrier(checkpoint, context))
    return { available: false, reason: 'hidden-information' };
  return { available: true };
}

export function restoreUndo<State, Snapshot, Context>(
  policy: UndoPolicy<State, Snapshot, Context>,
  checkpoint: UndoCheckpoint<Snapshot, Context> | null | undefined,
  context: Context,
): State | null {
  if (!getUndoStatus(policy, checkpoint, context).available || !checkpoint)
    return null;
  return policy.restore(checkpoint.snapshot);
}
