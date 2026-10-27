import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/authApi.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { toast } from '@/components/ui/toast.js';
import { useCurrentUser } from '@/hooks/useAuth.js';
import { disconnectPushNotifications } from '@/lib/pushNotifications';
import { isCurrentAuthSession, useAuthStore } from '@/stores/authStore.js';

export function EmailChangePanel(): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const queryClient = useQueryClient();
  const logout = useAuthStore((state) => state.logout);
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const { data: currentUser } = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const start = useMutation({
    onMutate: () => useAuthStore.getState(),
    mutationFn: () => authApi.startEmailChange({ email, currentPassword }),
    onSuccess: (result, _variables, requestSession) => {
      if (!isCurrentAuthSession(requestSession)) return;
      setChallengeId(result.challengeId);
      setMessage(t('client.profile.email_change.code_sent'));
      setError(null);
    },
    onError: (cause, _variables, requestSession) => {
      if (isCurrentAuthSession(requestSession)) setError(cause.message);
    },
  });
  const confirm = useMutation({
    onMutate: () => useAuthStore.getState(),
    mutationFn: () =>
      authApi.confirmEmailChange({ challengeId: challengeId ?? '', code }),
    onSuccess: async (_result, _variables, requestSession) => {
      if (!isCurrentAuthSession(requestSession)) return;
      try {
        await disconnectPushNotifications(() =>
          isCurrentAuthSession(requestSession),
        );
      } finally {
        if (isCurrentAuthSession(requestSession)) {
          logout();
          queryClient.clear();
          setEditing(false);
          setEmail('');
          setCurrentPassword('');
          setCode('');
          setChallengeId(null);
          setError(null);
          toast({
            title: t('client.profile.email_change.updated'),
            variant: 'success',
          });
        }
      }
    },
    onError: (cause, _variables, requestSession) => {
      if (isCurrentAuthSession(requestSession)) setError(cause.message);
    },
  });

  useEffect(() => {
    setEditing(false);
    setEmail('');
    setCurrentPassword('');
    setCode('');
    setChallengeId(null);
    setError(null);
    setMessage(null);
  }, [authEpoch]);

  if (!currentUser) return <></>;
  const isBound = Boolean(currentUser.emailVerifiedAt);

  return (
    <section
      className='mission-panel px-5 py-5 sm:px-6'
      data-testid='email-change-panel'
    >
      <div className='relative z-10 space-y-4'>
        <div>
          <p className='micro-label text-text-500'>
            {t('client.profile.email')}
          </p>
          <p className='mt-1 break-all text-sm text-text-200'>
            {currentUser.email}
          </p>
        </div>
        <p className='text-sm text-text-300'>
          {t(
            isBound
              ? 'client.profile.email_change.bound'
              : 'client.profile.email_change.optional',
          )}
        </p>
        {editing ? (
          <form
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault();
              if (challengeId) confirm.mutate();
              else start.mutate();
            }}
          >
            {!challengeId ? (
              <>
                <div className='space-y-1.5'>
                  <Label htmlFor='profile-new-email'>
                    {t(
                      isBound
                        ? 'client.profile.email_change.new_email'
                        : 'client.profile.email',
                    )}
                  </Label>
                  <Input
                    id='profile-new-email'
                    type='email'
                    required
                    autoComplete='email'
                    value={email}
                    disabled={start.isPending}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='profile-email-reauth'>
                    {t('client.profile.email_change.reauth')}
                  </Label>
                  <Input
                    id='profile-email-reauth'
                    type='password'
                    required
                    autoComplete='current-password'
                    value={currentPassword}
                    disabled={start.isPending}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className='space-y-1.5'>
                <Label htmlFor='profile-email-code'>
                  {t('client.auth.fields.verification_code')}
                </Label>
                <Input
                  id='profile-email-code'
                  inputMode='numeric'
                  autoComplete='one-time-code'
                  maxLength={6}
                  required
                  value={code}
                  disabled={confirm.isPending}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, ''))
                  }
                />
              </div>
            )}
            {message ? (
              <p role='status' className='text-sm text-text-300'>
                {message}
              </p>
            ) : null}
            {error ? (
              <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                {error}
              </p>
            ) : null}
            <div className='flex flex-wrap gap-2'>
              <Button
                type='submit'
                loading={start.isPending || confirm.isPending}
              >
                {challengeId
                  ? t('client.profile.email_change.confirm')
                  : t('client.profile.email_change.send_code')}
              </Button>
              <Button
                type='button'
                variant='ghost'
                disabled={start.isPending || confirm.isPending}
                onClick={() => {
                  setEditing(false);
                  setChallengeId(null);
                  setError(null);
                  setMessage(null);
                }}
              >
                {t('client.password.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type='button'
            variant='ghost'
            onClick={() => {
              setEmail(isBound ? '' : currentUser.email);
              setCurrentPassword('');
              setCode('');
              setEditing(true);
              setMessage(null);
              setError(null);
            }}
          >
            {t(
              isBound
                ? 'client.profile.email_change.action'
                : 'client.profile.email_change.bind',
            )}
          </Button>
        )}
      </div>
    </section>
  );
}
