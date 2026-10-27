import {
  GameAbandonControls,
  type GameSessionControlLabels,
  GameSessionProvider,
  GameTimeoutControls,
  useGameSession,
} from '@board-game/components';
import type {
  GameSessionControlCommand,
  GameSessionControlsView,
  JsonObject,
  JsonValue,
  SessionRoute,
} from '@board-game/contracts';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPlatformRequestId } from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createBrowserPlatformRuntime } from '@/runtime';

type PlatformRoomSessionView = JsonObject & {
  readonly sessionControls?: GameSessionControlsView;
};

type RecoveryAction = 'retry' | 'resume';

export interface PlatformRoomSessionPanelProps {
  readonly route: SessionRoute;
}

function modeLabel(
  translate: (key: string, options?: Record<string, unknown>) => string,
  mode: 'end-game' | 'continue-game',
): string {
  return translate(`room.session_controls.modes.${mode}`, {
    defaultValue: mode === 'end-game' ? 'end the game' : 'continue the game',
  });
}

function sessionControlLabels(
  translate: (key: string, options?: Record<string, unknown>) => string,
): GameSessionControlLabels {
  return {
    unnamedPlayer: translate('room.session_controls.unnamed_player'),
    abandon: translate('room.session_controls.abandon'),
    confirmAbandon: translate('room.session_controls.confirm_abandon'),
    abandonWarning: translate('room.session_controls.abandon_warning'),
    agree: translate('room.session_controls.agree'),
    withdraw: translate('room.session_controls.withdraw'),
    cancel: translate('status.cancel'),
    waiting: translate('room.session_controls.waiting'),
    failure: translate('room.session_controls.failure'),
    agreements: (names) =>
      translate('room.session_controls.agreements', { names }),
    remaining: (name, seconds) =>
      translate('room.session_controls.remaining', { name, seconds }),
    expired: (name) => translate('room.session_controls.expired', { name }),
    requestTimeout: (name, mode) =>
      translate('room.session_controls.request_timeout', {
        name,
        mode: modeLabel(translate, mode),
      }),
    confirmTimeout: (name, mode) =>
      translate('room.session_controls.confirm_timeout', {
        name,
        mode: modeLabel(translate, mode),
      }),
    waitToConfirm: (seconds) =>
      translate('room.session_controls.wait_to_confirm', { seconds }),
  };
}

function SessionPanelContent(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const session = useGameSession<
    GameSessionControlCommand,
    JsonValue,
    JsonValue,
    PlatformRoomSessionView
  >();
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction | null>(
    null,
  );
  const labels = useMemo(() => sessionControlLabels(t), [t]);
  const state = session.state;
  const snapshot = state.snapshot;
  const view = snapshot?.payload.sessionControls;
  const unknownSubmission = state.pendingSubmission?.phase === 'unknown';
  const conflict =
    state.error?.code === 'CONFLICT' || state.error?.code === 'STALE_REVISION';

  const sendCommand = useCallback(
    async (command: GameSessionControlCommand): Promise<boolean> => {
      const current = session.state;
      const currentSnapshot = current.snapshot;
      if (
        current.status !== 'ready' ||
        currentSnapshot === null ||
        current.pendingSubmission !== null
      )
        return false;
      try {
        const response = await session.submitCommand({
          commandId: createPlatformRequestId(),
          command,
          precondition: {
            kind: 'revision',
            expectedRevision: currentSnapshot.revision,
          },
        });
        return (
          response.receipt.status === 'accepted' ||
          response.receipt.status === 'duplicate'
        );
      } catch {
        return false;
      }
    },
    [session],
  );

  const recover = useCallback(
    async (action: RecoveryAction): Promise<void> => {
      if (recoveryAction !== null) return;
      setRecoveryAction(action);
      try {
        if (action === 'retry') await session.retryPending();
        else await session.resume();
      } catch {
        // The store keeps the authoritative error and exposes the action again.
      } finally {
        setRecoveryAction(null);
      }
    },
    [recoveryAction, session],
  );

  const controlsDisabled =
    state.status !== 'ready' ||
    state.pendingSubmission !== null ||
    recoveryAction !== null;

  return (
    <Card data-testid='platform-room-session-controls'>
      <CardHeader className='flex-row items-center justify-between gap-3'>
        <CardTitle>{t('room.session_controls.title')}</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        {state.status === 'loading' ? (
          <LoadingSpinner
            label={t('room.session_controls.loading')}
            variant='inline'
          />
        ) : state.status === 'recovering' ? (
          <LoadingSpinner
            label={t('room.session_controls.recovering')}
            variant='inline'
          />
        ) : state.status === 'closed' ? (
          <p role='status' className='text-sm text-text-400'>
            {t('room.session_controls.closed')}
          </p>
        ) : state.status === 'error' ? (
          <div className='space-y-3'>
            <p role='alert' className='text-sm text-text-400'>
              {unknownSubmission
                ? t('room.session_controls.unknown')
                : conflict
                  ? t('room.session_controls.conflict')
                  : t('room.session_controls.failure')}
            </p>
            <Button
              variant='ghost'
              size='sm'
              loading={recoveryAction !== null}
              loadingLabel={t('room.session_controls.recovering')}
              onClick={() =>
                void recover(unknownSubmission ? 'retry' : 'resume')
              }
            >
              {unknownSubmission
                ? t('room.session_controls.retry')
                : t('room.session_controls.resume')}
            </Button>
          </div>
        ) : view === undefined ? (
          <p role='status' className='text-sm text-text-400'>
            {t('room.session_controls.unavailable')}
          </p>
        ) : view.status !== 'active' ? (
          <p role='status' className='text-sm text-text-400'>
            {t('room.session_controls.ended')}
          </p>
        ) : (
          <div className='space-y-3'>
            <GameAbandonControls
              view={view}
              labels={labels}
              disabled={controlsDisabled}
              onCommand={sendCommand}
            />
            <GameTimeoutControls
              view={view}
              labels={labels}
              disabled={controlsDisabled}
              onCommand={sendCommand}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PlatformRoomSessionPanel({
  route,
}: PlatformRoomSessionPanelProps): React.JSX.Element {
  const runtime = useMemo(() => createBrowserPlatformRuntime(), []);
  const routeKey = JSON.stringify(route);
  const transport = useMemo(
    () =>
      runtime.session.createTransport<
        GameSessionControlCommand,
        JsonValue,
        JsonValue,
        PlatformRoomSessionView
      >(route),
    [routeKey, runtime],
  );

  return (
    <GameSessionProvider
      route={route}
      transport={transport}
      identityKey={runtime.viewer.identityKey}
      signals={runtime.session.signals}
    >
      <SessionPanelContent />
    </GameSessionProvider>
  );
}
