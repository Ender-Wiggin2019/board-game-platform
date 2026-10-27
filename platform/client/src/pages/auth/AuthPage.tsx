import {
  ACCOUNT_PASSWORD_MIN_CODE_POINTS,
  AccountRuleError,
  normalizeAccountName,
  normalizeEmailAddress,
  validatePassword,
  validatePasswordConfirmation,
} from '@board-platform/contracts/auth/accountRules';
import { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { z } from 'zod';
import { BrandWordmark } from '@/components/BrandWordmark';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useSceneHero } from '@/components/layout/SceneBackground';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { DEFAULT_LANGUAGE } from '@/config/constants';
import { useLogin, useRegister } from '@/hooks/useAuth';
import { getInterfaceLanguage } from '@/lib/interfaceLanguage';
import { useAuthStore } from '@/stores/authStore';

const AUTH_CARD_IMAGE = '/assets/platform/auth-observatory.webp';

const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

type TLoginForm = z.infer<typeof loginSchema>;
type TRegisterForm = { name: string; email: string; password: string };

function FieldError({
  message,
}: {
  message?: string;
}): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p className='font-mono text-[0.6875rem] uppercase tracking-microlabel text-[var(--signal-red-hi)]'>
      {message}
    </p>
  );
}

function LoginForm(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const loginMutation = useLogin();
  const [form, setForm] = useState<TLoginForm>({ email: '', password: '' });
  const [errors, setErrors] = useState<
    Partial<Record<keyof TLoginForm, string>>
  >({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = loginSchema.safeParse(form);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] as string;
        if (fieldErrors[key]) continue;
        if (key === 'email') {
          fieldErrors[key] = t('client.auth.validation.login_required');
          continue;
        }
        if (key === 'password') {
          fieldErrors[key] = t('client.auth.validation.password_min');
          continue;
        }
        fieldErrors[key] = t('client.auth.validation.invalid_field');
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    loginMutation.mutate(result.data, {
      onError: (err) =>
        toast({
          title: t('client.auth.toast.login_failed'),
          description: err.message,
          variant: 'error',
        }),
    });
  };

  return (
    <form onSubmit={handleSubmit} className='space-y-5'>
      <div className='space-y-1.5'>
        <Label htmlFor='login-email' variant='micro'>
          {t('client.auth.fields.login')}
        </Label>
        <Input
          id='login-email'
          disabled={loginMutation.isPending}
          autoComplete='username'
          type='text'
          placeholder={t('client.auth.placeholders.login')}
          value={form.email}
          mono
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <FieldError message={errors.email} />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='login-password' variant='micro'>
          {t('client.auth.fields.password')}
        </Label>
        <Input
          id='login-password'
          disabled={loginMutation.isPending}
          autoComplete='current-password'
          type='password'
          placeholder='••••••••'
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
        />
        <FieldError message={errors.password} />
      </div>
      <a
        href='/auth/password/forgot'
        className='inline-flex text-sm text-text-400 underline-offset-4 hover:text-text-100 hover:underline'
      >
        {t('client.password.forgot')}
      </a>
      <Button
        type='submit'
        size='lg'
        className='w-full'
        loading={loginMutation.isPending}
        data-testid='auth-login-submit'
      >
        {loginMutation.isPending
          ? t('client.auth.actions.authenticating')
          : t('client.auth.actions.sign_in')}
      </Button>
    </form>
  );
}

