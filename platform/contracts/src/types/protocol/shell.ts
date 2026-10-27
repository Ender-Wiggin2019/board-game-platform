import type { IBrowserNotificationPayload } from './notifications.js';

/** Counts supplied by one installed game's server-side summary adapter. */
export interface IPlatformGameShellSummary {
  readonly gameId: string;
  readonly gameInvitations: number;
  readonly actionRequired: number;
  readonly waitingReady: number;
}

/** The single account-level snapshot used by the platform shell. */
export interface IPlatformShellSummary {
  readonly notifications: {
    readonly friendRequests: {
      readonly incoming: number;
    };
    readonly gameInvitations: {
      readonly pending: number;
    };
    readonly messages: {
      readonly unread: number;
    };
  };
  readonly games: {
    readonly actionRequired: number;
    readonly waitingReady: number;
  };
  readonly byGame: readonly IPlatformGameShellSummary[];
}

/** Account events delivered through the authenticated platform namespace. */
export type TPlatformNotificationEvent =
  | {
      readonly kind: 'message';
      /** Game adapters may extend their message content discriminant. */
      readonly message: unknown;
    }
  | {
      readonly kind: 'browser';
      readonly notification: IBrowserNotificationPayload;
    }
  | {
      /** A durable account-owned snapshot changed; clients should refetch it. */
      readonly kind: 'shell';
    }
  | {
      readonly kind: 'game';
      readonly gameId: string;
      readonly type: string;
      readonly payload: unknown;
    };
