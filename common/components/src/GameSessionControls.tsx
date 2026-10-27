import type {
  GameSessionControlCommand,
  GameSessionControlsView,
  GameSessionTimeoutMode,
} from '@board-game/contracts';
import { useEffect, useState } from 'react';
import { type GameAction, GameActionBar } from './GameActionBar.js';

export interface GameSessionControlLabels {
  readonly unnamedPlayer: string;
  readonly abandon: string;
  readonly confirmAbandon: string;
  readonly abandonWarning: string;
  readonly agree: string;
  readonly withdraw: string;
  readonly cancel: string;
  readonly waiting: string;
  readonly failure: string;
  readonly agreements: (names: string) => string;
  readonly remaining: (name: string, seconds: number) => string;
  readonly expired: (name: string) => string;
  readonly requestTimeout: (
    name: string,
    mode: GameSessionTimeoutMode,
  ) => string;
  readonly confirmTimeout: (
    name: string,
    mode: GameSessionTimeoutMode,
  ) => string;
  readonly waitToConfirm: (seconds: number) => string;
}

export interface GameSessionControlProps {
  readonly view: GameSessionControlsView;
  readonly labels: GameSessionControlLabels;
  readonly disabled?: boolean;
  readonly onCommand: (command: GameSessionControlCommand) => Promise<boolean>;
}

function participantName(
  view: GameSessionControlsView,
  id: string,
  labels: GameSessionControlLabels,
): string {
  return (
    view.participants.find((player) => player.principalId === id)
      ?.displayName ?? labels.unnamedPlayer
  );
}

function isParticipant(view: GameSessionControlsView): boolean {
  return view.participants.some(
    (player) =>
      player.principalId === view.viewerId &&
      player.active &&
      player.controller !== 'bot',
  );
}

/** Room management, separate from the game's action bar and turn eligibility. */
export function GameAbandonControls({
  view,
  labels,
  disabled,
  onCommand,
}: GameSessionControlProps): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  const proposal = view.abandon;
  if (view.status !== 'active' || !isParticipant(view)) return null;
  const eligible =
    !proposal || proposal.eligibleParticipantIds.includes(view.viewerId ?? '');
  if (!eligible) return null;
  const agreed =
    proposal?.agreedParticipantIds.includes(view.viewerId ?? '') === true;
  const send = (action: 'abandonAgree' | 'abandonCancel') => async () => {
    const accepted = await onCommand({ type: 'sessionControl', action });
    if (accepted) setConfirming(false);
    return accepted;
  };
  const actions: GameAction[] = proposal
    ? [
        ...(!agreed
          ? [
              {
                id: 'agree',
                label: labels.agree,
                onAction: send('abandonAgree'),
              },
            ]
          : []),
        {
          id: 'withdraw',
          label: labels.withdraw,
          onAction: send('abandonCancel'),
        },
      ]
    : confirming
      ? [
          {
            id: 'cancel',
            label: labels.cancel,
            kind: 'cancel',
            onAction: () => setConfirming(false),
          },
          {
            id: 'abandon',
            label: labels.confirmAbandon,
            onAction: send('abandonAgree'),
          },
        ]
      : [
          {
            id: 'propose',
            label: labels.abandon,
            onAction: () => setConfirming(true),
          },
        ];
  return (
    <GameActionBar
      disabled={disabled}
      errorMessage={labels.failure}
      status={
        proposal
          ? labels.agreements(
              proposal.agreedParticipantIds
                .map((id) => participantName(view, id, labels))
                .join('、'),
            )
          : confirming
            ? labels.abandonWarning
            : undefined
      }
      actions={actions}
    />
  );
}

/** Advisory countdown only. The server checks deadlines and each voter's confirmation delay. */
export function GameTimeoutControls({
  view,
  labels,
  disabled,
  onCommand,
}: GameSessionControlProps): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now);
  const windows = view.timeout?.activeWindows ?? [];
  useEffect(() => {
    if (view.status !== 'active' || windows.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [view.status, windows]);
  if (view.status !== 'active' || windows.length === 0) return null;
  const vote = view.timeout?.timeoutVote;
  const viewer = view.viewerId ?? '';
  const actions: GameAction[] = [];
  let confirmationStatus: string | undefined;
  if (isParticipant(view)) {
    for (const window of windows) {
      if (window.participantId === viewer || now <= window.dueAtMs) continue;
      if (vote && vote.windowId !== window.id) continue;
      for (const mode of view.availableModes) {
        if (vote && vote.mode !== mode) continue;
        if (
          mode === 'continue-game' &&
          windows.some(
            (candidate) =>
              candidate.participantId === viewer && now > candidate.dueAtMs,
          )
        )
          continue;
        if (vote && !vote.eligibleParticipantIds.includes(viewer)) continue;
        const name = participantName(view, window.participantId, labels);
        const startedAt = vote?.confirmationStartedAtMsByParticipantId[viewer];
        if (vote?.acceptedParticipantIds.includes(viewer)) {
          confirmationStatus = labels.waiting;
          continue;
        }
        const waitMs =
          startedAt === undefined
            ? 0
            : startedAt + view.confirmationDelayMs - now;
        if (waitMs > 0)
          confirmationStatus = labels.waitToConfirm(Math.ceil(waitMs / 1000));
        actions.push({
          id: `${window.id}:${mode}`,
          label:
            startedAt === undefined
              ? labels.requestTimeout(name, mode)
              : labels.confirmTimeout(name, mode),
          disabled: waitMs > 0,
          onAction: () =>
            onCommand({
              type: 'sessionControl',
              action:
                startedAt === undefined ? 'timeoutRequest' : 'timeoutConfirm',
              windowId: window.id,
              mode,
            }),
        });
      }
    }
  }
  return (
    <div className='bgp-session-controls'>
      <div className='bgp-session-controls__clocks'>
        {windows.map((window) => {
          const remaining = Math.max(
            0,
            Math.ceil((window.dueAtMs - now) / 1000),
          );
          const name = participantName(view, window.participantId, labels);
          return (
            <span key={window.id}>
              {remaining > 0
                ? labels.remaining(name, remaining)
                : labels.expired(name)}
            </span>
          );
        })}
      </div>
      {actions.length > 0 || confirmationStatus ? (
        <GameActionBar
          disabled={disabled}
          errorMessage={labels.failure}
          status={confirmationStatus}
          actions={actions}
        />
      ) : null}
    </div>
  );
}