function RegisterForm(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const registerMutation = useRegister();
  const termsRef = useRef<HTMLInputElement>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsError, setTermsError] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const [form, setForm] = useState<TRegisterForm & { passwordConfirm: string }>(
    {
      name: '',
      email: '',
      password: '',
      passwordConfirm: '',
    },
  );
  const [errors, setErrors] = useState<
    Partial<Record<keyof TRegisterForm | 'passwordConfirm', string>>
  >({});

  const passwordsMatch =
    form.password.normalize('NFC') === form.passwordConfirm.normalize('NFC');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (registerMutation.isPending) return;
    if (!termsAccepted) {
      setTermsError(true);
      termsRef.current?.focus();
      return;
    }
    setErrors({});
    let email: string;
    try {
      email = normalizeEmailAddress(form.email).email;
    } catch {
      setErrors({ email: t('client.auth.validation.invalid_email') });
      return;
    }
    let name: string;
    try {
      name = normalizeAccountName(form.name).name;
    } catch (error) {
      const tooShort =
        error instanceof AccountRuleError &&
        error.code === 'NAME_LENGTH' &&
        Array.from(form.name.normalize('NFKC').trim()).length < 2;
      setErrors({
        name: t(
          tooShort
            ? 'client.auth.validation.name_min'
            : 'client.auth.validation.invalid_field',
        ),
      });
      return;
    }
    try {
      validatePassword(form.password, { username: name, email: form.email });
    } catch (error) {
      const tooShort =
        error instanceof AccountRuleError &&
        error.code === 'PASSWORD_LENGTH' &&
        Array.from(form.password.normalize('NFC')).length <
          ACCOUNT_PASSWORD_MIN_CODE_POINTS;
      setErrors({
        password: t(
          tooShort
            ? 'client.auth.validation.password_min'
            : 'client.auth.validation.invalid_field',
        ),
      });
      return;
    }
    try {
      validatePasswordConfirmation(form.password, form.passwordConfirm);
    } catch {
      setErrors({
        passwordConfirm: t('client.auth.validation.password_confirm'),
      });
      return;
    }
    const language = getInterfaceLanguage();
    registerMutation.mutate(
      {
        email,
        name,
        password: form.password,
        passwordConfirm: form.passwordConfirm,
        consentVersion: 'account-registration-v1',
        // Only a non-default language is saved, so binding a beta account later
        // can still bring over that account's own language.
        ...(language === DEFAULT_LANGUAGE ? {} : { language }),
      },
      {
        onError: (err) =>
          toast({
            title: t('client.auth.toast.registration_failed'),
            description: err.message,
            variant: 'error',
          }),
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} noValidate className='space-y-4'>
      <div className='space-y-1.5'>
        <Label htmlFor='reg-email' variant='micro'>
          {t('client.auth.fields.email')}
        </Label>
        <Input
          id='reg-email'
          type='email'
          autoComplete='email'
          placeholder={t('client.auth.placeholders.registration_email')}
          value={form.email}
          mono
          disabled={registerMutation.isPending}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        />
        <FieldError message={errors.email} />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='reg-name' variant='micro'>
          {t('client.auth.fields.username')}
        </Label>
        <Input
          id='reg-name'
          disabled={registerMutation.isPending}
          type='text'
          autoComplete='username'
          placeholder={t('client.auth.placeholders.name')}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <FieldError message={errors.name} />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='reg-password' variant='micro'>
          {t('client.auth.fields.password')}
        </Label>
        <Input
          id='reg-password'
          disabled={registerMutation.isPending}
          type='password'
          autoComplete='new-password'
          placeholder={t('client.auth.validation.password_min')}
          minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
        />
        <FieldError message={errors.password} />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='reg-password-confirm' variant='micro'>
          {t('client.auth.fields.password_confirm')}
        </Label>
        <Input
          id='reg-password-confirm'
          aria-describedby='reg-password-match'
          aria-invalid={Boolean(form.passwordConfirm && !passwordsMatch)}
          disabled={registerMutation.isPending}
          type='password'
          autoComplete='new-password'
          minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
          value={form.passwordConfirm}
          onChange={(e) =>
            setForm((f) => ({ ...f, passwordConfirm: e.target.value }))
          }
        />
        <p
          id='reg-password-match'
          role='status'
          className={`text-xs ${form.passwordConfirm && !passwordsMatch ? 'text-[var(--signal-red-hi)]' : 'text-text-300'}`}
        >
          {form.passwordConfirm
            ? t(
                passwordsMatch
                  ? 'client.auth.validation.password_match'
                  : 'client.auth.validation.password_confirm',
              )
            : errors.passwordConfirm}
        </p>
      </div>
      <div className='space-y-1.5'>
        <div className='flex items-start gap-2 text-sm text-text-300'>
          <input
            ref={termsRef}
            id='reg-terms'
            type='checkbox'
            required
            className='mt-1 size-4 shrink-0 cursor-pointer accent-accent-500'
            checked={termsAccepted}
            disabled={registerMutation.isPending}
            aria-labelledby='reg-terms-label'
            aria-describedby={termsError ? 'reg-terms-error' : undefined}
            aria-invalid={termsError}
            onChange={(event) => {
              setTermsAccepted(event.target.checked);
              setTermsError(false);
            }}
          />
          <span id='reg-terms-label'>
            <Trans
              ns='platform-common'
              i18nKey='client.auth.terms.accept'
              components={{
                terms: (
                  <button
                    type='button'
                    className='cursor-pointer text-text-100 underline underline-offset-4'
                    onClick={() => setTermsOpen(true)}
                  />
                ),
              }}
            />
          </span>
        </div>
        {termsError && (
          <p
            id='reg-terms-error'
            role='alert'
            className='text-xs text-[var(--signal-red-hi)]'
          >
            {t('client.auth.terms.required')}
          </p>
        )}
      </div>
      <Dialog
        open={termsOpen}
        onOpenChange={setTermsOpen}
        ariaLabel={t('client.auth.terms.title')}
      >
        <DialogContent
          onClose={() => setTermsOpen(false)}
          closeLabel={t('client.auth.terms.close')}
        >
          <DialogHeader>
            <DialogTitle>{t('client.auth.terms.title')}</DialogTitle>
          </DialogHeader>
          <div className='space-y-4 text-sm leading-relaxed text-text-300'>
            <p>{t('client.auth.terms.fan_work')}</p>
            <p>{t('client.auth.terms.rights')}</p>
            <p>{t('client.auth.terms.free')}</p>
            <p>{t('client.auth.terms.noncommercial')}</p>
          </div>
        </DialogContent>
      </Dialog>
      <Button
        type='submit'
        size='lg'
        className='w-full'
        disabled={registerMutation.isPending}
        data-testid='auth-register-submit'
      >
        {registerMutation.isPending
          ? t('client.auth.actions.initializing')
          : t('client.auth.actions.register')}
      </Button>
    </form>
  );
}

