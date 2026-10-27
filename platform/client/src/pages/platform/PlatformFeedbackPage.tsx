import {
  type IPlatformFeedbackReport,
  PLATFORM_FEEDBACK_CATEGORIES,
  type TPlatformFeedbackCategory,
} from '@board-platform/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createPlatformFeedbackEventId,
  platformFeedbackApi,
} from '@/api/platformFeedbackApi';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  resolvePlatformBrandName,
  usePlatformConfiguration,
} from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';

type FeedbackSearch = {
  readonly gameId?: unknown;
  readonly sessionId?: unknown;
};

type FeedbackDraft = {
  readonly category: TPlatformFeedbackCategory;
  readonly message: string;
  readonly gameId?: string;
  readonly sessionId?: string;
};

type FeedbackSubmission = {
  readonly draft: FeedbackDraft;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly eventId: string;
};

function searchString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function categoryLabel(
  category: TPlatformFeedbackCategory,
  t: (key: string) => string,
): string {
  return t(`feedback.categories.${category}`);
}

function statusLabel(
  status: IPlatformFeedbackReport['status'],
  t: (key: string) => string,
): string {
  return t(`feedback.status.${status}`);
}

function statusClass(status: IPlatformFeedbackReport['status']): string {
  if (status === 'resolved') return 'text-[oklch(0.88_0.14_160)]';
  if (status === 'ignored') return 'text-text-500';
  if (status === 'triaged') return 'text-[oklch(0.90_0.15_95)]';
  return 'text-[oklch(0.88_0.10_230)]';
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function PlatformFeedbackPage(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(configuration, t('brand.name'));
  const queryClient = useQueryClient();
  const epoch = useAuthStore((state) => state.authEpoch);
  const search = useSearch({ strict: false }) as FeedbackSearch;
  const initialGameId = searchString(search.gameId);
  const initialSessionId = searchString(search.sessionId);
  const [category, setCategory] = useState<TPlatformFeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [gameId, setGameId] = useState(initialGameId);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [selectedReport, setSelectedReport] = useState<{
    readonly epoch: number;
    readonly id: string;
  } | null>(null);
  const selectedReportId =
    selectedReport?.epoch === epoch ? selectedReport.id : null;
  const epochRef = useRef(epoch);
  const eventRef = useRef<{ fingerprint: string; eventId: string } | null>(
    null,
  );

  useEffect(() => {
    setGameId(initialGameId);
    setSessionId(initialSessionId);
  }, [initialGameId, initialSessionId]);

  const historyQuery = useQuery({
    queryKey: ['platform', 'feedback', 'mine', epoch],
    queryFn: () => platformFeedbackApi.listMine({ limit: 50 }),
  });
  const reportDetailQuery = useQuery({
    queryKey: [
      'platform',
      'feedback',
      'mine',
      'detail',
      epoch,
      selectedReportId,
    ],
    queryFn: () => platformFeedbackApi.getMine(selectedReportId ?? ''),
    enabled: Boolean(selectedReportId),
  });

  const draft = useMemo<FeedbackDraft>(
    () => ({
      category,
      message: message.trim(),
      ...(gameId.trim() ? { gameId: gameId.trim() } : {}),
      ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
    }),
    [category, gameId, message, sessionId],
  );
  const fingerprint = JSON.stringify(draft);
  const draftFingerprintRef = useRef(fingerprint);
  draftFingerprintRef.current = fingerprint;
  const submitMutation = useMutation({
    onMutate: ({ epoch: requestEpoch }: FeedbackSubmission) => requestEpoch,
    mutationFn: ({ draft: submission, eventId }: FeedbackSubmission) => {
      return platformFeedbackApi.submit({
        eventId,
        category: submission.category,
        message: submission.message,
        ...(submission.gameId ? { gameId: submission.gameId } : {}),
        ...(submission.sessionId
          ? {
              target: {
                kind: 'native-session',
                sessionId: submission.sessionId,
              },
            }
          : {}),
      });
    },
    onSuccess: (_, submission, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      if (submission.fingerprint === draftFingerprintRef.current) {
        eventRef.current = null;
        setMessage('');
        setSessionId('');
      }
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'feedback', 'mine', requestEpoch],
      });
    },
  });

  useEffect(() => {
    if (epochRef.current === epoch) return;
    epochRef.current = epoch;
    eventRef.current = null;
    setMessage('');
    setSessionId('');
    setSelectedReport(null);
    submitMutation.reset();
  }, [epoch]);

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draft.message) return;
    const current = eventRef.current;
    const eventId =
      current?.fingerprint === fingerprint
        ? current.eventId
        : createPlatformFeedbackEventId();
    eventRef.current = { fingerprint, eventId };
    submitMutation.mutate({ draft, fingerprint, epoch, eventId });
  };

  return (
    <main className='space-y-6'>
      <header className='space-y-2'>
        <p className='font-mono text-xs uppercase tracking-microlabel text-text-500'>
          {brandName}
        </p>
        <h1 className='font-display text-3xl font-medium text-text-100'>
          {t('feedback.title')}
        </h1>
        <p className='max-w-2xl text-sm leading-relaxed text-text-300'>
          {t('feedback.description')}
        </p>
      </header>

      <div className='grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]'>
        <Card>
          <CardHeader>
            <CardTitle>{t('feedback.form.title')}</CardTitle>
            <CardDescription>{t('feedback.form.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form className='space-y-4' onSubmit={submit}>
              <div className='space-y-2'>
                <Label htmlFor='feedback-category'>
                  {t('feedback.form.category')}
                </Label>
                <select
                  id='feedback-category'
                  className='h-10 w-full cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as TPlatformFeedbackCategory)
                  }
                >
                  {PLATFORM_FEEDBACK_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {categoryLabel(value, t)}
                    </option>
                  ))}
                </select>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='feedback-game'>{t('feedback.form.game')}</Label>
                <Input
                  id='feedback-game'
                  value={gameId}
                  onChange={(event) => setGameId(event.target.value)}
                  placeholder={t('feedback.form.game_placeholder')}
                  maxLength={256}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='feedback-session'>
                  {t('feedback.form.session')}
                </Label>
                <Input
                  id='feedback-session'
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                  placeholder={t('feedback.form.session_placeholder')}
                  maxLength={256}
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='feedback-message'>
                  {t('feedback.form.message')}
                </Label>
                <textarea
                  id='feedback-message'
                  className='min-h-36 w-full resize-y rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 py-2 text-sm text-text-100 placeholder:text-text-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder={t('feedback.form.message_placeholder')}
                  maxLength={20_000}
                  required
                />
              </div>
              {submitMutation.isError ? (
                <p role='alert' className='text-sm text-[var(--signal-red)]'>
                  {errorMessage(
                    submitMutation.error,
                    t('feedback.form.submit_failed'),
                  )}
                </p>
              ) : null}
              {submitMutation.isSuccess ? (
                <p
                  role='status'
                  className='text-sm text-[oklch(0.88_0.14_160)]'
                >
                  {t('feedback.form.submitted')}
                </p>
              ) : null}
              <Button
                type='submit'
                loading={submitMutation.isPending}
                loadingLabel={t('feedback.form.submitting')}
                disabled={!draft.message}
              >
                {t('feedback.form.submit')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('feedback.history.title')}</CardTitle>
            <CardDescription>
              {t('feedback.history.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {historyQuery.isPending ? (
              <p role='status'>{t('feedback.history.loading')}</p>
            ) : historyQuery.isError ? (
              <div className='flex flex-wrap items-center gap-3'>
                <p role='alert'>
                  {errorMessage(
                    historyQuery.error,
                    t('feedback.history.load_failed'),
                  )}
                </p>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => void historyQuery.refetch()}
                >
                  {t('feedback.history.retry')}
                </Button>
              </div>
            ) : historyQuery.data?.items.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('feedback.history.category')}</TableHead>
                    <TableHead>{t('feedback.history.message')}</TableHead>
                    <TableHead>{t('feedback.history.status')}</TableHead>
                    <TableHead>{t('feedback.history.created')}</TableHead>
                    <TableHead>{t('feedback.history.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historyQuery.data.items.map((report) => (
                    <TableRow key={report.reportId}>
                      <TableCell>
                        {categoryLabel(report.category, t)}
                        {report.gameId ? (
                          <span className='mt-1 block text-xs text-text-500'>
                            {report.gameId}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className='max-w-xs whitespace-normal'>
                        <p className='line-clamp-3'>{report.message}</p>
                        {report.sessionId ? (
                          <span className='mt-1 block text-xs text-text-500'>
                            {t('feedback.history.session')}: {report.sessionId}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className='whitespace-nowrap'>
                        <span
                          className={`whitespace-nowrap ${statusClass(report.status)}`}
                        >
                          {statusLabel(report.status, t)}
                        </span>
                      </TableCell>
                      <TableCell className='whitespace-nowrap text-xs text-text-500'>
                        {formatDate(report.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Button
                          size='sm'
                          variant='link'
                          className='text-xs'
                          onClick={() =>
                            setSelectedReport({ epoch, id: report.reportId })
                          }
                        >
                          {t('feedback.history.view_details')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className='text-sm text-text-300'>
                {t('feedback.history.empty')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {selectedReportId ? (
        <Card>
          <CardHeader>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='space-y-1'>
                <CardTitle>{t('feedback.detail.title')}</CardTitle>
                <CardDescription>
                  {t('feedback.detail.description')}
                </CardDescription>
              </div>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setSelectedReport(null)}
              >
                {t('feedback.detail.close')}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {reportDetailQuery.isPending ? (
              <p role='status'>{t('feedback.detail.loading')}</p>
            ) : reportDetailQuery.isError ? (
              <div className='flex flex-wrap items-center gap-3'>
                <p role='alert'>
                  {errorMessage(
                    reportDetailQuery.error,
                    t('feedback.detail.load_failed'),
                  )}
                </p>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => void reportDetailQuery.refetch()}
                >
                  {t('feedback.detail.retry')}
                </Button>
              </div>
            ) : reportDetailQuery.data ? (
              <div className='space-y-4'>
                <dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
                  <div>
                    <dt className='text-text-500'>
                      {t('feedback.detail.status')}
                    </dt>
                    <dd className='mt-1 text-text-100'>
                      {statusLabel(reportDetailQuery.data.status, t)}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('feedback.detail.game')}
                    </dt>
                    <dd className='mt-1 text-text-100'>
                      {reportDetailQuery.data.gameId ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('feedback.detail.session')}
                    </dt>
                    <dd className='mt-1 text-text-100'>
                      {reportDetailQuery.data.sessionId ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className='text-text-500'>
                      {t('feedback.detail.created')}
                    </dt>
                    <dd className='mt-1 text-text-100'>
                      {formatDate(reportDetailQuery.data.createdAt)}
                    </dd>
                  </div>
                </dl>
                <div>
                  <h3 className='text-sm font-medium text-text-100'>
                    {t('feedback.detail.message')}
                  </h3>
                  <p className='mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-300'>
                    {reportDetailQuery.data.message}
                  </p>
                </div>
                {reportDetailQuery.data.clientCrash ? (
                  <div>
                    <h3 className='text-sm font-medium text-text-100'>
                      {t('feedback.detail.crash')}
                    </h3>
                    <pre className='mt-2 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
                      {jsonText(reportDetailQuery.data.clientCrash)}
                    </pre>
                  </div>
                ) : null}
                {reportDetailQuery.data.nativeDiagnostics ? (
                  <div>
                    <h3 className='text-sm font-medium text-text-100'>
                      {t('feedback.detail.diagnostics')}
                    </h3>
                    <pre className='mt-2 max-h-72 overflow-auto rounded-[5px] bg-surface-instrument p-3 text-xs text-text-300'>
                      {jsonText(reportDetailQuery.data.nativeDiagnostics)}
                    </pre>
                  </div>
                ) : null}
                {!reportDetailQuery.data.clientCrash &&
                !reportDetailQuery.data.nativeDiagnostics ? (
                  <p className='text-sm text-text-300'>
                    {t('feedback.detail.empty')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
