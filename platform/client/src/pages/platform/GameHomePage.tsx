import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { useGameCatalog } from './gameCatalog';
import { QueryRefreshNotice } from './QueryRefreshNotice';
import './gameWorkspace.css';

export function GameHomePage(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const catalog = useGameCatalog();
  const games = [
    ...new Map(
      (catalog.data ?? []).map((entry) => [entry.metadata.gameId, entry]),
    ).values(),
  ];

  return (
    <section className='game-home' data-testid='game-home'>
      <header className='game-home-heading'>
        <h1>{t('home.title')}</h1>
        <p>{t('home.description')}</p>
      </header>
      {catalog.isError && catalog.data ? (
        <QueryRefreshNotice
          onRetry={() => void catalog.refetch()}
          retrying={catalog.isFetching}
        />
      ) : null}
      {catalog.isPending ? (
        <LoadingSpinner variant='block' label={t('catalog.loading')} />
      ) : catalog.isError && !catalog.data ? (
        <div className='game-workspace-status'>
          <p>{t('status.error')}</p>
          <Button onClick={() => void catalog.refetch()}>
            {t('status.retry')}
          </Button>
        </div>
      ) : games.length === 0 ? (
        <p className='game-workspace-status'>{t('catalog.empty')}</p>
      ) : (
        <div className='game-home-grid'>
          {games.map(({ metadata }) => {
            const cover = metadata.coverUrl;
            const name = metadata.name;
            const content = (
              <>
                <div className='game-home-art'>
                  {cover ? (
                    <img src={cover} alt='' loading='lazy' decoding='async' />
                  ) : null}
                  <span>{name}</span>
                </div>
                <div className='game-home-details'>
                  <p>{metadata.description}</p>
                  <span>
                    {t('home.enter')} <span aria-hidden>↗</span>
                  </span>
                </div>
              </>
            );
            return (
              <Link
                className='game-home-card'
                key={metadata.gameId}
                to='/games/$gameId/lobby'
                params={{ gameId: metadata.gameId }}
              >
                {content}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