export function AuthPage(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  useSceneHero('/assets/platform/auth-observatory.webp', null);

  if (isAuthenticated) {
    return <LoadingSpinner variant='block' />;
  }

  return (
    <div className='mx-auto flex w-full max-w-6xl flex-1 items-center justify-center py-4'>
      <section
        className='mission-panel w-full max-w-[440px]'
        style={{
          boxShadow:
            '0 24px 80px rgb(0 0 0 / 0.65), 0 8px 24px rgb(0 0 0 / 0.5)',
        }}
        aria-labelledby='auth-title'
        data-scene='auth'
      >
        <div
          className='pointer-events-none absolute inset-0'
          aria-hidden='true'
        >
          <img
            src={AUTH_CARD_IMAGE}
            alt=''
            data-testid='auth-scene-image'
            className='h-full w-full object-cover'
          />
          <div className='absolute inset-0 bg-gradient-to-b from-background-950/30 via-background-950/65 to-background-950/85' />
        </div>
        <div className='relative px-6 pb-7 pt-10 sm:px-8 sm:pb-8 sm:pt-12'>
          <header className='pb-6'>
            <h1 id='auth-title'>
              <BrandWordmark size='heading'>
                {t('client.auth.hero.title')}
              </BrandWordmark>
            </h1>
          </header>
          <Tabs defaultValue='login'>
            <TabsList className='w-full'>
              <TabsTrigger
                value='login'
                className='flex-1'
                data-testid='auth-tab-login'
              >
                {t('client.auth.tabs.login')}
              </TabsTrigger>
              <TabsTrigger
                value='register'
                className='flex-1'
                data-testid='auth-tab-register'
              >
                {t('client.auth.tabs.register')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value='login' className='mt-6'>
              <LoginForm />
            </TabsContent>
            <TabsContent value='register' className='mt-6'>
              <RegisterForm />
            </TabsContent>
          </Tabs>
        </div>
      </section>
    </div>
  );
}
