import { ECapability } from '@board-platform/contracts/auth/permissions';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/authApi.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { accountProfileQueryKey } from '@/hooks/accountProfileQuery';
import { usePermissions } from '@/hooks/usePermissions.js';
import { safeReturnTo } from '@/lib/returnNavigation';
import { isCurrentAuthSession, useAuthStore } from '@/stores/authStore.js';
import { listGameClients } from '../../platform/gameClientRegistry.js';

function ErrorMessage({
  message,
}: {
  message: string | null;
}): React.JSX.Element | null {
  return message ? (
    <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
      {message}
    </p>
  ) : null;
}

export function ActivationPage(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const navigate = useNavigate();
  const returnTo = useRouterState({
    select: (state) => safeReturnTo(state.location.search.returnTo),
  });
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canAccessGame = permissions.can(ECapability.GAME_PLAY);
  const helpers = useMemo(
    () =>
      listGameClients().flatMap((game) =>
        game.account?.activationHelp
          ? [{ gameId: game.gameId, Help: lazy(game.account.activationHelp) }]
          : [],
      ),
    [],
  );

  async function redeem(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;

    const normalizedCode = code.trim();
    if (!normalizedCode) {
      setError(t('client.activation.required'));
      return;
    }

    const session = useAuthStore.getState();
    setBusy(true);
    setError(null);
    try {
      await queryClient.cancelQueries({
        queryKey: accountProfileQueryKey(),
      });
      const updatedUser = await authApi.redeemInviteCode({
        code: normalizedCode,
      });
      if (!isCurrentAuthSession(session)) return;
      useAuthStore.getState().setUser(updatedUser);
      queryClient.setQueryData(accountProfileQueryKey(), updatedUser);
      if (returnTo) void navigate({ to: returnTo, replace: true });
      else void navigate({ to: '/platform', replace: true });
    } catch (cause) {
      if (isCurrentAuthSession(session)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className='mx-auto flex min-h-[calc(100dvh-9rem)] w-full max-w-4xl items-start px-5 py-8 sm:px-8'>
      <section className='mission-panel w-full px-5 py-6 sm:px-8'>
        <div className='relative z-10 space-y-7'>
          <header className='space-y-3'>
            <h1 className='font-display text-3xl font-semibold tracking-[0.06em] text-text-100'>
              {t('client.activation.title')}
            </h1>
            <p className='max-w-2xl text-sm leading-relaxed text-text-400'>
              {t('client.activation.intro')}
            </p>
          </header>

          <form className='max-w-xl space-y-5' onSubmit={redeem}>
            <div className='space-y-1.5'>
              <Label htmlFor='activation-code'>
                {t('client.activation.code_label')}
              </Label>
              <Input
                id='activation-code'
                type='text'
                autoComplete='off'
                autoCapitalize='characters'
                spellCheck={false}
                required
                value={code}
                disabled={busy}
                placeholder={t('client.activation.code_placeholder')}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (error) setError(null);
                }}
              />
            </div>
            <ErrorMessage message={error} />
            <div className='flex flex-wrap items-center gap-3'>
              <Button
                type='submit'
                loading={busy}
                loadingLabel={t('client.activation.redeeming')}
              >
                {t('client.activation.redeem')}
              </Button>
              {canAccessGame ? (
                <Link
                  to='/platform'
                  className='inline-flex min-h-10 items-center rounded-[5px] px-3 text-sm text-text-100 underline-offset-4 hover:underline'
                >
                  {t('client.activation.enter_lobby')}
                </Link>
              ) : null}
            </div>
          </form>

          {helpers.map(({ gameId, Help }) => (
            <Suspense key={gameId} fallback={null}>
              <Help returnTo={returnTo} />
            </Suspense>
          ))}
        </div>
      </section>
    </main>
  );
}
