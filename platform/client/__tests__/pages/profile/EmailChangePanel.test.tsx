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
import { useToastStore } from '@/components/ui/toast.js';
import { EmailChangePanel } from '@/features/profile/EmailChangePanel';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery';
import i18n from '@/i18n.js';
import { disconnectPushNotifications } from '@/lib/pushNotifications';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/lib/pushNotifications', () => ({
  disconnectPushNotifications: vi.fn().mockResolvedValue(undefined),
}));

const profile = vi.hoisted(() => ({
  id: 'account-1',
  name: 'Commander',
  email: 'player@example.com',
  emailVerifiedAt: null as string | null,
}));
vi.mock('@/hooks/useAuth.js', () => ({
  useCurrentUser: () => ({ data: profile }),
}));
vi.mock('@/api/authApi.js', () => ({
  authApi: { startEmailChange: vi.fn(), confirmEmailChange: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <EmailChangePanel />
      </QueryClientProvider>,
    ),
  };
}

describe('optional email binding', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    profile.emailVerifiedAt = null;
    useAuthStore.getState().logout();
    useAuthStore.getState().login('session-token', profile);
    await i18n.changeLanguage('en');
  });

  it('sends no email until the user explicitly requests binding and preserves the registered address', async () => {
    vi.mocked(authApi.startEmailChange).mockResolvedValue({
      challengeId: 'challenge-1',
      expiresAt: 'later',
    });
    renderPanel();
    expect(screen.getByText(/Email binding is optional/)).toBeInTheDocument();
    expect(authApi.startEmailChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bind email' }));
    expect(screen.getByLabelText('Email')).toHaveValue('player@example.com');
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send verification code' }),
    );
    await waitFor(() =>
      expect(authApi.startEmailChange).toHaveBeenCalledWith({
        email: 'player@example.com',
        currentPassword: 'existing-password',
      }),
    );
    expect(
      await screen.findByLabelText('Verification code'),
    ).toBeInTheDocument();
  });

  it('keeps binding optional and retains input after a mail failure', async () => {
    vi.mocked(authApi.startEmailChange).mockRejectedValue(
      new Error('Mail unavailable'),
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Bind email' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send verification code' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Mail unavailable',
    );
    expect(screen.getByLabelText('Email')).toHaveValue('player@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('button', { name: 'Bind email' }),
    ).toBeInTheDocument();
  });

  it('preserves success feedback after binding logs the user out', async () => {
    vi.mocked(authApi.startEmailChange).mockResolvedValue({
      challengeId: 'challenge-1',
      expiresAt: 'later',
    });
    vi.mocked(authApi.confirmEmailChange).mockResolvedValue({
      email: profile.email,
    });
    const logout = vi.spyOn(useAuthStore.getState(), 'logout');
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Bind email' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send verification code' }),
    );
    fireEvent.change(await screen.findByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(logout).toHaveBeenCalled());
    expect(useToastStore.getState().toasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Email bound successfully. Please sign in again.',
          variant: 'success',
        }),
      ]),
    );
    logout.mockRestore();
  });

  it('ignores a confirmation response after switching accounts', async () => {
    vi.mocked(authApi.startEmailChange).mockResolvedValue({
      challengeId: 'challenge-1',
      expiresAt: 'later',
    });
    let resolveConfirm: (
      value: Awaited<ReturnType<typeof authApi.confirmEmailChange>>,
    ) => void = () => undefined;
    const confirmResponse = new Promise<
      Awaited<ReturnType<typeof authApi.confirmEmailChange>>
    >((resolve) => {
      resolveConfirm = resolve;
    });
    vi.mocked(authApi.confirmEmailChange).mockReturnValue(confirmResponse);
    const logout = vi.spyOn(useAuthStore.getState(), 'logout');
    logout.mockClear();
    const { client } = renderPanel();
    client.setQueryData(accountProfileQueryKey(), profile);

    fireEvent.click(screen.getByRole('button', { name: 'Bind email' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send verification code' }),
    );
    fireEvent.change(await screen.findByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() =>
      expect(authApi.confirmEmailChange).toHaveBeenCalledWith({
        challengeId: 'challenge-1',
        code: '123456',
      }),
    );

    act(() => {
      useAuthStore.getState().login('other-token', {
        id: 'account-2',
        name: 'Other Commander',
        email: 'other@example.com',
      });
    });
    useToastStore.setState({ toasts: [] });
    await act(async () => {
      resolveConfirm({ email: profile.email });
      await confirmResponse;
    });

    expect(logout).not.toHaveBeenCalled();
    expect(disconnectPushNotifications).not.toHaveBeenCalled();
    expect(client.getQueryData(accountProfileQueryKey())).toEqual(profile);
    expect(useToastStore.getState().toasts).toEqual([]);
    logout.mockRestore();
  });

  it('does not log out a replacement account while push cleanup is pending', async () => {
    vi.mocked(authApi.startEmailChange).mockResolvedValue({
      challengeId: 'challenge-1',
      expiresAt: 'later',
    });
    vi.mocked(authApi.confirmEmailChange).mockResolvedValue({
      email: profile.email,
    });
    let releaseCleanup = () => undefined as void;
    vi.mocked(disconnectPushNotifications).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }),
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Bind email' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'existing-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Send verification code' }),
    );
    fireEvent.change(await screen.findByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await waitFor(() => expect(disconnectPushNotifications).toHaveBeenCalled());

    act(() => {
      useAuthStore.getState().login('other-token', {
        id: 'account-2',
        name: 'Other Commander',
        email: 'other@example.com',
      });
    });
    await act(async () => releaseCleanup());

    expect(useAuthStore.getState().user?.id).toBe('account-2');
  });

  it('shows recovery availability for a verified email', () => {
    profile.emailVerifiedAt = '2026-09-27T00:00:00Z';
    renderPanel();
    expect(screen.getByText(/Email bound/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Change email' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Bind email' }),
    ).not.toBeInTheDocument();
  });
});
