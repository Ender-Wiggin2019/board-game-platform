import type {
  AchievementCollection,
  GameCatalogEntry,
  GameProfileSummary,
  GameRankingSummary,
  GameWallet,
  JsonValue,
} from '@board-game/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { createElement, lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { platformGamesApi } from '@/api/platformGamesApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  AchievementGallery,
  type AchievementGalleryGroup,
} from '@/features/achievements/AchievementGallery';
import type { GameExtensionProps } from '@/index';
import { getGameClient } from '@/platform/gameClientRegistry';
import { usePlatformConfiguration } from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';
import { GameClientProviders } from '../../GameClientProviders.js';
import { useGameCatalog } from './gameCatalog';
import { QueryRefreshNotice } from './QueryRefreshNotice';

type PlatformProfileTab = 'profile' | 'achievements' | 'rankings' | 'wallet';

export interface PlatformProfilePageProps {
  readonly gameId: string;
  readonly defaultTab?: PlatformProfileTab;
  readonly embedded?: boolean;
}

/**
 * Renders one game-owned profile surface inside the platform workspace.
 * Game selection and tab navigation belong to the workspace route; this page
 * only reads the explicit game and tab supplied by that route.
 */
export function PlatformProfilePage({
  gameId,
  defaultTab = 'profile',
  embedded = false,
}: PlatformProfilePageProps): React.JSX.Element {
  const { t } = useTranslation('platform');
  const search = useSearch({ strict: false }) as {
    principalId?: unknown;
  };
  const currentUserId = useAuthStore((state) => state.user?.id ?? '');
  const { features } = usePlatformConfiguration();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const principalId =
    typeof search.principalId === 'string' && search.principalId.length > 0
      ? search.principalId
      : currentUserId;
  const isOwnProfile = principalId.length > 0 && principalId === currentUserId;
  const catalogQuery = useGameCatalog();
  const catalogGame = useMemo(
    () => uniqueGames(catalogQuery.data).find((game) => game.gameId === gameId),
    [catalogQuery.data, gameId],
  );
  const registration = getGameClient(gameId);
  const tab = defaultTab;
  const extensionLoader =
    tab === 'profile'
      ? registration?.extensions?.profile
      : tab === 'achievements'
        ? registration?.extensions?.achievements
        : tab === 'rankings'
          ? registration?.extensions?.rankings
          : undefined;
  const Extension = useMemo(
    () => (extensionLoader ? lazy(extensionLoader) : null),
    [extensionLoader],
  );
  const catalogTabEnabled = catalogGame
    ? canShowTab(catalogGame, tab, features.rankings)
    : false;
  const walletEnabled = Boolean(
    isOwnProfile &&
      catalogGame &&
      (catalogGame.capabilities.includes('wallet') ||
        catalogGame.capabilities.includes('rewards')),
  );

  const profileQuery = useQuery({
    queryKey: ['platform', 'game-profile', gameId, principalId, authEpoch],
    queryFn: () => platformGamesApi.getProfile(gameId, { principalId }),
    enabled: Boolean(
      gameId &&
        registration &&
        principalId &&
        tab === 'profile' &&
        catalogTabEnabled &&
        !extensionLoader,
    ),
  });
  const achievementsQuery = useQuery({
    queryKey: ['platform', 'game-achievements', gameId, principalId, authEpoch],
    queryFn: () => platformGamesApi.getAchievements(gameId, { principalId }),
    enabled: Boolean(
      gameId &&
        registration &&
        principalId &&
        tab === 'achievements' &&
        catalogTabEnabled &&
        !extensionLoader,
    ),
  });
  const walletQuery = useQuery({
    queryKey: ['platform', 'game-wallet', gameId, currentUserId, authEpoch],
    queryFn: () => platformGamesApi.getWallet(gameId),
    enabled: Boolean(gameId && walletEnabled && tab === 'wallet'),
  });
  const rankingsQuery = useQuery({
    queryKey: ['platform', 'game-rankings', gameId, authEpoch],
    queryFn: () => platformGamesApi.getRankings(gameId),
    enabled: Boolean(
      gameId &&
        registration &&
        tab === 'rankings' &&
        features.rankings &&
        catalogTabEnabled &&
        !extensionLoader,
    ),
  });

  if (catalogQuery.isPending) {
    return <LoadingSpinner variant='block' label={t('profile.loading')} />;
  }
  if (catalogQuery.isError && !catalogQuery.data) {
    return (
      <Card>
        <CardContent className='flex flex-wrap items-center justify-between gap-3 py-8'>
          <p className='text-sm text-text-300'>{t('profile.load_failed')}</p>
          <Button type='button' onClick={() => void catalogQuery.refetch()}>
            {t('status.retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const activeQuery = {
    profile: profileQuery,
    achievements: achievementsQuery,
    rankings: rankingsQuery,
    wallet: walletQuery,
  }[tab];
  const themeStyle = registration
    ? ({
        ...registration.theme?.tokens,
        ...(registration.palette?.accent
          ? { '--game-palette-accent': registration.palette.accent }
          : {}),
      } as React.CSSProperties)
    : undefined;
  const content = !catalogGame ? (
    <EmptyPanel message={t('profile.client_unavailable')} />
  ) : !registration ? (
    <EmptyPanel message={t('profile.client_unavailable')} />
  ) : !canShowTab(catalogGame, tab, features.rankings) ? (
    <EmptyPanel message={t('profile.no_capabilities')} />
  ) : (
    <ProfileSurface
      tab={tab}
      profileQuery={profileQuery}
      achievementsQuery={achievementsQuery}
      rankingsQuery={rankingsQuery}
      walletQuery={walletQuery}
      extension={Extension}
      extensionProps={{ gameId, userId: principalId }}
      walletEnabled={walletEnabled}
      t={t}
    />
  );

  return (
    <section
      className='space-y-5'
      data-testid='platform-profile-page'
      data-game-theme={registration?.theme?.dataTheme}
      data-game-theme-scope={registration?.theme?.scope}
      style={themeStyle}
    >
      {!embedded ? (
        <header className='space-y-2'>
          <Link
            to='/platform'
            className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
          >
            {t('room.back')}
          </Link>
          <h1 className='font-display text-2xl text-text-100'>
            {catalogGame?.name ?? t('profile.title')}
          </h1>
          <p className='max-w-2xl text-sm text-text-400'>
            {t('profile.description')}
          </p>
        </header>
      ) : null}
      {!embedded && catalogQuery.isError ? (
        <QueryRefreshNotice
          onRetry={() => void catalogQuery.refetch()}
          retrying={catalogQuery.isFetching}
        />
      ) : null}
      {!Extension && activeQuery.isError && activeQuery.data ? (
        <QueryRefreshNotice
          onRetry={() => void activeQuery.refetch()}
          retrying={activeQuery.isFetching}
        />
      ) : null}
      {content}
    </section>
  );
}

interface CatalogGame {
  readonly gameId: string;
  readonly name: string;
  readonly capabilities: GameCatalogEntry['capabilities'];
}

function canShowTab(
  game: CatalogGame,
  tab: PlatformProfileTab,
  rankingsEnabled = true,
): boolean {
  if (tab === 'profile') return game.capabilities.includes('profile');
  if (tab === 'achievements') return game.capabilities.includes('achievements');
  if (tab === 'rankings') {
    return (
      rankingsEnabled &&
      (game.capabilities.includes('rankings') ||
        game.capabilities.includes('rating'))
    );
  }
  return (
    game.capabilities.includes('wallet') ||
    game.capabilities.includes('rewards')
  );
}

function uniqueGames(
  data: readonly GameCatalogEntry[] | undefined,
): CatalogGame[] {
  const games = new Map<string, CatalogGame>();
  for (const entry of data ?? []) {
    const gameId = entry.metadata.gameId;
    if (!games.has(gameId)) {
      games.set(gameId, {
        gameId,
        name: entry.metadata.name,
        capabilities: entry.capabilities,
      });
    }
  }
  return [...games.values()];
}

function ProfileSurface({
  tab,
  profileQuery,
  achievementsQuery,
  rankingsQuery,
  walletQuery,
  extension,
  extensionProps,
  walletEnabled,
  t,
}: {
  readonly tab: PlatformProfileTab;
  readonly profileQuery: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameProfileSummary;
    readonly refetch: () => unknown;
  };
  readonly achievementsQuery: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: AchievementCollection;
    readonly refetch: () => unknown;
  };
  readonly rankingsQuery: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameRankingSummary;
    readonly refetch: () => unknown;
  };
  readonly walletQuery: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameWallet;
    readonly refetch: () => unknown;
  };
  readonly extension: React.LazyExoticComponent<
    React.ComponentType<GameExtensionProps>
  > | null;
  readonly extensionProps: GameExtensionProps;
  readonly walletEnabled: boolean;
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  if (tab === 'profile') {
    return (
      <ProfilePanel
        query={profileQuery}
        extension={extension}
        extensionProps={extensionProps}
        profile={profileQuery.data}
        t={t}
      />
    );
  }
  if (tab === 'achievements') {
    return (
      <AchievementsPanel
        query={achievementsQuery}
        extension={extension}
        extensionProps={extensionProps}
        t={t}
      />
    );
  }
  if (tab === 'rankings') {
    return (
      <RankingsPanel
        query={rankingsQuery}
        extension={extension}
        extensionProps={extensionProps}
        t={t}
      />
    );
  }
  return walletEnabled ? (
    <WalletPanel query={walletQuery} t={t} />
  ) : (
    <EmptyPanel message={t('profile.wallet_private')} />
  );
}

