import type { Participant } from '@board-game/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSeatHandoff } from '../src/GameSeatHandoff.js';

const seats: readonly Participant[] = [
  {
    principalId: 'seat-principal-1',
    seatId: 'seat-1',
    controller: 'hotseat',
    controlledBy: 'account-1',
    publicProfile: { displayName: 'Ada' },
  },
  {
    principalId: 'seat-principal-2',
    seatId: 'seat-2',
    controller: 'hotseat',
    controlledBy: 'account-1',
    publicProfile: { displayName: 'Grace' },
  },
];

describe('GameSeatHandoff', () => {
  afterEach(cleanup);

  it('requires a seat and explicit reveal before rendering private content', () => {
    const onSelectSeat = vi.fn();
    const { rerender } = render(
      <GameSeatHandoff controlledSeats={seats} onSelectSeat={onSelectSeat}>
        <p>Private board</p>
      </GameSeatHandoff>,
    );

    expect(screen.queryByText('Private board')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'seat-2' },
    });
    expect(onSelectSeat).toHaveBeenCalledWith('seat-2');

    rerender(
      <GameSeatHandoff
        controlledSeats={seats}
        selectedSeatId='seat-2'
        onSelectSeat={onSelectSeat}
      >
        <p>Private board</p>
      </GameSeatHandoff>,
    );
    expect(screen.queryByText('Private board')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal seat' }));
    expect(screen.getByText('Private board')).toBeTruthy();
  });

  it('disables switching while the command outcome is unknown', () => {
    render(
      <GameSeatHandoff
        controlledSeats={seats}
        selectedSeatId='seat-1'
        submissionUnknown
      >
        <p>Private board</p>
      </GameSeatHandoff>,
    );
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  it('accepts translated labels and interpolates the selected seat name', () => {
    const { rerender } = render(
      <GameSeatHandoff
        controlledSeats={seats}
        selectedSeatId='seat-2'
        labels={{
          seat: '座位',
          chooseSeat: '选择座位',
          ready: (seatLabel) => `${seatLabel} 已准备就绪。`,
          revealSeat: '显示座位',
        }}
      >
        <p>Private board</p>
      </GameSeatHandoff>,
    );

    expect(screen.getByText('选择座位')).toBeTruthy();
    expect(screen.getByText('Grace 已准备就绪。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '显示座位' })).toBeTruthy();

    rerender(
      <GameSeatHandoff
        controlledSeats={seats}
        selectedSeatId='seat-2'
        labels={{ seat: '座位', selectSeat: '选择座位' }}
      >
        <p>Private board</p>
      </GameSeatHandoff>,
    );
    expect(screen.getByText('Choose a seat')).toBeTruthy();
  });
});
