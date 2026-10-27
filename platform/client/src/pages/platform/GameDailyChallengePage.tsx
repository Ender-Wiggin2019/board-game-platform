import type { JsonObject, JsonValue } from '@board-game/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createDailyChallengeRequestId,
  type PlatformDailyChallengeAttempt,
  type PlatformDailyChallengeDefinition,
  type PlatformDailyChallengeToday,
  type PlatformDailyGrinderLeaderboard,
  type PlatformDailyGrinderLeaderboardEntry,
  type PlatformDailyLeaderboardEntry,
  type PlatformDailyLeaderboards,
  type PlatformDailyScoreLeaderboard,
  type PlatformDailyScoreLeaderboardEntry,
  platformGameApi,
} from '@/api/platformGameApi.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.js';
import { useAuthStore } from '@/stores/authStore.js';

export interface GameDailyChallengeRendererProps {
  readonly gameId: string;
  readonly challenge: PlatformDailyChallengeDefinition;
}

export type GameDailyChallengeRenderer =
  React.ComponentType<GameDailyChallengeRendererProps>;

type DailyBoard = 'firstLook' | 'overall' | 'grinder';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isDailyChallengeDateChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { responseMessageKey?: unknown }).responseMessageKey ===
      'platform.daily.date_changed'
  );
}

function recordValue(value: JsonValue | undefined): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return value as JsonObject;
}

function numberValue(
  value: JsonValue | undefined,
  key: string,
): number | undefined {
  const record = recordValue(value);
  const result = record?.[key];
  return typeof result === 'number' && Number.isFinite(result)
    ? result
    : undefined;
}

function attemptRank(
  attempt: PlatformDailyChallengeAttempt | undefined,
): number | undefined {
  return attempt ? numberValue(attempt.result, 'rank') : undefined;
}

function formatDateTime(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fallbackAttempt(
  attempt: PlatformDailyChallengeAttempt | undefined,
): PlatformDailyChallengeAttempt | undefined {
  return attempt
    ? {
        ...attempt,
        attemptNumber: attempt.attemptNumber ?? 1,
        publicationState: attempt.publicationState ?? 'pending',
      }
    : undefined;
}

function fallbackAttempts(
  today: PlatformDailyChallengeToday | undefined,
): readonly PlatformDailyChallengeAttempt[] {
  if (today?.attempts?.length) return today.attempts;
  const attempt = fallbackAttempt(today?.attempt);
  return attempt ? [attempt] : [];
}

function legacyLeaderboards(
  entries: readonly PlatformDailyLeaderboardEntry[],
  date: string,
): PlatformDailyLeaderboards {
  const normalized = entries.map<PlatformDailyScoreLeaderboardEntry>(
    (entry, index) => ({
      rank: entry.rank ?? index + 1,
      entryKey: entry.entryKey ?? `legacy:${date}:${index}`,
      ...(entry.principalId ? { principalId: entry.principalId } : {}),
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      publicationState: entry.publicationState ?? 'public',
      ...(entry.isCurrentUser ? { isCurrentUser: true } : {}),
      attemptNumber: entry.attemptNumber ?? 1,
      score: entry.score,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      completedAt: entry.completedAt,
      ...(entry.replayAvailable ? { replayAvailable: true } : {}),
    }),
  );
  return {
    date,
    firstLook: { date, top: normalized },
    overall: { date, top: normalized },
    grinder: { date, top: [] },
  };
}

function isLeaderboards(value: unknown): value is PlatformDailyLeaderboards {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PlatformDailyLeaderboards>;
  return Boolean(candidate.firstLook && candidate.overall && candidate.grinder);
}

function normalizeLeaderboards(
  value: unknown,
  date: string,
): PlatformDailyLeaderboards | undefined {
  if (isLeaderboards(value)) return value;
  if (Array.isArray(value))
    return legacyLeaderboards(
      value as readonly PlatformDailyLeaderboardEntry[],
      date,
    );
  return undefined;
}

function attemptStatusVariant(
  status: PlatformDailyChallengeAttempt['status'] | undefined,
): 'accent' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'abandoned') return 'danger';
  if (status === 'starting' || status === 'started') return 'accent';
  return 'neutral';
}

