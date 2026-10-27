import { ECapability } from '@board-platform/contracts/auth/permissions';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonVariants } from '@/components/ui/button.js';
import { AccountSecurityPanel } from '@/features/admin/AccountSecurityPanel.js';
import { ReleaseAdministrationPanel } from '@/features/admin/ReleaseAdministrationPanel.js';
import { UserManagementPanel } from '@/features/admin/UserManagementPanel.js';
import { usePermissions } from '@/hooks/usePermissions.js';

type TAdministrationTab = 'accounts' | 'security' | 'releases';

/** Platform-wide administration; game registrations are not required. */
export function PlatformAdministrationPage(): React.JSX.Element {
  const { t } = useTranslation('platform-admin');
  const permissions = usePermissions();
  const [tab, setTab] = useState<TAdministrationTab>('accounts');
  const canManageUsers = permissions.can(ECapability.USER_MANAGE);
  const canManageReleases =
    permissions.can(ECapability.ADMIN_ACCESS) &&
    permissions.can(ECapability.GAME_MODIFY_ANY);
  const canReadPerformance = permissions.can(ECapability.ANALYTICS_READ);

  if (!permissions.can(ECapability.ADMIN_ACCESS)) {
    return (
      <main className='space-y-6'>
        <header className='space-y-2'>
          <h1 className='font-display text-3xl font-medium text-text-100'>
            {t('title')}
          </h1>
        </header>
        <section className='mission-panel px-5 py-5'>
          <p role='alert' className='text-sm text-text-300'>
            {t('forbidden')}
          </p>
        </section>
      </main>
    );
  }

  const availableTabs: readonly TAdministrationTab[] = [
    ...(canManageUsers ? (['accounts', 'security'] as const) : []),
    ...(canManageReleases ? (['releases'] as const) : []),
  ];
  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0];

  return (
    <main className='space-y-6'>
      <header className='space-y-2'>
        <p className='font-mono text-xs uppercase tracking-microlabel text-text-500'>
          {t('eyebrow')}
        </p>
        <h1 className='font-display text-3xl font-medium text-text-100'>
          {t('title')}
        </h1>
        <p className='max-w-2xl text-sm leading-relaxed text-text-300'>
          {t('description')}
        </p>
      </header>

      <nav className='flex flex-wrap gap-2' aria-label={t('navigation')}>
        {canManageUsers ? (
          <TabButton
            active={activeTab === 'accounts'}
            onClick={() => setTab('accounts')}
          >
            {t('tabs.accounts')}
          </TabButton>
        ) : null}
        {canManageUsers ? (
          <TabButton
            active={activeTab === 'security'}
            onClick={() => setTab('security')}
          >
            {t('tabs.security')}
          </TabButton>
        ) : null}
        {canManageReleases ? (
          <TabButton
            active={activeTab === 'releases'}
            onClick={() => setTab('releases')}
          >
            {t('tabs.releases')}
          </TabButton>
        ) : null}
      </nav>

      {activeTab === 'accounts' ? <UserManagementPanel /> : null}
      {activeTab === 'security' ? <AccountSecurityPanel /> : null}
      {activeTab === 'releases' ? <ReleaseAdministrationPanel /> : null}

      <section className='mission-panel px-5 py-5'>
        <div className='relative z-10 space-y-3'>
          <h2 className='font-display text-xl text-text-100'>
            {t('operations.title')}
          </h2>
          <p className='text-sm text-text-400'>{t('operations.description')}</p>
          <div className='flex flex-wrap gap-2'>
            <Link
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              to='/platform/operations'
            >
              {t('operations.open')}
            </Link>
            <Link
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              to='/platform/feedback'
            >
              {t('operations.feedback')}
            </Link>
            <Link
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              to='/platform/access'
            >
              {t('operations.access')}
            </Link>
            {canReadPerformance ? (
              <Link
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                to='/admin/performance'
              >
                {t('operations.performance')}
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type='button'
      className={buttonVariants({
        variant: active ? 'primary' : 'ghost',
        size: 'sm',
      })}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
