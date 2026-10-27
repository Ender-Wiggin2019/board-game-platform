import { ERole } from '@board-platform/contracts/auth/roles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/api/authApi.js';
import { EmailNotificationSettings } from '@/features/profile/EmailNotificationSettings';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/api/authApi.js', () => ({
  authApi: { getMe: vi.fn(), updatePreferences: vi.fn() },
}));

afterEach(() => {
  cleanup();
});

const user = {
  id: 'account-1',
  name: 'Commander',
  email: 'commander@example.com',
  role: 'navigator',
  emailVerifiedAt: '2026-09-24T00:00:00.000Z',
  preferences: { emailTurnRemindersEnabled: true },
};

describe('EmailNotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().login('session-token', user);
    vi.mocked(authApi.getMe).mockResolvedValue(user);
    vi.mocked(authApi.updatePreferences).mockImplementation(async (patch) => ({
      ...user,
      preferences: {
        ...user.preferences,
        emailTurnRemindersEnabled:
          patch.emailTurnRemindersEnabled ??
          user.preferences.emailTurnRemindersEnabled,
        emailQuietHours: patch.emailQuietHours,
      },
    }));
  });

  it('lets a verified Navigator explicitly enable turn email', async () => {
    const optedOut = {
      ...user,
      preferences: { emailTurnRemindersEnabled: false },
    };
    useAuthStore.getState().login('session-token', optedOut);
    vi.mocked(authApi.getMe).mockResolvedValue(optedOut);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EmailNotificationSettings />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole('switch', {
      name: 'Turn reminder email',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(authApi.updatePreferences).toHaveBeenCalledWith({
        emailTurnRemindersEnabled: true,
      }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it('allows a Navigator without verified email to enable reminders', async () => {
    const unverified = {
      ...user,
      emailVerifiedAt: null,
      preferences: { emailTurnRemindersEnabled: false },
    };
    useAuthStore.getState().login('session-token', unverified);
    vi.mocked(authApi.getMe).mockResolvedValue(unverified);
    vi.mocked(authApi.updatePreferences).mockResolvedValue({
      ...unverified,
      preferences: { emailTurnRemindersEnabled: true },
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EmailNotificationSettings />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole('switch', {
      name: 'Turn reminder email',
    });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(authApi.updatePreferences).toHaveBeenCalledWith({
        emailTurnRemindersEnabled: true,
      }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  });

  it.each(['guest', 'player'])(
    'shows the membership requirement instead of reminder controls for %s',
    async (role) => {
      const currentUser = { ...user, role };
      useAuthStore.getState().login('session-token', currentUser);
      vi.mocked(authApi.getMe).mockResolvedValue(currentUser);
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <EmailNotificationSettings />
        </QueryClientProvider>,
      );
      expect(
        await screen.findByText(
          'Turn reminder email is available to Navigators and higher tiers.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(authApi.updatePreferences).not.toHaveBeenCalled();
    },
  );

  it('hides reminder controls when the Navigator grant is inactive', async () => {
    const inactive = {
      ...user,
      baseRole: ERole.PLAYER,
      navigator: { active: false, source: 'grant' as const, expiresAt: null },
    };
    useAuthStore.getState().login('session-token', inactive);
    vi.mocked(authApi.getMe).mockResolvedValue(inactive);
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EmailNotificationSettings />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        'Turn reminder email is available to Navigators and higher tiers.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('validates and saves account-time-zone quiet hours', async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <EmailNotificationSettings />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('switch', { name: 'Quiet hours' }));
    fireEvent.change(screen.getByLabelText('Time zone (IANA)'), {
      target: { value: 'Mars/Olympus' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid time zone');
    expect(authApi.updatePreferences).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Time zone (IANA)'), {
      target: { value: 'Asia/Shanghai' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    await waitFor(() =>
      expect(authApi.updatePreferences).toHaveBeenCalledWith({
        emailQuietHours: {
          start: '22:00',
          end: '08:00',
          timezone: 'Asia/Shanghai',
        },
      }),
    );
  });

  it('does not cache a preference response after switching accounts', async () => {
    let resolveUpdate: (
      value: Awaited<ReturnType<typeof authApi.updatePreferences>>,
    ) => void = () => undefined;
    const updateResponse = new Promise<
      Awaited<ReturnType<typeof authApi.updatePreferences>>
    >((resolve) => {
      resolveUpdate = resolve;
    });
    vi.mocked(authApi.updatePreferences).mockReturnValue(updateResponse);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <EmailNotificationSettings />
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole('switch', {
      name: 'Turn reminder email',
    });
    await waitFor(() =>
      expect(client.getQueryData(accountProfileQueryKey())).toEqual(user),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(authApi.updatePreferences).toHaveBeenCalledWith({
        emailTurnRemindersEnabled: false,
      }),
    );

    const otherAccount = {
      ...user,
      id: 'account-2',
      email: 'other@example.com',
      preferences: { emailTurnRemindersEnabled: false },
    };
    act(() => {
      useAuthStore.getState().login('other-token', otherAccount);
      client.setQueryData(accountProfileQueryKey(), otherAccount);
    });

    await act(async () => {
      resolveUpdate({
        ...user,
        preferences: { emailTurnRemindersEnabled: false },
      });
      await updateResponse;
    });

    expect(client.getQueryData(accountProfileQueryKey())).toEqual(otherAccount);
  });
});
