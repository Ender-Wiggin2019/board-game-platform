import { ACCOUNT_PASSWORD_MIN_CODE_POINTS } from '@board-platform/contracts/auth/accountRules';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/authApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function getResetToken(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('token');
}

export function PasswordResetPage(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const token = getResetToken();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (token) {
        if (
          Array.from(password.normalize('NFC')).length <
          ACCOUNT_PASSWORD_MIN_CODE_POINTS
        ) {
          throw new Error(t('client.auth.validation.password_min'));
        }
        if (password !== passwordConfirm) {
          throw new Error(t('client.auth.validation.password_confirm'));
        }
        await authApi.resetPassword({ token, password, passwordConfirm });
      } else {
        await authApi.forgotPassword({ email });
      }
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className='mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-xl items-center px-5 py-10'>
      <section className='mission-panel w-full px-5 py-6 sm:px-7'>
        <div className='relative z-10 space-y-6'>
          <header className='space-y-2'>
            <h1 className='font-display text-2xl font-semibold text-text-100'>
              {token
                ? t('client.password.reset_title')
                : t('client.password.forgot_title')}
            </h1>
            <p className='text-sm leading-relaxed text-text-400'>
              {token
                ? t('client.password.reset_hint')
                : t('client.password.forgot_hint')}
            </p>
          </header>

          {done ? (
            <div role='status' className='space-y-4 text-sm text-text-300'>
              <p>
                {token
                  ? t('client.password.reset_done')
                  : t('client.password.forgot_done')}
              </p>
              <a
                href='/auth'
                className='inline-flex text-text-100 underline-offset-4 hover:underline'
              >
                {t('client.password.back_to_login')}
              </a>
            </div>
          ) : (
            <form className='space-y-5' onSubmit={submit}>
              {token ? (
                <>
                  <div className='space-y-1.5'>
                    <Label htmlFor='reset-password'>
                      {t('client.auth.fields.access_code')}
                    </Label>
                    <Input
                      id='reset-password'
                      type='password'
                      autoComplete='new-password'
                      minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
                      required
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='reset-password-confirm'>
                      {t('client.auth.fields.password_confirm')}
                    </Label>
                    <Input
                      id='reset-password-confirm'
                      type='password'
                      autoComplete='new-password'
                      minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
                      required
                      value={passwordConfirm}
                      disabled={busy}
                      onChange={(event) =>
                        setPasswordConfirm(event.target.value)
                      }
                    />
                  </div>
                </>
              ) : (
                <div className='space-y-1.5'>
                  <Label htmlFor='reset-email'>
                    {t('client.auth.fields.email')}
                  </Label>
                  <Input
                    id='reset-email'
                    type='email'
                    autoComplete='email'
                    required
                    value={email}
                    disabled={busy}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
              )}
              {error ? (
                <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                  {error}
                </p>
              ) : null}
              <div className='flex flex-wrap items-center gap-3'>
                <Button type='submit' loading={busy}>
                  {token
                    ? t('client.password.reset_submit')
                    : t('client.password.send_reset')}
                </Button>
                <a
                  href='/auth'
                  className='text-sm text-text-400 underline-offset-4 hover:text-text-100 hover:underline'
                >
                  {t('client.password.back_to_login')}
                </a>
              </div>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
