import { describe, expect, it } from 'vitest';
import {
  agreeToAbandonProposal,
  assertAbandonCanBeCancelled,
  cancelAbandonProposal,
  confirmTimeout,
  DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS,
  renewTimeoutWindow,
  type TimeoutState,
  type TimeoutWindow,
  verifyTimeout,
} from '../src/session-controls.js';

const participants = [
  { principalId: 'p1', active: true as const },
  { principalId: 'p2', active: true as const },
  { principalId: 'p3', active: true as const },
  { principalId: 'bot', controller: 'bot' as const, active: true as const },
  { principalId: 'removed', active: false as const },
];

function window(
  id: string,
  participantId: string,
  dueAtMs = 100,
  generation = 0,
): TimeoutWindow {
  return {
    id,
    participantId,
    startedAtMs: 0,
    dueAtMs,
    generation,
    kind: 'turn',
  };
}

function state(activeWindows: readonly TimeoutWindow[]): TimeoutState {
  return { activeWindows };
}

describe('session abandon controls', () => {
  it('freezes eligible human participants and ignores later roster changes', () => {
    const first = agreeToAbandonProposal({
      actorId: 'p1',
      participants,
      excludedParticipantIds: ['p3'],
      nowMs: 1_000,
    });

    expect(first).toEqual({
      proposal: {
        eligibleParticipantIds: ['p1', 'p2'],
        excludedParticipantIds: ['p3', 'bot', 'removed'],
        agreedParticipantIds: ['p1'],
        createdAtMs: 1_000,
      },
      unanimous: false,
    });

    const second = agreeToAbandonProposal({
      existing: first.proposal,
      actorId: 'p2',
      participants: [{ principalId: 'different', active: true }],
      nowMs: 2_000,
    });

    expect(second.proposal.eligibleParticipantIds).toEqual(['p1', 'p2']);
    expect(second.proposal.agreedParticipantIds).toEqual(['p1', 'p2']);
    expect(second.unanimous).toBe(true);
  });

  it('rejects cancellation after unanimous agreement', () => {
    const result = agreeToAbandonProposal({
      actorId: 'p1',
      participants: [
        { principalId: 'p1', active: true },
        { principalId: 'p2', active: true },
      ],
      nowMs: 1_000,
    });
    const unanimous = agreeToAbandonProposal({
      existing: result.proposal,
      actorId: 'p2',
      participants: [],
      nowMs: 1_001,
    });

    expect(() => cancelAbandonProposal(unanimous.proposal, 'p1')).toThrow(
      /no longer be cancelled/i,
    );
    expect(() => assertAbandonCanBeCancelled(unanimous.proposal)).toThrow(
      /no longer be cancelled/i,
    );
  });
});

describe('session timeout controls', () => {
  it('requires expiry and the confirmation delay before end-game resolution', () => {
    const initial = state([window('w1', 'p1'), window('w2', 'p2')]);
    expect(() =>
      verifyTimeout({
        state: initial,
        actorId: 'p2',
        windowId: 'w1',
        mode: 'end-game',
        nowMs: 100,
        participants,
      }),
    ).toThrow(/not expired/i);

    const verified = verifyTimeout({
      state: initial,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'end-game',
      nowMs: 101,
      participants,
    });
    expect(verified.state.timeoutVote).toMatchObject({
      windowId: 'w1',
      targetWindowGeneration: 0,
      eligibleParticipantIds: ['p2', 'p3'],
      confirmationStartedAtMsByParticipantId: { p2: 101 },
    });

    expect(() =>
      confirmTimeout({
        state: verified.state,
        actorId: 'p2',
        windowId: 'w1',
        mode: 'end-game',
        nowMs: 101 + DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS - 1,
        participants,
      }),
    ).toThrow(/not available yet/i);

    const resolved = confirmTimeout({
      state: verified.state,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'end-game',
      nowMs: 101 + DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS,
      participants,
    });
    expect(resolved).toMatchObject({
      status: 'resolved',
      timedOutParticipantId: 'p1',
      mode: 'end-game',
    });
    expect(resolved.state.timeoutVote).toBeUndefined();
  });

  it('rechecks the current human eligibility of an end-game voter', () => {
    const initial = state([window('w1', 'p1'), window('w2', 'p2')]);
    const verified = verifyTimeout({
      state: initial,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'end-game',
      nowMs: 101,
      participants,
    });

    expect(() =>
      confirmTimeout({
        state: verified.state,
        actorId: 'p2',
        windowId: 'w1',
        mode: 'end-game',
        nowMs: 101 + DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS,
        participants: participants.map((participant) =>
          participant.principalId === 'p2'
            ? { ...participant, active: false }
            : participant,
        ),
      }),
    ).toThrow(/no longer eligible/i);
  });

  it('requires every eligible participant in continue-game mode', () => {
    const initial = state([window('w1', 'p1')]);
    const verified = verifyTimeout({
      state: initial,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'continue-game',
      nowMs: 101,
      participants,
    });
    const secondVerification = verifyTimeout({
      state: verified.state,
      actorId: 'p3',
      windowId: 'w1',
      mode: 'continue-game',
      nowMs: 102,
      participants,
    });
    const firstConfirmation = confirmTimeout({
      state: secondVerification.state,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'continue-game',
      nowMs: 101 + DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS,
      participants,
    });
    expect(firstConfirmation.status).toBe('pending');
    expect(firstConfirmation.state.timeoutVote?.acceptedParticipantIds).toEqual(
      ['p2'],
    );

    const resolved = confirmTimeout({
      state: firstConfirmation.state,
      actorId: 'p3',
      windowId: 'w1',
      mode: 'continue-game',
      nowMs: 102 + DEFAULT_TIMEOUT_CONFIRMATION_DELAY_MS,
      participants,
    });
    expect(resolved.status).toBe('resolved');
  });

  it('clears a vote when the target renews and forces a voter to reconfirm', () => {
    const initial = state([window('w1', 'p1')]);
    const verified = verifyTimeout({
      state: initial,
      actorId: 'p2',
      windowId: 'w1',
      mode: 'continue-game',
      nowMs: 101,
      participants,
    });
    const renewedVoter = renewTimeoutWindow(verified.state, {
      id: 'w2',
      participantId: 'p2',
      startedAtMs: 102,
      dueAtMs: 300,
      kind: 'input',
    });
    expect(renewedVoter.timeoutVote?.acceptedParticipantIds).toEqual([]);
    expect(
      renewedVoter.timeoutVote?.confirmationStartedAtMsByParticipantId,
    ).toEqual({});

    const renewedTarget = renewTimeoutWindow(renewedVoter, {
      id: 'w1-next',
      participantId: 'p1',
      startedAtMs: 103,
      dueAtMs: 400,
      kind: 'turn',
    });
    expect(renewedTarget.timeoutVote).toBeUndefined();
  });

  it('uses current continue-game eligibility and rejects the timed-out actor', () => {
    const initial = state([window('w1', 'p1'), window('w2', 'p2', 100)]);
    expect(() =>
      verifyTimeout({
        state: initial,
        actorId: 'p1',
        windowId: 'w1',
        mode: 'continue-game',
        nowMs: 101,
        participants,
      }),
    ).toThrow(/not eligible/i);
  });
});
