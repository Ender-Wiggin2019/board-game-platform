import { ECapability } from '@board-platform/contracts/auth/permissions';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platformAccessApi } from '../../api/platformAccessApi.js';
import { platformGamesApi } from '../../api/platformGamesApi.js';
import { Button } from '../../components/ui/button.js';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import {
  resolvePlatformBrandName,
  usePlatformConfiguration,
} from '../../providers/PlatformConfiguration.js';
import { useAuthStore } from '../../stores/authStore.js';

interface IssuedCode {
  readonly context: string;
  readonly code: string;
}

export function PlatformAccessPage(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const configuration = usePlatformConfiguration();
  const brandName = resolvePlatformBrandName(configuration, t('brand.name'));
  const permissions = usePermissions();
  const canManage =
    permissions.can(ECapability.ADMIN_ACCESS) &&
    permissions.can(ECapability.GAME_MODIFY_ANY);
  const epoch = useAuthStore((state) => state.authEpoch);
  const catalog = useQuery({
    queryKey: ['platform-access-catalog', epoch],
    queryFn: platformAccessApi.catalog,
  });
  const games = useQuery({
    queryKey: ['platform-games', epoch],
    queryFn: platformGamesApi.listGames,
  });
  const [selected, setSelected] = useState('');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [entitlement, setEntitlement] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const gameId = selected || catalog.data?.[0]?.gameId || '';
  const definition = catalog.data?.find((item) => item.gameId === gameId);
  useEffect(() => {
    if (
      selected &&
      catalog.data &&
      !catalog.data.some((item) => item.gameId === selected)
    ) {
      setSelected('');
    }
  }, [catalog.data, selected]);
  const label = (id: string) =>
    games.data?.find((game) => game.metadata.gameId === id)?.metadata.name ??
    id;
  const grants = useQuery({
    queryKey: ['platform-access-grants', gameId, epoch],
    queryFn: () => platformAccessApi.grants(gameId),
    enabled: Boolean(gameId),
  });
  const codes = useQuery({
    queryKey: ['platform-access-codes', gameId, epoch],
    queryFn: () => platformAccessApi.codes(gameId),
    enabled: Boolean(gameId) && canManage,
  });
  const contextRef = useRef<string | null>(null);
  const requestContext = `${epoch}:${gameId}`;
  const issuedCode = issued?.context === requestContext ? issued.code : '';
  contextRef.current = requestContext;
  useEffect(
    () => () => {
      contextRef.current = null;
    },
    [],
  );
  useEffect(() => {
    setBusy(false);
    setIssued(null);
    setCode('');
    setNotice('');
    setEntitlement('');
  }, [gameId, epoch]);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    const isCurrent = () =>
      useAuthStore.getState().authEpoch === epoch &&
      contextRef.current === requestContext;
    setBusy(true);
    setNotice('');
    try {
      await action(isCurrent);
    } catch (error) {
      if (isCurrent())
        setNotice(error instanceof Error ? error.message : t('access.failed'));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <main className='mx-auto w-full max-w-5xl space-y-6 px-4 py-8'>
      <header>
        <p className='text-sm text-text-300'>{brandName}</p>
        <h1 className='text-3xl font-semibold'>{t('access.title')}</h1>
        <p className='mt-2 text-text-300'>{t('access.description')}</p>
      </header>
      {catalog.isPending ? (
        <p role='status'>{t('access.loading')}</p>
      ) : catalog.error ? (
        <p role='alert'>
          {catalog.error.message}{' '}
          <Button onClick={() => void catalog.refetch()}>
            {t('access.retry')}
          </Button>
        </p>
      ) : !definition ? (
        <p>{t('access.empty')}</p>
      ) : (
        <>
          <label className='flex flex-wrap items-center gap-3'>
            {t('access.game')}
            <select
              className='rounded border border-white/20 bg-[var(--surface-panel)] p-2'
              value={gameId}
              onChange={(event) => setSelected(event.target.value)}
            >
              {catalog.data
                ?.filter(
                  (item, index, all) =>
                    all.findIndex((other) => other.gameId === item.gameId) ===
                    index,
                )
                .map((game) => (
                  <option key={game.gameId} value={game.gameId}>
                    {label(game.gameId)}
                  </option>
                ))}
            </select>
          </label>
          <div className='grid gap-5 md:grid-cols-2'>
            <Card>
              <CardHeader>
                <CardTitle>{t('access.redeemTitle')}</CardTitle>
              </CardHeader>
              <CardContent>
                <form
                  className='space-y-4'
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async (isCurrent) => {
                      await platformAccessApi.redeem(gameId, code.trim());
                      if (!isCurrent()) return;
                      setCode('');
                      setNotice(t('access.redeemed'));
                      await grants.refetch();
                    });
                  }}
                >
                  <label className='block'>
                    {t('access.code')}
                    <Input
                      required
                      autoComplete='off'
                      maxLength={256}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  </label>
                  <Button disabled={busy || !code.trim()} type='submit'>
                    {t('access.redeem')}
                  </Button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('access.myGrants')}</CardTitle>
              </CardHeader>
              <CardContent>
                {grants.isPending ? (
                  <p>{t('access.loading')}</p>
                ) : grants.error ? (
                  <p role='alert'>{grants.error.message}</p>
                ) : grants.data?.length ? (
                  <ul className='space-y-2'>
                    {grants.data.map((grant) => (
                      <li key={grant.grantId}>
                        {definition.entitlements.find(
                          (item) => item.entitlement === grant.entitlement,
                        )?.label ?? grant.entitlement}
                        <span className='ml-3 text-sm text-text-300'>
                          {new Date(grant.redeemedAt).toLocaleDateString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='text-text-300'>{t('access.noGrants')}</p>
                )}
              </CardContent>
            </Card>
          </div>
          {canManage && (
            <Card>
              <CardHeader>
                <CardTitle>{t('access.manage')}</CardTitle>
              </CardHeader>
              <CardContent className='space-y-5'>
                <form
                  className='flex flex-wrap items-end gap-4'
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async (isCurrent) => {
                      const selectedEntitlement =
                        entitlement || definition.entitlements[0]?.entitlement;
                      if (!selectedEntitlement) {
                        setNotice(t('access.empty'));
                        return;
                      }
                      const result = await platformAccessApi.issue(gameId, {
                        entitlement: selectedEntitlement,
                        maxUses,
                        ...(expires
                          ? { expiresAt: new Date(expires).toISOString() }
                          : {}),
                      });
                      if (!isCurrent()) return;
                      setIssued({ context: requestContext, code: result.code });
                      await codes.refetch();
                    });
                  }}
                >
                  <label>
                    {t('access.entitlement')}
                    <select
                      className='block rounded border border-white/20 bg-[var(--surface-panel)] p-2'
                      value={
                        entitlement || definition.entitlements[0]?.entitlement
                      }
                      onChange={(event) => setEntitlement(event.target.value)}
                    >
                      {definition.entitlements.map((item) => (
                        <option key={item.entitlement} value={item.entitlement}>
                          {item.label ?? item.entitlement}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('access.maxUses')}
                    <Input
                      type='number'
                      required
                      min={1}
                      max={100000}
                      value={maxUses}
                      onChange={(event) =>
                        setMaxUses(Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    {t('access.expires')}
                    <Input
                      type='datetime-local'
                      value={expires}
                      onChange={(event) => setExpires(event.target.value)}
                    />
                  </label>
                  <Button
                    type='submit'
                    disabled={busy || !definition.entitlements.length}
                  >
                    {t('access.issue')}
                  </Button>
                </form>
                {issuedCode && (
                  <div className='rounded border border-accent-400/40 p-4'>
                    <p>{t('access.issued')}</p>
                    <output className='mt-2 block break-all font-mono text-lg'>
                      {issuedCode}
                    </output>
                  </div>
                )}
                {codes.error && <p role='alert'>{codes.error.message}</p>}
                <div className='overflow-x-auto'>
                  <table className='w-full text-left text-sm'>
                    <thead>
                      <tr>
                        <th>{t('access.entitlement')}</th>
                        <th>{t('access.usage')}</th>
                        <th>{t('access.expires')}</th>
                        <th>{t('access.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {codes.data?.map((item) => (
                        <tr
                          className='border-t border-white/10'
                          key={item.codeId}
                        >
                          <td className='py-3'>{item.entitlement}</td>
                          <td>
                            {item.usedCount} / {item.maxUses ?? '∞'}
                          </td>
                          <td>
                            {item.expiresAt
                              ? new Date(item.expiresAt).toLocaleString()
                              : '—'}
                          </td>
                          <td>
                            {item.revokedAt ? (
                              t('access.revoked')
                            ) : (
                              <Button
                                variant='ghost'
                                disabled={busy}
                                onClick={() =>
                                  void run(async (isCurrent) => {
                                    await platformAccessApi.revoke(
                                      gameId,
                                      item.codeId,
                                    );
                                    if (isCurrent()) await codes.refetch();
                                  })
                                }
                              >
                                {t('access.revoke')}
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
      {notice && <p role='status'>{notice}</p>}
    </main>
  );
}
