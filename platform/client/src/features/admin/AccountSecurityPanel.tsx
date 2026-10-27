import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { accountSecurityAdminApi } from '@/api/accountSecurityAdminApi.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Shared platform audit view for account migration and security events. */
export function AccountSecurityPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('platform-admin');
  const [draftUserId, setDraftUserId] = useState('');
  const [userId, setUserId] = useState<string | undefined>();
  const [filterError, setFilterError] = useState(false);
  const receipts = useQuery({
    queryKey: ['platform-admin', 'account-security', 'receipts', userId],
    queryFn: () => accountSecurityAdminApi.receipts(userId),
  });
  const events = useQuery({
    queryKey: ['platform-admin', 'account-security', 'events', userId],
    queryFn: () => accountSecurityAdminApi.events(userId),
  });
  const formatDate = (value: string) =>
    new Date(value).toLocaleString(i18n.language);

  return (
    <div className='space-y-5'>
      <section className='mission-panel px-5 py-5'>
        <div className='relative z-10 space-y-4'>
          <div>
            <h2 className='font-display text-xl text-text-100'>
              {t('account_security.title')}
            </h2>
            <p className='mt-1 text-sm text-text-400'>
              {t('account_security.description')}
            </p>
          </div>
          <form
            className='flex flex-wrap items-end gap-3'
            onSubmit={(event) => {
              event.preventDefault();
              const next = draftUserId.trim();
              if (next && !UUID.test(next)) {
                setFilterError(true);
                return;
              }
              setFilterError(false);
              setUserId(next || undefined);
            }}
          >
            <div className='min-w-64 flex-1 space-y-1.5'>
              <Label htmlFor='platform-account-security-user-id'>
                {t('account_security.user_id')}
              </Label>
              <Input
                id='platform-account-security-user-id'
                value={draftUserId}
                onChange={(event) => {
                  setDraftUserId(event.target.value);
                  setFilterError(false);
                }}
                aria-invalid={filterError}
                placeholder={t('account_security.user_id_hint')}
              />
              {filterError ? (
                <p role='alert' className='text-xs text-[var(--signal-red-hi)]'>
                  {t('account_security.invalid_user_id')}
                </p>
              ) : null}
            </div>
            <Button type='submit'>{t('account_security.search')}</Button>
            <Button
              type='button'
              variant='ghost'
              onClick={() => {
                setDraftUserId('');
                setUserId(undefined);
                setFilterError(false);
                if (userId === undefined) {
                  void receipts.refetch();
                  void events.refetch();
                }
              }}
            >
              {t('account_security.recent')}
            </Button>
          </form>
        </div>
      </section>

      <AuditTable
        title={t('account_security.receipts')}
        pending={receipts.isPending}
        error={receipts.isError}
        empty={receipts.data?.length === 0}
        loadingText={t('account_security.loading')}
        errorText={t('account_security.load_failed')}
        emptyText={t('account_security.no_receipts')}
      >
        <table className='w-full min-w-[760px] text-left text-sm'>
          <thead className='border-b border-white/10 text-text-400'>
            <tr>
              <th className='p-2'>{t('account_security.time')}</th>
              <th className='p-2'>{t('account_security.receipt')}</th>
              <th className='p-2'>{t('account_security.account')}</th>
              <th className='p-2'>{t('account_security.assets')}</th>
            </tr>
          </thead>
          <tbody>
            {receipts.data?.map((receipt) => (
              <tr
                key={receipt.id}
                className='border-b border-white/5 align-top'
              >
                <td className='whitespace-nowrap p-2 text-text-300'>
                  {formatDate(receipt.createdAt)}
                </td>
                <td className='p-2 font-mono text-xs text-text-200'>
                  <div>{receipt.id}</div>
                  <div className='mt-1 text-text-400'>
                    {receipt.sourceSystem} · {receipt.policyVersion}
                  </div>
                </td>
                <td className='p-2 font-mono text-xs text-text-300'>
                  <div>{receipt.newUserId}</div>
                  <div className='mt-1 text-text-400'>
                    {receipt.legacyUserId}
                  </div>
                </td>
                <td className='max-w-72 break-all p-2 font-mono text-xs text-text-300'>
                  {JSON.stringify(receipt.counts)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AuditTable>

      <AuditTable
        title={t('account_security.events')}
        pending={events.isPending}
        error={events.isError}
        empty={events.data?.length === 0}
        loadingText={t('account_security.loading')}
        errorText={t('account_security.load_failed')}
        emptyText={t('account_security.no_events')}
      >
        <div className='max-h-[32rem] overflow-auto'>
          <table className='w-full min-w-[1080px] text-left text-sm'>
            <thead className='sticky top-0 border-b border-white/10 bg-[var(--surface-900)] text-text-400'>
              <tr>
                <th className='p-2'>{t('account_security.time')}</th>
                <th className='p-2'>{t('account_security.event')}</th>
                <th className='p-2'>{t('account_security.actor')}</th>
                <th className='p-2'>{t('account_security.subject')}</th>
                <th className='p-2'>{t('account_security.request_id')}</th>
                <th className='p-2'>{t('account_security.details')}</th>
              </tr>
            </thead>
            <tbody>
              {events.data?.map((item) => (
                <tr key={item.id} className='border-b border-white/5 align-top'>
                  <td className='whitespace-nowrap p-2 text-text-300'>
                    {formatDate(item.createdAt)}
                  </td>
                  <td className='p-2 font-mono text-xs text-text-200'>
                    {item.eventKind}
                  </td>
                  <td className='p-2 font-mono text-xs text-text-300'>
                    {item.actorUserId ?? '—'}
                  </td>
                  <td className='p-2 font-mono text-xs text-text-300'>
                    {item.subjectUserId ?? '—'}
                  </td>
                  <td className='p-2 font-mono text-xs text-text-300'>
                    {item.requestId ?? '—'}
                  </td>
                  <td className='max-w-72 break-all p-2 font-mono text-xs text-text-300'>
                    {JSON.stringify(item.context ?? {})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AuditTable>
    </div>
  );
}

function AuditTable({
  title,
  pending,
  error,
  empty,
  loadingText,
  errorText,
  emptyText,
  children,
}: {
  title: string;
  pending: boolean;
  error: boolean;
  empty: boolean | undefined;
  loadingText: string;
  errorText: string;
  emptyText: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className='mission-panel px-5 py-5'>
      <div className='relative z-10 space-y-3'>
        <h3 className='font-display text-lg text-text-100'>{title}</h3>
        {pending ? (
          <p className='text-sm text-text-400'>{loadingText}</p>
        ) : error ? (
          <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
            {errorText}
          </p>
        ) : empty ? (
          <p className='text-sm text-text-400'>{emptyText}</p>
        ) : (
          <div className='overflow-x-auto'>{children}</div>
        )}
      </div>
    </section>
  );
}
