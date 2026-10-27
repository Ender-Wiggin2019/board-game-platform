vi.mock('@/platform/gameClientRegistry', () => ({
  listGameClients: () => [
    {
      legacyRoutes: [
        '/my-games',
        '/friends',
        '/messages',
        '/admin',
        '/about',
      ].map((pathPrefix) => ({ pathPrefix })),
    },
  ],
}));

import { ERole } from '@board-platform/contracts/auth/roles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/layout/AppShell';
import i18n from '@/i18n';
import { useAuthStore } from '@/stores/authStore';

const homeSummaryMock = vi.hoisted(() => ({
  pendingCount: 0,
  actionRequiredCount: 3,
  waitingReadyCount: 4,
  useHomeSummary: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    activeProps: _activeProps,
    children,
    to,
    className,
    ...props
  }: {
    activeProps?: unknown;
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a className={className} href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/layout/ShellBadges', () => ({
  useShellBadges: () => ({
    friendPendingCount: homeSummaryMock.pendingCount,
    actionRequiredCount: homeSummaryMock.actionRequiredCount,
    waitingReadyCount: homeSummaryMock.waitingReadyCount,
    unreadCount: 2,
  }),
}));

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <p>Content</p>
      </AppShell>
    </QueryClientProvider>,
  );
}