function LoadingPanel({
  message,
}: {
  readonly message: string;
}): React.JSX.Element {
  return <LoadingSpinner variant='block' label={message} />;
}

function EmptyPanel({
  message,
}: {
  readonly message: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className='py-10 text-center text-sm text-text-500'>
        {message}
      </CardContent>
    </Card>
  );
}

function ErrorPanel({
  message,
  onRetry,
  retryLabel,
}: {
  readonly message: string;
  readonly onRetry: () => void;
  readonly retryLabel: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className='flex flex-wrap items-center justify-between gap-3 py-8'>
        <p className='text-sm text-text-300'>{message}</p>
        <Button type='button' variant='ghost' onClick={onRetry}>
          {retryLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

function ExtensionPanel({
  extension,
  props,
  loadingLabel,
}: {
  readonly extension: React.LazyExoticComponent<
    React.ComponentType<GameExtensionProps>
  >;
  readonly props: GameExtensionProps;
  readonly loadingLabel: string;
}): React.JSX.Element {
  return (
    <Suspense
      fallback={<LoadingSpinner variant='block' label={loadingLabel} />}
    >
      <GameClientProviders registration={getGameClient(props.gameId)}>
        {createElement(extension, props)}
      </GameClientProviders>
    </Suspense>
  );
}

function ProfilePanel({
  query,
  extension,
  extensionProps,
  profile,
  t,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameProfileSummary;
    readonly refetch: () => unknown;
  };
  readonly extension: React.LazyExoticComponent<
    React.ComponentType<GameExtensionProps>
  > | null;
  readonly extensionProps: GameExtensionProps;
  readonly profile: GameProfileSummary | undefined;
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  if (extension) {
    return (
      <ExtensionPanel
        extension={extension}
        props={extensionProps}
        loadingLabel={t('profile.loading')}
      />
    );
  }
  if (query.isPending) return <LoadingPanel message={t('profile.loading')} />;
  if (query.isError && !query.data) {
    return (
      <ErrorPanel
        message={t('profile.load_failed')}
        onRetry={() => void query.refetch()}
        retryLabel={t('status.retry')}
      />
    );
  }
  if (!profile) return <EmptyPanel message={t('profile.no_data')} />;
  return <ProfileSummaryPanel profile={profile} t={t} />;
}

function AchievementsPanel({
  query,
  extension,
  extensionProps,
  t,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: AchievementCollection;
    readonly refetch: () => unknown;
  };
  readonly extension: React.LazyExoticComponent<
    React.ComponentType<GameExtensionProps>
  > | null;
  readonly extensionProps: GameExtensionProps;
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  if (extension) {
    return (
      <ExtensionPanel
        extension={extension}
        props={extensionProps}
        loadingLabel={t('profile.loading')}
      />
    );
  }

  const collection = query.data;
  const groups:
    | readonly AchievementGalleryGroup<AchievementCollection['items'][number]>[]
    | undefined = collection
    ? [
        {
          id: 'all',
          title: t('profile.tabs.achievements'),
          items: collection.items,
        },
      ]
    : undefined;
  return (
    <AchievementGallery
      groups={groups}
      loading={query.isPending}
      error={query.isError && !query.data}
      onRetry={() => void query.refetch()}
      labels={{
        title: t('profile.tabs.achievements'),
        loading: t('profile.loading'),
        error: t('profile.load_failed'),
        retry: t('status.retry'),
        summary: (unlocked, total) => `${unlocked} / ${total}`,
        expand: t('profile.tabs.achievements'),
        collapse: t('profile.tabs.achievements'),
        earnedTitle: t('profile.unlocked'),
        earnedSummary: (count) => `${count}`,
        noEarned: t('profile.no_achievements_unlocked'),
        empty: t('profile.no_achievements'),
        filterPlaceholder: t('profile.achievement_filter', {
          defaultValue: 'Filter achievements',
        }),
        groupSummary: (unlocked, total) => `${unlocked} / ${total}`,
      }}
      getItemId={(item) => item.achievementId}
      isUnlocked={(item) => item.unlocked}
      getSearchText={(item) =>
        `${translateGameText(item.title, t, 'profile.achievement')} ${translateGameText(item.description, t, 'profile.achievement_description')}`
      }
      renderItem={(item) => (
        <Card className='h-full'>
          <CardHeader className='pb-2'>
            <CardTitle className='text-base'>
              {translateGameText(item.title, t, 'profile.achievement')}
            </CardTitle>
            <CardDescription>
              {translateGameText(
                item.description,
                t,
                'profile.achievement_description',
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className='flex items-center justify-between gap-3 text-sm'>
            <span>
              {item.progress}
              {item.target === undefined ? '' : ` / ${item.target}`}
            </span>
            <Badge variant={item.unlocked ? 'success' : 'default'}>
              {item.unlocked ? t('profile.unlocked') : t('profile.locked')}
            </Badge>
          </CardContent>
        </Card>
      )}
      initiallyExpanded
    />
  );
}

function RankingsPanel({
  query,
  extension,
  extensionProps,
  t,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameRankingSummary;
    readonly refetch: () => unknown;
  };
  readonly extension: React.LazyExoticComponent<
    React.ComponentType<GameExtensionProps>
  > | null;
  readonly extensionProps: GameExtensionProps;
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  if (extension) {
    return (
      <ExtensionPanel
        extension={extension}
        props={extensionProps}
        loadingLabel={t('profile.loading')}
      />
    );
  }
  if (query.isPending) return <LoadingPanel message={t('profile.loading')} />;
  if (query.isError && !query.data) {
    return (
      <ErrorPanel
        message={t('profile.load_failed')}
        onRetry={() => void query.refetch()}
        retryLabel={t('status.retry')}
      />
    );
  }
  if (!query.data || query.data.entries.length === 0) {
    return <EmptyPanel message={t('profile.no_rankings')} />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.rankings_title')}</CardTitle>
        <CardDescription>{t('profile.rankings_description')}</CardDescription>
      </CardHeader>
      <CardContent className='divide-y divide-[color:var(--metal-edge-soft)] p-0'>
        {query.data.entries.map((entry) => (
          <div
            key={entry.principalId}
            className='flex items-center justify-between gap-3 px-4 py-3 text-sm'
          >
            <span className='text-text-300'>
              {entry.displayName ?? t('profile.anonymous_player')}
            </span>
            <span className='readout text-text-100'>#{entry.rank}</span>
          </div>
        ))}
        {query.data.viewer &&
        !query.data.entries.some(
          (entry) => entry.principalId === query.data?.viewer?.principalId,
        ) ? (
          <div className='flex items-center justify-between gap-3 px-4 py-3 text-sm'>
            <span className='text-text-300'>{t('profile.your_rank')}</span>
            <span className='readout text-text-100'>
              #{query.data.viewer.rank}
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function WalletPanel({
  query,
  t,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data?: GameWallet;
    readonly refetch: () => unknown;
  };
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  if (query.isPending) return <LoadingPanel message={t('profile.loading')} />;
  if (query.isError && !query.data) {
    return (
      <ErrorPanel
        message={t('profile.load_failed')}
        onRetry={() => void query.refetch()}
        retryLabel={t('status.retry')}
      />
    );
  }
  if (!query.data || query.data.assets.length === 0) {
    return <EmptyPanel message={t('profile.no_wallet')} />;
  }
  return (
    <div className='grid gap-3 md:grid-cols-2'>
      {query.data.assets.map((asset) => (
        <Card key={asset.asset}>
          <CardContent className='flex items-center justify-between gap-3 py-4'>
            <span className='text-sm text-text-300'>
              {asset.label ?? t('profile.unnamed_asset')}
            </span>
            <div className='text-right'>
              <div className='readout text-text-100'>{asset.available}</div>
              <div className='text-xs text-text-500'>
                {t('profile.wallet_history', {
                  granted: asset.granted,
                  consumed: asset.consumed,
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ProfileSummaryPanel({
  profile,
  t,
}: {
  readonly profile: GameProfileSummary;
  readonly t: TFunction<'platform'>;
}): React.JSX.Element {
  const stats = collectProfileMetrics(profile.stats, 'stats', t);
  const rank = collectProfileMetrics(profile.rank, 'rank', t);
  return (
    <div className='space-y-3'>
      <Card>
        <CardHeader>
          <CardTitle>
            {profile.displayName ?? t('profile.anonymous_player')}
          </CardTitle>
          <CardDescription>{t('profile.profile_summary')}</CardDescription>
        </CardHeader>
      </Card>
      <div className='grid gap-3 md:grid-cols-2'>
        <MetricCard
          title={t('profile.statistics')}
          metrics={stats}
          emptyLabel={t('profile.no_statistics')}
        />
        <MetricCard
          title={t('profile.rank_summary')}
          metrics={rank}
          emptyLabel={t('profile.no_rank')}
        />
      </div>
    </div>
  );
}

function MetricCard({
  title,
  metrics,
  emptyLabel,
}: {
  readonly title: string;
  readonly metrics: readonly ProfileMetric[];
  readonly emptyLabel: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {metrics.length > 0 ? (
          <dl className='grid grid-cols-2 gap-3'>
            {metrics.map((metric) => (
              <div key={`${metric.label}-${metric.value}`}>
                <dt className='text-xs uppercase tracking-[0.12em] text-text-500'>
                  {metric.label}
                </dt>
                <dd className='readout mt-1 text-text-100'>{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className='text-sm text-text-500'>{emptyLabel}</p>
        )}
      </CardContent>
    </Card>
  );
}

interface ProfileMetric {
  readonly label: string;
  readonly value: string;
}

const PROFILE_METRIC_LABELS: Readonly<
  Record<'stats' | 'rank', Readonly<Record<string, string>>>
> = {
  stats: {
    selectedGameCount: 'profile.metrics.selected_games',
    completedGameCount: 'profile.metrics.completed_games',
    abandonedGameCount: 'profile.metrics.abandoned_games',
    ratedGameCount: 'profile.metrics.rated_games',
    winCount: 'profile.metrics.wins',
    lossCount: 'profile.metrics.losses',
    timeoutLossCount: 'profile.metrics.timeout_losses',
    unknownOutcomeCount: 'profile.metrics.unknown_outcomes',
    scoreGameCount: 'profile.metrics.scored_games',
    averageScore: 'profile.metrics.average_score',
    bestScore: 'profile.metrics.best_score',
    winRate: 'profile.metrics.win_rate',
    score: 'profile.metrics.score',
  },
  rank: {
    rank: 'profile.metrics.rank',
    publicRank: 'profile.metrics.rank',
    rating: 'profile.metrics.rating',
    stars: 'profile.metrics.stars',
    percentile: 'profile.metrics.percentile',
    stage: 'profile.metrics.stage',
    score: 'profile.metrics.score',
  },
};

function translateGameText(
  value: string,
  t: TFunction<'platform'>,
  fallbackKey: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) return t(fallbackKey);
  const translated = t(trimmed, { ns: 'common', defaultValue: '' });
  if (translated && translated !== trimmed) return translated;
  return /^(?:[a-z][\w-]*:)?[a-z][\w-]*(?:\.[a-z][\w-]*)+$/i.test(trimmed)
    ? t(fallbackKey)
    : trimmed;
}

function collectProfileMetrics(
  value: JsonValue | undefined,
  category: 'stats' | 'rank',
  t: TFunction<'platform'>,
): ProfileMetric[] {
  const metrics: ProfileMetric[] = [];
  const visit = (
    candidate: JsonValue,
    depth: number,
    inheritedLabel?: string,
    inheritedKey?: string,
  ): void => {
    if (depth > 3 || candidate === null) return;
    if (
      typeof candidate === 'string' ||
      typeof candidate === 'number' ||
      typeof candidate === 'boolean'
    ) {
      if (!inheritedLabel) return;
      const formatted = formatProfileMetricValue(
        inheritedKey ?? '',
        candidate,
        t,
      );
      if (formatted !== undefined) {
        metrics.push({ label: inheritedLabel, value: formatted });
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, depth + 1, inheritedLabel, inheritedKey);
      }
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const labelKey = PROFILE_METRIC_LABELS[category][key];
      const label = labelKey ? t(labelKey) : inheritedLabel;
      visit(child, depth + 1, label, labelKey ? key : inheritedKey);
    }
  };
  if (value !== undefined) visit(value, 0);
  return metrics.slice(0, 8);
}

function formatProfileMetricValue(
  key: string,
  value: string | number | boolean,
  t: TFunction<'platform'>,
): string | undefined {
  if (typeof value === 'number') {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (typeof value === 'boolean') {
    return t(value ? 'profile.yes' : 'profile.no');
  }
  if (key === 'stage') {
    const translated = t(`profile.stages.${value}`, { defaultValue: '' });
    return translated || t('profile.stages.unknown');
  }
  if (key === 'latestPlayedAt') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString();
  }
  return value;
}
