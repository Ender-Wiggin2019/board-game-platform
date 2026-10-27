import { type ReactNode, useRef, useState } from 'react';
import { GameSlot } from './GameFrame.js';

export type GameActionKind = 'primary' | 'secondary' | 'cancel' | 'undo';

export interface GameAction {
  readonly id: string;
  readonly label: ReactNode;
  readonly onAction: () => void | boolean | Promise<void | boolean>;
  readonly disabled?: boolean;
  readonly kind?: GameActionKind;
  readonly selected?: boolean;
}

export interface GameActionBarProps {
  readonly actions: readonly GameAction[];
  readonly status?: ReactNode;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly errorMessage?: ReactNode;
}

const DEFAULT_FAILURE_MESSAGE = 'Action could not be completed. Try again.';

function actionClassName(kind: GameActionKind | undefined): string {
  return `bgp-game-action-bar__button bgp-game-action-bar__button--${kind ?? 'secondary'}`;
}

/**
 * Shared action surface for game commands. GameSlot supplies the session's
 * authorization boundary; this component owns only button presentation and
 * the short in-flight guard needed to prevent duplicate clicks.
 */
export function GameActionBar({
  actions,
  status,
  children,
  disabled = false,
  busy = false,
  errorMessage,
}: GameActionBarProps): React.JSX.Element {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReactNode>(null);
  const pendingRef = useRef(false);
  const busyState = busy || pendingActionId !== null;
  const blocked = disabled || busyState;

  const runAction = (action: GameAction): void => {
    if (blocked || action.disabled || pendingRef.current) return;

    pendingRef.current = true;
    setPendingActionId(action.id);
    setFailure(null);
    let result: void | boolean | Promise<void | boolean>;
    try {
      result = action.onAction();
    } catch {
      setFailure(errorMessage ?? DEFAULT_FAILURE_MESSAGE);
      pendingRef.current = false;
      setPendingActionId(null);
      return;
    }
    if (result instanceof Promise) {
      void result
        .then((accepted) => {
          if (accepted === false)
            setFailure(errorMessage ?? DEFAULT_FAILURE_MESSAGE);
        })
        .catch(() => {
          setFailure(errorMessage ?? DEFAULT_FAILURE_MESSAGE);
        })
        .finally(() => {
          pendingRef.current = false;
          setPendingActionId(null);
        });
      return;
    }
    if (result === false) setFailure(errorMessage ?? DEFAULT_FAILURE_MESSAGE);
    pendingRef.current = false;
    setPendingActionId(null);
  };

  return (
    <GameSlot name='actions'>
      <div
        className='bgp-game-action-bar'
        data-state={failure ? 'error' : busyState ? 'busy' : 'ready'}
        aria-busy={busyState}
      >
        {status != null && (
          <div className='bgp-game-action-bar__status' role='status'>
            {status}
          </div>
        )}
        {failure != null && (
          <div className='bgp-game-action-bar__error' role='alert'>
            {failure}
          </div>
        )}
        {children != null && (
          <div className='bgp-game-action-bar__content'>{children}</div>
        )}
        <div className='bgp-game-action-bar__actions'>
          {actions.map((action) => (
            <button
              className={actionClassName(action.kind)}
              data-action-id={action.id}
              key={action.id}
              type='button'
              disabled={blocked || action.disabled === true}
              aria-busy={pendingActionId === action.id}
              aria-pressed={action.selected}
              onClick={() => runAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </GameSlot>
  );
}
