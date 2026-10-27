import {
  type IPlatformAutomationReplayResult,
  type IPlatformAutomationTrace,
  type IPlatformFeedbackReport,
  type IPlatformNativeDiagnostics,
  PLATFORM_FEEDBACK_STATUSES,
  type TPlatformFeedbackKind,
  type TPlatformFeedbackStatus,
} from '@board-platform/contracts';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platformFeedbackApi } from '@/api/platformFeedbackApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { usePermissions } from '@/hooks/usePermissions';
import {
  resolvePlatformBrandName,
  usePlatformConfiguration,
} from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';

type StatusDrafts = Readonly<Record<string, TPlatformFeedbackStatus>>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusVariant(
  status: IPlatformFeedbackReport['status'],
): 'accent' | 'success' | 'neutral' | 'warning' {
  if (status === 'resolved') return 'success';
  if (status === 'ignored') return 'neutral';
  if (status === 'triaged') return 'warning';
  return 'accent';
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function diagnosticsStatus(
  diagnostics: IPlatformNativeDiagnostics,
  t: (key: string) => string,
): string {
  return t(`operations.diagnostics.status_values.${diagnostics.status}`);
}

export interface PlatformOperationsPageProps {
  /** When set, keep the queue scoped to one game's reports. */
  readonly gameId?: string;
  /** The trusted queue kind; game pages default to ordinary reports. */
  readonly kind?: TPlatformFeedbackKind;
}

export function PlatformOperationsPage({
  gameId: scopedGameId,
  kind: scopedKind = 'game',
}: PlatformOperationsPageProps = {}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(configuration, t('brand.name'));
  const permissions = usePermissions();
  const epoch = useAuthStore((state) => state.authEpoch);
  const canRead = permissions.can(ECapability.ANALYTICS_READ);
  const canManage =
    permissions.can(ECapability.ADMIN_ACCESS) &&
    permissions.can(ECapability.GAME_MODIFY_ANY);
  const [status, setStatus] = useState<TPlatformFeedbackStatus | ''>('open');
  const [statusDrafts, setStatusDrafts] = useState<StatusDrafts>({});
  const [selectedReport, setSelectedReport] = useState<{
    readonly epoch: number;
    readonly id: string;
  } | null>(null);
  const [selectedSession, setSelectedSession] = useState<{
    readonly epoch: number;
    readonly id: string;
  } | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<{
    readonly traceId: string;
    readonly result: IPlatformAutomationReplayResult;
  } | null>(null);
  const selectedReportId =
    selectedReport?.epoch === epoch ? selectedReport.id : null;
  const selectedSessionId =
    selectedSession?.epoch === epoch ? selectedSession.id : null;

  const listParams = useMemo(
    () => ({
      limit: 100,
      kind: scopedKind,
      ...(scopedGameId ? {} : { scope: 'platform' as const }),
      ...(status ? { status } : {}),
      ...(scopedGameId ? { gameId: scopedGameId } : {}),
    }),
    [scopedGameId, scopedKind, status],
  );
  const reportsQuery = useQuery({
    queryKey: ['platform', 'feedback', 'operations', epoch, listParams],
    queryFn: () => platformFeedbackApi.list(listParams),
    enabled: canRead,
  });
  const reportDetailQuery = useQuery({
    queryKey: [
      'platform',
      'feedback',
      'operations',
      'detail',
      epoch,
      selectedReportId,
    ],
    queryFn: () => platformFeedbackApi.get(selectedReportId ?? ''),
    enabled: canRead && Boolean(selectedReportId),
  });
  const reportSessionId = reportDetailQuery.data?.sessionId;
  const reportGameId = reportDetailQuery.data?.gameId ?? scopedGameId;
  const diagnosticsQuery = useQuery({
    queryKey: ['platform', 'feedback', 'diagnostics', epoch, selectedSessionId],
    queryFn: () => platformFeedbackApi.diagnostics(selectedSessionId ?? ''),
    enabled: canRead && Boolean(selectedSessionId),
  });
  const automationTracesQuery = useQuery({
    queryKey: [
      'platform',
      'feedback',
      'automation-traces',
      epoch,
      reportGameId,
      reportSessionId,
    ],
    queryFn: () =>
      platformFeedbackApi.automationTraces(reportSessionId ?? '', {
        limit: 100,
      }),
    enabled: canManage && Boolean(reportSessionId),
  });
  const traceEvidenceQuery = useQuery({
    queryKey: [
      'platform',
      'feedback',
      'trace-evidence',
      epoch,
      reportGameId,
      selectedReportId,
      reportDetailQuery.data?.traceId,
      reportDetailQuery.data?.traceEvidenceAvailable,
    ],
    queryFn: () => platformFeedbackApi.traceEvidence(selectedReportId ?? ''),
    enabled:
      canManage &&
      reportDetailQuery.data?.traceEvidenceAvailable !== false &&
      Boolean(selectedReportId && reportDetailQuery.data?.traceId),
  });
  const statusMutation = useMutation({
    onMutate: () => epoch,
    mutationFn: (input: {
      readonly reportId: string;
      readonly status: TPlatformFeedbackStatus;
    }) => platformFeedbackApi.updateStatus(input.reportId, input.status),
    onSuccess: (_, input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      setStatusDrafts((current) => {
        const next = { ...current };
        delete next[input.reportId];
        return next;
      });
      void reportsQuery.refetch();
    },
  });
  const replayMutation = useMutation({
    mutationFn: (input: {
      readonly traceId: string;
      readonly reportId?: string;
      readonly sessionId?: string;
    }) =>
      input.reportId
        ? platformFeedbackApi.replayTraceEvidence(input.reportId)
        : platformFeedbackApi.replayAutomation(
            input.sessionId ?? '',
            input.traceId,
          ),
    onSuccess: (result, input) => {
      if (useAuthStore.getState().authEpoch !== epoch) return;
      setReplayResult({ traceId: input.traceId, result });
    },
  });

  useEffect(() => {
    setStatusDrafts({});
    setSelectedReport(null);
    setSelectedSession(null);
    setSelectedTraceId(null);
    setReplayResult(null);
    statusMutation.reset();
    replayMutation.reset();
  }, [epoch]);

  useEffect(() => {
    setSelectedTraceId(null);
    setReplayResult(null);
    replayMutation.reset();
  }, [selectedReportId]);

  useEffect(() => {
    setReplayResult(null);
    replayMutation.reset();
  }, [selectedTraceId]);

  if (!canRead) {
    return (
      <main className='space-y-6'>
        <header className='space-y-2'>
          <h1 className='font-display text-3xl font-medium text-text-100'>
            {t('operations.title')}
          </h1>
        </header>
        <Card>
          <CardContent className='pt-5'>
            <p role='alert'>{t('operations.forbidden')}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className='space-y-6'>
      <header className='space-y-2'>
        <p className='font-mono text-xs uppercase tracking-microlabel text-text-500'>
          {brandName}
        </p>
        <h1 className='font-display text-3xl font-medium text-text-100'>
          {scopedKind === 'ai'
            ? t('operations.ai_title', {
                defaultValue: 'AI issue reports',
              })
            : scopedGameId
              ? t('operations.game_title', {
                  defaultValue: 'Game error reports',
                })
              : t('operations.title')}
        </h1>
        <p className='max-w-2xl text-sm leading-relaxed text-text-300'>
          {scopedKind === 'ai'
            ? t('operations.ai_description', {
                defaultValue:
                  'Review trusted AI evidence, private traces, and dry-run results for this game.',
              })
            : scopedGameId
              ? t('operations.game_description', {
                  defaultValue:
                    'Review reports and bounded diagnostics for this game.',
                })
              : t('operations.description')}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t('operations.filters.title')}</CardTitle>
          <CardDescription>
            {t('operations.filters.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-wrap items-end gap-4'>
          <div className='min-w-48 space-y-2'>
            <Label htmlFor='operations-status'>
              {t('operations.filters.status')}
            </Label>
            <select
              id='operations-status'
              className='h-10 w-full cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as TPlatformFeedbackStatus | '')
              }
            >
              <option value=''>{t('operations.filters.all_statuses')}</option>
              {PLATFORM_FEEDBACK_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`feedback.status.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant='ghost'
            onClick={() => void reportsQuery.refetch()}
            loading={reportsQuery.isFetching && !reportsQuery.isPending}
            loadingLabel={t('operations.filters.refreshing')}
          >
            {t('operations.filters.refresh')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('operations.queue.title')}</CardTitle>
          <CardDescription>
            {t('operations.queue.count', {
              count: reportsQuery.data?.total ?? 0,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reportsQuery.isPending ? (
            <p role='status'>{t('operations.queue.loading')}</p>
          ) : reportsQuery.isError ? (
            <div className='flex flex-wrap items-center gap-3'>
              <p role='alert'>
                {errorMessage(
                  reportsQuery.error,
                  t('operations.queue.load_failed'),
                )}
              </p>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => void reportsQuery.refetch()}
              >
                {t('operations.queue.retry')}
              </Button>
            </div>
          ) : reportsQuery.data?.items.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('operations.queue.report')}</TableHead>
                  <TableHead>{t('operations.queue.reporter')}</TableHead>
                  <TableHead>{t('operations.queue.game')}</TableHead>
                  <TableHead>{t('operations.queue.status')}</TableHead>
                  {canManage ? (
                    <TableHead>{t('operations.queue.action')}</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {reportsQuery.data.items.map((report) => {
                  const nextStatus =
                    statusDrafts[report.reportId] ?? report.status;
                  const updating =
                    statusMutation.isPending &&
                    statusMutation.variables?.reportId === report.reportId;
                  return (
                    <TableRow key={report.reportId}>
                      <TableCell className='min-w-64 whitespace-normal'>
                        <div className='space-y-1'>
                          <div className='flex flex-wrap items-center gap-2'>
                            <span className='font-medium text-text-100'>
                              {t(`feedback.categories.${report.category}`)}
                            </span>
                            <span className='text-xs text-text-500'>
                              {formatDate(report.createdAt)}
                            </span>
                          </div>
                          <p className='line-clamp-3 text-sm text-text-300'>
                            {report.message}
                          </p>
                          <div className='flex flex-wrap gap-2'>
                            <Button
                              size='sm'
                              variant='link'
                              className='text-xs'
                              onClick={() =>
                                setSelectedReport({
                                  epoch,
                                  id: report.reportId,
                                })
                              }
                            >
                              {t('operations.queue.view_report')}
                            </Button>
                            {report.sessionId ? (
                              <Button
                                size='sm'
                                variant='link'
                                className='text-xs'
                                onClick={() =>
                                  setSelectedSession(
                                    report.sessionId
                                      ? { epoch, id: report.sessionId }
                                      : null,
                                  )
                                }
                              >
                                {t('operations.queue.view_diagnostics')}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className='font-mono text-xs'>
                        {report.reporterId}
                      </TableCell>
                      <TableCell>{report.gameId ?? '—'}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(report.status)}>
                          {t(`feedback.status.${report.status}`)}
                        </Badge>
                      </TableCell>
                      {canManage ? (
                        <TableCell>
                          <div className='flex min-w-48 items-center gap-2'>
                            <select
                              aria-label={t('operations.queue.status_for', {
                                category: report.category,
                              })}
                              className='h-9 min-w-28 cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-2 text-xs text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                              value={nextStatus}
                              onChange={(event) =>
                                setStatusDrafts((current) => ({
                                  ...current,
                                  [report.reportId]: event.target
                                    .value as TPlatformFeedbackStatus,
                                }))
                              }
                            >
                              {PLATFORM_FEEDBACK_STATUSES.map((value) => (
                                <option key={value} value={value}>
                                  {t(`feedback.status.${value}`)}
                                </option>
                              ))}
                            </select>
                            <Button
                              size='sm'
                              variant='ghost'
                              disabled={nextStatus === report.status}
                              loading={updating}
                              loadingLabel={t('operations.queue.updating')}
                              onClick={() =>
                                statusMutation.mutate({
                                  reportId: report.reportId,
                                  status: nextStatus,
                                })
                              }
                            >
                              {t('operations.queue.update')}
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className='text-sm text-text-300'>
              {t('operations.queue.empty')}
            </p>
          )}
          {statusMutation.isError ? (
            <p role='alert' className='mt-4 text-sm text-[var(--signal-red)]'>
              {errorMessage(
                statusMutation.error,
                t('operations.queue.update_failed'),
              )}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {selectedReportId ? (
        <Card>
          <CardHeader>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='space-y-1'>
                <CardTitle>{t('operations.report_detail.title')}</CardTitle>
                <CardDescription>
                  {t('operations.report_detail.description')}
                </CardDescription>
              </div>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setSelectedReport(null)}
              >
                {t('operations.report_detail.close')}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {reportDetailQuery.isPending ? (
              <p role='status'>{t('operations.report_detail.loading')}</p>
            ) : reportDetailQuery.isError ? (
              <div className='flex flex-wrap items-center gap-3'>
                <p role='alert'>
                  {errorMessage(
                    reportDetailQuery.error,
                    t('operations.report_detail.load_failed'),
                  )}
                </p>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => void reportDetailQuery.refetch()}
                >
                  {t('operations.report_detail.retry')}
                </Button>
              </div>
            ) : reportDetailQuery.data ? (
              <>
                <FeedbackReportDetail report={reportDetailQuery.data} t={t} />
                {reportDetailQuery.data.traceId ? (
                  <ReportTraceEvidence
                    report={reportDetailQuery.data}
                    traces={automationTracesQuery.data}
                    tracesPending={automationTracesQuery.isPending}
                    tracesError={automationTracesQuery.error}
                    onRetryTraces={() => void automationTracesQuery.refetch()}
                    traceEvidence={traceEvidenceQuery.data}
                    traceEvidenceAvailable={
                      reportDetailQuery.data.traceEvidenceAvailable
                    }
                    traceEvidencePending={traceEvidenceQuery.isPending}
                    traceEvidenceError={traceEvidenceQuery.error}
                    onRetryTraceEvidence={() =>
                      void traceEvidenceQuery.refetch()
                    }
                    selectedTraceId={selectedTraceId}
                    onSelectTrace={setSelectedTraceId}
                    canManage={canManage}
                    replayPending={replayMutation.isPending}
                    replayError={replayMutation.error}
                    onReplay={(traceId, reportBound) => {
                      if (reportBound && selectedReportId) {
                        replayMutation.mutate({
                          reportId: selectedReportId,
                          traceId,
                        });
                      } else if (reportSessionId) {
                        replayMutation.mutate({
                          sessionId: reportSessionId,
                          traceId,
                        });
                      }
                    }}
                    replayResult={replayResult}
                    t={t}
                  />
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {selectedSessionId ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('operations.diagnostics.title')}</CardTitle>
            <CardDescription>
              {t('operations.diagnostics.description', {
                session: selectedSessionId,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {diagnosticsQuery.isPending ? (
              <p role='status'>{t('operations.diagnostics.loading')}</p>
            ) : diagnosticsQuery.isError ? (
              <div className='flex flex-wrap items-center gap-3'>
                <p role='alert'>
                  {errorMessage(
                    diagnosticsQuery.error,
                    t('operations.diagnostics.load_failed'),
                  )}
                </p>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => void diagnosticsQuery.refetch()}
                >
                  {t('operations.diagnostics.retry')}
                </Button>
              </div>
            ) : diagnosticsQuery.data ? (
              <DiagnosticsView diagnostics={diagnosticsQuery.data} t={t} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}

function FeedbackReportDetail({
  report,
  t,
}: {
  readonly report: IPlatformFeedbackReport;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  return (
    <div className='space-y-4'>
      <dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
        <div>
          <dt className='text-text-500'>
            {t('operations.report_detail.status')}
          </dt>
          <dd className='mt-1 text-text-100'>
            {t(`feedback.status.${report.status}`)}
          </dd>
        </div>
        <div>
          <dt className='text-text-500'>
            {t('operations.report_detail.game')}
          </dt>
          <dd className='mt-1 text-text-100'>{report.gameId ?? '—'}</dd>
        </div>
        <div>
          <dt className='text-text-500'>
            {t('operations.report_detail.session')}
          </dt>
          <dd className='mt-1 text-text-100'>{report.sessionId ?? '—'}</dd>
        </div>
        <div>
          <dt className='text-text-500'>
            {t('operations.report_detail.created')}
          </dt>
          <dd className='mt-1 text-text-100'>{formatDate(report.createdAt)}</dd>
        </div>
      </dl>
      <div>
        <h3 className='text-sm font-medium text-text-100'>
          {t('operations.report_detail.message')}
        </h3>
        <p className='mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-300'>
          {report.message}
        </p>
      </div>
      {report.expectedBehavior ? (
        <div>
          <h3 className='text-sm font-medium text-text-100'>
            {t('operations.report_detail.expected_behavior')}
          </h3>
          <p className='mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-300'>
            {report.expectedBehavior}
          </p>
        </div>
      ) : null}
      {report.clientCrash ? (
        <div>
          <h3 className='text-sm font-medium text-text-100'>
            {t('operations.report_detail.crash')}
          </h3>
          <pre className='mt-2 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
            {jsonText(report.clientCrash)}
          </pre>
        </div>
      ) : null}
      {report.nativeDiagnostics ? (
        <div>
          <h3 className='text-sm font-medium text-text-100'>
            {t('operations.report_detail.diagnostics')}
          </h3>
          <pre className='mt-2 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
            {jsonText(report.nativeDiagnostics)}
          </pre>
        </div>
      ) : null}
      {!report.clientCrash && !report.nativeDiagnostics ? (
        <p className='text-sm text-text-300'>
          {t('operations.report_detail.empty')}
        </p>
      ) : null}
    </div>
  );
}

function ReportTraceEvidence({
  report,
  traces,
  tracesPending,
  tracesError,
  onRetryTraces,
  traceEvidence,
  traceEvidenceAvailable,
  traceEvidencePending,
  traceEvidenceError,
  onRetryTraceEvidence,
  selectedTraceId,
  onSelectTrace,
  canManage,
  replayPending,
  replayError,
  onReplay,
  replayResult,
  t,
}: {
  readonly report: IPlatformFeedbackReport;
  readonly traces: readonly IPlatformAutomationTrace[] | undefined;
  readonly tracesPending: boolean;
  readonly tracesError: unknown;
  readonly onRetryTraces: () => void;
  readonly traceEvidence: IPlatformAutomationTrace | undefined;
  readonly traceEvidenceAvailable?: boolean;
  readonly traceEvidencePending: boolean;
  readonly traceEvidenceError: unknown;
  readonly onRetryTraceEvidence: () => void;
  readonly selectedTraceId: string | null;
  readonly onSelectTrace: (traceId: string) => void;
  readonly canManage: boolean;
  readonly replayPending: boolean;
  readonly replayError: unknown;
  readonly onReplay: (traceId: string, reportBound: boolean) => void;
  readonly replayResult: {
    readonly traceId: string;
    readonly result: IPlatformAutomationReplayResult;
  } | null;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const selectedEvent = report.nativeDiagnostics?.events.find(
    (event) => event.sequence === report.eventSequence,
  );
  const selectedTrace =
    selectedTraceId === null
      ? (traces?.find((trace) => trace.traceId === report.traceId) ??
        traceEvidence)
      : (traces?.find((trace) => trace.traceId === selectedTraceId) ??
        (traceEvidence?.traceId === selectedTraceId
          ? traceEvidence
          : undefined));
  const selectedReplay =
    selectedTrace &&
    replayResult &&
    replayResult.traceId === selectedTrace.traceId
      ? replayResult.result
      : undefined;

  return (
    <section className='mt-6 space-y-4 border-t border-[color:var(--metal-edge-soft)] pt-5'>
      <div>
        <h3 className='text-sm font-medium text-text-100'>
          {t('operations.trace_evidence.title')}
        </h3>
        <p className='mt-1 text-sm leading-relaxed text-text-300'>
          {t('operations.trace_evidence.description')}
        </p>
      </div>

      <div className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument p-4'>
        <h4 className='text-sm font-medium text-text-100'>
          {t('operations.ai_evidence.selected_event')}
        </h4>
        {selectedEvent ? (
          <div className='mt-3 space-y-3'>
            <dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.sequence')}
                </dt>
                <dd className='mt-1 font-mono tabular-nums text-text-100'>
                  {selectedEvent.sequence}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.event_id')}
                </dt>
                <dd className='mt-1 break-all font-mono text-text-100'>
                  {selectedEvent.eventId}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.source')}
                </dt>
                <dd className='mt-1 text-text-100'>
                  {selectedEvent.source?.kind ??
                    t('operations.ai_evidence.unknown_source')}
                  {selectedEvent.source?.seatId
                    ? ` · ${selectedEvent.source.seatId}`
                    : ''}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.trace_reference')}
                </dt>
                <dd className='mt-1 break-all font-mono text-text-100'>
                  {selectedEvent.source?.traceId ?? report.traceId ?? '—'}
                </dd>
              </div>
            </dl>
            <div>
              <h5 className='text-xs font-medium uppercase tracking-microlabel text-text-500'>
                {t('operations.ai_evidence.event_payload')}
              </h5>
              <pre className='mt-2 max-h-64 overflow-auto rounded-[5px] bg-surface-page p-3 text-xs text-text-300'>
                {jsonText(selectedEvent.payload)}
              </pre>
            </div>
          </div>
        ) : (
          <p className='mt-2 text-sm text-text-300'>
            {t('operations.ai_evidence.no_selected_event')}
          </p>
        )}
      </div>

      <div className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument p-4'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h4 className='text-sm font-medium text-text-100'>
              {t('operations.trace_evidence.traces_title')}
            </h4>
            <p className='mt-1 text-sm leading-relaxed text-text-300'>
              {t('operations.trace_evidence.traces_description')}
            </p>
          </div>
          {canManage && tracesError ? (
            <Button size='sm' variant='ghost' onClick={onRetryTraces}>
              {t('operations.ai_evidence.retry')}
            </Button>
          ) : null}
        </div>

        {report.traceId ? (
          <div className='mt-3 rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-page p-3 text-sm'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <span className='text-text-300'>
                {t('operations.ai_evidence.report_trace')}
              </span>
              {!canManage ? (
                <span className='text-text-500'>
                  {t('operations.trace_evidence.traces_forbidden')}
                </span>
              ) : traceEvidenceAvailable === false ? (
                <span className='text-text-500'>
                  {t('operations.ai_evidence.report_trace_unavailable')}
                </span>
              ) : traceEvidencePending ? (
                <span role='status' className='text-text-500'>
                  {t('operations.ai_evidence.loading_report_trace')}
                </span>
              ) : traceEvidenceError ? (
                <div className='flex flex-wrap items-center gap-3'>
                  <span role='alert' className='text-[var(--signal-red)]'>
                    {errorMessage(
                      traceEvidenceError,
                      t('operations.ai_evidence.report_trace_failed'),
                    )}
                  </span>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={onRetryTraceEvidence}
                  >
                    {t('operations.ai_evidence.retry')}
                  </Button>
                </div>
              ) : traceEvidence ? (
                <Badge variant='success'>
                  {t('operations.ai_evidence.report_trace_loaded')}
                </Badge>
              ) : (
                <span className='text-text-500'>
                  {t('operations.ai_evidence.report_trace_missing')}
                </span>
              )}
            </div>
          </div>
        ) : null}

        {!canManage ? (
          <p className='mt-3 text-sm text-text-300'>
            {t('operations.trace_evidence.traces_forbidden')}
          </p>
        ) : tracesPending ? (
          <p role='status' className='mt-3 text-sm text-text-300'>
            {t('operations.trace_evidence.loading')}
          </p>
        ) : tracesError ? (
          <p role='alert' className='mt-3 text-sm text-[var(--signal-red)]'>
            {errorMessage(
              tracesError,
              t('operations.trace_evidence.load_failed'),
            )}
          </p>
        ) : traces?.length ? (
          <ul className='mt-3 space-y-2'>
            {traces.map((trace) => (
              <li
                key={trace.traceId}
                className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-page p-3'
              >
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <div className='flex flex-wrap items-center gap-2 text-xs text-text-500'>
                    <span className='font-mono text-text-100'>
                      {trace.traceId}
                    </span>
                    <span>
                      {trace.kind === 'automation'
                        ? t('operations.ai_evidence.automation_trace')
                        : t('operations.ai_evidence.command_trace')}
                    </span>
                    <Badge
                      variant={
                        trace.outcome === 'executed' ? 'success' : 'warning'
                      }
                    >
                      {trace.outcome}
                    </Badge>
                  </div>
                  <Button
                    size='sm'
                    variant='link'
                    className='text-xs'
                    onClick={() => onSelectTrace(trace.traceId)}
                  >
                    {t('operations.ai_evidence.inspect')}
                  </Button>
                </div>
                <dl className='mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4'>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.decision')}
                    </dt>
                    <dd className='mt-1 break-all font-mono text-text-300'>
                      {trace.decisionId}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.policy')}
                    </dt>
                    <dd className='mt-1 break-all font-mono text-text-300'>
                      {trace.policyId}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.seat')}
                    </dt>
                    <dd className='mt-1 text-text-300'>{trace.seatId}</dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.created')}
                    </dt>
                    <dd className='mt-1 text-text-300'>
                      {formatTimestamp(trace.createdAt)}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        ) : (
          <p className='mt-3 text-sm text-text-300'>
            {t('operations.trace_evidence.empty')}
          </p>
        )}

        {selectedTrace ? (
          <div className='mt-4 space-y-4 border-t border-[color:var(--metal-edge-soft)] pt-4'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <h4 className='text-sm font-medium text-text-100'>
                {t('operations.ai_evidence.trace_detail')}
              </h4>
              <Badge variant='accent'>{selectedTrace.outcome}</Badge>
            </div>
            <dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.trace_kind')}
                </dt>
                <dd className='mt-1 text-text-100'>
                  {selectedTrace.kind === 'automation'
                    ? t('operations.ai_evidence.automation_trace')
                    : t('operations.ai_evidence.command_trace')}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.trace_id')}
                </dt>
                <dd className='mt-1 break-all font-mono text-text-100'>
                  {selectedTrace.traceId}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.command')}
                </dt>
                <dd className='mt-1 break-all font-mono text-text-100'>
                  {selectedTrace.commandId}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.revision')}
                </dt>
                <dd className='mt-1 font-mono tabular-nums text-text-100'>
                  {selectedTrace.expectedRevision}
                </dd>
              </div>
              <div>
                <dt className='text-text-500'>
                  {t('operations.ai_evidence.events')}
                </dt>
                <dd className='mt-1 font-mono tabular-nums text-text-100'>
                  {selectedTrace.eventSequenceStart ?? '—'} /{' '}
                  {selectedTrace.eventSequenceCount ?? '—'}
                </dd>
              </div>
            </dl>
            <TraceValue
              label={t('operations.ai_evidence.state')}
              value={selectedTrace.state}
            />
            <TraceValue
              label={t('operations.ai_evidence.input')}
              value={selectedTrace.input}
            />
            <TraceValue
              label={t('operations.ai_evidence.options')}
              value={selectedTrace.options}
            />
            <TraceValue
              label={t('operations.ai_evidence.command_payload')}
              value={selectedTrace.command}
            />
            <TraceValue
              label={t('operations.ai_evidence.diagnostics')}
              value={selectedTrace.diagnostics}
            />
            <div className='flex flex-wrap items-center gap-3'>
              <Button
                size='sm'
                onClick={() =>
                  onReplay(
                    selectedTrace.traceId,
                    traceEvidenceAvailable !== false &&
                      traceEvidence?.traceId === selectedTrace.traceId,
                  )
                }
                loading={replayPending}
                loadingLabel={t('operations.ai_evidence.replaying')}
              >
                {t('operations.ai_evidence.replay')}
              </Button>
              {replayError ? (
                <p role='alert' className='text-sm text-[var(--signal-red)]'>
                  {errorMessage(
                    replayError,
                    t('operations.ai_evidence.replay_failed'),
                  )}
                </p>
              ) : null}
            </div>
            {selectedReplay ? (
              <div className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-page p-3'>
                <h5 className='text-sm font-medium text-text-100'>
                  {t('operations.ai_evidence.replay_result')}
                </h5>
                <dl className='mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.legal')}
                    </dt>
                    <dd className='mt-1 text-text-100'>
                      {selectedReplay.legal
                        ? t('operations.ai_evidence.legal_yes')
                        : t('operations.ai_evidence.legal_no')}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.duration')}
                    </dt>
                    <dd className='mt-1 font-mono tabular-nums text-text-100'>
                      {selectedReplay.durationMs} ms
                    </dd>
                  </div>
                  <div className='sm:col-span-2'>
                    <dt className='text-text-500'>
                      {t('operations.ai_evidence.input_digest')}
                    </dt>
                    <dd className='mt-1 break-all font-mono text-text-100'>
                      {selectedReplay.inputDigest}
                    </dd>
                  </div>
                </dl>
                <TraceValue
                  label={t('operations.ai_evidence.command_payload')}
                  value={selectedReplay.command}
                />
                <TraceValue
                  label={t('operations.ai_evidence.diagnostics')}
                  value={selectedReplay.diagnostics}
                />
                {selectedReplay.error ? (
                  <div className='mt-3 rounded-[5px] border border-[var(--signal-red)]/40 p-3 text-sm text-[var(--signal-red)]'>
                    {selectedReplay.error.code}:{' '}
                    {selectedReplay.error.messageKey}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TraceValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: unknown;
}): React.JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div className='mt-3'>
      <h5 className='text-xs font-medium uppercase tracking-microlabel text-text-500'>
        {label}
      </h5>
      <pre className='mt-2 max-h-64 overflow-auto rounded-[5px] bg-surface-page p-3 text-xs text-text-300'>
        {jsonText(value)}
      </pre>
    </div>
  );
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function DiagnosticsView({
  diagnostics,
  t,
}: {
  readonly diagnostics: IPlatformNativeDiagnostics;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  return (
    <div className='space-y-4'>
      <dl className='grid gap-3 text-sm sm:grid-cols-3'>
        <div>
          <dt className='text-text-500'>
            {t('operations.diagnostics.status')}
          </dt>
          <dd className='mt-1 text-text-100'>
            {diagnosticsStatus(diagnostics, t)}
          </dd>
        </div>
        <div>
          <dt className='text-text-500'>{t('operations.diagnostics.game')}</dt>
          <dd className='mt-1 text-text-100'>{diagnostics.gameId}</dd>
        </div>
        <div>
          <dt className='text-text-500'>
            {t('operations.diagnostics.revision')}
          </dt>
          <dd className='mt-1 font-mono tabular-nums text-text-100'>
            {diagnostics.sourceRevision}
          </dd>
        </div>
      </dl>
      <div>
        <h3 className='text-sm font-medium text-text-100'>
          {t('operations.diagnostics.summary')}
        </h3>
        <pre className='mt-2 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
          {jsonText(diagnostics.summary)}
        </pre>
      </div>
      <div>
        <h3 className='text-sm font-medium text-text-100'>
          {t('operations.diagnostics.events', {
            count: diagnostics.events.length,
          })}
        </h3>
        {diagnostics.events.length ? (
          <ul className='mt-2 space-y-2'>
            {diagnostics.events.map((event) => (
              <li
                key={`${event.sequence}-${event.eventId}`}
                className='rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument p-3'
              >
                <div className='flex flex-wrap gap-3 text-xs text-text-500'>
                  <span>
                    {t('operations.diagnostics.sequence')}: {event.sequence}
                  </span>
                  <span className='font-mono'>{event.eventId}</span>
                </div>
                <pre className='mt-2 max-h-48 overflow-auto text-xs text-text-300'>
                  {jsonText(event.payload)}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className='mt-2 text-sm text-text-300'>
            {t('operations.diagnostics.no_events')}
          </p>
        )}
      </div>
    </div>
  );
}
