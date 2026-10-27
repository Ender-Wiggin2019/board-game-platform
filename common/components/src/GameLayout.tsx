import type { ReactNode } from 'react';
import { GameSlot } from './GameFrame.js';

export interface GameLayoutProps {
  readonly board: ReactNode;
  readonly players?: ReactNode;
  readonly actions?: ReactNode;
  readonly history?: ReactNode;
  readonly result?: ReactNode;
}

/**
 * An optional responsive board and sidebar layout. Import
 * `@board-game/components/layout.css` once in the game entry. The host owns
 * scrolling; oversized boards scroll inside their own region. GameSlot keeps
 * action and history authority on the existing session frame.
 */
export function GameLayout({
  board,
  players,
  actions,
  history,
  result,
}: GameLayoutProps): React.JSX.Element {
  const sidebar = players != null || actions != null || history != null;
  return (
    <div className='bgp-game-layout' data-sidebar={sidebar || undefined}>
      <div className='bgp-game-layout__board'>
        <GameSlot name='board'>{board}</GameSlot>
      </div>
      {sidebar && (
        <div className='bgp-game-layout__sidebar'>
          {players != null && <GameSlot name='players'>{players}</GameSlot>}
          {actions != null && <GameSlot name='actions'>{actions}</GameSlot>}
          {history != null && (
            <div className='bgp-game-layout__history'>
              <GameSlot name='history'>{history}</GameSlot>
            </div>
          )}
        </div>
      )}
      {result != null && (
        <div className='bgp-game-layout__result'>
          <GameSlot name='result'>{result}</GameSlot>
        </div>
      )}
    </div>
  );
}
