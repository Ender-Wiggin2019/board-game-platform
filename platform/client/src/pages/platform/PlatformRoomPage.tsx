import { GameSetupOptions } from '@board-game/components';
import type {
  JsonValue,
  PlatformRoom,
  RoomSeatControllerInput,
} from '@board-game/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Bot, Check, Pencil, UserX, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { friendApi } from '@/api/friendApi';
import { createPlatformRequestId, platformApi } from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { useSceneHero } from '@/components/layout/SceneBackground';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { toast } from '@/components/ui/toast';
import { GameChatOverlay } from '@/features/chat/GameChatOverlay';
import { usePlatformRoomChat } from '@/features/chat/usePlatformRoomChat';
import { FRIEND_QUERY_KEYS } from '@/hooks/friendQueryKeys';
import { useResolvedGameClient } from '@/platform/useGameClient';
import { usePlatformConfiguration } from '@/providers/PlatformConfiguration.js';
import { useAuthStore } from '@/stores/authStore';
import { GameClientProviders } from '../../GameClientProviders.js';
import { PlatformRoomSessionPanel } from './PlatformRoomSessionPanel';
import { QueryRefreshNotice } from './QueryRefreshNotice';
import { RoomControllerPanel } from './RoomControllerPanel';

const PLATFORM_ROOM_POLL_INTERVAL_MS = 5_000;

