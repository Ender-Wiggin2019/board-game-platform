import type { ReactNode } from 'react';
import { GameSlot, type PlatformPlayerSummary } from './GameFrame.js';
import {
  GamePlayerSummary,
  type GamePlayerSummaryLabels,
} from './GamePlayerSummary.js';

type PlayerSlot =
  | ReactNode
  | ((player: PlatformPlayerSummary, index: number) => ReactNode);

export interface GameTableProps {
  readonly players: readonly PlatformPlayerSummary[];
  readonly board: ReactNode;
  readonly actions: ReactNode;
  readonly className?: string;
  readonly labels?: GameTableLabels;
  readonly playerLabels?: GamePlayerSummaryLabels;
  readonly renderPlayerDetails?: (
    player: PlatformPlayerSummary,
    index: number,
  ) => ReactNode;
  readonly renderPlayerAdornment?: PlayerSlot;
}

export interface GameTableLabels {
  readonly players?: string;
  readonly board?: string;
  readonly actions?: string;
}

function renderPlayerSlot(
  slot: PlayerSlot | undefined,
  player: PlatformPlayerSummary,
  index: number,
): ReactNode {
  return typeof slot === 'function' ? slot(player, index) : slot;
}

/**
 * Standard game surface. Session state remains in GameFrame; this component
 * only arranges the required player, board, and action slots.
 */
export function GameTable({
  players,
  board,
  actions,
  className,
  labels,
  playerLabels,
  renderPlayerDetails,
  renderPlayerAdornment,
}: GameTableProps): React.JSX.Element {
  return (
    <div
      className={className ? `bgp-game-table ${className}` : 'bgp-game-table'}
    >
      <section
        className='bgp-game-table__players'
        aria-label={labels?.players ?? 'Players'}
      >
        <GameSlot name='players'>
          <div className='bgp-game-table__player-list'>
            {players.map((player, index) => (
              <GamePlayerSummary
                key={player.principalId}
                player={player}
                labels={playerLabels}
                details={renderPlayerDetails?.(player, index)}
                extra={renderPlayerSlot(renderPlayerAdornment, player, index)}
              />
            ))}
          </div>
        </GameSlot>
      </section>
      <section
        className='bgp-game-table__board'
        aria-label={labels?.board ?? 'Game board'}
      >
        <GameSlot name='board'>{board}</GameSlot>
      </section>
      <section
        className='bgp-game-table__actions'
        aria-label={labels?.actions ?? 'Game actions'}
      >
        {actions}
      </section>
    </div>
  );
}
