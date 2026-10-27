import type {
  ModeDefinition,
  PlatformRoomInvitation,
  PlatformRoomView,
} from '@board-game/contracts';
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformCatalogEntry } from '@/api/platformApi';
import { LoadingSpinner } from '@/components/LoadingSpinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { QueryRefreshNotice } from '../QueryRefreshNotice';

export interface LobbySurfaceProps {
  readonly cover?: string;
  readonly roomModes: readonly PlatformCatalogEntry[];
  readonly soloAvailable: boolean;
  readonly rooms: readonly PlatformRoomView[];
  readonly roomsLoading: boolean;
  readonly roomsError: boolean;
  readonly roomsUpdateError: boolean;
  readonly roomsRefreshing: boolean;
  readonly roomsHasNextPage: boolean;
  readonly roomsFetchingNextPage: boolean;
  readonly invitations: readonly PlatformRoomInvitation[];
  readonly invitationsLoading: boolean;
  readonly invitationsError: boolean;
  readonly invitationsUpdateError: boolean;
  readonly invitationsHasNextPage: boolean;
  readonly invitationsFetchingNextPage: boolean;
  readonly invitationsActionPending: boolean;
  readonly onOpenRoomSetup: () => void;
  readonly onOpenSoloSetup: () => void;
  readonly onRetryRooms: () => void;
  readonly onLoadMoreRooms: () => void;
  readonly onRefreshRooms: () => void;
  readonly onRetryInvitations: () => void;
  readonly onLoadMoreInvitations: () => void;
  readonly onAcceptInvitation: (invitation: PlatformRoomInvitation) => void;
  readonly onDeclineInvitation: (invitation: PlatformRoomInvitation) => void;
}

