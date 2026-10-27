import { isUserLanguage } from '@board-platform/contracts/types/protocol/userLanguage';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { ChangePasswordPanel } from '../../features/profile/ChangePasswordPanel.js';
import { EmailChangePanel } from '../../features/profile/EmailChangePanel.js';
import { EmailNotificationSettings } from '../../features/profile/EmailNotificationSettings.js';
import { PushNotificationSettings } from '../../features/profile/PushNotificationSettings.js';
import {
  useCurrentUser,
  useLogout,
  useUpdatePreferences,
  useUpdateProfile,
} from '../../hooks/useAuth.js';

/** Account controls remain available without any installed game. */
export function AccountPage(): React.JSX.Element {
  const { t, i18n } = useTranslation('platform-common');
  const { data: user } = useCurrentUser();
  const updateProfile = useUpdateProfile();
  const preferences = useUpdatePreferences();
  const logout = useLogout();
  const [name, setName] = useState<string>();
  return (
    <div className='space-y-6'>
      <header>
        <h1 className='font-display text-3xl text-text-100'>
          {t('client.account.title')}
        </h1>
        <p className='mt-2 text-text-400'>{user?.email}</p>
      </header>
      <section className='mission-panel p-5 space-y-5'>
        <form
          className='relative z-10 space-y-3'
          onSubmit={(event) => {
            event.preventDefault();
            updateProfile.mutate({ name: name ?? user?.name });
          }}
        >
          <Label htmlFor='account-name'>{t('client.account.name')}</Label>
          <Input
            id='account-name'
            value={name ?? user?.name ?? ''}
            onChange={(event) => {
              setName(event.target.value);
              updateProfile.reset();
            }}
            required
          />
          {updateProfile.error ? (
            <p role='alert'>{updateProfile.error.message}</p>
          ) : null}
          <Button type='submit' loading={updateProfile.isPending}>
            {t('client.account.save')}
          </Button>
          {updateProfile.isSuccess ? (
            <p role='status' className='text-sm text-text-300'>
              {t('client.account.saved')}
            </p>
          ) : null}
        </form>
        <div className='relative z-10 space-y-2'>
          <Label htmlFor='account-language'>
            {t('client.account.language')}
          </Label>
          <select
            id='account-language'
            className='block rounded bg-surface-800 p-2 text-text-100'
            value={user?.preferences?.language ?? i18n.resolvedLanguage ?? 'en'}
            disabled={preferences.isPending}
            onChange={(event) => {
              const language = event.target.value;
              if (isUserLanguage(language)) preferences.mutate({ language });
            }}
          >
            <option value='en'>English</option>
            <option value='zh-CN'>简体中文</option>
          </select>
          {preferences.error ? (
            <p role='alert'>{preferences.error.message}</p>
          ) : null}
        </div>
      </section>
      <EmailChangePanel />
      <ChangePasswordPanel />
      <section className='mission-panel p-5 space-y-6'>
        <div className='relative z-10 space-y-6'>
          <EmailNotificationSettings />
          <PushNotificationSettings />
        </div>
      </section>
      <Button variant='danger' onClick={logout}>
        {t('client.account.logout')}
      </Button>
    </div>
  );
}
