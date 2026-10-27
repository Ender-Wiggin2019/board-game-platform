import { ECapability } from '@board-platform/contracts/auth/permissions';
import { Link } from '@tanstack/react-router';
import { Dices } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandWordmark } from '@/components/BrandWordmark.js';
import { GuestLanguageToggle } from '@/components/layout/GuestLanguageToggle.js';
import {
  SceneBackground,
  SceneProvider,
} from '@/components/layout/SceneBackground.js';
import { useShellBadges } from '@/components/layout/ShellBadges';
import { usePermissions } from '@/hooks/usePermissions';
import { useTurnAlertFavicon } from '@/hooks/useTurnAlertFavicon';
import { cn } from '@/lib/cn.js';
import {
  resolvePlatformBrandName,
  usePlatformConfiguration,
} from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';
import { listGameClients } from '../../platform/gameClientRegistry.js';

function hasGameRoute(path: string): boolean {
  return listGameClients().some((game) =>
    game.legacyRoutes?.some(
      (route) =>
        path === route.pathPrefix || path.startsWith(`${route.pathPrefix}/`),
    ),
  );
}

interface IAppShellProps {
  children: React.ReactNode;
}

/**
 * AppShell — the global chrome outside of a live game.
 *
 * The page sits in three depth planes:
 *   1. SceneBackground — top hero (per route) + mid solid + bottom footer.
 *   2. Surface-deep top bar (the first lift off the void).
 *   3. Surface-panel content cards within the main column.
 */
export function AppShell(props: IAppShellProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const { t: platformText } = useTranslation('platform');
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const userName = useAuthStore((s) => s.user?.name);
  const permissions = usePermissions();
  const canAccessGame = permissions.can(ECapability.GAME_PLAY);
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(
    configuration,
    platformText('brand.name'),
  );
  const {
    unreadCount,
    friendPendingCount,
    actionRequiredCount,
    waitingReadyCount,
  } = useShellBadges();

  // Flash the browser tab icon whenever ANY of the player's games is waiting on
  // them. Lives here rather than on the game page so it works from the lobby and
  // every other screen: in a turn-based game the turn usually arrives while you
  // are somewhere else entirely.
  useTurnAlertFavicon(actionRequiredCount > 0);

  // Keep the tab title localized outside a live game too. index.html carries an
  // English title for the pre-React paint, and only GamePage used to replace it
  // — so every lobby-side screen kept showing that English string whatever the
  // language was.
  useEffect(() => {
    document.title = brandName;
  }, [brandName]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        accountMenuRef.current &&
        !accountMenuRef.current.contains(event.target as Node)
      ) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [accountMenuOpen]);

  return (
    <SceneProvider>
      <div className='relative flex min-h-dvh flex-col text-text-100'>
        <SceneBackground />

        <header
          className={cn(
            'fixed top-0 inset-x-0 z-20',
            'border-b border-[color:var(--metal-edge-soft)]',
            'bg-[var(--surface-deep)]/82 backdrop-blur-md',
          )}
        >
          <div className='mx-auto flex max-w-6xl items-center justify-between gap-2 px-2 py-2 sm:gap-3 sm:px-5 sm:py-3'>
            <Link
              to='/'
              aria-label={`${brandName} ${platformText('brand.home')}`}
              className={cn(
                'group flex shrink-0 items-center gap-3 text-text-100',
                'transition-colors',
              )}
            >
              <Dices className='size-7 text-accent-400' aria-hidden />
              <span className='hidden sm:inline'>
                <BrandWordmark>{brandName}</BrandWordmark>
              </span>
            </Link>

            <div className='flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-2'>
              <nav className='flex min-w-0 items-center justify-end gap-0.5 sm:gap-1'>
                {isAuthenticated ? (
                  <>
                    {canAccessGame ? (
                      <NavLink
                        to='/'
                        badgeCount={waitingReadyCount}
                        badgeLabel={t(
                          'client.app_shell.my_games_attention_count',
                          { count: waitingReadyCount },
                        )}
                      >
                        {platformText('workspace.all_games')}
                      </NavLink>
                    ) : (
                      <NavLink to='/activate'>
                        {t('client.activation.title')}
                      </NavLink>
                    )}
                    {canAccessGame ? (
                      <>
                        <NavLink
                          to='/platform/sessions'
                          badgeCount={actionRequiredCount}
                          badgeLabel={t(
                            'client.app_shell.my_games_attention_count',
                            { count: actionRequiredCount },
                          )}
                        >
                          {t('client.app_shell.my_games')}
                        </NavLink>
                        {hasGameRoute('/friends') ? (
                          <NavLink
                            to='/friends'
                            badgeCount={friendPendingCount}
                            badgeLabel={t(
                              'client.app_shell.friends_pending_count',
                              {
                                count: friendPendingCount,
                                defaultValue: '{{count}} pending friend items',
                              },
                            )}
                          >
                            {t('client.app_shell.friends')}
                          </NavLink>
                        ) : null}
                      </>
                    ) : null}
                    <AccountMenu
                      open={accountMenuOpen}
                      onOpenChange={setAccountMenuOpen}
                      userInitial={userName?.charAt(0).toUpperCase() ?? '?'}
                      unreadCount={unreadCount}
                      canOperate={permissions.can(ECapability.ANALYTICS_READ)}
                      canAdminister={permissions.can(ECapability.ADMIN_ACCESS)}
                      canAccessGame={canAccessGame}
                      menuRef={accountMenuRef}
                    />
                  </>
                ) : (
                  <>
                    <GuestLanguageToggle />
                    <NavLink to='/auth'>{t('client.app_shell.login')}</NavLink>
                  </>
                )}
              </nav>
            </div>
          </div>
        </header>

        <main className='mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pt-20 pb-8'>
          {props.children}
        </main>

        {!isAuthenticated || canAccessGame ? <SiteFooter /> : null}
      </div>
    </SceneProvider>
  );
}

