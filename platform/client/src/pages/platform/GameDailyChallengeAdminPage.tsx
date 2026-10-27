import type { JsonObject, JsonValue } from '@board-game/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PlatformDailyChallengeSettings,
  platformGameApi,
} from '@/api/platformGameApi.js';
import { Button } from '@/components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.js';
import { useAuthStore } from '@/stores/authStore.js';

export interface GameDailyChallengeSettingsEditorProps {
  readonly gameId: string;
  readonly settings: JsonObject;
  readonly disabled: boolean;
  readonly onChange: (settings: JsonObject) => void;
}

export type GameDailyChallengeSettingsEditor =
  ComponentType<GameDailyChallengeSettingsEditorProps>;

interface SettingsDraft {
  readonly gameId: string;
  readonly authEpoch: number;
  readonly userId?: string;
  readonly revision: number;
  readonly settings: JsonObject;
  readonly dirty: boolean;
}

interface UpdateSettingsInput {
  readonly gameId: string;
  readonly authEpoch: number;
  readonly userId?: string;
  readonly revision: number;
  readonly settings: JsonObject;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function settingsObject(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function settingsQueryKey(
  gameId: string,
  authEpoch: number,
  userId: string | undefined,
) {
  return [
    'game',
    gameId,
    'daily-challenge',
    'settings',
    authEpoch,
    userId ?? 'anonymous',
  ] as const;
}

function sameScope(
  draft: Pick<SettingsDraft, 'gameId' | 'authEpoch' | 'userId'>,
  scope: Pick<SettingsDraft, 'gameId' | 'authEpoch' | 'userId'>,
): boolean {
  return (
    draft.gameId === scope.gameId &&
    draft.authEpoch === scope.authEpoch &&
    draft.userId === scope.userId
  );
}

function formFromSettings(
  settings: PlatformDailyChallengeSettings,
  scope: Pick<SettingsDraft, 'authEpoch' | 'userId'>,
): SettingsDraft {
  return {
    gameId: settings.gameId,
    authEpoch: scope.authEpoch,
    userId: scope.userId,
    revision: settings.revision,
    settings: settingsObject(settings.settings),
    dirty: false,
  };
}

export function GameDailyChallengeAdminPage({
  gameId,
  renderSettings: SettingsEditor,
}: {
  readonly gameId: string;
  /** The game owns its fields and validation; platform owns only persistence. */
  readonly renderSettings: GameDailyChallengeSettingsEditor;
}): React.JSX.Element | null {
  const { t } = useTranslation('platform');
  const queryClient = useQueryClient();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const scope = { gameId, authEpoch, userId } as const;
  const settingsKey = settingsQueryKey(gameId, authEpoch, userId);
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: () => platformGameApi.getDailyChallengeSettings(gameId),
  });
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings || settings.gameId !== gameId) return;
    setDraft((current) => {
      if (!current || !sameScope(current, scope))
        return formFromSettings(settings, scope);
      // A background refetch must never overwrite an in-progress edit. The
      // stale revision is intentionally retained so the server can reject a
      // concurrent save instead of accepting the wrong draft.
      if (current.dirty) return current;
      return formFromSettings(settings, scope);
    });
  }, [gameId, authEpoch, userId, settingsQuery.data]);

  const updateMutation = useMutation({
    mutationFn: (input: UpdateSettingsInput) =>
      platformGameApi.updateDailyChallengeSettings(input.gameId, {
        settings: input.settings,
        expectedRevision: input.revision,
      }),
    onSuccess: (settings, input) => {
      if (!sameScope(input, scopeRef.current)) return;
      setDraft((current) =>
        current && sameScope(current, scopeRef.current)
          ? formFromSettings(settings, scopeRef.current)
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKey(input.gameId, input.authEpoch, input.userId),
      });
    },
  });

  useEffect(() => {
    updateMutation.reset();
  }, [gameId, authEpoch, userId]);

  const currentDraft = draft && sameScope(draft, scope) ? draft : null;
  const save = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!currentDraft || updateMutation.isPending) return;
    updateMutation.mutate({
      gameId,
      authEpoch,
      userId,
      revision: currentDraft.revision,
      settings: currentDraft.settings,
    });
  };

  if (settingsQuery.isPending && !currentDraft) {
    return (
      <Card>
        <CardContent className='py-8'>
          <p role='status'>
            {t('game_pages.loading', { defaultValue: 'Loading…' })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (settingsQuery.isError && !currentDraft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {t('game_pages.daily_admin.title', {
              defaultValue: 'Daily challenge configuration',
            })}
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p role='alert'>
            {errorMessage(
              settingsQuery.error,
              t('game_pages.load_failed', {
                defaultValue: 'This game page could not be loaded.',
              }),
            )}
          </p>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void settingsQuery.refetch()}
          >
            {t('game_pages.retry', { defaultValue: 'Retry' })}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!currentDraft) return null;

  return (
    <Card data-testid='game-daily-challenge-admin-page'>
      <CardHeader>
        <CardTitle>
          {t('game_pages.daily_admin.title', {
            defaultValue: 'Daily challenge configuration',
          })}
        </CardTitle>
        <CardDescription>
          {t('game_pages.daily_admin.description', {
            defaultValue:
              'Configure the settings used by this game’s daily challenge.',
          })}
        </CardDescription>
        <p className='text-sm text-text-400'>
          {t('game_pages.daily_admin.frozen_notice', {
            defaultValue:
              'Changes apply only to daily challenges that have not been generated yet. A generated day keeps its frozen configuration.',
          })}
        </p>
      </CardHeader>
      <CardContent>
        <form className='space-y-4' onSubmit={save}>
          <SettingsEditor
            gameId={gameId}
            settings={currentDraft.settings}
            disabled={updateMutation.isPending}
            onChange={(settings) =>
              setDraft((current) =>
                current && sameScope(current, scope)
                  ? { ...current, settings, dirty: true }
                  : current,
              )
            }
          />
          <Button
            type='submit'
            loading={updateMutation.isPending}
            loadingLabel={t('game_pages.daily_admin.saving', {
              defaultValue: 'Saving configuration',
            })}
          >
            {t('game_pages.save', { defaultValue: 'Save configuration' })}
          </Button>
          {settingsQuery.isError ? (
            <p role='alert' className='text-sm text-[var(--signal-amber)]'>
              {t('game_pages.load_failed', {
                defaultValue:
                  'The latest configuration could not be refreshed; your draft is preserved.',
              })}
            </p>
          ) : null}
          {updateMutation.isError ? (
            <p role='alert' className='text-sm text-[var(--signal-red)]'>
              {errorMessage(
                updateMutation.error,
                t('game_pages.save_failed', {
                  defaultValue: 'The configuration could not be saved.',
                }),
              )}
            </p>
          ) : null}
          {updateMutation.isSuccess ? (
            <p role='status' className='text-sm text-[oklch(0.88_0.14_160)]'>
              {t('game_pages.saved', { defaultValue: 'Configuration saved.' })}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
