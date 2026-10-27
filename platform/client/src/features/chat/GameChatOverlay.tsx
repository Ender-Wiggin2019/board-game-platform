import {
  GAME_CHAT_MAX_BODY_LENGTH,
  type IGameChatMessage,
} from '@board-platform/contracts/types/protocol/gameChat';
import type { ComponentType } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/cn.js';
import type { IUseGameChatResult } from './chatTypes.js';

export interface IChatSenderProps {
  userId: string;
  name: string;
  className?: string;
  gameId?: string;
}
export interface IGameChatOverlayProps {
  chat: IUseGameChatResult;
  sender?: ComponentType<IChatSenderProps>;
  gameId?: string;
  zIndex?: number;
  /**
   * Seat colors as renderable hex, keyed by player id, so a sender's name
   * reads in the same color the board and the event log give them. Senders
   * without a seat (spectators) keep the default instrument blue.
   */
  playerColors?: Record<string, string>;
}

export function GameChatOverlay({
  chat,
  gameId,
  playerColors,
  sender = DefaultChatSender,
  zIndex = 300,
}: IGameChatOverlayProps): React.JSX.Element {
  const { t } = useTranslation('platform-common');
  const { messages, open, unreadCount, setOpen, sendMessage } = chat;
  const canSend = chat?.canSend ?? true;
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: 'smooth',
      });
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }, [messages.length, open]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    sendMessage(body);
    setDraft('');
  };

  const chatTitle = t('client.game_chat.title', { defaultValue: 'Chat' });
  const hasUnread = unreadCount > 0 && !open;
  const launcherLabel = hasUnread
    ? t('client.game_chat.unread_label', {
        count: unreadCount,
        defaultValue: 'Chat — unread messages: {{count}}',
      })
    : chatTitle;

  return (
    <div data-testid='game-chat-root'>
      {/* Docked launcher — a fixed, non-draggable icon control that rides above
          the hand dock. Matches the report-bug control's instrument styling so
          the floating chrome reads as one consistent set. */}
      <button
        type='button'
        aria-expanded={open}
        aria-controls='game-chat-panel'
        aria-label={launcherLabel}
        title={launcherLabel}
        data-state={open ? 'open' : hasUnread ? 'unread' : 'idle'}
        data-testid='game-chat-toggle'
        draggable={false}
        onClick={() => setOpen(!open)}
        style={{
          bottom:
            'calc(var(--game-hand-visible-reserve, var(--game-fixed-bottom-reserve, 0px)) + 1rem + env(safe-area-inset-bottom))',
          zIndex: zIndex,
          boxShadow: hasUnread
            ? '0 0 8px color-mix(in oklab, var(--signal-amber) 55%, transparent), 0 0 22px color-mix(in oklab, var(--signal-amber) 22%, transparent)'
            : undefined,
        }}
        className={cn(
          'fixed right-4 flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--metal-edge)] bg-surface-900/80 text-text-500 shadow-instrument backdrop-blur-sm transition-[bottom,color,background-color,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-surface-800 hover:text-text-100 motion-reduce:transition-none',
          hasUnread &&
            'w-auto min-w-12 gap-1.5 border-signal-amber bg-signal-amber/10 px-2 text-signal-amber-hi hover:bg-signal-amber/20',
          open && 'border-accent-500 bg-accent-500/20 text-text-100',
        )}
      >
        <svg
          xmlns='http://www.w3.org/2000/svg'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          className='h-4 w-4'
          aria-hidden
        >
          <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' />
        </svg>
        {unreadCount > 0 ? (
          <span
            className='min-w-4 rounded-[3px] bg-[var(--signal-amber)] px-1 text-center font-mono text-[10px] font-semibold leading-4 text-background-950'
            data-testid='game-chat-unread'
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <aside
          id='game-chat-panel'
          role='dialog'
          aria-label={t('client.game_chat.dialog_label')}
          aria-modal='false'
          className='fixed right-0 z-[var(--chat-z)] flex w-[min(22rem,100vw)] flex-col overflow-hidden border-l border-[color:var(--metal-edge)] bg-[color-mix(in_oklab,var(--surface-panel)_94%,black)] shadow-[0_18px_48px_oklch(0.04_0.018_260/0.62)] backdrop-blur-md'
          style={{
            top: 'var(--game-floating-top-offset, var(--game-fixed-top-reserve, 0px))',
            // The hand's real footprint, not the fixed layout reserve — on
            // mobile the reserve is only the collapsed rail height, and the
            // panel must stop at the expanded dock's top edge instead of
            // covering the cards and the collapse rail.
            bottom:
              'var(--game-hand-visible-reserve, var(--game-fixed-bottom-reserve, 0px))',
            ['--chat-z' as string]: String(zIndex),
          }}
          data-testid='game-chat-drawer'
        >
          <header
            className='flex h-10 shrink-0 items-center gap-2 border-b border-[color:var(--metal-edge-soft)] bg-[var(--surface-deep)]/84 px-3'
            data-testid='game-chat-header'
            draggable={false}
          >
            <p className='micro-label min-w-0 flex-1 truncate'>
              {t('client.game_chat.title', { defaultValue: 'Chat' })}
            </p>
            <Button
              variant='ghost'
              size='sm'
              className='h-7 px-2 font-mono text-[10px] uppercase tracking-microlabel'
              onClick={() => setOpen(false)}
            >
              {t('client.common.close', { defaultValue: 'Close' })}
            </Button>
          </header>

          <div
            ref={scrollRef}
            className='min-h-0 flex-1 overflow-y-auto px-3 py-2'
            data-testid='game-chat-messages'
          >
            {messages.length === 0 ? (
              <p className='py-6 text-center text-xs italic text-text-500'>
                {t('client.game_chat.empty', { defaultValue: 'No messages.' })}
              </p>
            ) : (
              <ol className='flex flex-col gap-2'>
                {messages.map((message) => (
                  <GameChatMessageRow
                    gameId={gameId}
                    sender={sender}
                    key={message.id}
                    message={message}
                    senderColor={playerColors?.[message.senderUserId]}
                  />
                ))}
              </ol>
            )}
          </div>

          <form
            className='flex shrink-0 gap-2 border-t border-[color:var(--metal-edge-soft)] bg-[var(--surface-deep)]/70 p-2'
            onSubmit={handleSubmit}
          >
            <input
              className='min-w-0 flex-1 rounded-[5px] border border-[color:var(--metal-edge)] bg-[var(--surface-instrument)] px-3 py-2 text-sm text-text-100 outline-none placeholder:text-text-500 focus:border-accent-500'
              data-testid='game-chat-input'
              disabled={!canSend}
              maxLength={GAME_CHAT_MAX_BODY_LENGTH}
              value={draft}
              placeholder={t('client.game_chat.placeholder', {
                defaultValue: canSend
                  ? 'Message'
                  : 'Join the room to send messages',
              })}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              type='submit'
              size='sm'
              data-testid='game-chat-send'
              disabled={!canSend || draft.trim().length === 0}
            >
              {t('client.game_chat.send', { defaultValue: 'Send' })}
            </Button>
          </form>
        </aside>
      ) : null}
    </div>
  );
}

