import type { GameCatalogEntry, SessionStatus } from '@board-game/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PlatformSessionDirectoryRecord,
  PlatformSessionListParams,
} from '@/api/platformApi';
import { platformApi } from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { GameClientRegistration } from '@/GameClientRegistration.js';
import { getGameClient } from '@/platform/gameClientRegistry';
import { useAuthStore } from '@/stores/authStore';
import { QueryRefreshNotice } from '../QueryRefreshNotice';
import { StatusCard } from './LobbySurface';
import './platformSessionDirectory.css';

export interface PlatformSessionDirectoryProps {
  readonly gameId?: string;
  readonly registration?: GameClientRegistration;
  readonly games?: readonly GameCatalogEntry[];
}

export function PlatformSessionDirectory({
  gameId,
  registration,
  games = [],
}: PlatformSessionDirectoryProps): React.JSX.Element {
  const { t } = useTranslation('platform');
  const [selectedGameId, setSelectedGameId] = useState('');
  const queryGameId = gameId ?? (selectedGameId || undefined);
  const [scope, setScope] = useState<'mine' | 'public'>('mine');
  const [status, setStatus] =
    useState<Extract<SessionStatus, 'active' | 'completed'>>('active');
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);

  const sessionsQuery = useInfiniteQuery({
    queryKey: ['platform', 'sessions', queryGameId, scope, status, authEpoch],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params: PlatformSessionListParams = {
        ...(queryGameId ? { gameId: queryGameId } : {}),
        scope,
        status,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      return platformApi.listSessions(params);
    },
    getNextPageParam: (page) => page.nextCursor,
  });
  const items =
    sessionsQuery.data?.pages
      .flatMap((page) => page.items)
      .filter((item) => !queryGameId || item.route.gameId === queryGameId) ??
    [];
  const catalog = new Map(games.map((game) => [game.metadata.gameId, game]));
  const legacyGamesRoute = registration?.legacyRoutes?.find(
    (route) => route.pathPrefix === '/my-games',
  );

  return (
    <section
      className='mission-panel px-4 py-4 sm:px-5 sm:py-5'
      data-testid='platform-session-directory'
    >
      <div className='space-y-4'>
        <header className='flex flex-wrap items-end justify-between gap-3'>
          <div>
            <h2 className='font-display text-lg text-text-100'>
              {t('history.title')}
            </h2>
            <p className='mt-1 text-sm text-text-500'>
              {t('history.description')}
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            {!gameId ? (
              <select
                aria-label={t('history.game_label')}
                value={selectedGameId}
                onChange={(event) => setSelectedGameId(event.target.value)}
                className='platform-session-filter'
              >
                <option value=''>{t('workspace.all_games')}</option>
                {selectedGameId && !catalog.has(selectedGameId) ? (
                  <option value={selectedGameId}>{selectedGameId}</option>
                ) : null}
                {[...catalog.values()].map(({ metadata }) => (
                  <option key={metadata.gameId} value={metadata.gameId}>
                    {metadata.name}
                  </option>
                ))}
              </select>
            ) : null}
            <select
              aria-label={t('history.scope_label')}
              value={scope}
              onChange={(event) =>
                setScope(event.target.value as 'mine' | 'public')
              }
              className='platform-session-filter'
            >
              <option value='mine'>{t('history.mine')}</option>
              <option value='public'>{t('history.public')}</option>
            </select>
            <select
              aria-label={t('history.status_label')}
              value={status}
              onChange={(event) =>
                setStatus(
                  event.target.value as Extract<
                    SessionStatus,
                    'active' | 'completed'
                  >,
                )
              }
              className='platform-session-filter'
            >
              <option value='active'>{t('history.active')}</option>
              <option value='completed'>{t('history.completed')}</option>
            </select>
            {legacyGamesRoute ? (
              <Link
                to='/my-games'
                className='rounded-[4px] px-2.5 py-2 text-xs text-accent-400 hover:bg-accent-500/15 hover:text-text-100'
              >
                {t('history.legacy_games')}
              </Link>
            ) : null}
          </div>
        </header>

        {sessionsQuery.isError && sessionsQuery.data ? (
          <QueryRefreshNotice
            retrying={sessionsQuery.isFetching}
            onRetry={() =>
              void (sessionsQuery.isFetchNextPageError
                ? sessionsQuery.fetchNextPage()
                : sessionsQuery.refetch())
            }
          />
        ) : null}
        {sessionsQuery.isPending ? (
          <LoadingSpinner label={t('history.loading')} />
        ) : sessionsQuery.isError && !sessionsQuery.data ? (
          <StatusCard
            title={t('status.error')}
            actionLabel={t('status.retry')}
            onAction={() => void sessionsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <p className='rounded-[6px] bg-surface-instrument/70 px-4 py-10 text-center text-sm text-text-500'>
            {t('history.empty')}
          </p>
        ) : (
          <div className='space-y-3'>
            {items.map((item) => (
              <SessionItem
                key={item.sessionId}
                item={item}
                scope={scope}
                userId={userId}
                registration={registration}
                game={catalog.get(item.route.gameId)}
              />
            ))}
          </div>
        )}

        {sessionsQuery.hasNextPage ? (
          <div className='flex justify-center border-t border-[color:var(--metal-edge-soft)] pt-4'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => void sessionsQuery.fetchNextPage()}
              loading={sessionsQuery.isFetchingNextPage}
              loadingLabel={t('history.loading')}
            >
              {t('history.load_more')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SessionItem({
  item,
  scope,
  userId,
  registration,
  game,
}: {
  readonly item: PlatformSessionDirectoryRecord;
  readonly scope: 'mine' | 'public';
  readonly userId?: string;
  readonly registration?: GameClientRegistration;
  readonly game?: GameCatalogEntry;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const canResume =
    item.status === 'active' &&
    scope === 'mine' &&
    userId !== undefined &&
    item.participants.some((participant) => participant.principalId === userId);
  const gameRegistration =
    getGameClient(item.route.gameId) ??
    (registration?.gameId === item.route.gameId ? registration : undefined);
  const gameName = game?.metadata.name ?? item.route.gameId;
  const cover = game?.metadata.coverUrl ?? gameRegistration?.metadata.cover;
  const gamePath =
    item.status === 'completed'
      ? '/game/$gameId/end'
      : canResume
        ? '/game/$gameId'
        : '/game/$gameId/spectate';
  return (
    <article className='platform-session-row'>
      {cover ? (
        <img
          className='platform-session-cover'
          src={cover}
          alt=''
          loading='lazy'
        />
      ) : null}
      <div className='platform-session-details space-y-1'>
        <p className='truncate text-sm font-medium text-text-100'>
          {gameRegistration
            ? t(gameRegistration.metadata.nameKey, { defaultValue: gameName })
            : gameName}
        </p>
        <p className='truncate text-xs text-text-400'>
          {t('modes.' + item.route.modeId, {
            defaultValue: item.route.modeId,
          })}
        </p>
        <p className='platform-session-participants text-xs text-text-400'>
          {item.participants
            .map(
              (participant, index) =>
                participant.publicProfile?.displayName ||
                t('history.player', { number: index + 1 }),
            )
            .join(' · ')}
        </p>
        <p className='text-xs text-text-500'>
          {t('history.players', { count: item.participants.length })} ·{' '}
          <time dateTime={new Date(item.updatedAt).toISOString()}>
            {new Date(item.updatedAt).toLocaleString(undefined, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
          </time>
        </p>
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <Badge variant={item.status === 'completed' ? 'success' : 'warning'}>
          {t('history.status.' + item.status)}
        </Badge>
        <Link
          to={gamePath}
          params={{ gameId: item.sessionId }}
          className='rounded-[4px] px-2.5 py-1.5 text-xs text-accent-400 hover:bg-accent-500/15 hover:text-text-100'
        >
          {item.status === 'completed'
            ? t('history.result')
            : canResume
              ? t('history.resume')
              : t('history.watch')}
        </Link>
      </div>
    </article>
  );
}