export function GameDailyChallengePage({
  gameId,
  renderChallenge: ChallengeRenderer,
}: {
  readonly gameId: string;
  /** The game owns the presentation of its fixed scenario and AI settings. */
  readonly renderChallenge?: GameDailyChallengeRenderer;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const [selectedDate, setSelectedDate] = useState<string>();
  const [selectedBoard, setSelectedBoard] = useState<DailyBoard>('firstLook');
  const startRequestContext = `${gameId}\u0000${authEpoch}\u0000${userId ?? 'anonymous'}`;
  const startRequestContextRef = useRef(startRequestContext);
  const startRequestId = useRef<string>();
  if (startRequestContextRef.current !== startRequestContext) {
    startRequestContextRef.current = startRequestContext;
    startRequestId.current = undefined;
  }

  const todayQuery = useQuery({
    queryKey: [
      'game',
      gameId,
      'daily-challenge',
      'today',
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () => platformGameApi.getDailyChallengeToday(gameId),
    refetchInterval: 30_000,
  });
  const today = todayQuery.data;
  const todayDate = today?.challenge.challengeDate;
  const activeDate = selectedDate ?? todayDate;
  const isHistoricalDate = Boolean(activeDate && activeDate !== todayDate);

  const legacyLeaderboardQuery = useQuery({
    queryKey: [
      'game',
      gameId,
      'daily-challenge',
      'leaderboard',
      activeDate,
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () =>
      platformGameApi.getDailyChallengeLeaderboard(gameId, activeDate ?? ''),
    enabled: Boolean(activeDate && !isHistoricalDate && !today?.leaderboards),
  });
  const leaderboardsQuery = useQuery({
    queryKey: [
      'game',
      gameId,
      'daily-challenge',
      'leaderboards',
      activeDate,
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () =>
      platformGameApi.getDailyChallengeLeaderboards(gameId, activeDate ?? ''),
    enabled: Boolean(activeDate && isHistoricalDate),
  });
  const attemptsQuery = useQuery({
    queryKey: [
      'game',
      gameId,
      'daily-challenge',
      'attempts',
      activeDate,
      authEpoch,
      userId ?? 'anonymous',
    ],
    queryFn: () =>
      platformGameApi.getDailyChallengeAttempts(gameId, activeDate ?? ''),
    enabled: Boolean(activeDate && isHistoricalDate),
  });

  const startMutation = useMutation({
    mutationFn: ({
      requestId,
    }: {
      readonly requestId: string;
      readonly context: string;
    }) => platformGameApi.startDailyChallenge(gameId, requestId),
    onSuccess: (result, variables) => {
      if (
        variables.context !== startRequestContextRef.current ||
        variables.requestId !== startRequestId.current
      )
        return;
      startRequestId.current = undefined;
      void queryClient.invalidateQueries({
        queryKey: ['game', gameId, 'daily-challenge'],
      });
      void navigate({
        to: '/game/$gameId',
        params: { gameId: result.start.sessionId },
      });
    },
  });
  const publicationMutation = useMutation({
    mutationFn: ({
      sessionId,
      publicationState,
    }: {
      readonly sessionId: string;
      readonly publicationState: 'public' | 'anonymous';
    }) =>
      platformGameApi.updateDailyChallengePublication(gameId, sessionId, {
        publicationState,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['game', gameId, 'daily-challenge'],
      });
    },
  });

  const challenge = today?.challenge;
  const todayAttempts = fallbackAttempts(today);
  const activeAttempt = fallbackAttempt(
    today?.activeAttempt ??
      (today?.attempt?.status === 'starting' ||
      today?.attempt?.status === 'started'
        ? today.attempt
        : undefined),
  );
  const latestAttempt = fallbackAttempt(today?.latestAttempt ?? today?.attempt);
  const attempts = isHistoricalDate
    ? (attemptsQuery.data?.attempts ?? [])
    : todayAttempts;
  const leaderboards = isHistoricalDate
    ? normalizeLeaderboards(leaderboardsQuery.data, activeDate ?? '')
    : normalizeLeaderboards(
        today?.leaderboards ?? legacyLeaderboardQuery.data,
        activeDate ?? todayDate ?? '',
      );
  const historyDates = useMemo(() => {
    const dates = [todayDate, ...(today?.historyDates ?? [])].filter(
      (date): date is string => Boolean(date),
    );
    return [...new Set(dates)];
  }, [today?.historyDates, todayDate]);
  const boardsLoading = isHistoricalDate
    ? leaderboardsQuery.isPending
    : !today?.leaderboards && legacyLeaderboardQuery.isPending;
  const boardsError = isHistoricalDate
    ? leaderboardsQuery.error
    : legacyLeaderboardQuery.error;
  const attemptsLoading = isHistoricalDate && attemptsQuery.isPending;
  const canResume = Boolean(activeAttempt?.sessionId);
  const primaryLabel = canResume
    ? t('game_pages.daily.resume', { defaultValue: 'Resume challenge' })
    : (today?.attemptCount ?? todayAttempts.length) > 0
      ? t('game_pages.daily.retry_challenge', {
          defaultValue: 'Try another challenge',
        })
      : t('game_pages.daily.start', { defaultValue: 'Start challenge' });

  const startOrResume = (): void => {
    if (activeAttempt?.sessionId) {
      void navigate({
        to: '/game/$gameId',
        params: { gameId: activeAttempt.sessionId },
      });
      return;
    }
    const requestId = startRequestId.current ?? createDailyChallengeRequestId();
    startRequestId.current = requestId;
    startMutation.mutate({ requestId, context: startRequestContext });
  };

  if (todayQuery.isPending) {
    return (
      <Card>
        <CardContent className='py-8'>
          <p role='status'>
            {t('game_pages.loading', { defaultValue: 'Loading…' })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (todayQuery.isError || !today || !challenge) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {t('game_pages.daily.title', { defaultValue: 'Daily challenge' })}
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p role='alert'>
            {errorMessage(
              todayQuery.error,
              t('game_pages.load_failed', {
                defaultValue: 'This game page could not be loaded.',
              }),
            )}
          </p>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void todayQuery.refetch()}
          >
            {t('game_pages.retry', { defaultValue: 'Retry' })}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className='space-y-5' data-testid='game-daily-challenge-page'>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div>
              <CardTitle>
                {t('game_pages.daily.title', {
                  defaultValue: 'Daily challenge',
                })}
              </CardTitle>
              <CardDescription>
                {t('game_pages.daily.description', {
                  defaultValue:
                    'Play today’s fixed scenario and compare your result.',
                })}
              </CardDescription>
            </div>
            <Badge variant='accent'>{challenge.challengeDate}</Badge>
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
          {ChallengeRenderer ? (
            <ChallengeRenderer gameId={gameId} challenge={challenge} />
          ) : (
            <div className='space-y-3'>
              <p className='text-sm text-text-400'>
                {t('game_pages.daily.fixed_scenario', {
                  defaultValue: 'Today’s fixed scenario is ready to play.',
                })}
              </p>
              <dl className='grid gap-3 sm:grid-cols-2'>
                <Definition
                  label={t('game_pages.daily.date', {
                    defaultValue: 'Challenge date',
                  })}
                  value={challenge.challengeDate}
                />
                <Definition
                  label={t('game_pages.daily.seed', {
                    defaultValue: 'Fixed seed',
                  })}
                  value={challenge.seed}
                  mono
                />
              </dl>
            </div>
          )}
        </CardContent>
      </Card>

      <section className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.6fr)]'>
        <Card>
          <CardHeader>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <CardTitle>
                  {t('game_pages.daily.status', {
                    defaultValue: 'Challenge status',
                  })}
                </CardTitle>
                <CardDescription>
                  {activeAttempt
                    ? t('game_pages.daily.active_description', {
                        defaultValue:
                          'Continue the active attempt or start another after it is complete.',
                      })
                    : t('game_pages.daily.ready_description', {
                        defaultValue:
                          'The scenario is frozen for the day. Your next attempt will use this configuration.',
                      })}
                </CardDescription>
              </div>
              {challenge.finalizedAt ? (
                <Badge variant='success'>
                  {t('game_pages.daily.finalized', {
                    defaultValue: 'Finalized',
                  })}
                </Badge>
              ) : (
                <Badge variant='warning'>
                  {t('game_pages.daily.next_refresh', {
                    defaultValue: 'Next refresh {{time}}',
                    time: formatDateTime(today.nextRefreshAt),
                  })}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex flex-wrap items-center gap-2'>
              <Badge variant={attemptStatusVariant(activeAttempt?.status)}>
                {attemptStatusLabel(t, activeAttempt?.status)}
              </Badge>
              {latestAttempt ? (
                <Badge variant='data'>
                  {t('game_pages.daily.attempt_number', {
                    defaultValue: 'Attempt #{{number}}',
                    number: latestAttempt.attemptNumber,
                  })}
                </Badge>
              ) : null}
              <Badge variant='neutral'>
                {t('game_pages.daily.attempt_count', {
                  defaultValue: '{{count}} attempts',
                  count: today.attemptCount ?? todayAttempts.length,
                })}
              </Badge>
            </div>
            <div className='flex flex-wrap items-center gap-3'>
              <Button
                loading={startMutation.isPending}
                loadingLabel={t('game_pages.daily.starting', {
                  defaultValue: 'Starting challenge',
                })}
                onClick={startOrResume}
              >
                {primaryLabel}
              </Button>
              {latestAttempt?.score !== undefined ? (
                <p className='text-sm text-text-400'>
                  {t('game_pages.daily.result', {
                    defaultValue:
                      'Your result: score {{score}}, rank {{rank}}.',
                    score: latestAttempt.score,
                    rank: attemptRank(latestAttempt) ?? '—',
                  })}
                </p>
              ) : null}
            </div>
            {startMutation.isError ? (
              <p role='alert' className='text-sm text-[var(--signal-red)]'>
                {errorMessage(
                  startMutation.error,
                  t('game_pages.daily.start_failed', {
                    defaultValue: 'The daily challenge could not be started.',
                  }),
                )}
              </p>
            ) : null}
          </CardContent>
        </Card>
        <MyRankPanel leaderboards={leaderboards} loading={boardsLoading} />
      </section>

      <Card data-testid='daily-challenge-leaderboard'>
        <CardHeader>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <CardTitle>
                {t('game_pages.daily.leaderboard', {
                  defaultValue: 'Leaderboards',
                })}
              </CardTitle>
              <CardDescription>
                {activeDate ??
                  t('game_pages.daily.no_date', { defaultValue: 'No date' })}
              </CardDescription>
            </div>
            <div className='w-full sm:w-56'>
              <Select
                value={activeDate ?? ''}
                onValueChange={(value) => setSelectedDate(value)}
              >
                <SelectTrigger
                  aria-label={t('game_pages.daily.date_select_aria', {
                    defaultValue: 'Daily challenge date',
                  })}
                >
                  <SelectValue
                    placeholder={t('game_pages.daily.select_date', {
                      defaultValue: 'Select date',
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {historyDates.map((date) => (
                    <SelectItem key={date} value={date}>
                      {date}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className='space-y-4'>
          <div className='lg:hidden'>
            <Tabs
              defaultValue='firstLook'
              value={selectedBoard}
              onValueChange={(value) => setSelectedBoard(value as DailyBoard)}
            >
              <TabsList className='flex flex-wrap'>
                <TabsTrigger value='firstLook'>
                  {t('game_pages.daily.boards.first_look', {
                    defaultValue: 'First Look',
                  })}
                </TabsTrigger>
                <TabsTrigger value='overall'>
                  {t('game_pages.daily.boards.overall', {
                    defaultValue: 'Overall',
                  })}
                </TabsTrigger>
                <TabsTrigger value='grinder'>
                  {t('game_pages.daily.boards.grinder', {
                    defaultValue: 'Grinder',
                  })}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {boardsError ? (
            <div className='flex flex-wrap items-center gap-3'>
              <p role='alert'>
                {isDailyChallengeDateChanged(boardsError)
                  ? t('game_pages.daily.leaderboard_date_changed', {
                      defaultValue:
                        'The challenge date changed. Refresh today to load the current leaderboard.',
                    })
                  : errorMessage(
                      boardsError,
                      t('game_pages.daily.leaderboard_failed', {
                        defaultValue:
                          'The public leaderboard could not be loaded.',
                      }),
                    )}
              </p>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => {
                  if (isDailyChallengeDateChanged(boardsError)) {
                    setSelectedDate(undefined);
                    void todayQuery.refetch();
                  } else if (isHistoricalDate) {
                    void leaderboardsQuery.refetch();
                  } else {
                    void legacyLeaderboardQuery.refetch();
                  }
                }}
              >
                {isDailyChallengeDateChanged(boardsError)
                  ? t('game_pages.daily.refresh_date', {
                      defaultValue: 'Refresh today',
                    })
                  : t('game_pages.retry', { defaultValue: 'Retry' })}
              </Button>
            </div>
          ) : boardsLoading ? (
            <p role='status'>
              {t('game_pages.loading', { defaultValue: 'Loading…' })}
            </p>
          ) : (
            <div className='grid gap-4 lg:grid-cols-3'>
              <BoardSlot
                board='firstLook'
                selectedBoard={selectedBoard}
                label={t('game_pages.daily.boards.first_look', {
                  defaultValue: 'First Look',
                })}
                scoreBoard={leaderboards?.firstLook}
                grinderBoard={undefined}
              />
              <BoardSlot
                board='overall'
                selectedBoard={selectedBoard}
                label={t('game_pages.daily.boards.overall', {
                  defaultValue: 'Overall',
                })}
                scoreBoard={leaderboards?.overall}
                grinderBoard={undefined}
              />
              <BoardSlot
                board='grinder'
                selectedBoard={selectedBoard}
                label={t('game_pages.daily.boards.grinder', {
                  defaultValue: 'Grinder',
                })}
                scoreBoard={undefined}
                grinderBoard={leaderboards?.grinder}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <AttemptsPanel
        attempts={attempts}
        isLoading={attemptsLoading}
        publishingSessionId={
          publicationMutation.isPending
            ? publicationMutation.variables?.sessionId
            : undefined
        }
        publicationError={publicationMutation.error}
        publicationErrorSessionId={
          publicationMutation.isError
            ? publicationMutation.variables?.sessionId
            : undefined
        }
        onPublicationChange={(sessionId, publicationState) =>
          publicationMutation.mutate({ sessionId, publicationState })
        }
      />
    </div>
  );
}

function Definition({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className='text-text-500'>{label}</dt>
      <dd className={`mt-1 text-text-100${mono ? ' font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function attemptStatusLabel(
  t: ReturnType<typeof useTranslation<'platform'>>['t'],
  status: PlatformDailyChallengeAttempt['status'] | undefined,
): string {
  if (status === 'completed')
    return t('game_pages.daily.status_completed', {
      defaultValue: 'Completed',
    });
  if (status === 'abandoned')
    return t('game_pages.daily.status_abandoned', {
      defaultValue: 'Abandoned',
    });
  if (status === 'started')
    return t('game_pages.daily.status_started', {
      defaultValue: 'In progress',
    });
  if (status === 'starting')
    return t('game_pages.daily.status_starting', { defaultValue: 'Starting' });
  return t('game_pages.daily.status_not_started', {
    defaultValue: 'Not started',
  });
}

function MyRankPanel({
  leaderboards,
  loading,
}: {
  readonly leaderboards?: PlatformDailyLeaderboards;
  readonly loading: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('game_pages.daily.my_rank', { defaultValue: 'My rank' })}
        </CardTitle>
        <CardDescription>
          {t('game_pages.daily.my_rank_description', {
            defaultValue: 'Your best eligible result for this date.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p role='status'>
            {t('game_pages.loading', { defaultValue: 'Loading…' })}
          </p>
        ) : (
          <dl className='grid gap-3 sm:grid-cols-3 lg:grid-cols-1'>
            <RankValue
              label={t('game_pages.daily.boards.first_look', {
                defaultValue: 'First Look',
              })}
              value={leaderboards?.firstLook.me?.rank}
            />
            <RankValue
              label={t('game_pages.daily.boards.overall', {
                defaultValue: 'Overall',
              })}
              value={leaderboards?.overall.me?.rank}
            />
            <RankValue
              label={t('game_pages.daily.boards.grinder', {
                defaultValue: 'Grinder',
              })}
              value={leaderboards?.grinder.me?.rank}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function RankValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value?: number;
}): React.JSX.Element {
  return (
    <div>
      <dt className='text-xs uppercase tracking-[0.12em] text-text-500'>
        {label}
      </dt>
      <dd className='mt-1 font-display text-2xl font-semibold tabular-nums text-text-100'>
        {value ?? '—'}
      </dd>
    </div>
  );
}

function BoardSlot({
  board,
  selectedBoard,
  label,
  scoreBoard,
  grinderBoard,
}: {
  readonly board: DailyBoard;
  readonly selectedBoard: DailyBoard;
  readonly label: string;
  readonly scoreBoard?: PlatformDailyScoreLeaderboard;
  readonly grinderBoard?: PlatformDailyGrinderLeaderboard;
}): React.JSX.Element {
  const hiddenOnMobile =
    board !== selectedBoard ? 'hidden lg:block' : undefined;
  return (
    <div className={hiddenOnMobile}>
      {scoreBoard && board !== 'grinder' ? (
        <ScoreBoard label={label} board={board} scoreBoard={scoreBoard} />
      ) : grinderBoard ? (
        <GrinderBoard label={label} board={grinderBoard} />
      ) : (
        <div className='rounded-[5px] bg-surface-instrument p-4'>
          <h3 className='font-semibold text-text-100'>{label}</h3>
          <p className='mt-3 text-sm text-text-400'>No results yet.</p>
        </div>
      )}
    </div>
  );
}

function ScoreBoard({
  label,
  board,
  scoreBoard,
}: {
  readonly label: string;
  readonly board: Exclude<DailyBoard, 'grinder'>;
  readonly scoreBoard: PlatformDailyScoreLeaderboard;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <div className='overflow-x-auto rounded-[5px] bg-surface-instrument p-3'>
      <h3 className='mb-3 font-semibold text-text-100'>{label}</h3>
      {scoreBoard.top.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t('game_pages.daily.rank', { defaultValue: 'Rank' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.player', { defaultValue: 'Player' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.attempt', { defaultValue: 'Attempt' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.score', { defaultValue: 'Score' })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scoreBoard.top.map((entry) => {
              const replayId = replaySessionId(entry, board);
              return (
                <TableRow key={entry.entryKey}>
                  <TableCell>{entry.rank}</TableCell>
                  <TableCell>
                    <span>{entryDisplayName(t, entry)}</span>
                    {entry.isCurrentUser ? (
                      <Badge className='ml-2' variant='accent'>
                        {t('game_pages.daily.you', { defaultValue: 'You' })}
                      </Badge>
                    ) : null}
                    {replayId ? (
                      <a
                        className='ml-2 text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
                        href={`/game/${encodeURIComponent(replayId)}/replay`}
                      >
                        {t('game_pages.daily.replay_available', {
                          defaultValue: 'Replay available',
                        })}
                      </a>
                    ) : null}
                  </TableCell>
                  <TableCell className='tabular-nums'>
                    #{entry.attemptNumber}
                  </TableCell>
                  <TableCell className='font-mono tabular-nums'>
                    {entry.score}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className='text-sm text-text-400'>
          {t('game_pages.daily.leaderboard_empty', {
            defaultValue: 'No public results are available yet.',
          })}
        </p>
      )}
    </div>
  );
}

function GrinderBoard({
  label,
  board,
}: {
  readonly label: string;
  readonly board: PlatformDailyGrinderLeaderboard;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <div className='overflow-x-auto rounded-[5px] bg-surface-instrument p-3'>
      <h3 className='mb-3 font-semibold text-text-100'>{label}</h3>
      {board.top.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t('game_pages.daily.rank', { defaultValue: 'Rank' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.player', { defaultValue: 'Player' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.attempts', { defaultValue: 'Attempts' })}
              </TableHead>
              <TableHead>
                {t('game_pages.daily.best_score', {
                  defaultValue: 'Best score',
                })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {board.top.map((entry) => (
              <TableRow key={entry.entryKey}>
                <TableCell>{entry.rank}</TableCell>
                <TableCell>
                  <span>{entryDisplayName(t, entry)}</span>
                  {entry.isCurrentUser ? (
                    <Badge className='ml-2' variant='accent'>
                      {t('game_pages.daily.you', { defaultValue: 'You' })}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className='tabular-nums'>
                  {entry.attemptCount}
                </TableCell>
                <TableCell className='font-mono tabular-nums'>
                  {entry.bestScore ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className='text-sm text-text-400'>
          {t('game_pages.daily.leaderboard_empty', {
            defaultValue: 'No public results are available yet.',
          })}
        </p>
      )}
    </div>
  );
}

function entryDisplayName(
  t: ReturnType<typeof useTranslation<'platform'>>['t'],
  entry: Pick<
    PlatformDailyScoreLeaderboardEntry | PlatformDailyGrinderLeaderboardEntry,
    'displayName' | 'publicationState'
  >,
): string {
  if (entry.publicationState === 'anonymous')
    return t('game_pages.daily.anonymous_player', {
      defaultValue: 'Anonymous player',
    });
  return (
    entry.displayName ??
    t('game_pages.daily.public_player', { defaultValue: 'Public player' })
  );
}

type ReplayableDailyScoreEntry = PlatformDailyScoreLeaderboardEntry & {
  readonly sessionId?: string;
};

function replaySessionId(
  entry: PlatformDailyScoreLeaderboardEntry,
  board: Exclude<DailyBoard, 'grinder'>,
): string | undefined {
  if (board !== 'firstLook' && board !== 'overall') return undefined;
  if (
    entry.replayAvailable !== true ||
    entry.rank > 3 ||
    (entry.publicationState !== 'public' && entry.isCurrentUser !== true)
  )
    return undefined;
  const sessionId = (entry as ReplayableDailyScoreEntry).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0
    ? sessionId
    : undefined;
}

function AttemptsPanel({
  attempts,
  isLoading,
  publishingSessionId,
  publicationError,
  publicationErrorSessionId,
  onPublicationChange,
}: {
  readonly attempts: readonly PlatformDailyChallengeAttempt[];
  readonly isLoading: boolean;
  readonly publishingSessionId?: string;
  readonly publicationError: unknown;
  readonly publicationErrorSessionId?: string;
  readonly onPublicationChange: (
    sessionId: string,
    publicationState: 'public' | 'anonymous',
  ) => void;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t('game_pages.daily.my_attempts', { defaultValue: 'My attempts' })}
        </CardTitle>
        <CardDescription>
          {t('game_pages.daily.publication_description', {
            defaultValue:
              'Completed attempts stay pending until you choose public or anonymous publication.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p role='status'>
            {t('game_pages.loading', { defaultValue: 'Loading…' })}
          </p>
        ) : attempts.length === 0 ? (
          <p className='text-sm text-text-400'>
            {t('game_pages.daily.no_attempts', {
              defaultValue: 'No attempts for this date.',
            })}
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t('game_pages.daily.attempt', { defaultValue: 'Attempt' })}
                  </TableHead>
                  <TableHead>
                    {t('game_pages.daily.status_label', {
                      defaultValue: 'Status',
                    })}
                  </TableHead>
                  <TableHead>
                    {t('game_pages.daily.score', { defaultValue: 'Score' })}
                  </TableHead>
                  <TableHead>
                    {t('game_pages.daily.publication', {
                      defaultValue: 'Publication',
                    })}
                  </TableHead>
                  <TableHead>
                    {t('game_pages.daily.completed_at', {
                      defaultValue: 'Completed',
                    })}
                  </TableHead>
                  <TableHead>
                    {t('game_pages.daily.actions_label', {
                      defaultValue: 'Actions',
                    })}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attempts.map((attempt) => (
                  <TableRow key={attempt.attemptId}>
                    <TableCell className='tabular-nums'>
                      #{attempt.attemptNumber}
                    </TableCell>
                    <TableCell>
                      <Badge variant={attemptStatusVariant(attempt.status)}>
                        {attemptStatusLabel(t, attempt.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className='font-mono tabular-nums'>
                      {attempt.score ?? '—'}
                    </TableCell>
                    <TableCell>
                      <PublicationLabel attempt={attempt} />
                    </TableCell>
                    <TableCell>{formatDateTime(attempt.completedAt)}</TableCell>
                    <TableCell>
                      {attempt.status === 'completed' &&
                      attempt.publicationState === 'pending' &&
                      attempt.sessionId ? (
                        <div className='flex flex-wrap gap-2'>
                          <Button
                            size='sm'
                            variant='ghost'
                            loading={publishingSessionId === attempt.sessionId}
                            onClick={() =>
                              onPublicationChange(
                                attempt.sessionId as string,
                                'public',
                              )
                            }
                          >
                            {t('game_pages.daily.publish_public', {
                              defaultValue: 'Publish publicly',
                            })}
                          </Button>
                          <Button
                            size='sm'
                            variant='ghost'
                            loading={publishingSessionId === attempt.sessionId}
                            onClick={() =>
                              onPublicationChange(
                                attempt.sessionId as string,
                                'anonymous',
                              )
                            }
                          >
                            {t('game_pages.daily.publish_anonymous', {
                              defaultValue: 'Publish anonymously',
                            })}
                          </Button>
                        </div>
                      ) : null}
                      {publicationError &&
                      publicationErrorSessionId === attempt.sessionId ? (
                        <p
                          role='alert'
                          className='mt-2 text-xs text-[var(--signal-red)]'
                        >
                          {errorMessage(
                            publicationError,
                            t('game_pages.daily.publication_failed', {
                              defaultValue: 'Publication could not be updated.',
                            }),
                          )}
                        </p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PublicationLabel({
  attempt,
}: {
  readonly attempt: PlatformDailyChallengeAttempt;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  if (attempt.publicationState === 'public')
    return (
      <Badge variant='success'>
        {t('game_pages.daily.publication_public', { defaultValue: 'Public' })}
      </Badge>
    );
  if (attempt.publicationState === 'anonymous')
    return (
      <Badge variant='info'>
        {t('game_pages.daily.publication_anonymous', {
          defaultValue: 'Anonymous',
        })}
      </Badge>
    );
  return (
    <div>
      <Badge variant='warning'>
        {t('game_pages.daily.publication_pending', { defaultValue: 'Pending' })}
      </Badge>
      {attempt.autoPublishAt ? (
        <span className='ml-2 text-xs text-text-500'>
          {t('game_pages.daily.publication_pending_until', {
            defaultValue: 'Auto-publishes at {{time}}',
            time: formatDateTime(attempt.autoPublishAt),
          })}
        </span>
      ) : null}
    </div>
  );
}
