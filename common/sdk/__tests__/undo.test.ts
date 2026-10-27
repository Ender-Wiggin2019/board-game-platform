import { describe, expect, it } from 'vitest';
import {
  createUndoCheckpoint,
  createUndoPolicy,
  getUndoStatus,
  restoreUndo,
} from '../src/undo.js';

type State = { readonly value: number };
type Context = { readonly owner: string; readonly barrier: boolean };

function policy() {
  return createUndoPolicy<State, State, Context>({
    snapshot: (state) => ({ ...state }),
    restore: (snapshot) => ({ ...snapshot }),
    isOwner: (checkpoint, context) =>
      checkpoint.context.owner === context.owner,
    isEligible: () => true,
    hasHiddenInformationBarrier: (_checkpoint, context) => context.barrier,
  });
}

describe('undo policy', () => {
  it('creates and restores a game-owned checkpoint', () => {
    const undo = policy();
    const checkpoint = createUndoCheckpoint(
      undo,
      { value: 3 },
      { owner: 'p1', barrier: false },
    );

    expect(
      getUndoStatus(undo, checkpoint, { owner: 'p1', barrier: false }),
    ).toEqual({
      available: true,
    });
    expect(
      restoreUndo(undo, checkpoint, { owner: 'p1', barrier: false }),
    ).toEqual({ value: 3 });
  });

  it('leaves ownership and information rules to the policy', () => {
    const undo = policy();
    const checkpoint = createUndoCheckpoint(
      undo,
      { value: 3 },
      { owner: 'p1', barrier: false },
    );

    expect(
      getUndoStatus(undo, checkpoint, { owner: 'p2', barrier: false }),
    ).toEqual({
      available: false,
      reason: 'not-owner',
    });
    expect(
      getUndoStatus(undo, checkpoint, { owner: 'p1', barrier: true }),
    ).toEqual({
      available: false,
      reason: 'hidden-information',
    });
    expect(
      restoreUndo(undo, checkpoint, { owner: 'p2', barrier: false }),
    ).toBeNull();
  });

  it('supports a disabled dynamic policy and does not require a checkpoint', () => {
    const undo = createUndoPolicy<State, State, Context>({
      isEnabled: (context) => context.owner !== 'disabled',
      snapshot: (state) => ({ ...state }),
      restore: (snapshot) => ({ ...snapshot }),
      isOwner: () => true,
      isEligible: () => true,
      hasHiddenInformationBarrier: () => false,
    });

    expect(
      getUndoStatus(undo, null, { owner: 'disabled', barrier: false }),
    ).toEqual({ available: false, reason: 'disabled' });
    expect(
      createUndoCheckpoint(
        undo,
        { value: 1 },
        { owner: 'disabled', barrier: false },
      ),
    ).toBeNull();
  });
});
