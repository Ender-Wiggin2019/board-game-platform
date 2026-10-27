import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n.js';
import { PlatformAdministrationPage } from '@/pages/admin/PlatformAdministrationPage.js';
import { useAuthStore } from '@/stores/authStore.js';

describe('PlatformAdministrationPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    await i18n.loadNamespaces('platform-admin');
    useAuthStore.setState({
      token: 'token',
      user: {
        id: 'player-1',
        name: 'Player One',
        email: 'player@example.com',
        role: 'player',
        baseRole: 'player',
      },
      isAuthenticated: true,
      isRestoring: false,
      sessionExpired: false,
    });
  });

  it('keeps the platform administration gate independent of game registration', () => {
    render(<PlatformAdministrationPage />);
    expect(
      screen.getByText(
        'You do not have permission to use platform administration.',
      ),
    ).toBeInTheDocument();
  });
});
