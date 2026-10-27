import {
  canonicalStableStringify,
  type PlatformRoomInvitation,
} from '@board-game/contracts';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type PlatformCatalogEntry,
  type PlatformRequestIntent,
  platformApi,
  resolvePlatformRequestIntent,
} from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { toast } from '@/components/ui/toast';
import type { GameClientRegistration } from '@/GameClientRegistration.js';
import { useResolvedGameClient } from '@/platform/useGameClient';
import { useAuthStore } from '@/stores/authStore';
import {
  LobbySetupDialog,
  type LobbySetupKind,
  type PlatformLobbyRoomSubmission,
  type PlatformLobbySoloSubmission,
} from './lobby/LobbySetupDialog';
import { LobbySurface, StatusCard } from './lobby/LobbySurface';
import { PlatformSessionDirectory } from './lobby/PlatformSessionDirectory';
import { QueryRefreshNotice } from './QueryRefreshNotice';
import './lobby/platformLobby.css';

export interface PlatformLobbyPageProps {
  readonly gameId: string;
  readonly view?: 'lobby' | 'sessions';
}

export function PlatformLobbyPage({
  gameId,
  view = 'lobby',
}: PlatformLobbyPageProps): React.JSX.Element {
  const { t } = useTranslation('platform');
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const catalogQuery = useQuery({
    queryKey: ['platform', 'catalog', authEpoch],
    queryFn: platformApi.catalog,
    staleTime: 5 * 60 * 1000,
  });
  const catalogEntries = useMemo(
    () => (catalogQuery.data ?? []).filter((entry) => entry.gameId === gameId),
    [catalogQuery.data, gameId],
  );
  const primaryEntry = catalogEntries[0];
  const client = useResolvedGameClient(gameId, primaryEntry?.releaseId);
  const registration = client.registration;
  const resolvedCatalogEntries = useMemo(
    () =>
      primaryEntry
        ? catalogEntries.filter(
            (entry) => entry.releaseId === primaryEntry.releaseId,
          )
        : [],
    [catalogEntries, primaryEntry],
  );
  const cover = primaryEntry?.metadata?.cover ?? registration?.metadata.cover;

  if (catalogQuery.isPending || client.isPending) {
    return <LoadingSpinner variant='block' label={t('catalog.loading')} />;
  }
  if (catalogQuery.isError && !catalogQuery.data) {
    return (
      <StatusCard
        title={t('status.error')}
        actionLabel={t('status.retry')}
        onAction={() => void catalogQuery.refetch()}
      />
    );
  }
  if (client.isError || client.isUnavailable) {
    return (
      <StatusCard
        title={t('workspace.unavailable')}
        actionLabel={t('status.retry')}
        onAction={() => void client.refetch()}
      />
    );
  }
  if (!registration || catalogEntries.length === 0) {
    return (
      <div data-testid='platform-lobby-unavailable'>
        <StatusCard
          title={t('workspace.unavailable', {
            defaultValue: 'This game is not available in this client.',
          })}
        />
      </div>
    );
  }

  const themeStyle = {
    ...registration.theme?.tokens,
    ...(registration.palette?.accent
      ? { '--game-palette-accent': registration.palette.accent }
      : {}),
  } as React.CSSProperties;

  return (
    <section
      className='space-y-5'
      data-testid='platform-lobby-page'
      data-game-id={gameId}
      data-game-theme={registration.theme?.dataTheme}
      data-game-theme-scope={registration.theme?.scope}
      style={themeStyle}
    >
      {catalogQuery.isError ? (
        <QueryRefreshNotice
          onRetry={() => void catalogQuery.refetch()}
          retrying={catalogQuery.isFetching}
        />
      ) : null}
      {view === 'sessions' ? (
        <PlatformSessionDirectory gameId={gameId} registration={registration} />
      ) : (
        <PlatformLobbyBody
          gameId={gameId}
          cover={cover}
          registration={registration}
          catalogEntries={resolvedCatalogEntries}
        />
      )}
    </section>
  );
}

