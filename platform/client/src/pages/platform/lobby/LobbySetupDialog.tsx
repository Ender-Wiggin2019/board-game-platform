import { GameSetupOptions } from '@board-game/components';
import type { JsonValue, ModeDefinition } from '@board-game/contracts';
import type React from 'react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformCatalogEntry } from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GameClientProviders } from '@/GameClientProviders';
import type { GameClientRegistration } from '@/GameClientRegistration.js';

export type LobbySetupKind = 'room' | 'solo';

export interface PlatformLobbyRoomSubmission {
  readonly modeId: string;
  readonly releaseId: string;
  readonly visibility: 'public' | 'private';
  readonly setup: JsonValue;
  readonly seed?: string;
  readonly name?: string;
  readonly password?: string;
}

export interface PlatformLobbySoloSubmission {
  readonly modeId: string;
  readonly releaseId: string;
  readonly setup: JsonValue;
  readonly seed?: string;
}

interface PendingSubmission {
  readonly kind: LobbySetupKind;
  readonly room?: PlatformLobbyRoomSubmission;
  readonly solo?: PlatformLobbySoloSubmission;
}

export interface LobbySetupDialogProps {
  readonly open: boolean;
  readonly kind: LobbySetupKind;
  readonly gameId: string;
  readonly registration: GameClientRegistration;
  readonly roomModes: readonly PlatformCatalogEntry[];
  readonly soloMode?: PlatformCatalogEntry;
  readonly cover?: string;
  readonly isPending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreateRoom: (input: PlatformLobbyRoomSubmission) => void;
  readonly onCreateSolo: (input: PlatformLobbySoloSubmission) => void;
}

function modeLabel(
  gameId: string,
  modeId: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t('games.' + gameId + '.modes.' + modeId, {
    defaultValue: t('modes.' + modeId, { defaultValue: modeId }),
  });
}

function playerCountOptions(mode: ModeDefinition | undefined): number[] {
  if (!mode) return [];
  return Array.from(
    { length: mode.maxPlayers - mode.minPlayers + 1 },
    (_, index) => mode.minPlayers + index,
  );
}

