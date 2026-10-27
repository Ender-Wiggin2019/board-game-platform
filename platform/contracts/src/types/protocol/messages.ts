export enum EMessageSeverity {
  INFO = 'info',
  SUCCESS = 'success',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

export const MESSAGE_SEVERITIES: readonly EMessageSeverity[] = [
  EMessageSeverity.INFO,
  EMessageSeverity.SUCCESS,
  EMessageSeverity.WARNING,
  EMessageSeverity.CRITICAL,
];

export function isMessageSeverity(value: unknown): value is EMessageSeverity {
  return (
    typeof value === 'string' &&
    (MESSAGE_SEVERITIES as readonly string[]).includes(value)
  );
}

export const MESSAGE_STATUSES = ['unread', 'read', 'all'] as const;
export type TMessageStatus = (typeof MESSAGE_STATUSES)[number];
export const MESSAGE_INBOX_PAGE_SIZE = 100;

export function isMessageStatus(value: unknown): value is TMessageStatus {
  return (
    typeof value === 'string' &&
    (MESSAGE_STATUSES as readonly string[]).includes(value)
  );
}

export type TMessageText =
  | { kind: 'literal'; text: string }
  | {
      kind: 'i18n';
      key: string;
      values?: Record<string, string | number>;
      fallback: string;
    };

/** Base message payload. Games may add their own discriminated content kinds. */
export type TMessageContent = {
  version: 1;
  kind: 'plain';
  /** Registered game source; omitted for platform-wide messages. */
  gameId?: string;
  title: TMessageText;
  body: TMessageText;
  action?: IUserMessageAction;
};

export type TMessageResolutionStatus = 'not-required' | 'pending' | 'resolved';

export function isMessageContent(value: unknown): value is TMessageContent {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'plain') {
    return false;
  }
  return (
    hasOnlyKeys(value, [
      'version',
      'kind',
      'title',
      'body',
      'action',
      'gameId',
    ]) &&
    (value.gameId === undefined ||
      (typeof value.gameId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.gameId))) &&
    isMessageText(value.title) &&
    isMessageText(value.body) &&
    (value.action === undefined || isMessageAction(value.action))
  );
}

export interface IGlobalMessage {
  id: string;
  content: TMessageContent;
  severity: EMessageSeverity;
  createdByUserId: string | null;
  recipientUserId: string | null;
  createdAt: string;
  canMarkRead: boolean;
  resolutionStatus: TMessageResolutionStatus;
}

export interface IUserMessage extends IGlobalMessage {
  readAt: string | null;
  action?: IUserMessageAction;
}

export interface IUserMessageAction {
  label: string;
  href: string;
}

export interface ICreateGlobalMessageRequest {
  title: string;
  body: string;
  severity?: EMessageSeverity;
}

export interface IUnreadMessageCountResponse {
  unreadCount: number;
}

export interface IMarkAllMessagesReadResponse {
  readCount: number;
  skippedCount: number;
}

export interface IGlobalMessageSocketPayload {
  message: IUserMessage;
}

function isMessageText(value: unknown): value is TMessageText {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'literal') {
    return (
      hasOnlyKeys(value, ['kind', 'text']) && typeof value.text === 'string'
    );
  }
  if (value.kind !== 'i18n') return false;
  if (!hasOnlyKeys(value, ['kind', 'key', 'values', 'fallback'])) return false;
  if (
    typeof value.key !== 'string' ||
    value.key.length === 0 ||
    typeof value.fallback !== 'string'
  ) {
    return false;
  }
  if (value.values === undefined) return true;
  if (!isRecord(value.values)) return false;
  return Object.values(value.values).every(
    (entry) => typeof entry === 'string' || typeof entry === 'number',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMessageAction(value: unknown): value is IUserMessageAction {
  if (!isRecord(value) || !hasOnlyKeys(value, ['label', 'href'])) return false;
  return (
    typeof value.label === 'string' &&
    typeof value.href === 'string' &&
    value.href.startsWith('/') &&
    !value.href.startsWith('//') &&
    !value.href.includes('\\')
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
