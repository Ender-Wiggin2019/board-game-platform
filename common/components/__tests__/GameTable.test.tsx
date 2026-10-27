import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameActionBar,
  GamePlayerSummary,
  GameTable,
  type PlatformPlayerSummary,
} from '../src/index.js';

afterEach(cleanup);

const players: readonly PlatformPlayerSummary[] = [
  {
    principalId: 'p1',
    seatId: 'seat-1',
    displayName: 'Ada Lovelace',
    connection: 'online',
    needsAttention: true,
  },
  {
    principalId: 'p2',
    seatId: 'seat-2',
    displayName: 'Grace Hopper',
    connection: 'away',
    needsAttention: false,
  },
];

describe('GameTable', () => {
  it('requires and renders player, board, and action slots with game-owned details', () => {
    const { container } = render(
      <GameTable
        players={players}
        board={<div>Board</div>}
        actions={<button type='button'>Confirm</button>}
        className='dinosaur-theme'
        labels={{
          players: '玩家',
          board: '棋盘',
          actions: '行动',
        }}
        playerLabels={{
          seatLabel: '位次',
          attention: '轮到你',
          presence: { online: '在线', away: '暂离' },
        }}
        renderPlayerDetails={(player) => <span>{player.seatId} resources</span>}
        renderPlayerAdornment={(player) => (
          <span>{player.principalId} badge</span>
        )}
      />,
    );

    expect(container.firstElementChild).toHaveProperty(
      'className',
      'bgp-game-table dinosaur-theme',
    );
    expect(screen.getByRole('region', { name: '玩家' })).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('位次 seat-1')).toBeTruthy();
    expect(screen.getByText('在线')).toBeTruthy();
    expect(screen.getByText('轮到你')).toBeTruthy();
    expect(screen.getByText('seat-1 resources')).toBeTruthy();
    expect(screen.getByText('p1 badge')).toBeTruthy();
    expect(screen.getByRole('region', { name: '棋盘' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '行动' })).toBeTruthy();
  });

  it('uses the PlatformPlayerSummary identity and resource slots directly', () => {
    render(
      <GamePlayerSummary
        player={players[1]}
        labels={{ seatLabel: 'Seat', presence: { away: 'Away' } }}
        avatar={<img alt='Grace avatar' src='/avatar.png' />}
        details={
          <>
            <span>Hand: 3</span>
            <span>Leaves: 2</span>
          </>
        }
        extra={<span>First player</span>}
      />,
    );

    expect(screen.getByAltText('Grace avatar')).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Seat seat-2')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
    expect(screen.getByText('Hand: 3')).toBeTruthy();
    expect(screen.getByText('Leaves: 2')).toBeTruthy();
    expect(screen.getByText('First player')).toBeTruthy();
  });

  it('hides internal seat ids and unknown presence without explicit labels', () => {
    render(
      <GamePlayerSummary
        player={{
          ...players[0],
          connection: 'unknown',
          seatId: 'internal-seat',
        }}
      />,
    );

    expect(screen.queryByText(/internal-seat/)).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});

describe('GameActionBar', () => {
  it('uses one GameSlot authorization boundary and prevents duplicate async actions', async () => {
    let resolveAction: (() => void) | undefined;
    const onAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(
      <GameActionBar
        actions={[
          {
            id: 'confirm',
            label: 'Confirm',
            kind: 'primary',
            selected: true,
            onAction,
          },
        ]}
        status={<span>Ready</span>}
      />,
    );

    const button = screen.getByRole('button', { name: 'Confirm' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledOnce();
    expect(button.hasAttribute('disabled')).toBe(true);
    resolveAction?.();
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  });

  it('shows a retryable error after a failed action', async () => {
    const onAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    render(
      <GameActionBar
        actions={[{ id: 'retry', label: 'Retry', onAction }]}
        errorMessage='请重试这次行动。'
      />,
    );

    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        '请重试这次行动。',
      ),
    );
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
  });

  it('does not mark disabled bars as busy and never exposes raw errors', async () => {
    const onAction = vi
      .fn()
      .mockRejectedValue(new Error('secret server detail'));
    const disabledView = render(
      <GameActionBar
        actions={[{ id: 'retry', label: 'Retry', onAction }]}
        disabled
        errorMessage='操作失败，请重试。'
      />,
    );

    const bar = document.querySelector('.bgp-game-action-bar');
    expect(bar?.getAttribute('data-state')).toBe('ready');
    expect(bar?.getAttribute('aria-busy')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).not.toHaveBeenCalled();
    disabledView.unmount();

    render(
      <GameActionBar
        actions={[{ id: 'retry', label: 'Retry', onAction }]}
        errorMessage='操作失败，请重试。'
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('操作失败，请重试。'),
    );
    expect(screen.queryByText('secret server detail')).toBeNull();
  });
});
