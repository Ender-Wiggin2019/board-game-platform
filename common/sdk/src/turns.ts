import {
  assertTurnState,
  type TurnInputOpportunity,
  type TurnState,
} from '@board-game/contracts';

export function sequentialTurn(id: string, seatId: string | null): TurnState {
  const turn: TurnState = {
    id,
    mode: 'sequential',
    activeSeatIds: seatId === null ? [] : [seatId],
  };
  assertTurnState(turn);
  return turn;
}

export function simultaneousTurn(
  id: string,
  opportunities: Readonly<Record<string, TurnInputOpportunity>>,
): TurnState {
  const turn: TurnState = {
    id,
    mode: 'simultaneous',
    activeSeatIds: Object.keys(opportunities),
    inputOpportunities: structuredClone(opportunities),
  };
  assertTurnState(turn);
  return turn;
}
