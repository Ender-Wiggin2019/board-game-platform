import type { JsonValue, Participant } from '@board-game/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  type PlatformSessionResultResponse,
  platformApi,
} from '@/api/platformApi.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';

function isRecord(
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function participantName(
  participantId: string,
  participants: readonly Participant[],
): string {
  const participant = participants.find(
    (item) => item.principalId === participantId,
  );
  return (
    participant?.publicProfile?.displayName?.trim() ||
    participant?.seatId ||
    participantId
  );
}

function resultValue(
  response: PlatformSessionResultResponse,
): JsonValue | null | undefined {
  return response.result ?? response.completion?.result ?? response.endRecord;
}

function statusLabel(
  status: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!status) return t('game.result.status_values.unknown');
  return t(`game.result.status_values.${status}`, { defaultValue: status });
}

function jsonText(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Platform-owned terminal result projection, independent of any game client. */
export function PlatformSessionResult({
  sessionId,
}: {
  readonly sessionId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const resultQuery = useQuery({
    queryKey: ['platform', 'session-result', sessionId],
    queryFn: () => platformApi.getSessionResult(sessionId),
    retry: false,
  });

  return (
    <section
      className='mission-panel px-5 py-5'
      data-testid='platform-session-result'
      aria-busy={resultQuery.isPending || undefined}
    >
      <div className='relative z-10 space-y-4'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <p className='micro-label'>{t('game.result.eyebrow')}</p>
            <h2 className='font-display text-xl text-text-100'>
              {t('game.result.title')}
            </h2>
            <p className='mt-1 text-sm text-text-400'>
              {t('game.result.description')}
            </p>
          </div>
          {resultQuery.data ? (
            <div className='flex flex-wrap gap-2'>
              <Badge variant='success'>
                {statusLabel(
                  resultQuery.data.status ??
                    resultQuery.data.completion?.status,
                  t,
                )}
              </Badge>
              <Badge
                variant={
                  resultQuery.data.settlement?.processingState === 'settled'
                    ? 'success'
                    : 'warning'
                }
              >
                {t('game.result.settlement', {
                  value:
                    resultQuery.data.settlement?.processingState ??
                    t('game.result.settlement_unknown'),
                })}
              </Badge>
            </div>
          ) : null}
        </div>

        {resultQuery.isPending ? (
          <p role='status' className='text-sm text-text-400'>
            {t('game.result.loading')}
          </p>
        ) : resultQuery.isError ? (
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
              {t('game.result.unavailable')}
            </p>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => void resultQuery.refetch()}
            >
              {t('status.retry')}
            </Button>
          </div>
        ) : resultQuery.data ? (
          <ResultBody response={resultQuery.data} t={t} />
        ) : (
          <p className='text-sm text-text-400'>{t('game.result.empty')}</p>
        )}
      </div>
    </section>
  );
}

function ResultBody({
  response,
  t,
}: {
  response: PlatformSessionResultResponse;
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const participants = response.completion?.participants ?? [];
  const result = resultValue(response);
  const replayAvailable =
    (response.replayRef !== null && response.replayRef !== undefined) ||
    (response.completion?.replayRef !== null &&
      response.completion?.replayRef !== undefined);

  return (
    <div className='space-y-4'>
      {isRecord(result) && result.kind === 'competitive' ? (
        <CompetitiveResult result={result} participants={participants} t={t} />
      ) : isRecord(result) &&
        (result.kind === 'cooperative' || result.kind === 'solo') ? (
        <CooperativeResult result={result} participants={participants} t={t} />
      ) : isRecord(result) && result.kind === 'progress' ? (
        <div className='space-y-2'>
          <p className='text-sm text-text-300'>{t('game.result.progress')}</p>
          <pre className='max-h-64 overflow-auto rounded-[5px] bg-surface-instrument p-3 font-mono text-xs text-text-300'>
            {jsonText(result.progress)}
          </pre>
        </div>
      ) : (
        <p className='text-sm text-text-400'>
          {t('game.result.details_unavailable')}
        </p>
      )}
      <div className='flex flex-wrap items-center gap-2 text-xs text-text-500'>
        <Badge variant={replayAvailable ? 'accent' : 'neutral'}>
          {replayAvailable
            ? t('game.result.replay_available')
            : t('game.result.replay_unavailable')}
        </Badge>
        {response.sourceRevision !== undefined ? (
          <span>
            {t('game.result.source_revision', {
              value: response.sourceRevision,
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CompetitiveResult({
  result,
  participants,
  t,
}: {
  result: Record<string, JsonValue>;
  participants: readonly Participant[];
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const groups = Array.isArray(result.rankGroups) ? result.rankGroups : [];
  return (
    <div className='overflow-x-auto rounded-[5px] border border-white/10'>
      <table className='w-full min-w-[32rem] text-left text-sm'>
        <thead className='bg-surface-instrument text-text-500'>
          <tr>
            <th className='px-3 py-2'>{t('game.result.rank')}</th>
            <th className='px-3 py-2'>{t('game.result.participants')}</th>
            <th className='px-3 py-2'>{t('game.result.score')}</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-white/10'>
          {groups.flatMap((group, groupIndex) => {
            if (!isRecord(group) || !Array.isArray(group.teams)) return [];
            return group.teams.map((team, teamIndex) => {
              if (!isRecord(team)) return null;
              const ids = Array.isArray(team.participantIds)
                ? team.participantIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [];
              return (
                <tr key={`${groupIndex}-${teamIndex}`}>
                  <td className='px-3 py-2 font-mono text-text-100'>
                    {groupIndex + 1}
                  </td>
                  <td className='px-3 py-2 text-text-200'>
                    {ids
                      .map((id) => participantName(id, participants))
                      .join(', ') || '—'}
                  </td>
                  <td className='px-3 py-2 font-mono text-text-200'>
                    {typeof team.score === 'number' ? team.score : '—'}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function CooperativeResult({
  result,
  participants,
  t,
}: {
  result: Record<string, JsonValue>;
  participants: readonly Participant[];
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const ids = Array.isArray(result.participantIds)
    ? result.participantIds.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const outcome =
    typeof result.outcome === 'string' ? result.outcome : 'completed';
  return (
    <div className='grid gap-3 sm:grid-cols-3'>
      <Readout label={t('game.result.outcome')}>
        {t(`game.result.outcome_values.${outcome}`, {
          defaultValue: outcome,
        })}
      </Readout>
      <Readout label={t('game.result.score')}>
        {typeof result.score === 'number' ? result.score : '—'}
      </Readout>
      <Readout label={t('game.result.participants')}>
        {ids.map((id) => participantName(id, participants)).join(', ') || '—'}
      </Readout>
    </div>
  );
}

function Readout({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className='rounded-[5px] bg-surface-instrument px-3 py-3'>
      <p className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
        {label}
      </p>
      <p className='mt-1 text-sm text-text-100'>{children}</p>
    </div>
  );
}