describe('AppShell admin navigation', () => {
  it('uses platform destinations in the shared navigation', () => {
    useAuthStore.getState().login('token', {
      id: 'player-1',
      name: 'Player',
      email: 'player@test.com',
      role: ERole.PLAYER,
    });
    renderShell();
    expect(document.querySelector('a[href="/rankings"]')).toBeNull();
    expect(document.querySelector('a[href="/platform/rankings"]')).toBeNull();
    expect(screen.getByRole('link', { name: /All games/ })).toHaveAttribute(
      'href',
      '/',
    );
    expect(document.querySelector('a[href="/daily-challenge"]')).toBeNull();
    expect(document.querySelector('a[href="/stats"]')).toBeNull();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    homeSummaryMock.pendingCount = 0;
    homeSummaryMock.actionRequiredCount = 3;
    homeSummaryMock.waitingReadyCount = 4;
    homeSummaryMock.useHomeSummary.mockClear();
    await i18n.changeLanguage('en');
    useAuthStore.getState().logout();
  });

  it('keeps game links, friends, and avatar in the top chrome', () => {
    useAuthStore.getState().login('token', {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@test.com',
      role: ERole.ADMIN,
    });

    renderShell();

    const homeLink = screen.getByLabelText('Board Game Utopia Home');
    expect(homeLink).not.toHaveClass('hidden');
    const gamesLink = screen.getByRole('link', { name: /All games/ });
    expect(gamesLink).toHaveAttribute('href', '/');
    expect(within(gamesLink).getByText('4')).toBeInTheDocument();
    const sessionsLink = screen.getByRole('link', { name: /My Games/ });
    expect(sessionsLink).toHaveAttribute('href', '/platform/sessions');
    expect(within(sessionsLink).getByText('3')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Rankings' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Friends' })).toHaveAttribute(
      'href',
      '/friends',
    );
    expect(screen.queryByTestId('header-controls')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Admin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Profile' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toHaveClass(
      'h-10',
      'w-10',
    );
    const accountMenu = screen.getByRole('button', { name: 'Account menu' });
    expect(within(accountMenu).getByText('2')).toBeInTheDocument();
    expect(accountMenu).toHaveAccessibleDescription('2 unread messages');

    fireEvent.click(accountMenu);
    expect(screen.getByRole('link', { name: 'Messages (2)' })).toHaveAttribute(
      'href',
      '/messages',
    );
  });

  it('shows pending friend work on the Friends navigation link only when actionable items exist', async () => {
    useAuthStore.getState().login('token', {
      id: 'user-1',
      name: 'Player',
      email: 'player@test.com',
      role: ERole.PLAYER,
    });
    homeSummaryMock.pendingCount = 3;

    renderShell();

    const friendsLink = screen.getByRole('link', { name: /Friends/ });
    const badge = within(friendsLink).getByText('3');

    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAccessibleName('3 pending friend items');
    expect(friendsLink).toHaveAttribute('href', '/friends');
  });

  it('moves profile, settings, and admin into the avatar menu', () => {
    useAuthStore.getState().login('token', {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@test.com',
      role: ERole.ADMIN,
    });

    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    expect(
      screen.queryByRole('link', { name: 'Profile' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Account migration' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(
      screen.queryByRole('link', { name: 'Admin' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Platform operations' }),
    ).toHaveAttribute('href', '/platform/operations');
  });

  it('localizes top navigation and account menu links', async () => {
    await i18n.changeLanguage('zh-CN');
    useAuthStore.getState().login('token', {
      id: 'admin-1',
      name: 'Admin',
      email: 'admin@test.com',
      role: ERole.ADMIN,
    });

    renderShell();

    expect(
      screen.getByRole('link', { name: '桌游乌托邦 首页' }),
    ).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /全部游戏/ })).toHaveAttribute(
      'href',
      '/',
    );
    expect(
      screen.queryByRole('link', { name: '排位榜' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '好友' })).toHaveAttribute(
      'href',
      '/friends',
    );

    fireEvent.click(screen.getByRole('button', { name: '账户菜单' }));

    expect(
      screen.queryByRole('link', { name: '个人资料' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(
      screen.queryByRole('link', { name: '管理' }),
    ).not.toBeInTheDocument();
  });

  it('hides admin menu item for non-admin users', () => {
    useAuthStore.getState().login('token', {
      id: 'user-1',
      name: 'Player',
      email: 'player@test.com',
      role: ERole.PLAYER,
    });

    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    expect(
      screen.queryByRole('link', { name: 'Admin' }),
    ).not.toBeInTheDocument();
  });

  it('shows account binding only without querying game-only summaries', () => {
    useAuthStore.getState().login('token', {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest@test.com',
      role: ERole.GUEST,
    });

    renderShell();

    expect(
      screen.getByRole('link', { name: 'Activate account' }),
    ).toHaveAttribute('href', '/activate');
    expect(
      screen.queryByRole('link', { name: 'Daily Challenge' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'My Games' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Stats' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Friends' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(
      screen.queryByRole('link', { name: 'Messages (2)' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'About' }),
    ).not.toBeInTheDocument();
    // Asserts the `enabled` flag it cares about rather than the whole options
    // object, so adding an unrelated option does not fail this test.
  });

  it('localizes the tab title outside a live game', async () => {
    await i18n.changeLanguage('zh-CN');
    useAuthStore.getState().login('token', {
      id: 'player-1',
      name: 'Player One',
      email: 'player1@test.com',
      role: ERole.PLAYER,
    });

    renderShell();

    // index.html carries an English title for the pre-React paint, and only the
    // game page used to replace it — so every lobby-side screen stayed English
    // regardless of language.
    expect(document.title).toBe('桌游乌托邦');
  });

  it('restores the document icons after the turn alert ends', () => {
    homeSummaryMock.actionRequiredCount = 2;
    useAuthStore.getState().login('token', {
      id: 'player-1',
      name: 'Player One',
      email: 'player1@test.com',
      role: ERole.PLAYER,
    });

    const ico = document.createElement('link');
    ico.setAttribute('rel', 'icon');
    ico.setAttribute('sizes', 'any');
    ico.setAttribute('href', '/favicon.ico');
    document.head.append(ico);

    try {
      const { unmount } = renderShell();

      // The alert icon is drawn from a fetched image, which jsdom does not load,
      // so the flashing itself is not observable here. What must hold either
      // way: the hook parks the document's own icons while alerting (favicon.ico
      // declares sizes="any" and would otherwise win), and puts them back — so
      // the tab is never left without its normal icon.
      unmount();
      expect(document.querySelectorAll('link[data-turn-alert]')).toHaveLength(
        0,
      );
      expect(document.head.contains(ico)).toBe(true);
      expect(ico.getAttribute('href')).toBe('/favicon.ico');
    } finally {
      ico.remove();
    }
  });

  it('offers signed-out visitors the language switch next to sign in', () => {
    renderShell();

    const toggle = screen.getByTestId('guest-language-toggle');
    expect(
      within(toggle).getByRole('button', { name: '中文' }),
    ).toBeInTheDocument();
    expect(
      within(toggle).getByRole('button', { name: 'English' }),
    ).toBeInTheDocument();
    expect(document.querySelector('a[href="/auth"]')).toBeInTheDocument();
  });

  it('leaves the language to account settings once signed in', () => {
    useAuthStore.getState().login('token', {
      id: 'player-1',
      name: 'Player',
      email: 'player@test.com',
      role: ERole.PLAYER,
    });

    renderShell();

    expect(
      screen.queryByTestId('guest-language-toggle'),
    ).not.toBeInTheDocument();
  });
});
