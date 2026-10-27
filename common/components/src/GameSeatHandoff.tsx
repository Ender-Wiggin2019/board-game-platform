import type { Participant } from '@board-game/contracts';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

export interface GameSeatHandoffLabels {
  readonly seat: string;
  readonly selectSeat: string;
  readonly chooseSeat: string;
  readonly loadingSeat: string;
  readonly pendingAction: string;
  readonly revealingSeat: string;
  readonly ready: (seatLabel: string) => string;
  readonly revealSeat: string;
}

const DEFAULT_LABELS: GameSeatHandoffLabels = {
  seat: 'Seat',
  selectSeat: 'Select a seat',
  chooseSeat: 'Choose a seat',
  loadingSeat: 'Loading seat…',
  pendingAction: 'Resolve the pending action before changing seats.',
  revealingSeat: 'The selected seat is being revealed.',
  ready: (seatLabel) => `${seatLabel} is ready.`,
  revealSeat: 'Reveal seat',
};

export interface GameSeatHandoffProps {
  /** Seats the gateway publicly authorized this account to control. */
  readonly controlledSeats?: readonly Participant[];
  readonly selectedSeatId?: string;
  readonly loading?: boolean;
  /** An unknown command outcome fences seat changes until the original intent is resolved. */
  readonly submissionUnknown?: boolean;
  readonly onSelectSeat?: (seatId: string | undefined) => void;
  /** UI copy is supplied by the host; common keeps English defaults for standalone games. */
  readonly labels?: Partial<GameSeatHandoffLabels>;
  readonly children: ReactNode;
}

function seatLabel(participant: Participant): string {
  return participant.publicProfile?.displayName?.trim() || participant.seatId;
}

/**
 * Shared hot-seat boundary.  It keeps the old game tree mounted only for the
 * currently revealed seat; a selected seat first reloads its store and then
 * requires an explicit reveal before private game content is shown.
 */
export function GameSeatHandoff({
  controlledSeats,
  selectedSeatId,
  loading = false,
  submissionUnknown = false,
  onSelectSeat,
  labels,
  children,
}: GameSeatHandoffProps): React.JSX.Element {
  const copy = { ...DEFAULT_LABELS, ...labels };
  const [revealedSeatId, setRevealedSeatId] = useState<string | undefined>();
  const seats = controlledSeats ?? [];
  const selectionEnabled = controlledSeats !== undefined && seats.length > 1;
  const selectedParticipant = useMemo(
    () => seats.find((participant) => participant.seatId === selectedSeatId),
    [seats, selectedSeatId],
  );
  const effectiveSeatId =
    selectedSeatId ?? (seats.length === 1 ? seats[0]?.seatId : undefined);
  const needsSelection = selectionEnabled && effectiveSeatId === undefined;
  const needsReveal =
    selectedSeatId !== undefined && revealedSeatId !== selectedSeatId;

  useEffect(() => {
    setRevealedSeatId(undefined);
  }, [selectedSeatId]);

  const selector = selectionEnabled ? (
    <label className='bgp-game-seat-handoff__field'>
      <span>{copy.seat}</span>
      <select
        value={selectedSeatId ?? ''}
        disabled={submissionUnknown || loading}
        onChange={(event) => onSelectSeat?.(event.target.value || undefined)}
      >
        <option value='' disabled>
          {copy.selectSeat}
        </option>
        {seats.map((participant) => (
          <option key={participant.seatId} value={participant.seatId}>
            {seatLabel(participant)}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  if (!needsSelection && !needsReveal && !loading) {
    return (
      <>
        {selectionEnabled ? (
          <div className='bgp-game-seat-handoff__switcher'>{selector}</div>
        ) : null}
        {children}
      </>
    );
  }

  return (
    <section
      className='bgp-game-seat-handoff'
      aria-live='polite'
      aria-busy={loading}
    >
      <div className='bgp-game-seat-handoff__card'>
        <p className='bgp-game-seat-handoff__title'>
          {loading ? copy.loadingSeat : copy.chooseSeat}
        </p>
        {selector}
        {submissionUnknown ? (
          <p className='bgp-game-seat-handoff__message'>{copy.pendingAction}</p>
        ) : loading ? (
          <p className='bgp-game-seat-handoff__message'>{copy.revealingSeat}</p>
        ) : needsReveal ? (
          <>
            <p className='bgp-game-seat-handoff__message'>
              {copy.ready(
                selectedParticipant
                  ? seatLabel(selectedParticipant)
                  : `Seat ${effectiveSeatId ?? ''}`,
              )}
            </p>
            <button
              type='button'
              className='bgp-game-seat-handoff__reveal'
              onClick={() => setRevealedSeatId(effectiveSeatId)}
              disabled={effectiveSeatId === undefined}
            >
              {copy.revealSeat}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
