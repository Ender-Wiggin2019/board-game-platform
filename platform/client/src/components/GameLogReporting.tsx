import type { ProjectedEvent } from '@board-game/contracts';
import type { TPlatformFeedbackCategory } from '@board-platform/contracts';
import { Bug } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  createPlatformFeedbackEventId,
  platformFeedbackApi,
} from '../api/platformFeedbackApi.js';
import {
  IssueReportDialog,
  type IssueReportDraft,
} from './IssueReportDialog.js';

export interface ReportableGameLog {
  /** The game's stable presentation key, explicitly mapped to a Host event. */
  readonly key: string;
  readonly event: ProjectedEvent;
}

const LogReportContext = createContext<{
  readonly events: ReadonlyMap<string, ProjectedEvent>;
  readonly selected?: number;
  readonly select: (event: ProjectedEvent) => void;
  readonly report: (event: ProjectedEvent) => void;
} | null>(null);

export function GameLogReportingProvider(props: {
  readonly gameId: string;
  readonly sessionId: string;
  readonly identityKey: string;
  readonly logs: readonly ReportableGameLog[];
  readonly children: ReactNode;
}): React.JSX.Element {
  // A session/account change discards selected evidence and any unsent draft.
  return (
    <SessionLogReporting
      key={`${props.gameId}:${props.sessionId}:${props.identityKey}`}
      {...props}
    />
  );
}

function SessionLogReporting({
  gameId,
  sessionId,
  logs,
  children,
}: Parameters<typeof GameLogReportingProvider>[0]): React.JSX.Element {
  const { t } = useTranslation('common');
  const [selected, setSelected] = useState<number>();
  const [target, setTarget] = useState<ProjectedEvent>();
  const retry = useRef<{ digest: string; eventId: string }>();
  const events = useMemo(
    () => new Map(logs.map((log) => [log.key, log.event])),
    [logs],
  );
  const ai = target?.source?.kind === 'ai' || target?.source?.kind === 'automa';
  const categories = ai
    ? (['behavior', 'optimization'] as const)
    : (['bug', 'rules', 'ux', 'other'] as const);
  const submit = async (draft: IssueReportDraft): Promise<{ id: string }> => {
    if (!target) throw new Error(t('client.logReport.missingEvent'));
    const input = {
      gameId,
      category: draft.category as TPlatformFeedbackCategory,
      message: draft.description,
      ...(draft.expectedBehavior
        ? { expectedBehavior: draft.expectedBehavior }
        : {}),
      target: {
        kind: 'native-session' as const,
        sessionId,
        eventSequence: target.sequence,
      },
    };
    const digest = JSON.stringify(input);
    if (retry.current?.digest !== digest)
      retry.current = { digest, eventId: createPlatformFeedbackEventId() };
    const result = await platformFeedbackApi.submit({
      ...input,
      eventId: retry.current.eventId,
    });
    return { id: result.reportId };
  };
  return (
    <LogReportContext.Provider
      value={{
        events,
        selected,
        select: (event) => setSelected(event.sequence),
        report: (event) => {
          retry.current = undefined;
          setTarget(event);
        },
      }}
    >
      {children}
      {target ? (
        <IssueReportDialog
          key={target.sequence}
          ai={ai}
          categories={categories.map((value) => ({
            value,
            label: t(`client.logReport.categories.${value}`),
          }))}
          attachment={t('client.logReport.attachedEvent', {
            sequence: target.sequence,
          })}
          onSubmit={submit}
          onClose={() => setTarget(undefined)}
        />
      ) : null}
    </LogReportContext.Provider>
  );
}

/** Selection preserves controls embedded inside rich game log descriptions. */
export function ReportableLogEntry({
  logKey,
  children,
}: {
  readonly logKey: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const context = useContext(LogReportContext);
  const { t } = useTranslation('common');
  const event = context?.events.get(logKey);
  if (!context || !event) return <>{children}</>;
  const selected = context.selected === event.sequence;
  return (
    <div
      role='group'
      aria-label={t('client.logReport.logEntry')}
      data-report-selected={selected || undefined}
      className={`relative min-w-0 rounded-sm pr-10 ${selected ? 'bg-amber-500/10 ring-1 ring-amber-500/60' : ''}`}
      onClickCapture={(click) => {
        if (
          click.target instanceof Element &&
          click.target.closest(
            'button,a,input,select,textarea,summary,[role="button"]',
          )
        )
          return;
        context.select(event);
      }}
    >
      <button
        type='button'
        className='sr-only focus:not-sr-only'
        aria-pressed={selected}
        onClick={() => context.select(event)}
      >
        {t('client.logReport.select')}
      </button>
      {children}
      {selected ? (
        <ReportIssueButton
          className='absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded text-text-300 hover:bg-surface-700 hover:text-text-100'
          onClick={() => context.report(event)}
        />
      ) : null}
    </div>
  );
}

export function ReportIssueButton({
  onClick,
  className,
  style,
}: {
  readonly onClick: () => void;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}): React.JSX.Element {
  const { t } = useTranslation('common');
  return (
    <button
      type='button'
      onClick={onClick}
      className={className}
      style={style}
      title={t('client.logReport.open')}
      aria-label={t('client.logReport.open')}
    >
      <Bug size={16} aria-hidden />
    </button>
  );
}
