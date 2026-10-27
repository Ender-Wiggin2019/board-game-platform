import { useTranslation } from 'react-i18next';
import { useGameCatalog } from './gameCatalog';
import { PlatformSessionDirectory } from './lobby/PlatformSessionDirectory';
import { QueryRefreshNotice } from './QueryRefreshNotice';
import './gameWorkspace.css';

/** Browsing sessions requires platform metadata, not every game's client bundle. */
export function PlatformSessionsPage(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const catalog = useGameCatalog();
  return (
    <section className='game-workspace' data-testid='platform-sessions-page'>
      <header className='game-workspace-heading'>
        <h1>{t('history.all_title')}</h1>
      </header>
      {catalog.isError ? (
        <QueryRefreshNotice
          onRetry={() => void catalog.refetch()}
          retrying={catalog.isFetching}
        />
      ) : null}
      <PlatformSessionDirectory games={catalog.data} />
    </section>
  );
}