export function PlatformRoomPage(): React.JSX.Element {
  const { t } = useTranslation('platform');
  const { roomId } = useParams({ strict: false }) as { roomId: string };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authEpoch = useAuthStore((state) => state.authEpoch);
  const userId = useAuthStore((state) => state.user?.id);
  const { features } = usePlatformConfiguration();
  useAuthStore((state) => state.user);
  const [draftSetup, setDraftSetup] = useState<JsonValue | null>(null);
  const [roomNameDraft, setRoomNameDraft] = useState('');
  const [isEditingRoomName, setIsEditingRoomName] = useState(false);
  const [joinPassword, setJoinPassword] = useState('');
  const [kickTarget, setKickTarget] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const draftRoomIdRef = useRef(roomId);
  const draftSetupDirtyRef = useRef(false);
  const previousRoomStatusRef = useRef<PlatformRoom['status'] | undefined>(
    undefined,
  );
  const startIntentRef = useRef<{
    readonly authEpoch: number;
    readonly roomId: string;
    readonly revision: number;
    readonly requestId: string;
  } | null>(null);

  const catalogQuery = useQuery({
    queryKey: ['platform', 'catalog', authEpoch],
    queryFn: platformApi.catalog,
    staleTime: 5 * 60 * 1000,
  });
  const roomQuery = useQuery({
    queryKey: ['platform', 'room', roomId, authEpoch],
    queryFn: () => platformApi.getRoom(roomId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'starting') return 1_500;
      if (status === 'open') return PLATFORM_ROOM_POLL_INTERVAL_MS;
      return false;
    },
  });
  const room = roomQuery.data;
  const lobbyHref = room
    ? `/games/${encodeURIComponent(room.gameId)}/lobby`
    : '/';
  const mode = room
    ? catalogQuery.data?.find(
        (entry) =>
          entry.gameId === room.gameId &&
          entry.mode.id === room.modeId &&
          entry.releaseId === room.releaseId,
      )?.mode
    : undefined;
  const resolvedClient = useResolvedGameClient(
    room?.gameId,
    room?.route?.releaseId ?? room?.releaseId,
    room?.route,
  );
  const registration = resolvedClient.registration;
  const preferredColor = registration?.setup.getPreferredPlayerColor?.();
  useSceneHero(
    registration?.theme?.hero ?? null,
    registration?.theme?.footer ?? null,
  );
  const PlayerColorPicker = useMemo(
    () =>
      registration?.setup.playerColorPicker
        ? lazy(registration.setup.playerColorPicker)
        : null,
    [registration],
  );
  const SetupEditor = useMemo(() => {
    const loader = registration?.setup.setupEditor;
    return loader ? lazy(loader) : null;
  }, [registration]);
  const setupOptions = registration?.setup.options ?? [];
  const member = room?.members.find((item) => item.principalId === userId);
  const roomChat = usePlatformRoomChat(
    roomId,
    Boolean(room && member && room.status === 'open'),
  );
  const roomChatPlayerColors = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const candidate of room?.members ?? []) {
      if (candidate.controller === 'bot') continue;
      const color = colorFromMember(candidate);
      if (color) entries.push([candidate.principalId, color]);
    }
    return Object.fromEntries(entries);
  }, [room?.members]);
  const isOwner = room?.ownerId === userId;
  const allReady = Boolean(
    room && room.members.length > 0 && room.members.every((item) => item.ready),
  );
  const memberCount = room?.members.length ?? 0;
  const configuredPlayerCount = room
    ? (registration?.setup.getPlayerCount(room.setup, mode?.minPlayers ?? 2) ??
      mode?.minPlayers ??
      2)
    : 0;
  const setup = draftSetup ?? room?.setup ?? null;

  useEffect(() => {
    if (!room) return;
    if (draftRoomIdRef.current !== roomId) {
      draftRoomIdRef.current = roomId;
      draftSetupDirtyRef.current = false;
      previousRoomStatusRef.current = undefined;
      setDraftSetup(room.setup);
      setRoomNameDraft(room.name ?? '');
      return;
    }
    if (!draftSetupDirtyRef.current) {
      setDraftSetup(room.setup);
    }
    if (!isEditingRoomName) setRoomNameDraft(room.name ?? '');
  }, [isEditingRoomName, room?.revision, roomId]);

  useEffect(() => {
    previousRoomStatusRef.current = undefined;
  }, [roomId]);

  useEffect(() => {
    if (!room) return;
    const previousStatus = previousRoomStatusRef.current;
    previousRoomStatusRef.current = room.status;
    if (
      room.status !== 'started' ||
      (previousStatus !== 'open' && previousStatus !== 'starting') ||
      !room.route?.sessionId
    )
      return;
    void navigate({
      to: '/game/$gameId',
      params: { gameId: room.route.sessionId },
      replace: true,
    });
  }, [navigate, room?.route?.sessionId, room?.status]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({
      queryKey: ['platform', 'room', roomId],
    });
  };

  const actionError = (error: unknown): void => {
    toast({
      title: t('status.action_error'),
      description: error instanceof Error ? error.message : undefined,
      variant: 'error',
    });
  };

  const joinMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (password?: string) =>
      platformApi.joinRoom(roomId, room?.revision, {
        ...(password ? { password } : {}),
        ...(registration?.capabilities?.playerColorSelection && preferredColor
          ? { color: preferredColor }
          : {}),
      }),
    onSuccess: (next, _password, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
    },
    onError: (error, _password, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const leaveMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => platformApi.leaveRoom(roomId, room?.revision ?? 0),
    onSuccess: (_next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      void navigate({ to: lobbyHref });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const readyMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () =>
      platformApi.readyRoom(roomId, room?.revision ?? 0, !member?.ready),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const configureMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => {
      if (!room || !setup) throw new Error('platform.room.unavailable');
      return platformApi.configureRoom(roomId, room.revision, setup);
    },
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      draftSetupDirtyRef.current = false;
      setDraftSetup(next.setup);
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const startMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => {
      const revision = room?.revision ?? 0;
      const existing = startIntentRef.current;
      const intent =
        existing &&
        existing.authEpoch === authEpoch &&
        existing.roomId === roomId &&
        existing.revision === revision
          ? existing
          : {
              authEpoch,
              roomId,
              revision,
              requestId: createPlatformRequestId(),
            };
      startIntentRef.current = intent;
      return platformApi.startRoom(roomId, revision, intent.requestId);
    },
    onSuccess: (start, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      startIntentRef.current = null;
      if (start.state === 'active') {
        void navigate({
          to: '/game/$gameId',
          params: { gameId: start.route.sessionId },
          replace: true,
        });
        return;
      }
      refresh();
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const cancelMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => platformApi.cancelStart(roomId),
    onSuccess: (_next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      refresh();
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const renameMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (name: string) =>
      platformApi.renameRoom(roomId, room?.revision ?? 0, name),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      setRoomNameDraft(next.name ?? '');
      setIsEditingRoomName(false);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'rooms'] });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const deleteMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => platformApi.deleteRoom(roomId, room?.revision ?? 0),
    onSuccess: (_next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      void queryClient.invalidateQueries({ queryKey: ['platform', 'rooms'] });
      void navigate({ to: lobbyHref });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const kickMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (principalId: string) =>
      platformApi.kickRoomMember(roomId, room?.revision ?? 0, principalId),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      setKickTarget(null);
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const addBotMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: () => platformApi.addBot(roomId, room?.revision ?? 0),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'rooms'] });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      if (isStaleRevisionError(error)) {
        void roomQuery.refetch();
        toast({
          title: t('room.stale_revision'),
          variant: 'error',
        });
        return;
      }
      actionError(error);
    },
  });
  const controllerMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (controller: RoomSeatControllerInput) =>
      platformApi.setRoomController(roomId, room?.revision ?? 0, controller),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      void queryClient.invalidateQueries({ queryKey: ['platform', 'rooms'] });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      if (isStaleRevisionError(error)) {
        void roomQuery.refetch();
        toast({
          title: t('room.stale_revision'),
          variant: 'error',
        });
        return;
      }
      actionError(error);
    },
  });
  const inviteMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (input: { principalId: string; seatId?: string }) => {
      if (input.seatId) {
        return platformApi.inviteToRoom(
          roomId,
          room?.revision ?? 0,
          input.principalId,
          input.seatId,
        );
      }
      return platformApi.inviteToRoom(
        roomId,
        room?.revision ?? 0,
        input.principalId,
      );
    },
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
      void queryClient.invalidateQueries({
        queryKey: FRIEND_QUERY_KEYS.friends,
      });
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const revokeInviteMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (principalId: string) =>
      platformApi.revokeRoomInvite(roomId, room?.revision ?? 0, principalId),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });
  const colorMutation = useMutation({
    onMutate: () => authEpoch,
    mutationFn: (color: string) =>
      platformApi.setRoomColor(roomId, room?.revision ?? 0, color),
    onSuccess: (next, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      queryClient.setQueryData(['platform', 'room', roomId, authEpoch], next);
    },
    onError: (error, _input, requestEpoch) => {
      if (requestEpoch !== useAuthStore.getState().authEpoch) return;
      actionError(error);
    },
  });

  const canManageRoom = Boolean(
    room && isOwner && member && room.status === 'open',
  );
  const friendsQuery = useQuery({
    queryKey: FRIEND_QUERY_KEYS.friends,
    queryFn: friendApi.listFriends,
    enabled: canManageRoom,
    staleTime: 10_000,
  });

  const playerCountOptions = useMemo(() => {
    if (!mode) return [];
    return Array.from(
      { length: mode.maxPlayers - mode.minPlayers + 1 },
      (_, index) => mode.minPlayers + index,
    );
  }, [mode]);

  const updateSetup = (next: JsonValue): void => {
    draftSetupDirtyRef.current = true;
    setDraftSetup(next);
  };

  const updatePlayerCount = (count: number): void => {
    if (!setup || !registration) return;
    updateSetup(registration.setup.updatePlayerCount(setup, count));
  };

  if (
    roomQuery.isLoading ||
    catalogQuery.isLoading ||
    resolvedClient.isPending
  ) {
    return <LoadingSpinner variant='block' label={t('status.loading')} />;
  }
  if (roomQuery.isError && isForbiddenError(roomQuery.error)) {
    return (
      <section className='space-y-4'>
        <Link
          to={lobbyHref}
          className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
        >
          {t('room.back')}
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>{t('room.private_access')}</CardTitle>
            <CardDescription>{t('room.password_required')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className='flex flex-wrap items-end gap-2'
              onSubmit={(event) => {
                event.preventDefault();
                joinMutation.mutate(joinPassword.trim() || undefined);
              }}
            >
              <div className='min-w-[12rem] flex-1 space-y-1'>
                <Label htmlFor='platform-private-room-password'>
                  {t('room.password')}
                </Label>
                <Input
                  id='platform-private-room-password'
                  type='password'
                  value={joinPassword}
                  onChange={(event) => setJoinPassword(event.target.value)}
                  placeholder={t('room.password_placeholder')}
                  autoComplete='current-password'
                />
              </div>
              <Button
                type='submit'
                loading={joinMutation.isPending}
                loadingLabel={t('room.joining')}
              >
                {t('room.password_join')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>
    );
  }
  if (
    (roomQuery.isError && !roomQuery.data) ||
    (catalogQuery.isError && !catalogQuery.data) ||
    !room
  ) {
    return (
      <section className='space-y-4'>
        <Link
          to={lobbyHref}
          className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
        >
          {t('room.back')}
        </Link>
        <Card>
          <CardContent className='pt-5'>
            <p role='alert' className='text-sm text-text-400'>
              {t('status.error')}
            </p>
            <Button
              variant='ghost'
              size='sm'
              className='mt-4'
              onClick={() => void roomQuery.refetch()}
            >
              {t('status.retry')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }
  if (resolvedClient.isError || resolvedClient.isUnavailable) {
    return (
      <section className='space-y-4'>
        <Link
          to={lobbyHref}
          className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
        >
          {t('room.back')}
        </Link>
        <Card>
          <CardContent className='space-y-3 pt-5'>
            <p role='alert' className='text-sm text-text-400'>
              {t('room.client_unavailable', {
                defaultValue:
                  'This game release is not available in this client.',
              })}
            </p>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => void resolvedClient.refetch()}
            >
              {t('status.retry')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }
  if (!registration || !mode) {
    return (
      <section className='space-y-4'>
        <Link
          to={lobbyHref}
          className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
        >
          {t('room.back')}
        </Link>
        <Card>
          <CardContent className='space-y-3 pt-5'>
            <p role='alert' className='text-sm text-text-400'>
              {t('room.client_unavailable', {
                defaultValue: 'This game is not available in this client.',
              })}
            </p>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                void catalogQuery.refetch();
                void resolvedClient.refetch();
              }}
            >
              {t('status.retry')}
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  const canJoin =
    !member && room.visibility === 'public' && room.status === 'open';
  const canLeave = Boolean(member && !isOwner && room.status === 'open');
  const canReady = Boolean(member && room.status === 'open');
  const canConfigure = Boolean(
    isOwner && room.status === 'open' && mode?.entry === 'room',
  );
  const canStart = Boolean(
    isOwner &&
      room.status === 'open' &&
      allReady &&
      memberCount === configuredPlayerCount &&
      memberCount >= (mode?.minPlayers ?? 2),
  );
  const sessionPanelRoute =
    room.status === 'started' &&
    member &&
    registration.capabilities?.sessionControls === true
      ? (room.route ?? null)
      : null;
  const isStarting = room.status === 'starting';
  const roomName = room.name?.trim() || t('room.title');
  const roomPasswordProtected = room.metadata?.passwordProtected === true;
  const roomCapacity =
    room.metadata?.capacity ?? mode?.maxPlayers ?? memberCount;
  const reservations = room.metadata?.reservations ?? [];
  const reservedSeatCount = reservations.filter(
    (reservation) => reservation.state === 'pending' && reservation.seatId,
  ).length;
  const hasOpenSeat = memberCount + reservedSeatCount < roomCapacity;
  const canAddBot = Boolean(
    canManageRoom &&
      room.metadata?.controllers === undefined &&
      room.metadata?.botsAllowed === true &&
      hasOpenSeat,
  );
  const canAddController = Boolean(
    canManageRoom &&
      mode.platformRating !== true &&
      room.metadata?.controllers !== undefined &&
      hasOpenSeat,
  );
  const kickTargetMember = kickTarget
    ? room.members.find((item) => item.principalId === kickTarget)
    : undefined;
  const kickTargetIsBot = kickTargetMember?.controller === 'bot';
  const inviteCandidates = (friendsQuery.data?.items ?? []).filter(
    (friend) =>
      !room.members.some((item) => item.principalId === friend.id) &&
      !reservations.some(
        (reservation) => reservation.principalId === friend.id,
      ),
  );
  const selectedColor = member ? colorFromMember(member) : undefined;
  const disabledColors = room.members
    .filter((item) => item.controller !== 'bot' && item.principalId !== userId)
    .map(colorFromMember)
    .filter((color): color is string => color !== undefined);

  const reservationSeatId = (): string => {
    const occupied = new Set([
      ...room.members.map((item) => item.seatId),
      ...reservations.flatMap((reservation) =>
        reservation.seatId ? [reservation.seatId] : [],
      ),
    ]);
    for (let index = 1; index <= roomCapacity; index += 1) {
      const candidate = `platform:${room.id}:seat:${index}`;
      if (!occupied.has(candidate)) return candidate;
    }
    return `platform:${room.id}:reserved:${reservations.length + 1}`;
  };

  const submitRoomName = (): void => {
    const name = roomNameDraft.trim();
    if (!name || name === (room.name ?? '').trim()) {
      setRoomNameDraft(room.name ?? '');
      setIsEditingRoomName(false);
      return;
    }
    renameMutation.mutate(name);
  };

  const themeStyle = {
    ...registration.theme?.tokens,
    ...(registration.palette?.accent
      ? { '--game-palette-accent': registration.palette.accent }
      : {}),
  } as React.CSSProperties;

  return (
    <section
      className='space-y-6'
      data-testid='platform-room-page'
      data-game-theme={registration.theme?.dataTheme}
      data-game-theme-scope={registration.theme?.scope}
      style={themeStyle}
    >
      {roomQuery.isError || catalogQuery.isError ? (
        <QueryRefreshNotice
          onRetry={() => {
            if (roomQuery.isError) void roomQuery.refetch();
            if (catalogQuery.isError) void catalogQuery.refetch();
          }}
          retrying={roomQuery.isFetching || catalogQuery.isFetching}
        />
      ) : null}
      {sessionPanelRoute ? (
        <PlatformRoomSessionPanel route={sessionPanelRoute} />
      ) : null}
      <header className='flex flex-wrap items-start justify-between gap-4'>
        <div className='space-y-2'>
          <Link
            to={lobbyHref}
            className='text-xs text-text-500 underline-offset-4 hover:text-text-100 hover:underline'
          >
            {t('room.back')}
          </Link>
          <div className='flex flex-wrap items-center gap-2'>
            {isEditingRoomName && isOwner ? (
              <>
                <Input
                  value={roomNameDraft}
                  maxLength={80}
                  autoFocus
                  aria-label={t('room.rename')}
                  onChange={(event) => setRoomNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submitRoomName();
                    }
                    if (event.key === 'Escape') {
                      setRoomNameDraft(room.name ?? '');
                      setIsEditingRoomName(false);
                    }
                  }}
                />
                <Button
                  variant='ghost'
                  size='iconSm'
                  aria-label={t('room.rename_save')}
                  onClick={submitRoomName}
                  loading={renameMutation.isPending}
                >
                  <Check size={14} aria-hidden />
                </Button>
                <Button
                  variant='ghost'
                  size='iconSm'
                  aria-label={t('room.rename_cancel')}
                  onClick={() => {
                    setRoomNameDraft(room.name ?? '');
                    setIsEditingRoomName(false);
                  }}
                  disabled={renameMutation.isPending}
                >
                  <X size={14} aria-hidden />
                </Button>
              </>
            ) : (
              <>
                <h1 className='font-display text-2xl text-text-100'>
                  {roomName}
                </h1>
                {isOwner && room.status === 'open' ? (
                  <Button
                    variant='ghost'
                    size='iconSm'
                    aria-label={t('room.rename')}
                    onClick={() => {
                      setRoomNameDraft(room.name ?? '');
                      setIsEditingRoomName(true);
                    }}
                  >
                    <Pencil size={14} aria-hidden />
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <p className='text-sm text-text-500'>
            {mode?.entry === 'room'
              ? t('catalog.room')
              : t('room.unknown_mode')}
          </p>
          {room.seed ? (
            <p className='break-all text-sm text-text-500'>
              {t('create.seed_confirm_value', { seed: room.seed })}
            </p>
          ) : null}
          {roomPasswordProtected ? (
            <Badge variant='neutral'>{t('room.password_protected')}</Badge>
          ) : null}
        </div>
        <div className='flex items-center gap-3'>
          {room.status === 'started' && room.route?.sessionId ? (
            <Link
              to='/game/$gameId'
              params={{ gameId: room.route.sessionId }}
              className='text-sm text-accent-400 underline-offset-4 hover:text-text-100 hover:underline'
            >
              {t('room.enter_game')}
            </Link>
          ) : null}
          <Badge variant={room.status === 'open' ? 'success' : 'warning'}>
            {t(`rooms.${room.status}`)}
          </Badge>
        </div>
      </header>

      <div className='grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]'>
        <Card>
          <CardHeader>
            <CardTitle>{t('room.members')}</CardTitle>
            <CardDescription>
              {t('rooms.members', {
                count: memberCount,
                max: roomCapacity,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-2'>
            {room.members.map((item) => {
              const isBot = item.controller === 'bot';
              const displayName =
                item.publicProfile?.displayName ?? item.principalId;
              const color = isBot ? undefined : colorFromMember(item);
              const canKick =
                canManageRoom && item.principalId !== room.ownerId;
              const removeLabel = isBot ? t('room.remove_bot') : t('room.kick');
              return (
                <div
                  key={item.principalId}
                  className='flex items-center justify-between gap-3 rounded-[5px] bg-surface-instrument px-3 py-2'
                >
                  <div className='flex min-w-0 items-center gap-2'>
                    {color ? (
                      <span
                        className='h-3 w-3 shrink-0 rounded-full border border-[color:var(--metal-edge-soft)]'
                        style={{ backgroundColor: color }}
                        aria-label={color}
                      />
                    ) : null}
                    <div className='min-w-0'>
                      <p className='flex items-center gap-1 truncate text-sm text-text-100'>
                        {isBot ? <Bot size={14} aria-hidden /> : null}
                        <span className='truncate'>{displayName}</span>
                      </p>
                      {item.principalId === room.ownerId ? (
                        <p className='text-xs text-text-500'>
                          {t('room.owner')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className='flex shrink-0 items-center gap-2'>
                    {isBot ? (
                      <Badge variant='neutral'>
                        <Bot size={13} aria-hidden />
                        {t('room.bot')}
                      </Badge>
                    ) : (
                      <Badge variant={item.ready ? 'success' : 'neutral'}>
                        {item.ready ? t('room.ready') : t('room.not_ready')}
                      </Badge>
                    )}
                    {canKick ? (
                      <Button
                        variant='ghost'
                        size='iconSm'
                        aria-label={`${removeLabel} ${displayName}`}
                        title={removeLabel}
                        onClick={() => setKickTarget(item.principalId)}
                      >
                        <UserX size={14} aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {member &&
            registration.capabilities?.playerColorSelection &&
            PlayerColorPicker ? (
              <div className='space-y-2 border-t border-[color:var(--metal-edge-soft)] pt-3'>
                <Label>{t('room.color')}</Label>
                <Suspense fallback={null}>
                  <GameClientProviders registration={registration}>
                    <PlayerColorPicker
                      selected={selectedColor}
                      disabledColors={disabledColors}
                      disabled={
                        colorMutation.isPending || room.status !== 'open'
                      }
                      onSelect={(color) => colorMutation.mutate(color)}
                    />
                  </GameClientProviders>
                </Suspense>
              </div>
            ) : null}
          </CardContent>
          <CardFooter className='flex-wrap'>
            {canJoin ? (
              roomPasswordProtected ? (
                <form
                  className='flex w-full flex-wrap items-end gap-2'
                  onSubmit={(event) => {
                    event.preventDefault();
                    const password = joinPassword.trim();
                    if (!password) return;
                    joinMutation.mutate(password);
                  }}
                >
                  <div className='min-w-[12rem] flex-1 space-y-1'>
                    <Label htmlFor='platform-room-join-password'>
                      {t('room.password')}
                    </Label>
                    <Input
                      id='platform-room-join-password'
                      type='password'
                      value={joinPassword}
                      onChange={(event) => setJoinPassword(event.target.value)}
                      placeholder={t('room.password_placeholder')}
                      autoComplete='current-password'
                    />
                  </div>
                  <Button
                    type='submit'
                    loading={joinMutation.isPending}
                    loadingLabel={t('room.joining')}
                    disabled={!joinPassword.trim()}
                  >
                    {t('room.password_join')}
                  </Button>
                </form>
              ) : (
                <Button
                  onClick={() => joinMutation.mutate(undefined)}
                  loading={joinMutation.isPending}
                  loadingLabel={t('room.joining')}
                >
                  {t('room.join')}
                </Button>
              )
            ) : null}
            {canReady ? (
              <Button
                variant='ghost'
                onClick={() => readyMutation.mutate()}
                loading={readyMutation.isPending}
                loadingLabel={t('room.ready_action')}
              >
                {member?.ready
                  ? t('room.not_ready_action')
                  : t('room.ready_action')}
              </Button>
            ) : null}
            {canLeave ? (
              <Button
                variant='ghost'
                onClick={() => leaveMutation.mutate()}
                loading={leaveMutation.isPending}
                loadingLabel={t('room.leaving')}
              >
                {t('room.leave')}
              </Button>
            ) : null}
            {canAddBot ? (
              <Button
                variant='ghost'
                onClick={() => addBotMutation.mutate()}
                loading={addBotMutation.isPending}
                loadingLabel={t('room.adding_bot')}
              >
                {t('room.add_bot')}
              </Button>
            ) : null}
          </CardFooter>
        </Card>

        <div className='space-y-5'>
          {canAddController && room.metadata.controllers ? (
            <RoomControllerPanel
              capabilities={room.metadata.controllers}
              disabled={room.status !== 'open'}
              loading={controllerMutation.isPending}
              onSave={(controller) => controllerMutation.mutate(controller)}
            />
          ) : null}
          {setup ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('room.configure')}</CardTitle>
              </CardHeader>
              <CardContent className='space-y-4'>
                {setupOptions.length > 0 ? (
                  <GameClientProviders registration={registration}>
                    <GameSetupOptions
                      options={setupOptions}
                      legendLabel={t('room.configure')}
                      setup={setup}
                      readOnly={!canConfigure}
                      disabled={configureMutation.isPending}
                      onChange={updateSetup}
                      translate={(key) =>
                        t(key, {
                          defaultValue: key,
                        })
                      }
                    />
                  </GameClientProviders>
                ) : null}
                {SetupEditor ? (
                  <Suspense
                    fallback={<LoadingSpinner label={t('status.loading')} />}
                  >
                    <GameClientProviders registration={registration}>
                      <SetupEditor
                        setup={setup}
                        mode={mode}
                        readOnly={!canConfigure}
                        disabled={configureMutation.isPending}
                        onChange={updateSetup}
                      />
                    </GameClientProviders>
                  </Suspense>
                ) : setupOptions.length === 0 ? (
                  <p className='text-sm text-text-500'>
                    {t('room.setup_unavailable', {
                      defaultValue:
                        'Game setup is not available in this client.',
                    })}
                  </p>
                ) : null}
                {canConfigure ? (
                  <div className='space-y-2'>
                    <Label htmlFor='platform-room-config-player-count'>
                      {t('room.player_count')}
                    </Label>
                    <select
                      id='platform-room-config-player-count'
                      value={registration.setup.getPlayerCount(
                        setup,
                        mode.minPlayers,
                      )}
                      onChange={(event) =>
                        updatePlayerCount(Number(event.target.value))
                      }
                      className='h-10 w-full rounded-[5px] border border-[color:var(--metal-edge-soft)] bg-surface-instrument px-3 text-sm text-text-100 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/40'
                    >
                      {playerCountOptions.map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </CardContent>
              {canConfigure ? (
                <CardFooter>
                  <Button
                    variant='ghost'
                    onClick={() => configureMutation.mutate()}
                    loading={configureMutation.isPending}
                    loadingLabel={t('room.saving')}
                  >
                    {t('room.save')}
                  </Button>
                </CardFooter>
              ) : null}
            </Card>
          ) : null}

          {canManageRoom ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('room.invites')}</CardTitle>
                <CardDescription>
                  {t('room.invite_description')}
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-3'>
                {friendsQuery.isLoading ? (
                  <p className='text-sm text-text-500'>{t('status.loading')}</p>
                ) : friendsQuery.isError ? (
                  <div className='space-y-2'>
                    <p className='text-sm text-text-500'>{t('status.error')}</p>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={() => void friendsQuery.refetch()}
                    >
                      {t('status.retry')}
                    </Button>
                  </div>
                ) : inviteCandidates.length === 0 ? (
                  <p className='text-sm text-text-500'>
                    {t('room.no_friends')}
                  </p>
                ) : (
                  <div className='space-y-2'>
                    {inviteCandidates.map((friend) => (
                      <div
                        key={friend.id}
                        className='flex flex-wrap items-center justify-between gap-2 rounded-[5px] bg-surface-instrument px-3 py-2'
                      >
                        <span className='text-sm text-text-100'>
                          {friend.name}
                        </span>
                        <div className='flex flex-wrap gap-2'>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() =>
                              inviteMutation.mutate({ principalId: friend.id })
                            }
                            loading={inviteMutation.isPending}
                          >
                            {t('room.invite')}
                          </Button>
                          {hasOpenSeat ? (
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={() =>
                                inviteMutation.mutate({
                                  principalId: friend.id,
                                  seatId: reservationSeatId(),
                                })
                              }
                              loading={inviteMutation.isPending}
                            >
                              {t('room.reserve')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {reservations.length > 0 ? (
                  <div className='space-y-2 border-t border-[color:var(--metal-edge-soft)] pt-3'>
                    {reservations.map((reservation) => {
                      const friend = friendsQuery.data?.items.find(
                        (candidate) => candidate.id === reservation.principalId,
                      );
                      return (
                        <div
                          key={reservation.grantId}
                          className='flex flex-wrap items-center justify-between gap-2 text-sm'
                        >
                          <span className='text-text-300'>
                            {friend?.name ?? reservation.principalId}
                            <span className='ml-2 text-xs text-text-500'>
                              {reservation.seatId
                                ? t('room.reserved')
                                : t('room.invited')}
                            </span>
                          </span>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() =>
                              revokeInviteMutation.mutate(
                                reservation.principalId,
                              )
                            }
                            loading={revokeInviteMutation.isPending}
                          >
                            {t('room.revoke')}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardContent className='space-y-3 pt-5'>
              {isStarting ? (
                <p className='text-sm text-text-400'>{t('room.launching')}</p>
              ) : null}
              {!isStarting && !allReady ? (
                <p className='text-sm text-text-400'>{t('room.waiting')}</p>
              ) : null}
              {canStart ? (
                <Button
                  className='w-full'
                  onClick={() => startMutation.mutate()}
                  loading={startMutation.isPending}
                  loadingLabel={t('room.starting')}
                >
                  {t('room.start')}
                </Button>
              ) : null}
              {isStarting && isOwner ? (
                <Button
                  variant='ghost'
                  className='w-full'
                  onClick={() => cancelMutation.mutate()}
                  loading={cancelMutation.isPending}
                  loadingLabel={t('room.cancelling')}
                >
                  {t('room.cancel_start')}
                </Button>
              ) : null}
              {isOwner && room.status === 'open' ? (
                <Button
                  variant='danger'
                  className='w-full'
                  onClick={() => setDeleteConfirmOpen(true)}
                  loading={deleteMutation.isPending}
                  loadingLabel={t('room.deleting')}
                >
                  {t('room.delete')}
                </Button>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
      {features.chat ? (
        <GameChatOverlay
          chat={roomChat}
          gameId={room?.gameId}
          playerColors={roomChatPlayerColors}
        />
      ) : null}
      <Dialog
        open={kickTarget !== null}
        onOpenChange={(open) => {
          if (!open && !kickMutation.isPending) setKickTarget(null);
        }}
        dismissible={!kickMutation.isPending}
        ariaLabel={
          kickTargetIsBot
            ? t('room.remove_bot_confirm')
            : t('room.kick_confirm')
        }
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {kickTargetIsBot
                ? t('room.remove_bot_confirm')
                : t('room.kick_confirm')}
            </DialogTitle>
            <DialogDescription>
              {kickTargetIsBot
                ? t('room.remove_bot_description')
                : t('room.kick_description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='ghost'
              onClick={() => setKickTarget(null)}
              disabled={kickMutation.isPending}
            >
              {t('status.cancel')}
            </Button>
            <Button
              variant='danger'
              loading={kickMutation.isPending}
              onClick={() => {
                if (kickTarget) kickMutation.mutate(kickTarget);
              }}
            >
              {kickTargetIsBot ? t('room.remove_bot') : t('room.kick')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleteConfirmOpen(false);
        }}
        dismissible={!deleteMutation.isPending}
        ariaLabel={t('room.delete_confirm')}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('room.delete_confirm')}</DialogTitle>
            <DialogDescription>
              {t('room.delete_description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='ghost'
              onClick={() => setDeleteConfirmOpen(false)}
              disabled={deleteMutation.isPending}
            >
              {t('room.rename_cancel')}
            </Button>
            <Button
              variant='danger'
              loading={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {t('room.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function colorFromMember(
  member: PlatformRoom['members'][number],
): string | undefined {
  const appearance = member.publicProfile?.appearance;
  if (
    appearance === null ||
    appearance === undefined ||
    typeof appearance !== 'object' ||
    Array.isArray(appearance)
  ) {
    return undefined;
  }
  const color = (appearance as Record<string, unknown>).color;
  return typeof color === 'string' ? color : undefined;
}

function isForbiddenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  return candidate.status === 403 || candidate.response?.status === 403;
}

function isStaleRevisionError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return false;
  }
  const candidate = error as {
    responseCode?: unknown;
    response?: { data?: unknown };
  };
  if (candidate.responseCode === 'STALE_REVISION') return true;
  const data = candidate.response?.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).code === 'STALE_REVISION'
  );
}
