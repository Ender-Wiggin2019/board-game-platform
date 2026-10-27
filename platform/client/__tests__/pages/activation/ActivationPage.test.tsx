import { ERole } from '@board-platform/contracts/auth/roles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery.js';
import i18n from '@/i18n.js';
import { ActivationPage } from '@/pages/activation/ActivationPage.js';
import { useAuthStore } from '@/stores/authStore.js';

const authMocks = vi.hoisted(() => ({
  redeemInviteCode: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as { returnTo?: string },
}));

vi.mock('@/api/authApi.js', () => ({ authApi: authMocks }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => routerMocks.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { search: { returnTo?: string } } }) => unknown;
  }) => select({ location: { search: routerMocks.search } }),
}));

function renderActivation() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ActivationPage />
      </QueryClientProvider>,
    ),
  };
}

describe('ActivationPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    routerMocks.search = {};
    await i18n.changeLanguage('en');
    useAuthStore.getState().login('guest-token', {
      id: 'guest-1',
      name: 'Guest Explorer',
      email: 'guest@example.com',
      role: ERole.GUEST,
    });
  });

  it('resumes an original game link after activation', async () => {
    routerMocks.search = { returnTo: '/game/original?view=board#hand' };
    authMocks.redeemInviteCode.mockResolvedValueOnce({
      ...useAuthStore.getState().user,
      role: ERole.PLAYER,
    });
    renderActivation();
    fireEvent.change(screen.getByLabelText('Invitation code'), {
      target: { value: 'ABCD2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() =>
      expect(routerMocks.navigate).toHaveBeenCalledWith({
        to: routerMocks.search.returnTo,
        replace: true,
      }),
    );
  });

  it('redeems the invite code, updates the account cache, and enters the platform lobby', async () => {
    const updatedUser = {
      id: 'guest-1',
      name: 'Guest Explorer',
      email: 'guest@example.com',
      role: ERole.PLAYER,
    };
    authMocks.redeemInviteCode.mockResolvedValueOnce(updatedUser);
    const { queryClient } = renderActivation();
    let resolveStaleProfile!: (value: {
      id: string;
      name: string;
      email: string;
      role: ERole;
    }) => void;
    const staleProfile = new Promise<{
      id: string;
      name: string;
      email: string;
      role: ERole;
    }>((resolve) => {
      resolveStaleProfile = resolve;
    });
    const staleProfileQuery = queryClient
      .fetchQuery({
        queryKey: accountProfileQueryKey(),
        queryFn: () => staleProfile,
      })
      .catch(() => undefined);

    const codeInput = screen.getByLabelText('Invitation code');
    fireEvent.change(codeInput, { target: { value: '  ABCD2345  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() =>
      expect(authMocks.redeemInviteCode).toHaveBeenCalledWith({
        code: 'ABCD2345',
      }),
    );
    expect(useAuthStore.getState().user).toEqual(updatedUser);
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(
      updatedUser,
    );
    expect(routerMocks.navigate).toHaveBeenCalledWith({
      to: '/platform',
      replace: true,
    });
    await act(async () => {
      resolveStaleProfile({ ...updatedUser, role: ERole.GUEST });
      await staleProfileQuery;
    });
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(
      updatedUser,
    );
  });

  it('keeps the code and shows a local error when redemption fails', async () => {
    authMocks.redeemInviteCode.mockRejectedValueOnce(
      new Error('This invite code has expired.'),
    );
    renderActivation();

    const codeInput = screen.getByLabelText('Invitation code');
    fireEvent.change(codeInput, { target: { value: 'EXPIRED1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This invite code has expired.',
    );
    expect(codeInput).toHaveValue('EXPIRED1');
    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user?.role).toBe(ERole.GUEST);
  });

  it('clears the busy state when redemption resolves for a previous session', async () => {
    let resolveRedemption!: (user: {
      id: string;
      name: string;
      email: string;
      role: ERole;
    }) => void;
    authMocks.redeemInviteCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRedemption = resolve;
        }),
    );
    renderActivation();

    const codeInput = screen.getByLabelText('Invitation code');
    fireEvent.change(codeInput, { target: { value: 'STALE123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() =>
      expect(authMocks.redeemInviteCode).toHaveBeenCalledWith({
        code: 'STALE123',
      }),
    );

    act(() => {
      useAuthStore.getState().login('new-token', {
        id: 'new-user',
        name: 'New Explorer',
        email: 'new@example.com',
        role: ERole.PLAYER,
      });
    });
    resolveRedemption({
      id: 'guest-1',
      name: 'Guest Explorer',
      email: 'guest@example.com',
      role: ERole.PLAYER,
    });

    await waitFor(() => expect(codeInput).toBeEnabled());
    expect(useAuthStore.getState().user?.id).toBe('new-user');
    expect(routerMocks.navigate).not.toHaveBeenCalled();
  });

  it('applies a successful redemption after the same account refreshes its token', async () => {
    let resolveRedemption!: (user: {
      id: string;
      name: string;
      email: string;
      role: ERole;
    }) => void;
    authMocks.redeemInviteCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRedemption = resolve;
        }),
    );
    const { queryClient } = renderActivation();

    fireEvent.change(screen.getByLabelText('Invitation code'), {
      target: { value: 'ABCD2345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));
    await waitFor(() => expect(authMocks.redeemInviteCode).toHaveBeenCalled());

    act(() => {
      const requestSession = useAuthStore.getState();
      useAuthStore.getState().refreshSession(
        'rotated-token',
        {
          id: 'guest-1',
          name: 'Guest Explorer',
          email: 'guest@example.com',
          role: ERole.GUEST,
        },
        requestSession,
      );
    });
    const updatedUser = {
      id: 'guest-1',
      name: 'Guest Explorer',
      email: 'guest@example.com',
      role: ERole.PLAYER,
    };
    resolveRedemption(updatedUser);

    await waitFor(() =>
      expect(useAuthStore.getState().user).toEqual(updatedUser),
    );
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(
      updatedUser,
    );
    expect(routerMocks.navigate).toHaveBeenCalledWith({
      to: '/platform',
      replace: true,
    });
  });

  it('lets an active player redeem an upgrade code', async () => {
    const player = {
      id: 'player-1',
      name: 'Player Explorer',
      email: 'player@example.com',
      role: ERole.PLAYER,
    };
    const upgradedUser = { ...player, role: ERole.TESTER };
    useAuthStore.getState().login('player-token', player);
    authMocks.redeemInviteCode.mockResolvedValueOnce(upgradedUser);
    const { queryClient } = renderActivation();

    expect(screen.getByRole('link', { name: 'Enter lobby' })).toHaveAttribute(
      'href',
      '/platform',
    );
    fireEvent.change(screen.getByLabelText('Invitation code'), {
      target: { value: 'TESTER42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Activate account' }));

    await waitFor(() =>
      expect(authMocks.redeemInviteCode).toHaveBeenCalledWith({
        code: 'TESTER42',
      }),
    );
    expect(useAuthStore.getState().user).toEqual(upgradedUser);
    expect(queryClient.getQueryData(accountProfileQueryKey())).toEqual(
      upgradedUser,
    );
    expect(routerMocks.navigate).toHaveBeenCalledWith({
      to: '/platform',
      replace: true,
    });
  });
});