function GameChatMessageRow({
  gameId,
  message,
  senderColor,
  sender: Sender,
}: {
  gameId?: string;
  message: IGameChatMessage;
  senderColor?: string;
  sender: ComponentType<IChatSenderProps>;
}): React.JSX.Element {
  /**
   * The seat color EXACTLY as the board and the event log paint it — no
   * lightening. A name here has to be matchable against the piece on the board
   * at a glance, and any adjustment for contrast shifts the hue enough to read
   * as a different player's color (reported as 颜色和游戏内玩家颜色有色差).
   *
   * Legibility comes from the type instead: the micro-label treatment this panel
   * uses for its own chrome — monospace at 11px with extra letter-spacing — is
   * the least readable combination available, and it had been applied to the one
   * string here that is a person's name. Bold sans at 12px carries the dark
   * seats (purple #801da1, red #c62828, green #219449) on its own, which is what
   * `highlightPlayerNames` has always relied on in the event log.
   */
  const senderStyle = senderColor ? { color: senderColor } : undefined;
  return (
    <li className='rounded-[6px] border border-[color:var(--metal-edge-soft)] bg-[var(--surface-instrument)]/68 px-3 py-2'>
      <div className='flex items-baseline gap-2'>
        {/* Not uppercased: this is a player-chosen name, and forcing case
            misrepresents it (reported as 姓名强制大写). The micro-label
            treatment stays for the surrounding chrome, which is our own copy.
            PlayerNameLink itself skips linking rivals and empty ids. */}
        <span
          className='min-w-0 flex-1 truncate text-[var(--signal-blue-hi)]'
          style={senderStyle}
        >
          {/* The typography rides on the link, not the wrapper: it is the
              element that actually holds the name. */}
          <Sender
            gameId={gameId}
            userId={message.senderUserId}
            name={message.senderName}
            className='font-body text-xs font-semibold'
          />
        </span>
        <time className='shrink-0 font-mono text-[10px] text-text-500'>
          {formatChatTime(message.createdAt)}
        </time>
      </div>
      <p className='mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-text-100'>
        {message.body}
      </p>
    </li>
  );
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function DefaultChatSender({
  gameId,
  userId,
  name,
  className,
}: IChatSenderProps): React.JSX.Element {
  const profilePath = gameId
    ? `/games/${encodeURIComponent(gameId)}/profile`
    : '/platform/profile';
  return (
    <a
      className={className}
      href={`${profilePath}?principalId=${encodeURIComponent(userId)}`}
    >
      {name}
    </a>
  );
}
