import { ECapability } from '@board-platform/contracts/auth/permissions';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useSceneHero } from '@/components/layout/SceneBackground';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/hooks/usePermissions';
import { useResolvedGameClient } from '@/platform/useGameClient';
import { usePlatformConfiguration } from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';
import { GameClientProviders } from '../../GameClientProviders';
import type { GameEntryRuntime } from '../../runtime';
import { useGameCatalog } from './gameCatalog';
import { QueryRefreshNotice } from './QueryRefreshNotice';
import './gameWorkspace.css';

const LobbyPage = lazy(() =>
  import('./PlatformLobbyPage').then((module) => ({
    default: module.PlatformLobbyPage,
  })),
);
const ProfilePage = lazy(() =>
  import('./PlatformProfilePage').then((module) => ({
    default: module.PlatformProfilePage,
  })),
);

export function GameWorkspace({
  runtime,
}: {
  readonly runtime: GameEntryRuntime;
}): React.JSX.Element {
  const {
    gameId = '',
    section: routeSection,
    adminPage,
  } = useParams({ strict: false });
  const section = adminPage ? 'admin' : (routeSection ?? 'lobby');
  const { t } = useTranslation('platform');
  const permissions = usePermissions();
  const currentUserId = useAuthStore((state) => state.user?.id);
  const { features } = usePlatformConfiguration();
  const search = useSearch({ strict: false }) as { principalId?: string };
  const catalog = useGameCatalog();
  const game = catalog.data?.find((entry) => entry.metadata.gameId === gameId);
  const client = useResolvedGameClient(gameId, game?.releaseId);
  const registration = client.registration;
  const capabilities = new Set(game?.capabilities);
  const pages = (registration?.pages ?? []).filter(
    (page) =>
      !page.requiredCapability || permissions.can(page.requiredCapability),
  );
  const administration = permissions.can(ECapability.ADMIN_ACCESS)
    ? (registration?.administration ?? []).filter(
        (page) =>
          !page.requiredCapability || permissions.can(page.requiredCapability),
      )
    : [];
  const tabs = [
    { id: 'lobby', label: t('workspace.lobby') },
    { id: 'sessions', label: t('workspace.sessions') },
    ...(capabilities.has('profile')
      ? [{ id: 'profile', label: t('profile.tabs.profile') }]
      : []),
    ...(capabilities.has('achievements')
      ? [{ id: 'achievements', label: t('profile.tabs.achievements') }]
      : []),
    ...(features.rankings &&
    (capabilities.has('rankings') || capabilities.has('rating'))
      ? [{ id: 'rankings', label: t('profile.tabs.rankings') }]
      : []),
    ...(capabilities.has('wallet') || capabilities.has('rewards')
      ? [{ id: 'wallet', label: t('profile.tabs.wallet') }]
      : []),
    ...pages.map((page) => ({ id: page.id, label: t(page.labelKey) })),
    ...(administration.length
      ? [{ id: 'admin', label: t('workspace.admin') }]
      : []),
  ];
  useSceneHero(
    registration?.theme?.hero ?? null,
    registration?.theme?.footer ?? null,
  );
  const contribution =
    section === 'admin'
      ? administration.find(
          (page) => page.id === (adminPage ?? administration[0]?.id),
        )
      : pages.find((page) => page.id === section);
  const Contribution = useMemo(
    () => (contribution ? lazy(contribution.load) : null),
    [contribution],
  );

  if (catalog.isPending || client.isPending)
    return <LoadingSpinner variant='block' label={t('catalog.loading')} />;
  if (catalog.isError && !catalog.data) {
    return (
      <div className='game-workspace-status'>
        <p>{t('status.error')}</p>
        <Button onClick={() => void catalog.refetch()}>
          {t('status.retry')}
        </Button>
      </div>
    );
  }
  if (client.isError || client.isUnavailable) {
    return (
      <div className='game-workspace-status'>
        <p role='alert'>{t('workspace.unavailable')}</p>
        <Button onClick={() => void client.refetch()}>
          {t('status.retry')}
        </Button>
        <Link to='/'>{t('workspace.all_games')}</Link>
      </div>
    );
  }
  if (!registration || !game) {
    return (
      <div className='game-workspace-status'>
        <p>{t('workspace.unavailable')}</p>
        <Link to='/'>{t('workspace.all_games')}</Link>
      </div>
    );
  }
  const available = tabs.some((tab) => tab.id === section);
  return (
    <section
      className='game-workspace'
      data-testid='game-workspace'
      data-game-id={gameId}
    >
      {catalog.isError ? (
        <QueryRefreshNotice
          onRetry={() => void catalog.refetch()}
          retrying={catalog.isFetching}
        />
      ) : null}
      <header className='game-workspace-heading'>
        <div>
          <Link className='game-workspace-back' to='/'>
            {t('workspace.all_games')}
          </Link>
          <h1>
            {t(registration.metadata.nameKey, {
              defaultValue: game.metadata.name,
            })}
          </h1>
        </div>
        <Link
          className='game-workspace-back'
          to='/platform/feedback'
          search={{ gameId }}
        >
          {t('workspace.feedback')}
        </Link>
      </header>
      <nav
        className='game-workspace-tabs'
        aria-label={t('workspace.navigation')}
      >
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            to='/games/$gameId/$section'
            params={{ gameId, section: tab.id }}
            search={
              ['profile', 'achievements', 'rankings', 'wallet'].includes(
                tab.id,
              ) && search.principalId
                ? { principalId: search.principalId }
                : undefined
            }
            aria-current={section === tab.id ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Suspense
        fallback={
          <LoadingSpinner variant='block' label={t('profile.loading')} />
        }
      >
        {!available ? (
          <p className='game-workspace-status'>
            {t('workspace.section_unavailable')}
          </p>
        ) : section === 'lobby' || section === 'sessions' ? (
          <LobbyPage
            key={`${gameId}:${section}`}
            gameId={gameId}
            view={section === 'sessions' ? 'sessions' : 'lobby'}
          />
        ) : section === 'profile' ||
          section === 'achievements' ||
          section === 'rankings' ||
          section === 'wallet' ? (
          <ProfilePage
            key={`${gameId}:${section}`}
            gameId={gameId}
            defaultTab={section}
            embedded
          />
        ) : (
          <>
            {section === 'admin' ? (
              <nav
                className='game-workspace-tabs'
                aria-label={t('workspace.admin')}
              >
                {administration.map((page) => (
                  <Link
                    key={page.id}
                    to='/admin/$gameId/$adminPage'
                    params={{ gameId, adminPage: page.id }}
                    aria-current={
                      contribution?.id === page.id ? 'page' : undefined
                    }
                  >
                    {t(page.labelKey)}
                  </Link>
                ))}
              </nav>
            ) : null}
            {contribution && Contribution ? (
              <GameClientProviders registration={registration}>
                <Contribution
                  key={`${gameId}:${contribution.id}`}
                  gameId={gameId}
                  userId={search.principalId ?? currentUserId}
                  runtime={runtime}
                />
              </GameClientProviders>
            ) : (
              <p className='game-workspace-status'>
                {t('workspace.section_unavailable')}
              </p>
            )}
          </>
        )}
      </Suspense>
    </section>
  );
}