function PlatformLobbyBody({
  gameId,
  cover,
  registration,
  catalogEntries,
}: {
  readonly gameId: string;
  readonly cover?: string;
  readonly registration: GameClientRegistration;
  readonly catalogEntries: readonly PlatformCatalogEntry[];
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const roomModes = useMemo(
    () => catalogEntries.filter((entry) => entry.mode.entry === 'room'),
    [catalogEntries],
  );
  const soloMode = catalogEntries.find(
    (entry) => entry.mode.entry === 'direct-solo',
  );
  const [setupKind, setSetupKind] = useState<LobbySetupKind | null>(null);
  const roomIntent = useRef<PlatformRequestIntent | null>(null);
  const soloIntent = useRef<PlatformRequestIntent | null>(null);

  const roomsQuery = useInfiniteQuery({
    queryKey: ['platform', 'rooms', gameId, 'open', authEpoch],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      platformApi.listRooms({
        gameId,
        status: 'open',
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: roomModes.length > 0,
  });
  const invitationsQuery = useInfiniteQuery({
    queryKey: ['platform', 'invitations', gameId, authEpoch],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      platformApi.listInvitations({
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 30 * 1000,
  });
  const invitations = useMemo(
    () =>
      invitationsQuery.data?.pages.flatMap((page) =>
        page.items.filter((invitation) => invitation.gameId === gameId),
      ) ?? [],
    [gameId, invitationsQuery.data?.pages],
  );
  const rooms = roomsQuery.data?.pages.flatMap((page) => page.rooms) ?? [];

  const actionError = (error: unknown): void => {
    toast({
      title: t('status.action_error'),
      description: error instanceof Error ? error.message : undefined,
      variant: 'error',
    });
  };

  const createRoomMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (
      input: PlatformLobbyRoomSubmission & {
        requestId: string;
        color?: string;
      },
    ) => {
      const { color, ...submission } = input;
      const modeEntry = catalogEntries.find(
        (entry) =>
          entry.mode.id === submission.modeId &&
          entry.releaseId === submission.releaseId,
      );
      return platformApi.createRoom({
        gameId,
        modeId: submission.modeId,
        ...(modeEntry?.channel
          ? { channel: modeEntry.channel }
          : { releaseId: submission.releaseId }),
        requestId: input.requestId,
        visibility: submission.visibility,
        setup: submission.setup,
        ...(submission.seed ? { seed: submission.seed } : {}),
        ...(submission.name ? { name: submission.name } : {}),
        ...(submission.password ? { password: submission.password } : {}),
        ...(color ? { color } : {}),
      });
    },
    onSuccess: (room, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      roomIntent.current = null;
      setSetupKind(null);
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'rooms', gameId],
      });
      void navigate({
        to: '/platform/rooms/$roomId',
        params: { roomId: room.id },
      });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });

  const createSoloMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (
      input: PlatformLobbySoloSubmission & { requestId: string },
    ) => {
      const modeEntry = catalogEntries.find(
        (entry) =>
          entry.mode.id === input.modeId && entry.releaseId === input.releaseId,
      );
      return platformApi.createSolo({
        gameId,
        modeId: input.modeId,
        ...(modeEntry?.channel
          ? { channel: modeEntry.channel }
          : { releaseId: input.releaseId }),
        requestId: input.requestId,
        setup: input.setup,
        ...(input.seed ? { seed: input.seed } : {}),
      });
    },
    onSuccess: (start, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      soloIntent.current = null;
      if (start.state === 'active') {
        setSetupKind(null);
        void navigate({
          to: '/game/$gameId',
          params: { gameId: start.route.sessionId },
        });
        return;
      }
      setSetupKind(null);
      void navigate({
        to: '/platform/rooms/$roomId',
        params: { roomId: start.roomId },
      });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });

  const acceptInvitationMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (invitation: PlatformRoomInvitation) =>
      platformApi.acceptInvitation(invitation.roomId, invitation.grantId),
    onSuccess: (room, _invitation, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'invitations', gameId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'rooms', gameId],
      });
      if (room.status === 'started' && room.route?.sessionId) {
        void navigate({
          to: '/game/$gameId',
          params: { gameId: room.route.sessionId },
        });
      } else {
        void navigate({
          to: '/platform/rooms/$roomId',
          params: { roomId: room.id },
        });
      }
    },
    onError: (error, _invitation, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });

  const declineInvitationMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (invitation: PlatformRoomInvitation) =>
      platformApi.declineInvitation(invitation.roomId, invitation.grantId),
    onSuccess: (_room, _invitation, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      void queryClient.invalidateQueries({
        queryKey: ['platform', 'invitations', gameId],
      });
    },
    onError: (error, _invitation, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });

  const invitationsLoading =
    invitationsQuery.isPending && !invitationsQuery.isError;
  const roomsLoading =
    roomModes.length > 0 && roomsQuery.isPending && !roomsQuery.isError;
  const invitationsError = invitationsQuery.isError && !invitationsQuery.data;
  const roomsError = roomsQuery.isError && !roomsQuery.data;
  const setupPending =
    setupKind === 'room'
      ? createRoomMutation.isPending
      : createSoloMutation.isPending;

  return (
    <>
      <LobbySurface
        cover={cover}
        roomModes={roomModes}
        soloAvailable={soloMode !== undefined}
        rooms={rooms}
        roomsLoading={roomsLoading}
        roomsError={roomsError}
        roomsUpdateError={roomsQuery.isError && Boolean(roomsQuery.data)}
        roomsRefreshing={
          roomsQuery.isFetching && !roomsQuery.isFetchingNextPage
        }
        roomsHasNextPage={Boolean(roomsQuery.hasNextPage)}
        roomsFetchingNextPage={roomsQuery.isFetchingNextPage}
        invitations={invitations}
        invitationsLoading={invitationsLoading}
        invitationsError={invitationsError}
        invitationsUpdateError={
          invitationsQuery.isError && Boolean(invitationsQuery.data)
        }
        invitationsHasNextPage={Boolean(invitationsQuery.hasNextPage)}
        invitationsFetchingNextPage={invitationsQuery.isFetchingNextPage}
        invitationsActionPending={
          acceptInvitationMutation.isPending ||
          declineInvitationMutation.isPending
        }
        onOpenRoomSetup={() => setSetupKind('room')}
        onOpenSoloSetup={() => setSetupKind('solo')}
        onRetryRooms={() =>
          void (roomsQuery.isFetchNextPageError
            ? roomsQuery.fetchNextPage()
            : roomsQuery.refetch())
        }
        onLoadMoreRooms={() => void roomsQuery.fetchNextPage()}
        onRefreshRooms={() => void roomsQuery.refetch()}
        onRetryInvitations={() =>
          void (invitationsQuery.isFetchNextPageError
            ? invitationsQuery.fetchNextPage()
            : invitationsQuery.refetch())
        }
        onLoadMoreInvitations={() => void invitationsQuery.fetchNextPage()}
        onAcceptInvitation={(invitation) =>
          acceptInvitationMutation.mutate(invitation)
        }
        onDeclineInvitation={(invitation) =>
          declineInvitationMutation.mutate(invitation)
        }
      />
      {setupKind ? (
        <LobbySetupDialog
          open
          kind={setupKind}
          gameId={gameId}
          registration={registration}
          roomModes={roomModes}
          soloMode={soloMode}
          cover={cover}
          isPending={setupPending}
          onOpenChange={(open) => {
            if (!open && !setupPending) {
              roomIntent.current = null;
              soloIntent.current = null;
              setSetupKind(null);
            }
          }}
          onCreateRoom={(input) => {
            const preferredColor =
              registration.capabilities?.playerColorSelection === true
                ? registration.setup.getPreferredPlayerColor?.()
                : undefined;
            const submission = {
              ...input,
              ...(preferredColor ? { color: preferredColor } : {}),
            };
            const key = canonicalStableStringify({
              authEpoch,
              gameId,
              kind: 'room',
              ...submission,
            });
            roomIntent.current = resolvePlatformRequestIntent(
              roomIntent.current,
              key,
            );
            createRoomMutation.mutate({
              ...submission,
              requestId: roomIntent.current.requestId,
            });
          }}
          onCreateSolo={(input) => {
            const key = canonicalStableStringify({
              authEpoch,
              gameId,
              kind: 'solo',
              ...input,
            });
            soloIntent.current = resolvePlatformRequestIntent(
              soloIntent.current,
              key,
            );
            createSoloMutation.mutate({
              ...input,
              requestId: soloIntent.current.requestId,
            });
          }}
        />
      ) : null}
    </>
  );
}