export function LobbySetupDialog({
  open,
  kind,
  gameId,
  registration,
  roomModes,
  soloMode,
  cover,
  isPending,
  onOpenChange,
  onCreateRoom,
  onCreateSolo,
}: LobbySetupDialogProps): React.JSX.Element | null {
  const { t } = useTranslation('platform');
  const [modeId, setModeId] = useState('');
  const [setupDraft, setSetupDraft] = useState<JsonValue | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [roomName, setRoomName] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [seed, setSeed] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmingSeed, setConfirmingSeed] = useState(false);
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingSubmission | null>(null);

  const availableModes =
    kind === 'room' ? roomModes : soloMode ? [soloMode] : [];
  const activeEntry = availableModes.find((entry) => entry.mode.id === modeId);
  const activeMode = activeEntry?.mode;
  const SetupEditor = useMemo(() => {
    const loader = registration.setup.setupEditor;
    return loader ? lazy(loader) : null;
  }, [registration]);
  const effectiveSetup =
    setupDraft ??
    (activeMode ? registration.setup.default(activeMode.id) : null);
  const setupOptions = registration.setup.options ?? [];
  const playerCount = activeMode
    ? registration.setup.getPlayerCount(
        effectiveSetup ?? {},
        activeMode.minPlayers,
      )
    : 0;

  useEffect(() => {
    if (open) {
      const firstMode = availableModes[0];
      setModeId(firstMode?.mode.id ?? '');
      setSetupDraft(
        firstMode ? registration.setup.default(firstMode.mode.id) : null,
      );
      setVisibility('public');
      setRoomName('');
      setRoomPassword('');
      setSeed('');
      setAdvancedOpen(false);
      setConfirmingSeed(false);
      setPendingSubmission(null);
      return;
    }
    setConfirmingSeed(false);
    setPendingSubmission(null);
  }, [gameId, kind, open, registration, roomModes, soloMode]);

  const handleModeChange = (nextModeId: string): void => {
    const nextEntry = availableModes.find(
      (entry) => entry.mode.id === nextModeId,
    );
    setModeId(nextModeId);
    setSetupDraft(
      nextEntry ? registration.setup.default(nextEntry.mode.id) : null,
    );
    setAdvancedOpen(false);
    setSeed('');
  };

  const handlePlayerCountChange = (count: number): void => {
    if (!activeMode || effectiveSetup === null) return;
    setSetupDraft(registration.setup.updatePlayerCount(effectiveSetup, count));
  };

  const makeSubmission = (): PendingSubmission | null => {
    if (!activeEntry || effectiveSetup === null) return null;
    const preset =
      !activeEntry.mode.platformRating && seed.trim()
        ? { seed: seed.trim() }
        : {};
    if (kind === 'solo') {
      return {
        kind,
        solo: {
          modeId: activeEntry.mode.id,
          releaseId: activeEntry.releaseId,
          setup: effectiveSetup,
          ...preset,
        },
      };
    }
    return {
      kind,
      room: {
        modeId: activeEntry.mode.id,
        releaseId: activeEntry.releaseId,
        visibility,
        setup: effectiveSetup,
        ...preset,
        ...(roomName.trim() ? { name: roomName.trim() } : {}),
        ...(roomPassword ? { password: roomPassword } : {}),
      },
    };
  };

  const submit = (): void => {
    const next = makeSubmission();
    if (!next) return;
    if (seed.trim() && !activeMode?.platformRating) {
      setPendingSubmission(next);
      setConfirmingSeed(true);
      return;
    }
    if (next.kind === 'room' && next.room) onCreateRoom(next.room);
    if (next.kind === 'solo' && next.solo) onCreateSolo(next.solo);
  };

  const confirmSubmission = (): void => {
    if (!pendingSubmission) return;
    if (pendingSubmission.kind === 'room' && pendingSubmission.room) {
      onCreateRoom(pendingSubmission.room);
    } else if (pendingSubmission.kind === 'solo' && pendingSubmission.solo) {
      onCreateSolo(pendingSubmission.solo);
    }
  };

  if (!open) return null;

  const title =
    kind === 'room'
      ? t('create.title')
      : t('create.solo', { defaultValue: 'Start solo challenge' });
  const description =
    kind === 'room'
      ? t('create.description', {
          defaultValue: 'Choose the table rules before opening this room.',
        })
      : t('create.solo_description');

  return (
    <Dialog
      open={open}
      dismissible={!isPending}
      onOpenChange={onOpenChange}
      ariaLabel={title}
    >
      <DialogContent
        scene={cover}
        sceneHeight={120}
        variant='default'
        onClose={isPending ? undefined : () => onOpenChange(false)}
        closeLabel={t('status.close', { defaultValue: 'Close dialog' })}
      >
        <DialogHeader>
          <DialogTitle>
            {confirmingSeed
              ? t('create.seed_confirm_title', {
                  defaultValue: 'Confirm preset seed',
                })
              : title}
          </DialogTitle>
          <DialogDescription>
            {confirmingSeed
              ? t('create.seed_confirm_description', {
                  defaultValue:
                    'This seed makes the setup reproducible for everyone who joins.',
                })
              : description}
          </DialogDescription>
        </DialogHeader>

        {confirmingSeed ? (
          <div className='space-y-3 text-sm text-text-300'>
            <p>
              {t('create.seed_confirm_value', {
                defaultValue: 'Preset seed: {{seed}}',
                seed: seed.trim(),
              })}
            </p>
            <p className='text-xs text-text-500'>
              {t('create.seed_confirm_notice', {
                defaultValue:
                  'Players joining this room will use the same preset.',
              })}
            </p>
          </div>
        ) : (
          <div className='space-y-5'>
            {kind === 'room' ? (
              <Field label={t('create.mode')} htmlFor='platform-room-mode'>
                <select
                  id='platform-room-mode'
                  value={modeId}
                  onChange={(event) => handleModeChange(event.target.value)}
                  className='h-10 w-full cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                >
                  {roomModes.map((entry) => (
                    <option key={entry.mode.id} value={entry.mode.id}>
                      {modeLabel(gameId, entry.mode.id, t)} ·{' '}
                      {entry.mode.minPlayers}–{entry.mode.maxPlayers}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {kind === 'room' ? (
              <>
                <div className='grid gap-4 sm:grid-cols-2'>
                  <Field
                    label={t('create.player_count')}
                    htmlFor='platform-room-player-count'
                  >
                    <select
                      id='platform-room-player-count'
                      value={playerCount}
                      onChange={(event) =>
                        handlePlayerCountChange(Number(event.target.value))
                      }
                      className='h-10 w-full cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                    >
                      {playerCountOptions(activeMode).map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={t('create.visibility')}
                    htmlFor='platform-room-visibility'
                  >
                    <select
                      id='platform-room-visibility'
                      value={visibility}
                      onChange={(event) =>
                        setVisibility(
                          event.target.value as 'public' | 'private',
                        )
                      }
                      className='h-10 w-full cursor-pointer rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                    >
                      <option value='public'>{t('create.public')}</option>
                      <option value='private'>{t('create.private')}</option>
                    </select>
                  </Field>
                </div>
                <Field label={t('create.name')} htmlFor='platform-room-name'>
                  <Input
                    id='platform-room-name'
                    value={roomName}
                    maxLength={80}
                    onChange={(event) => setRoomName(event.target.value)}
                    placeholder={t('create.name_placeholder')}
                  />
                </Field>
                <Field
                  label={t('create.password')}
                  htmlFor='platform-room-password'
                >
                  <Input
                    id='platform-room-password'
                    type='password'
                    value={roomPassword}
                    maxLength={128}
                    onChange={(event) => setRoomPassword(event.target.value)}
                    placeholder={t('create.password_placeholder')}
                    autoComplete='new-password'
                  />
                </Field>
              </>
            ) : null}

            {setupOptions.length > 0 && effectiveSetup !== null ? (
              <GameClientProviders registration={registration}>
                <GameSetupOptions
                  options={setupOptions}
                  legendLabel={t('create.description')}
                  setup={effectiveSetup}
                  disabled={isPending}
                  onChange={setSetupDraft}
                  translate={(key) =>
                    t(key, {
                      defaultValue: key,
                    })
                  }
                />
              </GameClientProviders>
            ) : null}

            <details
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
              className='platform-lobby-advanced rounded-[6px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument/70 px-3 py-2'
            >
              <summary className='cursor-pointer text-sm font-medium text-text-100'>
                {t('create.advanced', { defaultValue: 'Advanced settings' })}
              </summary>
              <div className='space-y-4 pt-4'>
                {registration.capabilities?.supportsSeed !== false &&
                !activeMode?.platformRating ? (
                  <Field label={t('create.seed')} htmlFor='platform-room-seed'>
                    <Input
                      id='platform-room-seed'
                      value={seed}
                      maxLength={256}
                      onChange={(event) => setSeed(event.target.value)}
                      placeholder={t('create.seed_placeholder')}
                      autoComplete='off'
                    />
                  </Field>
                ) : null}
                {advancedOpen &&
                SetupEditor &&
                activeMode &&
                effectiveSetup !== null ? (
                  <div className='space-y-2'>
                    <p className='text-xs uppercase tracking-microlabel text-text-500'>
                      {kind === 'solo'
                        ? t('create.solo_setup')
                        : t('room.configure')}
                    </p>
                    <Suspense
                      fallback={<LoadingSpinner label={t('status.loading')} />}
                    >
                      <GameClientProviders registration={registration}>
                        <SetupEditor
                          setup={effectiveSetup}
                          mode={activeMode}
                          readOnly={false}
                          disabled={isPending}
                          onChange={setSetupDraft}
                        />
                      </GameClientProviders>
                    </Suspense>
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        )}

        <DialogFooter>
          {confirmingSeed ? (
            <>
              <Button
                type='button'
                variant='ghost'
                disabled={isPending}
                onClick={() => {
                  setConfirmingSeed(false);
                  setPendingSubmission(null);
                }}
              >
                {t('status.back', { defaultValue: 'Back' })}
              </Button>
              <Button
                type='button'
                loading={isPending}
                loadingLabel={t('create.creating')}
                onClick={confirmSubmission}
              >
                {t('create.seed_confirm', {
                  defaultValue: 'Use seed and create',
                })}
              </Button>
            </>
          ) : (
            <>
              <Button
                type='button'
                variant='ghost'
                disabled={isPending}
                onClick={() => onOpenChange(false)}
              >
                {t('status.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button
                type='button'
                loading={isPending}
                loadingLabel={t('create.creating')}
                disabled={!activeEntry || effectiveSetup === null}
                onClick={submit}
              >
                {kind === 'room'
                  ? t('create.create')
                  : t('create.solo', {
                      defaultValue: 'Start solo challenge',
                    })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className='space-y-2'>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
