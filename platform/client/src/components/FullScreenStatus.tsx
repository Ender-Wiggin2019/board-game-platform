import { Dices, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '@/components/ui/button';
import './FullScreenStatus.css';

interface IStatusAction {
  label: string;
  onClick: () => void | Promise<unknown>;
  testId?: string;
}

const LOADING_MESSAGE_KEYS = [
  'client.full_screen_status.loading_messages.preparing_table',
  'client.full_screen_status.loading_messages.connecting_players',
  'client.full_screen_status.loading_messages.loading_pieces',
  'client.full_screen_status.loading_messages.checking_updates',
  'client.full_screen_status.loading_messages.opening_lobby',
  'client.full_screen_status.loading_messages.preparing_view',
] as const;

type TFullScreenStatusProps = {
  description?: string;
  note?: string;
  action?: IStatusAction;
  secondaryAction?: { label: string; href: string };
  children?: ReactNode;
} & ({ state?: 'loading'; label?: string } | { state: 'error'; label: string });

function LoadingMessage(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const [messageKey] = useState(
    () =>
      LOADING_MESSAGE_KEYS[
        Math.floor(Math.random() * LOADING_MESSAGE_KEYS.length)
      ],
  );
  return <>{t(messageKey)}</>;
}

/** Shared loading feedback and recovery actions for app and route states. */
export function FullScreenStatus({
  state = 'loading',
  label,
  description,
  note,
  action,
  secondaryAction,
  children,
}: TFullScreenStatusProps): React.JSX.Element {
  const titleId = useId();
  const actionPending = useRef(false);
  const [isActionPending, setIsActionPending] = useState(false);

  const runAction = async (): Promise<void> => {
    if (!action || actionPending.current) return;
    actionPending.current = true;
    try {
      const pending = action.onClick();
      if (pending) {
        setIsActionPending(true);
        await pending;
      }
    } finally {
      actionPending.current = false;
      setIsActionPending(false);
    }
  };

  return (
    <section className='full-screen-status' data-state={state}>
      <div className='full-screen-status__content'>
        {state === 'loading' ? (
          <Loader2
            className='full-screen-status__spinner animate-spin'
            aria-hidden
          />
        ) : (
          <Dices className='full-screen-status__mark' aria-hidden />
        )}
        <div
          className='full-screen-status__message'
          role={state === 'error' ? 'alert' : 'status'}
          aria-labelledby={titleId}
          aria-live={state === 'error' ? 'assertive' : 'polite'}
          aria-atomic='true'
        >
          <h1 id={titleId} className='full-screen-status__label'>
            {state === 'loading' ? (label ?? <LoadingMessage />) : label}
          </h1>
          {description ? (
            <p className='full-screen-status__description'>{description}</p>
          ) : null}
          {note ? <p className='full-screen-status__note'>{note}</p> : null}
        </div>
        {action || secondaryAction ? (
          <div className='full-screen-status__actions'>
            {action ? (
              <Button
                onClick={() => void runAction()}
                loading={isActionPending}
                data-testid={action.testId}
                wrap
              >
                {action.label}
              </Button>
            ) : null}
            {secondaryAction ? (
              <a
                href={secondaryAction.href}
                className={buttonVariants({ variant: 'ghost', wrap: true })}
              >
                {secondaryAction.label}
              </a>
            ) : null}
          </div>
        ) : null}
        {children ? (
          <div className='full-screen-status__recovery'>{children}</div>
        ) : null}
      </div>
    </section>
  );
}
