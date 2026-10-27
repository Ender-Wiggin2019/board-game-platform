import { ECapability } from '@board-platform/contracts/auth/permissions';
import type { IPlatformPerformanceSnapshot } from '@board-platform/contracts/types/protocol/administration';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { platformPerformanceApi } from '@/api/platformPerformanceApi.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.js';
import { usePermissions } from '@/hooks/usePermissions.js';

const REFRESH_INTERVAL_MS = 10_000;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const;
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount >= 100 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatPercent(value: number | null, samplingLabel: string): string {
  return value === null || !Number.isFinite(value)
    ? samplingLabel
    : `${value.toFixed(1)}%`;
}

function formatMilliseconds(
  value: number | null,
  samplingLabel: string,
): string {
  return value === null || !Number.isFinite(value)
    ? samplingLabel
    : `${value.toFixed(1)} ms`;
}

function MetricCard({
  label,
  value,
  description,
}: {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}): React.JSX.Element {
  return (
    <Card variant='instrument'>
      <CardContent className='space-y-1.5'>
        <p className='font-mono text-[0.68rem] uppercase tracking-microlabel text-text-500'>
          {label}
        </p>
        <p className='font-display text-2xl font-medium tabular-nums text-text-100'>
          {value}
        </p>
        {description ? (
          <p className='text-xs text-text-500'>{description}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PerformanceMetrics({
  snapshot,
  samplingLabel,
  t,
}: {
  readonly snapshot: IPlatformPerformanceSnapshot;
  readonly samplingLabel: string;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const eventLoop = snapshot.eventLoopLagMs;
  return (
    <div className='space-y-5'>
      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <MetricCard
          label={t('performance.cpu')}
          value={formatPercent(snapshot.cpuPercent, samplingLabel)}
          description={t('performance.cpu_description')}
        />
        <MetricCard
          label={t('performance.uptime')}
          value={formatDuration(snapshot.uptimeSeconds)}
        />
        <MetricCard
          label={t('performance.sample_window')}
          value={`${snapshot.sampleWindowMs.toFixed(0)} ms`}
        />
        <MetricCard
          label={t('performance.event_loop')}
          value={formatMilliseconds(eventLoop?.p95 ?? null, samplingLabel)}
          description={t('performance.p95')}
        />
      </div>

      <div className='grid gap-5 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>{t('performance.memory')}</CardTitle>
            <CardDescription>
              {t('performance.memory_description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3 sm:grid-cols-2'>
            <MetricCard
              label={t('performance.rss')}
              value={formatBytes(snapshot.memoryBytes.rss)}
            />
            <MetricCard
              label={t('performance.heap')}
              value={`${formatBytes(snapshot.memoryBytes.heapUsed)} / ${formatBytes(snapshot.memoryBytes.heapTotal)}`}
            />
            <MetricCard
              label={t('performance.external')}
              value={formatBytes(snapshot.memoryBytes.external)}
            />
            <MetricCard
              label={t('performance.array_buffers')}
              value={formatBytes(snapshot.memoryBytes.arrayBuffers)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('performance.event_loop')}</CardTitle>
            <CardDescription>
              {t('performance.event_loop_description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3 sm:grid-cols-3'>
            <MetricCard
              label={t('performance.mean')}
              value={formatMilliseconds(eventLoop?.mean ?? null, samplingLabel)}
            />
            <MetricCard
              label={t('performance.p95')}
              value={formatMilliseconds(eventLoop?.p95 ?? null, samplingLabel)}
            />
            <MetricCard
              label={t('performance.max')}
              value={formatMilliseconds(eventLoop?.max ?? null, samplingLabel)}
            />
          </CardContent>
        </Card>
      </div>

      <p className='text-xs text-text-500'>
        {t('performance.captured_at', {
          value: formatDate(snapshot.capturedAt),
        })}
      </p>
    </div>
  );
}

export function PlatformPerformancePage(): React.JSX.Element {
  const { t } = useTranslation('platform-admin');
  const permissions = usePermissions();
  const canRead = permissions.can(ECapability.ANALYTICS_READ);
  const query = useQuery({
    queryKey: ['platform', 'admin', 'performance'],
    queryFn: platformPerformanceApi.getSnapshot,
    enabled: canRead,
    refetchInterval: REFRESH_INTERVAL_MS,
    staleTime: REFRESH_INTERVAL_MS / 2,
    retry: false,
  });

  if (!canRead) {
    return (
      <main className='space-y-6'>
        <header className='space-y-2'>
          <h1 className='font-display text-3xl font-medium text-text-100'>
            {t('performance.title')}
          </h1>
        </header>
        <Card>
          <CardContent className='pt-5'>
            <p role='alert'>{t('performance.forbidden')}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const samplingLabel = t('performance.sampling');
  const loadError = query.isError && !query.data;

  return (
    <main className='space-y-6' data-testid='platform-performance-page'>
      <header className='flex flex-wrap items-start justify-between gap-4'>
        <div className='space-y-2'>
          <p className='font-mono text-xs uppercase tracking-microlabel text-text-500'>
            {t('eyebrow')}
          </p>
          <h1 className='font-display text-3xl font-medium text-text-100'>
            {t('performance.title')}
          </h1>
          <p className='max-w-2xl text-sm leading-relaxed text-text-300'>
            {t('performance.description')}
          </p>
        </div>
        <Button
          variant='ghost'
          size='sm'
          loading={query.isFetching}
          loadingLabel={t('performance.refreshing')}
          onClick={() => void query.refetch()}
        >
          {t('performance.refresh')}
        </Button>
      </header>

      {loadError ? (
        <Card>
          <CardContent className='flex flex-wrap items-center justify-between gap-3 pt-5'>
            <div>
              <p className='font-medium text-text-100'>
                {t('performance.error_title')}
              </p>
              <p className='mt-1 text-sm text-text-400'>
                {t('performance.error_description')}
              </p>
            </div>
            <Button
              size='sm'
              loading={query.isFetching}
              loadingLabel={t('performance.refreshing')}
              onClick={() => void query.refetch()}
            >
              {t('performance.retry')}
            </Button>
          </CardContent>
        </Card>
      ) : query.isPending ? (
        <Card>
          <CardContent className='pt-5'>
            <Badge variant='neutral'>{t('performance.loading')}</Badge>
          </CardContent>
        </Card>
      ) : query.data ? (
        <>
          {query.isError ? (
            <p role='status' className='text-sm text-text-400'>
              {t('performance.refresh_failed')}
            </p>
          ) : null}
          <PerformanceMetrics
            snapshot={query.data}
            samplingLabel={samplingLabel}
            t={t}
          />
        </>
      ) : null}
    </main>
  );
}