export function LobbySurface({
  cover,
  roomModes,
  soloAvailable,
  rooms,
  roomsLoading,
  roomsError,
  roomsUpdateError,
  roomsRefreshing,
  roomsHasNextPage,
  roomsFetchingNextPage,
  invitations,
  invitationsLoading,
  invitationsError,
  invitationsUpdateError,
  invitationsHasNextPage,
  invitationsFetchingNextPage,
  invitationsActionPending,
  onOpenRoomSetup,
  onOpenSoloSetup,
  onRetryRooms,
  onLoadMoreRooms,
  onRefreshRooms,
  onRetryInvitations,
  onLoadMoreInvitations,
  onAcceptInvitation,
  onDeclineInvitation,
}: LobbySurfaceProps): React.JSX.Element {
  const { t } = useTranslation('platform');
  const playerCount = rooms.reduce(
    (total, room) => total + room.members.length,
    0,
  );

  return (
    <div
      className='platform-lobby space-y-5'
      data-testid='platform-lobby-surface'
    >
      <section
        className='platform-lobby-action-strip mission-panel relative overflow-hidden px-5 py-5 sm:px-6 sm:py-6'
        data-testid='platform-lobby-actions'
      >
        {cover ? (
          <img
            aria-hidden
            src={cover}
            alt=''
            className='pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20'
          />
        ) : null}
        <div className='relative z-10 flex flex-wrap items-end justify-between gap-5'>
          <div className='max-w-xl space-y-2'>
            <p className='text-sm text-text-400'>
              {t('lobby.action_description', {
                defaultValue: 'Find a table or open one for this game.',
              })}
            </p>
          </div>
          <div className='flex flex-wrap gap-2'>
            {roomModes.length > 0 ? (
              <Button
                type='button'
                size='lg'
                onClick={onOpenRoomSetup}
                data-testid='platform-open-create-room'
              >
                {t('create.create')}
              </Button>
            ) : null}
            {soloAvailable ? (
              <Button
                type='button'
                size='lg'
                variant='ghost'
                onClick={onOpenSoloSetup}
                data-testid='platform-open-solo-setup'
              >
                {t('create.solo')}
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className='grid grid-cols-3 gap-3'
        aria-label={t('lobby.activity', {
          defaultValue: 'Lobby activity',
        })}
        data-testid='platform-lobby-stats'
      >
        <StatTile label={t('rooms.open')} value={rooms.length} signal='blue' />
        <StatTile
          label={t('lobby.players', { defaultValue: 'Players' })}
          value={playerCount}
          signal='green'
        />
        <StatTile
          label={t('catalog.title')}
          value={roomModes.length}
          signal='violet'
        />
      </section>

      {invitationsLoading ||
      invitationsError ||
      invitationsUpdateError ||
      invitations.length > 0 ||
      invitationsHasNextPage ? (
        <RoomInvitationPanel
          invitations={invitations}
          isLoading={invitationsLoading}
          isError={invitationsError}
          updateError={invitationsUpdateError}
          hasNextPage={invitationsHasNextPage}
          isFetchingNextPage={invitationsFetchingNextPage}
          actionPending={invitationsActionPending}
          onRetry={onRetryInvitations}
          onLoadMore={onLoadMoreInvitations}
          onAccept={onAcceptInvitation}
          onDecline={onDeclineInvitation}
        />
      ) : null}

      <section
        className='mission-panel px-4 py-4 sm:px-5 sm:py-5'
        data-testid='platform-room-browser'
      >
        <div className='space-y-4'>
          <div className='flex flex-wrap items-end justify-between gap-3'>
            <div>
              <h2 className='font-display text-lg text-text-100'>
                {t('rooms.title')}
              </h2>
              <p className='mt-1 text-sm text-text-500'>
                {t('lobby.rooms_description', {
                  defaultValue: 'Open tables for this game.',
                })}
              </p>
            </div>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={onRefreshRooms}
              loading={roomsRefreshing}
              loadingLabel={t('rooms.loading')}
            >
              {t('rooms.refresh')}
            </Button>
          </div>

          {roomsUpdateError ? (
            <QueryRefreshNotice
              onRetry={onRetryRooms}
              retrying={roomsRefreshing || roomsFetchingNextPage}
            />
          ) : null}
          {roomsLoading ? (
            <LoadingSpinner variant='block' label={t('rooms.loading')} />
          ) : roomsError ? (
            <StatusCard
              title={t('status.error')}
              actionLabel={t('status.retry')}
              onAction={onRetryRooms}
            />
          ) : rooms.length === 0 ? (
            <p className='rounded-[6px] bg-surface-instrument/70 px-4 py-10 text-center text-sm text-text-500'>
              {t('rooms.empty')}
            </p>
          ) : (
            <div className='platform-lobby-room-grid'>
              {rooms.map((room) => (
                <RoomListItem
                  key={room.id}
                  room={room}
                  mode={
                    roomModes.find((entry) => entry.mode.id === room.modeId)
                      ?.mode
                  }
                />
              ))}
            </div>
          )}

          {roomsHasNextPage ? (
            <div className='flex justify-center border-t border-[color:var(--metal-edge-soft)] pt-4'>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={onLoadMoreRooms}
                loading={roomsFetchingNextPage}
                loadingLabel={t('rooms.loading')}
              >
                {t('rooms.load_more')}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  signal,
}: {
  readonly label: string;
  readonly value: number;
  readonly signal: 'blue' | 'green' | 'violet';
}): React.JSX.Element {
  return (
    <article className='platform-lobby-stat-card' data-signal={signal}>
      <span className='text-xs font-medium text-text-300 sm:text-sm'>
        {label}
      </span>
      <strong className='font-display text-3xl font-black leading-none tabular-nums text-[color:var(--platform-lobby-stat-color)] sm:text-5xl'>
        {value}
      </strong>
    </article>
  );
}

function RoomListItem({
  room,
  mode,
}: {
  readonly room: PlatformRoomView;
  readonly mode?: ModeDefinition;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <article className='platform-lobby-room-card'>
      <div className='min-w-0 space-y-1'>
        <p className='truncate text-sm font-medium text-text-100'>
          {room.name ??
            (mode?.entry === 'room'
              ? t('catalog.room')
              : t('room.unknown_mode'))}
        </p>
        <p className='truncate text-xs text-text-500'>
          {mode ? modeLabel(room.gameId, mode.id, t) : room.modeId}
        </p>
        <p className='text-xs text-text-400'>
          {t('rooms.members', {
            count: room.members.length,
            max:
              room.metadata?.capacity ??
              mode?.maxPlayers ??
              room.members.length,
          })}
        </p>
      </div>
      <div className='flex shrink-0 flex-wrap items-center justify-end gap-2'>
        {room.metadata?.passwordProtected ? (
          <Badge variant='neutral'>{t('room.password_protected')}</Badge>
        ) : null}
        <Badge variant={room.status === 'open' ? 'success' : 'neutral'}>
          {t('rooms.' + room.status)}
        </Badge>
        <Link
          to='/platform/rooms/$roomId'
          params={{ roomId: room.id }}
          className={cn(
            'rounded-[4px] px-2.5 py-1.5 text-xs text-accent-400',
            'hover:bg-accent-500/15 hover:text-text-100',
          )}
        >
          {room.status === 'open' && room.visibility === 'public'
            ? t('rooms.join')
            : t('rooms.open_room')}
        </Link>
      </div>
    </article>
  );
}

function RoomInvitationPanel({
  invitations,
  isLoading,
  isError,
  updateError,
  hasNextPage,
  isFetchingNextPage,
  actionPending,
  onRetry,
  onLoadMore,
  onAccept,
  onDecline,
}: {
  readonly invitations: readonly PlatformRoomInvitation[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly updateError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly actionPending: boolean;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly onAccept: (invitation: PlatformRoomInvitation) => void;
  readonly onDecline: (invitation: PlatformRoomInvitation) => void;
}): React.JSX.Element {
  const { t } = useTranslation('platform');
  return (
    <section
      className='mission-panel px-4 py-4 sm:px-5'
      data-testid='platform-room-invitations'
    >
      <div className='space-y-4'>
        <div>
          <h2 className='font-display text-lg text-text-100'>
            {t('invitations.title')}
          </h2>
          <p className='mt-1 text-sm text-text-500'>
            {t('invitations.description')}
          </p>
        </div>
        {updateError ? (
          <QueryRefreshNotice onRetry={onRetry} retrying={isFetchingNextPage} />
        ) : null}
        {isLoading ? (
          <LoadingSpinner label={t('invitations.loading')} />
        ) : isError ? (
          <StatusCard
            title={t('status.error')}
            actionLabel={t('status.retry')}
            onAction={onRetry}
          />
        ) : invitations.length === 0 ? (
          <p className='text-sm text-text-500'>{t('invitations.empty')}</p>
        ) : (
          <div className='space-y-3'>
            {invitations.map((invitation) => (
              <div
                key={invitation.grantId}
                className='platform-lobby-invitation'
              >
                <div className='min-w-0 space-y-1'>
                  <p className='truncate text-sm font-medium text-text-100'>
                    {invitation.roomName ?? t('rooms.title')}
                  </p>
                  <p className='truncate text-xs text-text-400'>
                    {modeLabel(invitation.gameId, invitation.modeId, t)}
                  </p>
                  <p className='truncate text-xs text-text-500'>
                    {t('invitations.invited_by', {
                      name: invitation.ownerName ?? invitation.ownerId,
                    })}
                    {invitation.reservedSeatId
                      ? ' · ' + t('invitations.reserved_seat')
                      : ''}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  <Button
                    type='button'
                    size='sm'
                    disabled={actionPending}
                    onClick={() => onAccept(invitation)}
                    data-testid={
                      'platform-invitation-accept-' + invitation.grantId
                    }
                  >
                    {t('invitations.accept')}
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    disabled={actionPending}
                    onClick={() => onDecline(invitation)}
                    data-testid={
                      'platform-invitation-decline-' + invitation.grantId
                    }
                  >
                    {t('invitations.decline')}
                  </Button>
                </div>
              </div>
            ))}
            {hasNextPage ? (
              <div className='flex justify-center border-t border-[color:var(--metal-edge-soft)] pt-4'>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={onLoadMore}
                  loading={isFetchingNextPage}
                  loadingLabel={t('invitations.loading')}
                  data-testid='platform-invitations-load-more'
                >
                  {t('invitations.load_more')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {!isLoading && !isError && invitations.length === 0 && hasNextPage ? (
          <div className='flex justify-center border-t border-[color:var(--metal-edge-soft)] pt-4'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={onLoadMore}
              loading={isFetchingNextPage}
              loadingLabel={t('invitations.loading')}
              data-testid='platform-invitations-load-more'
            >
              {t('invitations.load_more')}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function StatusCard({
  title,
  actionLabel,
  onAction,
}: {
  readonly title: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}): React.JSX.Element {
  return (
    <div
      role='alert'
      className='flex flex-wrap items-center justify-between gap-3 rounded-[6px] bg-surface-instrument px-4 py-3 text-sm text-text-400'
    >
      <span>{title}</span>
      {actionLabel && onAction ? (
        <Button type='button' variant='ghost' size='sm' onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function modeLabel(
  gameId: string,
  modeId: string,
  t: TFunction<'platform'>,
): string {
  return t('games.' + gameId + '.modes.' + modeId, {
    defaultValue: t('modes.' + modeId, { defaultValue: modeId }),
  });
}
