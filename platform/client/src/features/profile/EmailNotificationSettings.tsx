import { can, ECapability } from '@board-platform/contracts/auth/permissions';
import {
  isEmailQuietHours,
  type TAccountPreferencesPatch,
} from '@board-platform/contracts/types/protocol/accountPreferences';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/authApi.js';
import type { IAuthUser } from '@/api/types';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { Switch } from '@/components/ui/switch.js';
import { useCurrentUser } from '@/hooks/useAuth.js';
import { effectiveAuthRole } from '@/hooks/usePermissions.js';
import { isCurrentAuthSession, useAuthStore } from '@/stores/authStore.js';

export function EmailNotificationSettings(): React.JSX.Element | null {
  const { t } = useTranslation('platform-common');
  const queryClient = useQueryClient();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const { data: currentUser } = useCurrentUser();
  const preference =
    currentUser?.preferences?.emailTurnRemindersEnabled ?? false;
  const savedQuiet = currentUser?.preferences?.emailQuietHours;
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('08:00');
  const [quietZone, setQuietZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [quietError, setQuietError] = useState(false);
  const [quietSaved, setQuietSaved] = useState(false);
  useEffect(() => {
    setQuietEnabled(Boolean(savedQuiet));
    setQuietStart(savedQuiet?.start ?? '22:00');
    setQuietEnd(savedQuiet?.end ?? '08:00');
    setQuietZone(
      savedQuiet?.timezone ||
        Intl.DateTimeFormat().resolvedOptions().timeZone ||
        'UTC',
    );
  }, [savedQuiet?.start, savedQuiet?.end, savedQuiet?.timezone]);
  const update = useMutation({
    onMutate: () => useAuthStore.getState(),
    mutationFn: (patch: TAccountPreferencesPatch) =>
      authApi.updatePreferences(patch),
    onSuccess: (updatedUser, variables, requestSession) => {
      if (!isCurrentAuthSession(requestSession)) return;
      const currentUser = useAuthStore.getState().user;
      if (!currentUser) return;
      const nextUser: IAuthUser = {
        ...currentUser,
        preferences: {
          ...currentUser.preferences,
          ...('emailTurnRemindersEnabled' in variables
            ? {
                emailTurnRemindersEnabled:
                  updatedUser.preferences?.emailTurnRemindersEnabled,
              }
            : {}),
          ...('emailQuietHours' in variables
            ? { emailQuietHours: updatedUser.preferences?.emailQuietHours }
            : {}),
        },
      };
      useAuthStore.getState().setUser(nextUser);
      queryClient.setQueryData<IAuthUser>(['auth', 'me'], nextUser);
      if ('emailQuietHours' in variables) setQuietSaved(true);
    },
  });
  useEffect(() => {
    update.reset();
    setQuietError(false);
    setQuietSaved(false);
  }, [authEpoch, update.reset]);

  // Missing values use the server's disabled default until the user enables it.
  if (!currentUser) return null;
  if (!can(effectiveAuthRole(currentUser), ECapability.TURN_EMAIL_REMINDERS)) {
    return (
      <p className='text-sm text-text-400'>
        {t('client.profile.email_notifications.vip_required')}
      </p>
    );
  }

  return (
    <div className='space-y-4'>
      <div className='flex min-w-0 flex-wrap items-center gap-3'>
        <Switch
          id='profile-email-turn-notifications'
          checked={preference}
          disabled={update.isPending}
          onCheckedChange={(checked) =>
            update.mutate({ emailTurnRemindersEnabled: checked })
          }
          aria-label={t('client.profile.email_notifications.label')}
        />
        <label
          htmlFor='profile-email-turn-notifications'
          className='text-sm text-text-300'
        >
          {t('client.profile.email_notifications.label')}
        </label>
      </div>
      <form
        className='space-y-3'
        onSubmit={(event) => {
          event.preventDefault();
          const quiet = quietEnabled
            ? { start: quietStart, end: quietEnd, timezone: quietZone.trim() }
            : null;
          if (quiet !== null && !isEmailQuietHours(quiet)) {
            setQuietError(true);
            return;
          }
          setQuietError(false);
          update.mutate({ emailQuietHours: quiet });
        }}
      >
        <div className='flex items-center gap-3'>
          <Switch
            id='profile-email-quiet-hours'
            checked={quietEnabled}
            onCheckedChange={(checked) => {
              setQuietEnabled(checked);
              setQuietSaved(false);
            }}
          />
          <Label htmlFor='profile-email-quiet-hours'>
            {t('client.profile.email_notifications.quiet_hours')}
          </Label>
        </div>
        {quietEnabled ? (
          <div className='flex flex-wrap gap-3'>
            <div className='space-y-1'>
              <Label htmlFor='profile-email-quiet-start'>
                {t('client.profile.email_notifications.quiet_start')}
              </Label>
              <Input
                id='profile-email-quiet-start'
                type='time'
                value={quietStart}
                onChange={(event) => {
                  setQuietStart(event.target.value);
                  setQuietSaved(false);
                }}
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='profile-email-quiet-end'>
                {t('client.profile.email_notifications.quiet_end')}
              </Label>
              <Input
                id='profile-email-quiet-end'
                type='time'
                value={quietEnd}
                onChange={(event) => {
                  setQuietEnd(event.target.value);
                  setQuietSaved(false);
                }}
              />
            </div>
            <div className='min-w-48 space-y-1'>
              <Label htmlFor='profile-email-quiet-zone'>
                {t('client.profile.email_notifications.timezone')}
              </Label>
              <Input
                id='profile-email-quiet-zone'
                value={quietZone}
                onChange={(event) => {
                  setQuietZone(event.target.value);
                  setQuietSaved(false);
                }}
                placeholder='Asia/Shanghai'
              />
            </div>
          </div>
        ) : null}
        {quietError ? (
          <p role='alert' className='text-xs text-[var(--signal-red-hi)]'>
            {t('client.profile.email_notifications.quiet_invalid')}
          </p>
        ) : null}
        <Button type='submit' disabled={update.isPending}>
          {t('client.profile.email_notifications.save_quiet')}
        </Button>
        {quietSaved ? (
          <span className='ml-3 text-xs text-text-400'>
            {t('client.profile.email_notifications.saved')}
          </span>
        ) : null}
      </form>
      {update.isError ? (
        <p role='alert' className='text-xs text-[var(--signal-red-hi)]'>
          {update.error.message}
        </p>
      ) : null}
    </div>
  );
}
