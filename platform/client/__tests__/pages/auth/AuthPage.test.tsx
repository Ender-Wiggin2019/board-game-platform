import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n.js';
import { requestInterfaceLanguage } from '@/lib/interfaceLanguage.js';
import { AuthPage } from '@/pages/auth/AuthPage.js';
import { useAuthStore } from '@/stores/authStore.js';

function renderAuth() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AuthPage />
    </QueryClientProvider>,
  );
}

const mockLoginMutate = vi.fn();
const mockRegisterMutate = vi.fn();

vi.mock('@/hooks/useAuth.js', () => ({
  useLogin: () => ({ isPending: false, mutate: mockLoginMutate }),
  useRegister: () => ({ isPending: false, mutate: mockRegisterMutate }),
}));

describe('AuthPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    useAuthStore.getState().logout();
  });

  it('renders a loading state while the root route guard handles an authenticated visit', () => {
    useAuthStore.getState().login('token', {
      id: 'player-1',
      name: 'Player One',
      email: 'player@example.com',
      role: 'player',
    });

    renderAuth();

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByTestId('auth-login-submit')).not.toBeInTheDocument();
  });

  it('links to the password recovery flow', () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-login'));
    expect(
      screen.getByRole('link', { name: 'Forgot password?' }),
    ).toHaveAttribute('href', '/auth/password/forgot');
  });

  it('defaults to login while keeping the illustrated auth tabs usable', () => {
    renderAuth();

    expect(screen.getByTestId('auth-scene-image')).toHaveAttribute(
      'src',
      '/assets/platform/auth-observatory.webp',
    );
    expect(screen.getByTestId('auth-login-submit')).toBeInTheDocument();
    expect(screen.getByTestId('auth-tab-login')).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(screen.getByTestId('auth-tab-register'));

    expect(screen.getByTestId('auth-register-submit')).toBeInTheDocument();
  });

  it.each(['player@example.com', 'Explorer'])(
    'submits login identifier %s through the auth mutation',
    async (identifier) => {
      renderAuth();
      fireEvent.click(screen.getByTestId('auth-tab-login'));

      fireEvent.change(
        document.querySelector('#login-email') as HTMLInputElement,
        {
          target: { value: identifier },
        },
      );
      fireEvent.change(
        document.querySelector('#login-password') as HTMLInputElement,
        {
          target: { value: 'password123' },
        },
      );
      fireEvent.click(screen.getByTestId('auth-login-submit'));

      await waitFor(() => expect(mockLoginMutate).toHaveBeenCalledTimes(1));
      expect(mockLoginMutate).toHaveBeenCalledWith(
        { email: identifier, password: 'password123' },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    },
  );

  it('requires an account identifier without imposing email syntax', () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-login'));
    fireEvent.change(screen.getByLabelText('Email or username'), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('auth-login-submit'));
    expect(mockLoginMutate).not.toHaveBeenCalled();
    expect(
      screen.getByText('Enter your email or username.'),
    ).toBeInTheDocument();
  });

  it('registers all four fields directly without an email challenge', async () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-register'));

    fireEvent.change(document.querySelector('#reg-email') as HTMLInputElement, {
      target: { value: 'explorer@example.com' },
    });
    fireEvent.change(document.querySelector('#reg-name') as HTMLInputElement, {
      target: { value: 'Explorer' },
    });
    fireEvent.change(
      document.querySelector('#reg-password') as HTMLInputElement,
      {
        target: { value: '123456' },
      },
    );
    fireEvent.change(
      document.querySelector('#reg-password-confirm') as HTMLInputElement,
      {
        target: { value: '123456' },
      },
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('auth-register-submit'));

    await waitFor(() => expect(mockRegisterMutate).toHaveBeenCalledTimes(1));
    expect(mockRegisterMutate).toHaveBeenCalledWith(
      {
        email: 'explorer@example.com',
        name: 'Explorer',
        password: '123456',
        passwordConfirm: '123456',
        consentVersion: 'account-registration-v1',
        language: 'en',
      },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('keeps the default account language when registering from the Chinese interface', async () => {
    await i18n.changeLanguage('zh-CN');
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-register'));
    for (const [selector, value] of [
      ['#reg-email', 'explorer@example.com'],
      ['#reg-name', 'Explorer'],
      ['#reg-password', '123456'],
      ['#reg-password-confirm', '123456'],
    ]) {
      fireEvent.change(document.querySelector(selector) as HTMLInputElement, {
        target: { value },
      });
    }
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('auth-register-submit'));

    await waitFor(() => expect(mockRegisterMutate).toHaveBeenCalledTimes(1));
    expect(mockRegisterMutate.mock.calls[0]?.[0]).not.toHaveProperty(
      'language',
    );
  });

  it('registers with the pending guest language choice before its resources finish loading', async () => {
    await i18n.changeLanguage('zh-CN');
    let finishEnglishLoad!: () => void;
    const englishLoad = new Promise<void>((resolve) => {
      finishEnglishLoad = resolve;
    });
    const originalChangeLanguage = i18n.changeLanguage.bind(i18n);
    const changeLanguage = vi
      .spyOn(i18n, 'changeLanguage')
      .mockImplementation((language, callback) =>
        language === 'en'
          ? (englishLoad.then(() =>
              originalChangeLanguage(language, callback),
            ) as ReturnType<typeof i18n.changeLanguage>)
          : originalChangeLanguage(language, callback),
      );
    const pendingLanguage = requestInterfaceLanguage('en');

    try {
      renderAuth();
      fireEvent.click(screen.getByTestId('auth-tab-register'));
      for (const [selector, value] of [
        ['#reg-email', 'explorer@example.com'],
        ['#reg-name', 'Explorer'],
        ['#reg-password', '123456'],
        ['#reg-password-confirm', '123456'],
      ]) {
        fireEvent.change(document.querySelector(selector) as HTMLInputElement, {
          target: { value },
        });
      }
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('auth-register-submit'));

      await waitFor(() => expect(mockRegisterMutate).toHaveBeenCalledTimes(1));
      expect(mockRegisterMutate.mock.calls[0]?.[0]).toMatchObject({
        language: 'en',
      });
    } finally {
      finishEnglishLoad();
      await pendingLanguage;
      changeLanguage.mockRestore();
    }
  });

  it('retains the four fields and does not register when password confirmation differs', () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-register'));
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'explorer@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'Explorer' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different-password' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('auth-register-submit'));
    expect(mockRegisterMutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Email')).toHaveValue('explorer@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue('123456');
    expect(
      screen.queryByLabelText('Verification code'),
    ).not.toBeInTheDocument();
  });

  it('focuses terms and blocks registration until explicitly accepted', () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-register'));
    fireEvent.click(screen.getByTestId('auth-register-submit'));
    expect(screen.getByRole('checkbox')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please read and agree',
    );
    expect(mockRegisterMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Terms of use' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('not affiliated');
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'All gameplay content',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close terms' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('updates password matching feedback while either password changes', () => {
    renderAuth();
    fireEvent.click(screen.getByTestId('auth-tab-register'));
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: '123456' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: '123457' },
    });
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: '123456' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('Passwords match');
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: '654321' },
    });
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it.each([
    ['en', 'Enter your name', 'Terms of use'],
    ['zh-CN', '请输入名称', '使用条款'],
  ])(
    'localizes registration and terms in %s',
    async (locale, placeholder, title) => {
      await i18n.changeLanguage(locale);
      const view = renderAuth();
      try {
        fireEvent.click(screen.getByTestId('auth-tab-register'));
        expect(screen.getByPlaceholderText(placeholder)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: title }));
        expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
        expect(screen.getByRole('dialog')).not.toHaveTextContent(
          'client.auth.terms',
        );
      } finally {
        view.unmount();
        await i18n.changeLanguage('en');
      }
    },
  );

  it.each([
    ['en', 'Board Game Utopia'],
    ['zh-CN', 'Board Game Utopia'],
  ] as const)('renders the shared %s brand identity', async (locale, name) => {
    await i18n.changeLanguage(locale);
    const view = renderAuth();

    try {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(name);
    } finally {
      view.unmount();
      await i18n.changeLanguage('en');
    }
  });
});