/**
 * Global footer for every non-game route. Game routes mount their own shell
 * without AppShell, so the footer never appears over a live table.
 */
function SiteFooter(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(configuration, t('brand.name'));

  if (!hasGameRoute('/about'))
    return (
      <footer className='relative z-10 flex justify-center py-4 text-xs text-text-500'>
        {brandName}
      </footer>
    );
  return (
    <footer className='relative z-10 flex justify-center py-4'>
      <Link
        to='/about'
        className='text-xs text-text-500 underline-offset-4 transition-colors hover:text-text-300 hover:underline'
      >
        {t('client.footer.about')}
      </Link>
    </footer>
  );
}

function AccountMenu({
  open,
  onOpenChange,
  userInitial,
  unreadCount,
  canOperate,
  canAdminister,
  canAccessGame,
  menuRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userInitial: string;
  unreadCount: number;
  canOperate: boolean;
  canAdminister: boolean;
  canAccessGame: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
}): React.JSX.Element {
  const { t } = useTranslation('platform-common');

  return (
    <div ref={menuRef} className='relative ml-1'>
      <button
        type='button'
        aria-label={t('client.app_shell.account_menu_label')}
        aria-describedby={
          unreadCount > 0 ? 'account-menu-unread-count' : undefined
        }
        aria-haspopup='menu'
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={cn(
          'relative flex h-10 w-10 items-center justify-center rounded-[5px]',
          'bg-[var(--surface-instrument)] text-text-100',
          'font-mono text-[0.7rem] font-semibold ',
          'transition-colors hover:bg-[var(--surface-panel)]',
          'focus-visible:outline-none',
        )}
      >
        {userInitial}
        {unreadCount > 0 ? (
          <>
            <span
              aria-hidden
              className='absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-[4px] bg-[oklch(0.32_0.09_35/0.82)] px-1 font-mono text-[0.62rem] text-[oklch(0.92_0.10_60)]'
            >
              {unreadCount}
            </span>
            <span id='account-menu-unread-count' className='sr-only'>
              {t('client.app_shell.unread_messages_count', {
                count: unreadCount,
                defaultValue: '{{count}} unread messages',
              })}
            </span>
          </>
        ) : null}
      </button>

      {open ? (
        <div
          className={cn(
            'absolute right-0 top-full mt-2 w-44 overflow-hidden rounded-[6px] p-1',
            'bg-[var(--surface-raised)]/95 shadow-instrument backdrop-blur-md',
          )}
        >
          {!canAccessGame ? (
            <AccountMenuLink href='/account'>
              {t('client.app_shell.settings')}
            </AccountMenuLink>
          ) : null}
          {canAccessGame ? (
            <>
              <AccountMenuLink href='/platform/feedback'>
                {t('client.app_shell.platform_feedback')}
              </AccountMenuLink>
              <AccountMenuLink href='/platform/access'>
                {t('client.app_shell.game_access', {
                  defaultValue: 'Game access',
                })}
              </AccountMenuLink>
              <AccountMenuLink href='/account'>
                {t('client.app_shell.settings')}
              </AccountMenuLink>
              {hasGameRoute('/messages') ? (
                <AccountMenuLink href='/messages'>
                  {unreadCount > 0
                    ? t('client.app_shell.messages_with_count', {
                        count: unreadCount,
                        defaultValue: 'Messages ({{count}})',
                      })
                    : t('client.app_shell.messages', {
                        defaultValue: 'Messages',
                      })}
                </AccountMenuLink>
              ) : null}
            </>
          ) : null}
          {canOperate ? (
            <AccountMenuLink href='/platform/operations'>
              {t('client.app_shell.platform_operations')}
            </AccountMenuLink>
          ) : null}
          {canAdminister ? (
            <AccountMenuLink href='/admin'>
              {t('platform-admin:title')}
            </AccountMenuLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AccountMenuLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      to={href}
      className={cn(
        'flex min-h-9 items-center rounded-[4px] px-3 text-sm',
        'text-text-300 transition-colors',
        'hover:bg-[var(--surface-panel)] hover:text-text-100',
        'focus-visible:outline-none',
      )}
    >
      {children}
    </Link>
  );
}

interface INavLinkProps {
  to: string;
  children: React.ReactNode;
  leading?: React.ReactNode;
  badgeCount?: number;
  badgeLabel?: string;
}

function NavLink({
  to,
  children,
  leading,
  badgeCount = 0,
  badgeLabel,
}: INavLinkProps): React.JSX.Element {
  return (
    <Link
      to={to}
      className={cn(
        'group relative flex items-center gap-1.5 rounded-[4px] px-2 py-1.5 sm:gap-2 sm:px-3',
        'text-xs text-text-300 sm:text-sm',
        'transition-colors duration-150',
        'hover:text-text-100 hover:bg-[var(--surface-panel)]/60',
      )}
      activeProps={{
        className:
          'text-text-100 bg-[var(--surface-panel)]/70 [&>.nav-active-tick]:opacity-100',
      }}
    >
      {leading}
      <span>{children}</span>
      {badgeCount > 0 ? (
        <span
          aria-label={badgeLabel}
          className='inline-flex min-w-5 items-center justify-center rounded-[4px] bg-[oklch(0.32_0.09_35/0.82)] px-1 font-mono text-[0.62rem] leading-4 text-[oklch(0.92_0.10_60)]'
        >
          {badgeCount}
        </span>
      ) : null}
      <span
        aria-hidden
        className='nav-active-tick pointer-events-none absolute bottom-[-9px] left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-accent-500 opacity-0 transition-opacity'
      />
    </Link>
  );
}
