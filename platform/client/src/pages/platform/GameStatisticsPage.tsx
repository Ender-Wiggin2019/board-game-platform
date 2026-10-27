import type { JsonObject, JsonValue } from '@board-game/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { platformGameApi } from '@/api/platformGameApi.js';
import { Button } from '@/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.js';
import { useAuthStore } from '@/stores/authStore.js';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KNOWN_METRICS = [
  {
    keys: ['totalSessions', 'totalGames'],
    labelKey: 'total_sessions',
  },
  {
    keys: ['completedSessions', 'completedGames'],
    labelKey: 'completed_sessions',
  },
  {
    keys: ['playedSessions', 'playedGames', 'personalGames'],
    labelKey: 'played_sessions',
  },
  {
    keys: ['playerCompletedSessions', 'personalCompletedGames'],
    labelKey: 'player_completed_sessions',
  },
  { keys: ['wins', 'winCount'], labelKey: 'wins' },
] as const;

interface MetricRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

interface MetricSection {
  readonly title?: string;
  readonly metrics: readonly MetricRow[];
}

function knownMetrics(
  value: JsonValue | undefined,
  label: (key: string) => string,
): readonly MetricRow[] {
  if (!isJsonObject(value)) return [];
  return KNOWN_METRICS.flatMap((definition) => {
    const key = definition.keys.find(
      (candidate) =>
        typeof value[candidate] === 'number' &&
        Number.isFinite(value[candidate]),
    );
    if (!key) return [];
    return [
      {
        key,
        label: label(definition.labelKey),
        value: value[key] as number,
      },
    ];
  });
}

function metricSections(
  value: JsonValue | undefined,
  label: (key: string) => string,
): readonly MetricSection[] {
  const record = isJsonObject(value) ? value : undefined;
  const global = record?.globalStats;
  const personal = record?.playerStats;
  const globalValue = isJsonObject(global) ? global : undefined;
  const personalValue = isJsonObject(personal) ? personal : undefined;
  if (globalValue || personalValue) {
    return [
      ...(globalValue
        ? [
            {
              title: label('global'),
              metrics: knownMetrics(globalValue, label),
            },
          ]
        : []),
      ...(personalValue
        ? [
            {
              title: label('personal'),
              metrics: knownMetrics(personalValue, label),
            },
          ]
        : []),
    ].filter((section) => section.metrics.length > 0);
  }
  const metrics = knownMetrics(value, label);
  return metrics.length ? [{ metrics }] : [];
}

function jsonText(value: JsonValue): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function StatisticsPanel({
  value,
  isPending,
  isError,
  error,
  onRetry,
  operator,
}: {
  readonly value: JsonValue | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly operator: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  if (isPending)
    return (
      <p role='status'>
        {t('game_pages.loading', { defaultValue: 'Loading…' })}
      </p>
    );
  if (isError)
    return (
      <div className='flex flex-wrap items-center gap-3'>
        <p role='alert'>
          {errorMessage(
            error,
            t('game_pages.statistics.load_failed', {
              defaultValue: 'Statistics could not be loaded.',
            }),
          )}
        </p>
        <Button size='sm' variant='ghost' onClick={onRetry}>
          {t('game_pages.retry', { defaultValue: 'Retry' })}
        </Button>
      </div>
    );

  const label = (key: string): string =>
    t(`game_pages.statistics.${key}`, {
      defaultValue:
        key === 'global'
          ? 'All games'
          : key === 'personal'
            ? 'Your games'
            : key,
    });
  const sections = metricSections(value, (key) =>
    key === 'global' || key === 'personal'
      ? label(key)
      : t(`game_pages.statistics.metrics.${key}`, {
          defaultValue: key,
        }),
  );
  if (!sections.length) {
    return (
      <p className='text-sm text-text-300'>
        {t('game_pages.statistics.empty', {
          defaultValue: 'No numeric statistics are available yet.',
        })}
      </p>
    );
  }

  return (
    <div className='space-y-4'>
      {sections.map((section, index) => (
        <section
          key={section.title ?? `section-${index}`}
          className='space-y-3'
        >
          {section.title ? (
            <h3 className='text-sm font-semibold text-text-200'>
              {section.title}
            </h3>
          ) : null}
          <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
            {section.metrics.map((metric) => (
              <div
                key={metric.key}
                className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-4 py-3'
              >
                <p className='text-xs text-text-500'>{metric.label}</p>
                <p className='mt-1 font-mono text-xl tabular-nums text-text-100'>
                  {metric.value}
                </p>
              </div>
            ))}
          </div>
        </section>
      ))}
      {operator && value ? (
        <details>
          <summary className='cursor-pointer text-sm text-accent-400'>
            {t('game_pages.statistics.details', {
              defaultValue: 'View details',
            })}
          </summary>
          <pre className='mt-3 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
            {jsonText(value)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function GameStatisticsPage({
  gameId,
}: {
  readonly gameId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const query = useQuery({
    queryKey: [
      'game',
      gameId,
      'statistics',
      'player',
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () => platformGameApi.getPlayerStatistics(gameId),
  });
  return (
    <Card data-testid='game-statistics-page'>
      <CardHeader>
        <CardTitle>
          {t('game_pages.statistics.title', { defaultValue: 'Statistics' })}
        </CardTitle>
        <CardDescription>
          {t('game_pages.statistics.description', {
            defaultValue: 'Your results and progress for this game.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatisticsPanel
          value={query.data}
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          operator={false}
        />
      </CardContent>
    </Card>
  );
}

export function GameStatisticsAdminPage({
  gameId,
}: {
  readonly gameId: string;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const query = useQuery({
    queryKey: [
      'game',
      gameId,
      'statistics',
      'operator',
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () => platformGameApi.getOperatorStatistics(gameId),
  });
  return (
    <Card data-testid='game-statistics-admin-page'>
      <CardHeader>
        <CardTitle>
          {t('game_pages.statistics.admin_title', {
            defaultValue: 'Game statistics',
          })}
        </CardTitle>
        <CardDescription>
          {t('game_pages.statistics.admin_description', {
            defaultValue: 'Aggregate operational metrics for this game.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StatisticsPanel
          value={query.data}
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          onRetry={() => void query.refetch()}
          operator
        />
      </CardContent>
    </Card>
  );
}
