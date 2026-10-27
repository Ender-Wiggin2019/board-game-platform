// @vitest-environment jsdom
import type { GameSessionControlsView } from '@board-game/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameAbandonControls,
  type GameSessionControlLabels,
  GameTimeoutControls,
} from '../src/GameSessionControls.js';

const labels: GameSessionControlLabels = {
  unnamedPlayer: 'Unnamed player',
  abandon: 'Propose abandon',
  confirmAbandon: 'Confirm abandon',
  abandonWarning: 'End without a score?',
  agree: 'Agree',
  withdraw: 'Withdraw',
  cancel: 'Cancel',
  waiting: 'Waiting for others',
  failure: 'Try again',
  agreements: (names) => `Agreed: ${names}`,
  remaining: (name, seconds) => `${name}: ${seconds}s`,
  expired: (name) => `${name} timed out`,
  requestTimeout: (name, mode) => `Request ${mode} for ${name}`,
  confirmTimeout: (name, mode) => `Confirm ${mode} for ${name}`,
  waitToConfirm: (seconds) => `Wait ${seconds}s`,
};
const view: GameSessionControlsView = {
  status: 'active',
  confirmationDelayMs: 20_000,
  serverNowMs: 1000,
  viewerId: 'a',
  availableModes: ['end-game', 'continue-game'],
  timeout: null,
  abandon: null,
  participants: [
    {
      principalId: 'a',
      displayName: 'Alice',
      controller: 'human',
      active: true,
    },
    { principalId: 'b', displayName: 'Bob', controller: 'human', active: true },
  ],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared session controls', () => {
  it('confirms an initial abandon intent and retains it after a failure', async () => {
    const onCommand = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    render(
      <GameAbandonControls view={view} labels={labels} onCommand={onCommand} />,
    );
    fireEvent.click(screen.getByText('Propose abandon'));
    expect(onCommand).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        (screen.getByText('Confirm abandon') as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText('Confirm abandon'));
    await screen.findByText('Try again');
    expect(screen.getByText('End without a score?')).toBeDefined();
    fireEvent.click(screen.getByText('Confirm abandon'));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(onCommand).toHaveBeenLastCalledWith({
      type: 'sessionControl',
      action: 'abandonAgree',
    });
  });

  it('does not offer agreement to a spectator, bot or removed player', () => {
    for (const next of [
      { ...view, viewerId: null },
      {
        ...view,
        participants: view.participants.map((p) => ({
          ...p,
          controller: 'bot' as const,
        })),
      },
      {
        ...view,
        participants: view.participants.map((p) => ({ ...p, active: false })),
      },
      { ...view, status: 'cancelled' as const },
    ]) {
      const result = render(
        <GameAbandonControls view={next} labels={labels} onCommand={vi.fn()} />,
      );
      expect(result.container.textContent).toBe('');
      result.unmount();
    }
  });

  it('uses the current window and mode to start a timeout confirmation', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const onCommand = vi.fn().mockResolvedValue(true);
    render(
      <GameTimeoutControls
        view={{
          ...view,
          timeout: {
            timeoutVote: null,
            activeWindows: [
              {
                id: 'turn-4',
                participantId: 'b',
                kind: null,
                generation: 4,
                startedAtMs: 0,
                dueAtMs: 90_000,
              },
            ],
          },
        }}
        labels={labels}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByText('Request continue-game for Bob'));
    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        type: 'sessionControl',
        action: 'timeoutRequest',
        windowId: 'turn-4',
        mode: 'continue-game',
      }),
    );
  });

  it('uses the localized fallback when a participant has no display name', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    render(
      <GameTimeoutControls
        view={{
          ...view,
          participants: view.participants.map((participant) =>
            participant.principalId === 'b'
              ? { ...participant, displayName: null }
              : participant,
          ),
          timeout: {
            timeoutVote: null,
            activeWindows: [
              {
                id: 'turn-4',
                participantId: 'b',
                kind: null,
                generation: 4,
                startedAtMs: 0,
                dueAtMs: 90_000,
              },
            ],
          },
        }}
        labels={labels}
        onCommand={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Request continue-game for Unnamed player'),
    ).toBeDefined();
  });

  it('keeps confirm disabled during the server-specified delay and never lets the target vote', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const timed: GameSessionControlsView = {
      ...view,
      timeout: {
        activeWindows: [
          {
            id: 'turn-4',
            participantId: 'b',
            kind: null,
            generation: 4,
            startedAtMs: 0,
            dueAtMs: 90_000,
          },
        ],
        timeoutVote: {
          windowId: 'turn-4',
          targetWindowGeneration: 4,
          timedOutParticipantId: 'b',
          triggeredByParticipantId: 'a',
          verifiedAtMs: 95_000,
          mode: 'continue-game',
          eligibleParticipantIds: ['a'],
          acceptedParticipantIds: [],
          confirmationStartedAtMsByParticipantId: { a: 95_000 },
          confirmationWindowGenerationByParticipantId: {},
        },
      },
    };
    const mounted = render(
      <GameTimeoutControls view={timed} labels={labels} onCommand={vi.fn()} />,
    );
    expect(
      (screen.getByText('Confirm continue-game for Bob') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText('Wait 15s')).toBeDefined();
    mounted.rerender(
      <GameTimeoutControls
        view={{ ...timed, viewerId: 'b' }}
        labels={labels}
        onCommand={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
