import type {
  GamePolicyVersion,
  GameServiceDescription,
  JsonValue,
  ReleaseManifest,
} from '@board-game/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PlatformReleaseAdminItem,
  type PlatformReleaseBinding,
  type PlatformReleaseReconciliation,
  platformAdministrationApi,
  type RegisterStagedReleaseRequest,
  type SwitchPlatformReleaseChannelRequest,
} from '@/api/platformAdministrationApi.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { toast } from '@/components/ui/toast.js';

type BindingAction = 'ready' | 'activate' | 'drain' | 'disable' | 'retain';

interface RegistrationFormState {
  manifest: string;
  service: string;
  approvedFeatures: string;
  approvedModes: string;
  policyBundle: string;
  approvedPolicyVersions: string;
  deployment: 'managed' | 'external';
  controlEndpoint: string;
  playerEndpoint: string;
  authorizationEndpoint: string;
  clientArtifactBaseUrl: string;
  serviceCredentialRef: string;
}

interface ChannelFormState {
  gameId: string;
  modeId: string;
  channel: string;
  expectedRevision: string;
  targetBackendBindingId: string;
  operationId: string;
}

const INITIAL_REGISTRATION: RegistrationFormState = {
  manifest: '{}',
  service: '{}',
  approvedFeatures: '[]',
  approvedModes: '[]',
  policyBundle: '',
  approvedPolicyVersions: '',
  deployment: 'external',
  controlEndpoint: '',
  playerEndpoint: '',
  authorizationEndpoint: '',
  clientArtifactBaseUrl: '',
  serviceCredentialRef: '',
};

const INITIAL_CHANNEL: ChannelFormState = {
  gameId: '',
  modeId: '',
  channel: 'stable',
  expectedRevision: '0',
  targetBackendBindingId: '',
  operationId: '',
};

function statusVariant(
  status: PlatformReleaseBinding['status'],
): 'warning' | 'success' | 'accent' | 'neutral' | 'danger' {
  switch (status) {
    case 'ready':
      return 'success';
    case 'draining':
      return 'warning';
    case 'retired':
      return 'danger';
    case 'retained':
      return 'neutral';
    default:
      return 'accent';
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function parseJson<T>(value: string, errorMessage: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function parseStringList(
  value: string,
  errorMessage: string,
): readonly string[] {
  const parsed = parseJson<unknown>(value, errorMessage);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error(errorMessage);
  return parsed;
}

function parseOptionalJson(
  value: string,
  errorMessage: string,
): JsonValue | undefined {
  if (!value.trim()) return undefined;
  return parseJson<JsonValue>(value, errorMessage);
}

function parseOptionalPolicyVersions(
  value: string,
  errorMessage: string,
): readonly GamePolicyVersion[] | undefined {
  if (!value.trim()) return undefined;
  const parsed = parseJson<unknown>(value, errorMessage);
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { kind?: unknown }).kind !== 'string' ||
        typeof (entry as { version?: unknown }).version !== 'string',
    )
  ) {
    throw new Error(errorMessage);
  }
  return parsed as readonly GamePolicyVersion[];
}

function operationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return crypto.randomUUID();
  return `platform-release-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function downloadReconciliation(data: PlatformReleaseReconciliation): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `platform-release-reconciliation-${data.platformId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Platform-owned release, binding, and admission-channel administration. */
export function ReleaseAdministrationPanel(): React.JSX.Element {
  const { t, i18n } = useTranslation('platform-admin');
  const queryClient = useQueryClient();
  const [registration, setRegistration] = useState(INITIAL_REGISTRATION);
  const [registrationError, setRegistrationError] = useState<string | null>(
    null,
  );
  const [channel, setChannel] = useState(INITIAL_CHANNEL);
  const [pendingBinding, setPendingBinding] = useState<string | null>(null);
  const [lastChannel, setLastChannel] = useState<Awaited<
    ReturnType<typeof platformAdministrationApi.switchChannel>
  > | null>(null);
  const releases = useQuery({
    queryKey: ['platform-admin', 'releases'],
    queryFn: platformAdministrationApi.listReleases,
  });
  const reconciliation = useQuery({
    queryKey: ['platform-admin', 'releases', 'reconciliation'],
    queryFn: platformAdministrationApi.getReleaseReconciliation,
  });
  const invalidateReleaseQueries = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['platform-admin', 'releases'],
      }),
      queryClient.invalidateQueries({
        queryKey: ['platform-admin', 'releases', 'reconciliation'],
      }),
    ]);
  };
  const actionMutation = useMutation({
    mutationFn: (input: { action: BindingAction; bindingId: string }) => {
      switch (input.action) {
        case 'ready':
          return platformAdministrationApi.readyBinding(input.bindingId);
        case 'activate':
          return platformAdministrationApi.activateBinding(input.bindingId);
        case 'drain':
          return platformAdministrationApi.drainBinding(input.bindingId);
        case 'disable':
          return platformAdministrationApi.disableBinding(input.bindingId);
        case 'retain':
          return platformAdministrationApi.retainBinding(input.bindingId);
      }
    },
    onMutate: ({ bindingId }) => setPendingBinding(bindingId),
    onSuccess: async (_binding, input) => {
      await invalidateReleaseQueries();
      toast({
        title: t(`releases.toast.${input.action}_success`),
        variant: 'success',
      });
    },
    onError: (error, input) =>
      toast({
        title: t(`releases.toast.${input.action}_failed`),
        description: errorText(error, t('releases.action_failed')),
        variant: 'error',
      }),
    onSettled: () => setPendingBinding(null),
  });
  const registerMutation = useMutation({
    mutationFn: (input: RegisterStagedReleaseRequest) =>
      platformAdministrationApi.registerRelease(input),
    onSuccess: async () => {
      await invalidateReleaseQueries();
      setRegistrationError(null);
      toast({
        title: t('releases.toast.register_success'),
        variant: 'success',
      });
      setRegistration(INITIAL_REGISTRATION);
    },
    onError: (error) => {
      const description = errorText(error, t('releases.action_failed'));
      setRegistrationError(description);
      toast({
        title: t('releases.toast.register_failed'),
        description,
        variant: 'error',
      });
    },
  });
  const channelMutation = useMutation({
    mutationFn: () => {
      const expectedRevision = Number(channel.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error(t('releases.channel.invalid_revision'));
      const input: SwitchPlatformReleaseChannelRequest = {
        gameId: channel.gameId.trim(),
        modeId: channel.modeId.trim(),
        channel: channel.channel.trim(),
        expectedRevision,
        targetBackendBindingId: channel.targetBackendBindingId.trim(),
        operationId: channel.operationId.trim() || operationId(),
      };
      return platformAdministrationApi.switchChannel(input);
    },
    onSuccess: async (result) => {
      setLastChannel(result);
      await invalidateReleaseQueries();
      toast({ title: t('releases.toast.channel_success'), variant: 'success' });
    },
    onError: (error) =>
      toast({
        title: t('releases.toast.channel_failed'),
        description: errorText(error, t('releases.action_failed')),
        variant: 'error',
      }),
  });

  const updateRegistration = <K extends keyof RegistrationFormState>(
    key: K,
    value: RegistrationFormState[K],
  ) => {
    setRegistrationError(null);
    setRegistration((current) => ({ ...current, [key]: value }));
  };
  const updateChannel = <K extends keyof ChannelFormState>(
    key: K,
    value: ChannelFormState[K],
  ) => setChannel((current) => ({ ...current, [key]: value }));
  const formatDate = (value: number) =>
    new Date(value).toLocaleString(i18n.language);
  const submitRegistration = (): void => {
    try {
      const policyBundle = parseOptionalJson(
        registration.policyBundle,
        t('releases.invalid_json', {
          field: t('releases.form.policy_bundle'),
        }),
      );
      const approvedPolicyVersions = parseOptionalPolicyVersions(
        registration.approvedPolicyVersions,
        t('releases.invalid_json', {
          field: t('releases.form.approved_policy_versions'),
        }),
      );
      const input: RegisterStagedReleaseRequest = {
        manifest: parseJson<ReleaseManifest>(
          registration.manifest,
          t('releases.invalid_json', {
            field: t('releases.form.manifest'),
          }),
        ),
        service: parseJson<GameServiceDescription>(
          registration.service,
          t('releases.invalid_json', {
            field: t('releases.form.service'),
          }),
        ),
        approvedFeatures: parseStringList(
          registration.approvedFeatures,
          t('releases.invalid_json', {
            field: t('releases.form.approved_features'),
          }),
        ),
        approvedModes: parseStringList(
          registration.approvedModes,
          t('releases.invalid_json', {
            field: t('releases.form.approved_modes'),
          }),
        ),
        ...(policyBundle === undefined ? {} : { policyBundle }),
        ...(approvedPolicyVersions === undefined
          ? {}
          : { approvedPolicyVersions }),
        binding: {
          deployment: registration.deployment,
          controlEndpoint: registration.controlEndpoint.trim(),
          playerEndpoint: registration.playerEndpoint.trim(),
          ...(registration.authorizationEndpoint.trim()
            ? {
                authorizationEndpoint:
                  registration.authorizationEndpoint.trim(),
              }
            : {}),
          clientArtifactBaseUrl: registration.clientArtifactBaseUrl.trim(),
          serviceCredentialRef: registration.serviceCredentialRef.trim(),
        },
      };
      setRegistrationError(null);
      registerMutation.mutate(input);
    } catch (error) {
      setRegistrationError(errorText(error, t('releases.action_failed')));
    }
  };

  return (
    <div className='space-y-5'>
      <section className='mission-panel px-5 py-5'>
        <div className='relative z-10 space-y-4'>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div>
              <p className='micro-label'>{t('releases.heading')}</p>
              <p className='mt-1 max-w-3xl text-sm text-text-400'>
                {t('releases.description')}
              </p>
            </div>
            <Button
              size='sm'
              variant='ghost'
              loading={releases.isFetching}
              onClick={() => void releases.refetch()}
            >
              {t('releases.refresh')}
            </Button>
          </div>
          {releases.isPending ? (
            <p className='text-sm text-text-400'>{t('releases.loading')}</p>
          ) : releases.isError ? (
            <div className='space-y-2'>
              <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                {t('releases.load_failed')}
              </p>
              <Button
                size='sm'
                variant='ghost'
                onClick={() => void releases.refetch()}
              >
                {t('releases.retry')}
              </Button>
            </div>
          ) : releases.data?.length ? (
            <div className='space-y-4'>
              {releases.data.map((item) => (
                <ReleaseCard
                  key={`${item.release.gameId}:${item.release.releaseId}`}
                  item={item}
                  formatDate={formatDate}
                  pendingBinding={pendingBinding}
                  onAction={(action, bindingId) =>
                    actionMutation.mutate({ action, bindingId })
                  }
                  t={t}
                />
              ))}
            </div>
          ) : (
            <p className='text-sm text-text-400'>{t('releases.empty')}</p>
          )}
        </div>
      </section>

      <ReconciliationCard
        data={reconciliation.data}
        isPending={reconciliation.isPending}
        isFetching={reconciliation.isFetching}
        isError={reconciliation.isError}
        onRefresh={() => void reconciliation.refetch()}
        formatDate={formatDate}
        onDownload={downloadReconciliation}
        t={t}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('releases.form.title')}</CardTitle>
          <CardDescription>{t('releases.form.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault();
              submitRegistration();
            }}
          >
            <div className='grid gap-4 xl:grid-cols-2'>
              <JsonField
                id='platform-release-manifest'
                label={t('releases.form.manifest')}
                value={registration.manifest}
                onChange={(value) => updateRegistration('manifest', value)}
              />
              <JsonField
                id='platform-release-service'
                label={t('releases.form.service')}
                value={registration.service}
                onChange={(value) => updateRegistration('service', value)}
              />
              <JsonField
                id='platform-release-approved-features'
                label={t('releases.form.approved_features')}
                value={registration.approvedFeatures}
                onChange={(value) =>
                  updateRegistration('approvedFeatures', value)
                }
                compact
              />
              <JsonField
                id='platform-release-approved-modes'
                label={t('releases.form.approved_modes')}
                value={registration.approvedModes}
                onChange={(value) => updateRegistration('approvedModes', value)}
                compact
              />
              <JsonField
                id='platform-release-policy-bundle'
                label={t('releases.form.policy_bundle')}
                value={registration.policyBundle}
                onChange={(value) => updateRegistration('policyBundle', value)}
              />
              <JsonField
                id='platform-release-approved-policy-versions'
                label={t('releases.form.approved_policy_versions')}
                value={registration.approvedPolicyVersions}
                onChange={(value) =>
                  updateRegistration('approvedPolicyVersions', value)
                }
                compact
              />
            </div>
            <div className='grid gap-4 md:grid-cols-2'>
              <TextField
                id='platform-release-control-endpoint'
                label={t('releases.form.control_endpoint')}
                value={registration.controlEndpoint}
                onChange={(value) =>
                  updateRegistration('controlEndpoint', value)
                }
              />
              <TextField
                id='platform-release-player-endpoint'
                label={t('releases.form.player_endpoint')}
                value={registration.playerEndpoint}
                onChange={(value) =>
                  updateRegistration('playerEndpoint', value)
                }
              />
              <TextField
                id='platform-release-authorization-endpoint'
                label={t('releases.form.authorization_endpoint')}
                value={registration.authorizationEndpoint}
                onChange={(value) =>
                  updateRegistration('authorizationEndpoint', value)
                }
              />
              <TextField
                id='platform-release-client-artifact-base-url'
                label={t('releases.form.client_artifact_base_url')}
                value={registration.clientArtifactBaseUrl}
                onChange={(value) =>
                  updateRegistration('clientArtifactBaseUrl', value)
                }
              />
              <TextField
                id='platform-release-service-credential-ref'
                label={t('releases.form.service_credential_ref')}
                value={registration.serviceCredentialRef}
                onChange={(value) =>
                  updateRegistration('serviceCredentialRef', value)
                }
              />
              <div className='space-y-1.5'>
                <Label htmlFor='platform-release-deployment'>
                  {t('releases.form.deployment')}
                </Label>
                <select
                  id='platform-release-deployment'
                  className='h-10 w-full rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                  value={registration.deployment}
                  onChange={(event) =>
                    updateRegistration(
                      'deployment',
                      event.target.value as RegistrationFormState['deployment'],
                    )
                  }
                >
                  <option value='external'>
                    {t('releases.form.external')}
                  </option>
                  <option value='managed'>{t('releases.form.managed')}</option>
                </select>
              </div>
            </div>
            <Button type='submit' loading={registerMutation.isPending}>
              {t('releases.form.submit')}
            </Button>
            {registrationError ? (
              <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                {registrationError}
              </p>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('releases.channel.title')}</CardTitle>
          <CardDescription>{t('releases.channel.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className='space-y-4'
            onSubmit={(event) => {
              event.preventDefault();
              channelMutation.mutate();
            }}
          >
            <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
              <TextField
                id='platform-release-channel-game'
                label={t('releases.channel.game_id')}
                value={channel.gameId}
                onChange={(value) => updateChannel('gameId', value)}
              />
              <TextField
                id='platform-release-channel-mode'
                label={t('releases.channel.mode_id')}
                value={channel.modeId}
                onChange={(value) => updateChannel('modeId', value)}
              />
              <TextField
                id='platform-release-channel-name'
                label={t('releases.channel.channel')}
                value={channel.channel}
                onChange={(value) => updateChannel('channel', value)}
              />
              <TextField
                id='platform-release-channel-revision'
                label={t('releases.channel.expected_revision')}
                value={channel.expectedRevision}
                onChange={(value) => updateChannel('expectedRevision', value)}
                inputMode='numeric'
              />
              <TextField
                id='platform-release-channel-binding'
                label={t('releases.channel.binding_id')}
                value={channel.targetBackendBindingId}
                onChange={(value) =>
                  updateChannel('targetBackendBindingId', value)
                }
              />
              <TextField
                id='platform-release-channel-operation'
                label={t('releases.channel.operation_id')}
                value={channel.operationId}
                onChange={(value) => updateChannel('operationId', value)}
                placeholder={t('releases.channel.operation_hint')}
              />
            </div>
            <div className='flex flex-wrap items-center gap-3'>
              <Button type='submit' loading={channelMutation.isPending}>
                {t('releases.channel.submit')}
              </Button>
              <p className='text-xs text-text-500'>
                {t('releases.channel.rollback_hint')}
              </p>
            </div>
            {lastChannel ? (
              <div className='rounded-[5px] border border-white/10 bg-surface-instrument p-3 font-mono text-xs text-text-300'>
                <p>{t('releases.channel.last_switch')}</p>
                <p className='mt-1 break-all'>
                  {lastChannel.gameId} / {lastChannel.modeId} /{' '}
                  {lastChannel.channel} → {lastChannel.targetBackendBindingId} ·
                  r{lastChannel.revision}
                </p>
              </div>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ReconciliationCard({
  data,
  isPending,
  isFetching,
  isError,
  onRefresh,
  formatDate,
  onDownload,
  t,
}: {
  data: PlatformReleaseReconciliation | undefined;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  formatDate: (value: number) => string;
  onDownload: (data: PlatformReleaseReconciliation) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <CardTitle>{t('releases.reconciliation.title')}</CardTitle>
            <CardDescription>
              {t('releases.reconciliation.description')}
            </CardDescription>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              variant='ghost'
              loading={isFetching}
              onClick={onRefresh}
            >
              {t('releases.reconciliation.refresh')}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              disabled={!data}
              onClick={() => {
                if (data) onDownload(data);
              }}
            >
              {t('releases.reconciliation.download')}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isPending && !data ? (
          <p className='text-sm text-text-400'>
            {t('releases.reconciliation.loading')}
          </p>
        ) : !data ? (
          <div className='space-y-2'>
            <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
              {t('releases.reconciliation.load_failed')}
            </p>
            <Button size='sm' variant='ghost' onClick={onRefresh}>
              {t('releases.reconciliation.retry')}
            </Button>
          </div>
        ) : (
          <div className='space-y-5'>
            {isError ? (
              <p role='alert' className='text-sm text-[var(--signal-red-hi)]'>
                {t('releases.reconciliation.load_failed')}
              </p>
            ) : null}
            <div className='grid gap-3 text-sm text-text-300 md:grid-cols-3'>
              <div>
                <p className='micro-label'>
                  {t('releases.reconciliation.platform')}
                </p>
                <p className='mt-1 break-all font-mono text-xs text-text-100'>
                  {data.platformId}
                </p>
              </div>
              <div>
                <p className='micro-label'>
                  {t('releases.reconciliation.generated')}
                </p>
                <p className='mt-1 text-xs text-text-100'>
                  {formatDate(data.generatedAt)}
                </p>
              </div>
              <div>
                <p className='micro-label'>
                  {t('releases.reconciliation.state')}
                </p>
                <p className='mt-1 text-xs text-text-100'>
                  {data.desiredConfigured
                    ? data.desired.length > 0
                      ? t('releases.reconciliation.configured')
                      : t('releases.reconciliation.configured_empty')
                    : t('releases.reconciliation.not_configured')}
                </p>
              </div>
            </div>

            <ReconciliationListSection
              title={t('releases.reconciliation.desired')}
              emptyLabel={
                data.desiredConfigured
                  ? t('releases.reconciliation.no_desired')
                  : t('releases.reconciliation.desired_unconfigured')
              }
            >
              {data.desired.map((item) => (
                <li
                  key={`${item.gameId}:${item.releaseId}`}
                  className='rounded-[5px] border border-white/10 bg-surface-900/45 p-3 text-xs text-text-300'
                >
                  <span className='font-mono text-text-100'>
                    {item.gameId} / {item.releaseId}
                  </span>{' '}
                  · {item.deployment} ·{' '}
                  {item.enabled
                    ? t('releases.reconciliation.enabled')
                    : t('releases.reconciliation.disabled')}
                </li>
              ))}
            </ReconciliationListSection>

            <div className='grid gap-5 xl:grid-cols-2'>
              <ReconciliationListSection
                title={t('releases.reconciliation.channels')}
                emptyLabel={t('releases.reconciliation.no_channels')}
              >
                {data.actual.channels.map((channel) => (
                  <ChannelRecordRow
                    key={`${channel.gameId}:${channel.modeId}:${channel.channel}`}
                    channel={channel}
                    formatDate={formatDate}
                  />
                ))}
              </ReconciliationListSection>
              <ReconciliationListSection
                title={t('releases.reconciliation.history')}
                emptyLabel={t('releases.reconciliation.no_history')}
              >
                {data.channelHistory.slice(0, 100).map((channel, index) => (
                  <ChannelRecordRow
                    key={`${channel.operationId}:${index}`}
                    channel={channel}
                    formatDate={formatDate}
                  />
                ))}
              </ReconciliationListSection>
            </div>

            <ReconciliationListSection
              title={t('releases.reconciliation.differences')}
              emptyLabel={t('releases.reconciliation.no_differences')}
            >
              {data.differences.map((difference, index) => (
                <li
                  key={`${difference.gameId}:${difference.modeId ?? ''}:${difference.kind}:${index}`}
                  className='rounded-[5px] border border-[var(--signal-red-hi)]/30 bg-[var(--signal-red)]/10 p-3 text-xs text-text-200'
                >
                  <p className='font-medium text-[var(--signal-red-hi)]'>
                    {t(
                      `releases.reconciliation.difference_kind.${difference.kind}`,
                    )}
                  </p>
                  <p className='mt-1 break-all text-text-400'>
                    {difference.gameId}
                    {difference.modeId ? ` / ${difference.modeId}` : ''} ·{' '}
                    {t('releases.reconciliation.expected')}:{' '}
                    {difference.expected ?? '—'} ·{' '}
                    {t('releases.reconciliation.actual')}:{' '}
                    {difference.actual ?? '—'}
                  </p>
                </li>
              ))}
            </ReconciliationListSection>

            <p className='text-xs text-text-500'>
              {t('releases.reconciliation.counts', {
                releases: data.actual.releases.length,
                bindings: data.actual.bindings.length,
                channels: data.actual.channels.length,
                history: Math.min(data.channelHistory.length, 100),
              })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ReconciliationListSection({
  title,
  emptyLabel,
  children,
}: {
  title: string;
  emptyLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : children !== null && children !== undefined;
  return (
    <section className='space-y-2'>
      <h3 className='font-display text-base text-text-100'>{title}</h3>
      {hasChildren ? (
        <ul className='space-y-2'>{children}</ul>
      ) : (
        <p className='text-xs text-text-500'>{emptyLabel}</p>
      )}
    </section>
  );
}

function ChannelRecordRow({
  channel,
  formatDate,
}: {
  channel: PlatformReleaseReconciliation['actual']['channels'][number];
  formatDate: (value: number) => string;
}): React.JSX.Element {
  return (
    <li className='rounded-[5px] border border-white/10 bg-surface-900/45 p-3 text-xs text-text-300'>
      <p className='font-mono text-text-100'>
        {channel.gameId} / {channel.modeId} / {channel.channel}
      </p>
      <p className='mt-1 break-all'>
        {channel.releaseId} · {channel.targetBackendBindingId} · r
        {channel.revision} · {formatDate(channel.updatedAt)}
      </p>
    </li>
  );
}

function ReleaseCard({
  item,
  formatDate,
  pendingBinding,
  onAction,
  t,
}: {
  item: PlatformReleaseAdminItem;
  formatDate: (value: number) => string;
  pendingBinding: string | null;
  onAction: (action: BindingAction, bindingId: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const { release } = item;
  return (
    <article className='rounded-[6px] border border-white/10 bg-surface-instrument/55 p-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h3 className='font-display text-lg text-text-100'>
            {release.gameId}{' '}
            <span className='font-mono text-sm text-text-300'>
              {release.releaseId}
            </span>
          </h3>
          <p className='mt-1 text-sm text-text-400'>
            {release.manifest.displayVersion} ·{' '}
            {t('releases.created', {
              date: formatDate(release.createdAt),
            })}
          </p>
        </div>
        <Badge variant='data'>
          {t('releases.bindings_count', { count: item.bindings.length })}
        </Badge>
      </div>
      <div className='mt-3 grid gap-2 text-xs text-text-400 md:grid-cols-3'>
        <span className='break-all'>
          {t('releases.manifest_digest')}: <code>{release.manifestDigest}</code>
        </span>
        <span className='break-all'>
          {t('releases.service_digest')}: <code>{release.serviceDigest}</code>
        </span>
        <span>
          {t('releases.modes')}: {release.approvedModes.join(', ') || '—'}
        </span>
      </div>
      <div className='mt-4 space-y-3'>
        {item.bindings.map((binding) => (
          <BindingRow
            key={binding.backendBindingId}
            binding={binding}
            formatDate={formatDate}
            pending={pendingBinding === binding.backendBindingId}
            onAction={onAction}
            t={t}
          />
        ))}
      </div>
    </article>
  );
}

function BindingRow({
  binding,
  formatDate,
  pending,
  onAction,
  t,
}: {
  binding: PlatformReleaseBinding;
  formatDate: (value: number) => string;
  pending: boolean;
  onAction: (action: BindingAction, bindingId: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}): React.JSX.Element {
  const trigger = (action: BindingAction) =>
    onAction(action, binding.backendBindingId);
  return (
    <div className='rounded-[5px] border border-white/10 bg-surface-900/45 p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Badge variant={statusVariant(binding.status)}>
          {t(`releases.status.${binding.status}`)}
        </Badge>
        <code className='break-all text-xs text-text-200'>
          {binding.backendBindingId}
        </code>
        <span className='text-xs text-text-500'>
          {binding.deployment} · r{binding.revision}
        </span>
      </div>
      <div className='mt-2 grid gap-1 text-xs text-text-400 md:grid-cols-3'>
        <span>
          {t('releases.storage')}: {binding.storageBindingId}
        </span>
        <span>
          {t('releases.epoch')}: {binding.ownershipEpoch}
        </span>
        <span>
          {t('releases.updated')}: {formatDate(binding.updatedAt)}
        </span>
      </div>
      {binding.readiness ? (
        <p className='mt-2 text-xs text-[oklch(0.88_0.14_160)]'>
          {t('releases.probe_evidence', {
            probeId: binding.readiness.probeId,
            date: formatDate(binding.readiness.checkedAt),
          })}
        </p>
      ) : null}
      <div className='mt-3 flex flex-wrap gap-2'>
        {binding.status === 'staged' ? (
          <Button size='sm' loading={pending} onClick={() => trigger('ready')}>
            {t('releases.actions.ready')}
          </Button>
        ) : null}
        {binding.status === 'ready' ? (
          <Button
            size='sm'
            variant='ghost'
            loading={pending}
            onClick={() => trigger('activate')}
          >
            {t('releases.actions.activate')}
          </Button>
        ) : null}
        {binding.status === 'ready' ? (
          <Button
            size='sm'
            variant='ghost'
            loading={pending}
            onClick={() => trigger('drain')}
          >
            {t('releases.actions.drain')}
          </Button>
        ) : null}
        {binding.status === 'ready' ? (
          <Button
            size='sm'
            variant='danger'
            loading={pending}
            onClick={() => trigger('disable')}
          >
            {t('releases.actions.disable')}
          </Button>
        ) : null}
        {binding.status === 'draining' ? (
          <Button
            size='sm'
            variant='ghost'
            loading={pending}
            onClick={() => trigger('retain')}
          >
            {t('releases.actions.retain')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  inputMode,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  placeholder?: string;
}): React.JSX.Element {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function JsonField({
  id,
  label,
  value,
  onChange,
  compact = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        className={`min-h-${compact ? '24' : '40'} w-full rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 py-2 font-mono text-xs text-text-100 placeholder:text-text-500 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
