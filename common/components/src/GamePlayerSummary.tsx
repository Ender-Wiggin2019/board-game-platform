import type { ReactNode } from 'react';
import type { PlatformPlayerSummary } from './GameFrame.js';

export type GamePlayerConnection = PlatformPlayerSummary['connection'];

export interface GamePlayerSummaryLabels {
  readonly seatLabel?: string;
  readonly unassignedSeat?: string;
  readonly attention?: string;
  readonly presence?: Partial<Record<GamePlayerConnection, string>>;
}

export interface GamePlayerSummaryProps {
  readonly player: PlatformPlayerSummary;
  readonly labels?: GamePlayerSummaryLabels;
  readonly avatar?: ReactNode;
  readonly details?: ReactNode;
  readonly extra?: ReactNode;
}

const DEFAULT_PRESENCE_LABELS: Partial<Record<GamePlayerConnection, string>> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0];
  if (parts.length === 1) return first?.slice(0, 2).toUpperCase() ?? '?';
  const last = parts.at(-1);
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
}

function presenceLabel(
  connection: GamePlayerConnection,
  labels: GamePlayerSummaryLabels | undefined,
): string | null {
  if (connection === 'unknown') return null;
  return (
    labels?.presence?.[connection] ??
    DEFAULT_PRESENCE_LABELS[connection] ??
    null
  );
}

/**
 * Common player identity and platform status surface. Game-owned resources
 * belong in the `details` slot, while adornments stay in `extra`.
 */
export function GamePlayerSummary({
  player,
  labels,
  avatar,
  details,
  extra,
}: GamePlayerSummaryProps): React.JSX.Element {
  const seat = player.seatId ?? labels?.unassignedSeat;
  const presence = presenceLabel(player.connection, labels);

  return (
    <article
      className='bgp-game-player-summary'
      data-connection={player.connection}
      data-needs-attention={player.needsAttention || undefined}
      data-player-id={player.principalId}
    >
      <div className='bgp-game-player-summary__header'>
        <div
          className='bgp-game-player-summary__avatar'
          aria-hidden={avatar == null ? true : undefined}
        >
          {avatar ?? initials(player.displayName)}
        </div>
        <div className='bgp-game-player-summary__identity'>
          <strong className='bgp-game-player-summary__name'>
            {player.displayName}
          </strong>
          <div className='bgp-game-player-summary__meta'>
            {labels?.seatLabel && seat && (
              <span className='bgp-game-player-summary__seat'>
                {labels.seatLabel} {seat}
              </span>
            )}
            {presence && (
              <span
                className='bgp-game-player-summary__presence'
                data-presence={player.connection}
              >
                {presence}
              </span>
            )}
          </div>
        </div>
        {extra != null && (
          <div className='bgp-game-player-summary__extra'>{extra}</div>
        )}
      </div>
      {player.needsAttention && (
        <div className='bgp-game-player-summary__attention' role='status'>
          {labels?.attention ?? 'Needs attention'}
        </div>
      )}
      {details != null && (
        <div className='bgp-game-player-summary__details'>{details}</div>
      )}
    </article>
  );
}
