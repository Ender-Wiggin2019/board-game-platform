import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authApi } from '@/api/authApi.js';
import { useToastStore } from '@/components/ui/toast.js';
import { ChangePasswordPanel } from '@/features/profile/ChangePasswordPanel';
import { useAuthStore } from '@/stores/authStore.js';

vi.mock('@/api/authApi.js', () => ({ authApi: { changePassword: vi.fn() } }));
function openForm() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      }
    >
      <ChangePasswordPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'old-password' },
  });
  fireEvent.change(
    screen.getByLabelText('New password (at least 6 characters)'),
    { target: { value: 'new-password-long' } },
  );
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: 'new-password-long' },
  });
}
describe('change password', () => {
  beforeEach(() => vi.clearAllMocks());
  it('replaces the session with the returned token after success', async () => {
    const user = {
      id: 'account',
      email: 'me@test.com',
      name: 'Me',
      role: 'guest',
    };
    useAuthStore.getState().login('old-token', user);
    vi.mocked(authApi.changePassword).mockImplementation(async () => {
      const requestSession = useAuthStore.getState();
      const response = {
        token: 'replacement-token',
        user,
      };
      useAuthStore
        .getState()
        .refreshSession(response.token, response.user, requestSession);
      return response;
    });
    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(useAuthStore.getState().token).toBe('replacement-token'),
    );
    expect(authApi.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-password',
      newPassword: 'new-password-long',
      passwordConfirm: 'new-password-long',
    });
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });
  it.each(['logout', 'switch'])(
    'ignores a password response after session %s',
    async (action) => {
      const user = {
        id: 'account',
        email: 'me@test.com',
        name: 'Me',
        role: 'guest',
      };
      const other = {
        id: 'other',
        email: 'other@test.com',
        name: 'Other',
        role: 'player',
      };
      useAuthStore.getState().login('original-token', user);
      let resolve = (
        _value: Awaited<ReturnType<typeof authApi.changePassword>>,
      ) => undefined as void;
      vi.mocked(authApi.changePassword).mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      openForm();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(authApi.changePassword).toHaveBeenCalled());
      act(() => {
        if (action === 'logout') useAuthStore.getState().logout();
        else useAuthStore.getState().login('other-token', other);
      });
      useToastStore.setState({ toasts: [] });
      await act(async () => resolve({ token: 'rotated-token', user }));
      expect(useAuthStore.getState().token).toBe(
        action === 'logout' ? null : 'other-token',
      );
      expect(useAuthStore.getState().user?.id).toBe(
        action === 'logout' ? undefined : 'other',
      );
      expect(useToastStore.getState().toasts).toEqual([]);
    },
  );

  it('keeps entered values and the session when the current password is wrong', async () => {
    vi.mocked(authApi.changePassword).mockRejectedValue(
      new Error('Current password is incorrect'),
    );
    openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Current password is incorrect',
    );
    expect(screen.getByLabelText('Current password')).toHaveValue(
      'old-password',
    );
    expect(
      screen.getByLabelText('New password (at least 6 characters)'),
    ).toHaveValue('new-password-long');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue(
      'new-password-long',
    );
  });
});
