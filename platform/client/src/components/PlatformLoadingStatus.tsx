import { useTranslation } from 'react-i18next';
import { FullScreenStatus } from './FullScreenStatus';

/** Loading feedback for platform-owned routes and lazy game entries. */
export function PlatformLoadingStatus(): React.JSX.Element {
  const { t } = useTranslation('platform');
  return <FullScreenStatus label={t('status.loading')} />;
}
