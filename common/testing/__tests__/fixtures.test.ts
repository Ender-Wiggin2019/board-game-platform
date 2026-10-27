import type { Actor, Viewer } from '@board-game/sdk';
import { describe, expect, it } from 'vitest';
import {
  cooperativeTeamFixture,
  createSoloProgressSolutionCommand,
  sequentialTurnFixture,
  simultaneousHiddenFixture,
  soloProgressPuzzleFixture,
} from '../src/fixtures/index.js';

const actors: readonly Actor[] = [
  { kind: 'player', principalId: 'alice', seatId: 'seat-a' },
  { kind: 'player', principalId: 'bob', seatId: 'seat-b' },
];

const alice: Viewer = {
  principalId: 'alice',
  seatId: 'seat-a',
  audience: 'player',
  epoch: 'epoch-1',
};
const bob: Viewer = {
  principalId: 'bob',
  seatId: 'seat-b',
  audience: 'player',
  epoch: 'epoch-1',
};

function context(actor: Actor, logicalTime = 1) {
  return { actor, logicalTime };
}

describe('platform fixtures', () => {
  it('keeps sequential turns deterministic and seat-authorized', () => {
    const initial = sequentialTurnFixture.rules.create(
      { target: 2 },
      {
        sessionId: 'fixture-session',
        modeId: 'fixture-mode',
        seed: 'fixed',
        participants: actors,
      },
    );
    const rejected = sequentialTurnFixture.rules.execute(
      initial,
      { type: 'claim' },
      context(actors[1]),
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_TURN' },
    });

    const first = sequentialTurnFixture.rules.execute(
      initial,
      { type: 'claim' },
      context(actors[0]),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = sequentialTurnFixture.rules.execute(
      first.state,
      { type: 'claim' },
      context(actors[1], 2),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const third = sequentialTurnFixture.rules.execute(
      second.state,
      { type: 'claim' },
      context(actors[0], 3),
    );
    expect(third).toMatchObject({
      ok: true,
      state: { finished: true, winnerSeatId: 'seat-a' },
    });
    if (!third.ok) return;

    const view = sequentialTurnFixture.rules.project(third.state, alice);
    expect(view.you).toMatchObject({
      seatId: 'seat-a',
      score: 2,
      canAct: false,
    });
    expect(
      sequentialTurnFixture.rules.decode(
        sequentialTurnFixture.rules.encode(third.state),
        1,
      ),
    ).toEqual(third.state);
  });

  it('keeps simultaneous choices private until every participant submits', () => {
    const initial = simultaneousHiddenFixture.rules.create(
      {},
      {
        sessionId: 'fixture-session',
        modeId: 'fixture-mode',
        seed: 'fixed',
        participants: actors,
      },
    );
    expect(
      simultaneousHiddenFixture.inputOpportunity?.(initial, actors[0]),
    ).toEqual({
      promptId: 'prompt-1',
      participantInputRevision: 0,
    });

    const first = simultaneousHiddenFixture.rules.execute(
      initial,
      {
        type: 'submit',
        promptId: 'prompt-1',
        participantInputRevision: 0,
        choice: 'red',
      },
      context(actors[0]),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      simultaneousHiddenFixture.rules.project(first.state, bob),
    ).toMatchObject({
      phase: 'collecting',
      yourChoice: null,
      revealedChoices: null,
    });
    expect(
      JSON.stringify(simultaneousHiddenFixture.rules.project(first.state, bob)),
    ).not.toContain('red');
    expect(
      simultaneousHiddenFixture.rules.projectEvent(first.events[0], bob),
    ).not.toHaveProperty('choice');
    expect(
      simultaneousHiddenFixture.rules.projectEvent(first.events[0], alice),
    ).toHaveProperty('choice', 'red');

    const stale = simultaneousHiddenFixture.rules.execute(
      first.state,
      {
        type: 'submit',
        promptId: 'prompt-1',
        participantInputRevision: 0,
        choice: 'blue',
      },
      context(actors[0]),
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'STALE_INPUT_REVISION' },
    });

    const second = simultaneousHiddenFixture.rules.execute(
      first.state,
      {
        type: 'submit',
        promptId: 'prompt-1',
        participantInputRevision: 0,
        choice: 'blue',
      },
      context(actors[1]),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.phase).toBe('revealed');
    expect(
      simultaneousHiddenFixture.rules.project(second.state, alice)
        .revealedChoices,
    ).toEqual({
      'seat-a': 'red',
      'seat-b': 'blue',
    });
    expect(
      simultaneousHiddenFixture.rules.projectEvent(second.events[1], bob),
    ).toMatchObject({
      type: 'choices-revealed',
    });
  });

  it('lets multiple actors advance one cooperative team without individual rating', () => {
    const mode = cooperativeTeamFixture.modes[0];
    expect(mode?.platformRating).toBe(false);
    const initial = cooperativeTeamFixture.rules.create(
      { target: 2 },
      {
        sessionId: 'fixture-session',
        modeId: 'fixture-mode',
        seed: 'fixed',
        participants: actors,
      },
    );
    const first = cooperativeTeamFixture.rules.execute(
      initial,
      { type: 'contribute' },
      context(actors[1]),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = cooperativeTeamFixture.rules.execute(
      first.state,
      { type: 'contribute' },
      context(actors[0], 2),
    );
    expect(second).toMatchObject({
      ok: true,
      state: { finished: true, teamScore: 2 },
    });
    if (!second.ok) return;
    expect(
      cooperativeTeamFixture.rules.project(second.state, alice).contributions,
    ).toEqual({ 'seat-a': 1, 'seat-b': 1 });
  });

  it('keeps the solo puzzle answer server-only while retaining progress', () => {
    const modes = soloProgressPuzzleFixture.modes;
    expect(modes.map((mode) => mode.history)).toEqual([
      'progress-only',
      'ephemeral-result',
    ]);
    const initial = soloProgressPuzzleFixture.rules.create(
      {},
      {
        sessionId: 'fixture-session',
        modeId: 'solo-progress',
        seed: 'fixed',
        participants: [actors[0]],
      },
    );
    const wrong = soloProgressPuzzleFixture.rules.execute(
      initial,
      { type: 'answer', answer: 'wrong' },
      context(actors[0]),
    );
    expect(wrong.ok).toBe(true);
    if (!wrong.ok) return;
    const solution = createSoloProgressSolutionCommand();
    const completed = soloProgressPuzzleFixture.rules.execute(
      wrong.state,
      solution,
      context(actors[0], 2),
    );
    expect(completed).toMatchObject({
      ok: true,
      state: { completed: true, progress: 1 },
    });
    const view = soloProgressPuzzleFixture.rules.project(
      completed.ok ? completed.state : wrong.state,
      alice,
    );
    expect(view).toMatchObject({ completed: true, progress: 1 });
    expect(JSON.stringify(view)).not.toContain(solution.answer);
    expect(
      JSON.stringify(
        soloProgressPuzzleFixture.summarize(
          completed.ok ? completed.state : wrong.state,
        ),
      ),
    ).not.toContain(solution.answer);
    expect(
      soloProgressPuzzleFixture.rules.decode(
        soloProgressPuzzleFixture.rules.encode(
          completed.ok ? completed.state : wrong.state,
        ),
        1,
      ),
    ).toEqual(completed.ok ? completed.state : wrong.state);
  });
});
