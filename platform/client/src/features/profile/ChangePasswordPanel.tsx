import { ACCOUNT_PASSWORD_MIN_CODE_POINTS } from '@board-platform/contracts/auth/accountRules';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/authApi.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { toast } from '@/components/ui/toast.js';
import { isCurrentAuthSession, useAuthStore } from '@/stores/authStore.js';

export function ChangePasswordPanel(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const [editing, setEditing] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const mutation = useMutation({
    onMutate: () => useAuthStore.getState(),
    mutationFn: () =>
      authApi.changePassword({
        currentPassword,
        newPassword,
        passwordConfirm,
      }),
    onSuccess: (_response, _variables, requestSession) => {
      if (!isCurrentAuthSession(requestSession)) return;
      setCurrentPassword('');
      setNewPassword('');
      setPasswordConfirm('');
      setEditing(false);
      toast({ title: t('client.password.updated'), variant: 'success' });
    },
  });
  return (
    <section className='mission-panel px-5 py-5'>
      <div className='relative z-10 space-y-4'>
        <h2 className='font-display text-lg text-text-100'>
          {t('client.password.title')}
        </h2>
        {editing ? (
          <form
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <div className='space-y-1.5'>
              <Label htmlFor='current-password'>
                {t('client.password.current')}
              </Label>
              <Input
                id='current-password'
                type='password'
                autoComplete='current-password'
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='new-password'>{t('client.password.new')}</Label>
              <Input
                id='new-password'
                type='password'
                autoComplete='new-password'
                minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='new-password-confirmation'>
                {t('client.password.confirm')}
              </Label>
              <Input
                id='new-password-confirmation'
                type='password'
                autoComplete='new-password'
                minLength={ACCOUNT_PASSWORD_MIN_CODE_POINTS}
                required
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
                disabled={mutation.isPending}
              />
            </div>
            {mutation.isError ? (
              <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                {mutation.error.message}
              </p>
            ) : null}
            <div className='flex gap-2'>
              <Button type='submit' loading={mutation.isPending}>
                {t(
                  mutation.isPending
                    ? 'client.password.saving'
                    : 'client.password.save',
                )}
              </Button>
              <Button
                type='button'
                variant='ghost'
                disabled={mutation.isPending}
                onClick={() => {
                  setEditing(false);
                  setCurrentPassword('');
                  setNewPassword('');
                  setPasswordConfirm('');
                  mutation.reset();
                }}
              >
                {t('client.password.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant='ghost' onClick={() => setEditing(true)}>
            {t('client.password.title')}
          </Button>
        )}
      </div>
    </section>
  );
}
