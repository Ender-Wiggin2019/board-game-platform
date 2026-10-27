import type {
  AutomationPreset,
  RoomControllerCapabilities,
  RoomSeatControllerInput,
} from '@board-game/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function RoomControllerPanel({
  capabilities,
  disabled,
  loading,
  onSave,
}: {
  readonly capabilities: RoomControllerCapabilities;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onSave: (controller: RoomSeatControllerInput) => void;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const firstAutomation = capabilities.automation[0];
  const [selection, setSelection] = useState(
    capabilities.hotseat ? 'hotseat' : (firstAutomation?.id ?? ''),
  );
  const [displayName, setDisplayName] = useState('');
  const [presetId, setPresetId] = useState('');
  const automation = useMemo(
    () =>
      capabilities.automation.find((candidate) => candidate.id === selection),
    [capabilities.automation, selection],
  );
  const presets = useMemo(
    (): readonly AutomationPreset[] => automation?.presets ?? [],
    [automation],
  );
  const selectedPreset = presets.find((preset) => preset.id === presetId);

  useEffect(() => {
    if (selection === 'hotseat' && capabilities.hotseat) return;
    if (automation) return;
    setSelection(
      capabilities.hotseat ? 'hotseat' : (firstAutomation?.id ?? ''),
    );
  }, [automation, capabilities.hotseat, firstAutomation?.id, selection]);

  useEffect(() => {
    if (presets.length === 0) {
      setPresetId('');
      return;
    }
    if (presets.some((preset) => preset.id === presetId)) return;
    setPresetId(presets[0]?.id ?? '');
  }, [presetId, presets]);

  const save = (): void => {
    if (selection === 'hotseat') {
      onSave({
        kind: 'hotseat',
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
      return;
    }
    if (!automation) return;
    onSave({
      kind: automation.kind,
      controllerId: automation.id,
      ...(selectedPreset?.options !== undefined
        ? { options: selectedPreset.options }
        : automation.defaultOptions === undefined
          ? {}
          : { options: automation.defaultOptions }),
    });
  };

  const hasOptions = capabilities.hotseat || capabilities.automation.length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('room.controller_title')}</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        {!hasOptions ? (
          <p className='text-sm text-text-500'>
            {t('room.controller_unavailable')}
          </p>
        ) : (
          <>
            <div className='space-y-2'>
              <Label htmlFor='platform-room-controller-kind'>
                {t('room.controller_kind')}
              </Label>
              <select
                id='platform-room-controller-kind'
                value={selection}
                disabled={disabled || loading}
                onChange={(event) => setSelection(event.target.value)}
                className='h-10 w-full rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
              >
                {capabilities.hotseat ? (
                  <option value='hotseat'>
                    {t('room.controller_hotseat')}
                  </option>
                ) : null}
                {capabilities.automation.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </div>
            {selection === 'hotseat' ? (
              <div className='space-y-2'>
                <Label htmlFor='platform-room-controller-name'>
                  {t('room.controller_name')}
                </Label>
                <Input
                  id='platform-room-controller-name'
                  value={displayName}
                  disabled={disabled || loading}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t('room.controller_name_placeholder')}
                />
              </div>
            ) : null}
            {selection !== 'hotseat' && presets.length > 0 ? (
              <div className='space-y-2'>
                <Label htmlFor='platform-room-controller-preset'>
                  {t('room.controller_preset')}
                </Label>
                <select
                  id='platform-room-controller-preset'
                  value={presetId}
                  disabled={disabled || loading}
                  onChange={(event) => setPresetId(event.target.value)}
                  className='h-10 w-full rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                >
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
      {hasOptions ? (
        <CardFooter>
          <Button
            variant='ghost'
            onClick={save}
            loading={loading}
            loadingLabel={t('room.controller_saving')}
            disabled={disabled || !selection}
          >
            {t('room.controller_add')}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
