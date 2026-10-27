import type { SessionRoute } from '@board-game/contracts';

export type NotificationRuntimeOwner = 'legacy' | 'platform';

/** A server-derived notification target. Browser routes are never accepted. */
export interface NotificationTarget {
  readonly runtimeOwner: NotificationRuntimeOwner;
  readonly legacyGameId?: string;
  readonly sessionId?: string;
}

export interface NativeNotificationParticipant {
  readonly principalId: string;
  readonly seatId?: string;
}

export interface NativeNotificationSnapshot {
  readonly target: NotificationTarget;
  readonly route: SessionRoute;
  readonly sessionName?: string | null;
  readonly status:
    | 'suspended'
    | 'active'
    | 'paused'
    | 'completed'
    | 'cancelled';
  readonly participants: readonly NativeNotificationParticipant[];
  readonly actionablePrincipalIds: readonly string[];
  readonly actionKeyByPrincipal?: Readonly<Record<string, string | null>>;
}

export interface NativeNotificationResolver {
  resolve(sessionId: string): Promise<NativeNotificationSnapshot | null>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertNotificationTarget(target: NotificationTarget): void {
  if (!target || typeof target !== 'object')
    throw new Error('NOTIFICATION_TARGET_INVALID');
  if (target.runtimeOwner === 'legacy') {
    if (
      typeof target.legacyGameId !== 'string' ||
      !UUID_PATTERN.test(target.legacyGameId) ||
      target.sessionId !== undefined
    )
      throw new Error('NOTIFICATION_LEGACY_TARGET_INVALID');
    return;
  }
  if (
    target.runtimeOwner !== 'platform' ||
    typeof target.sessionId !== 'string' ||
    target.sessionId.trim().length === 0 ||
    target.sessionId.length > 200 ||
    target.legacyGameId !== undefined
  )
    throw new Error('NOTIFICATION_PLATFORM_TARGET_INVALID');
}

export function notificationTargetKey(target: NotificationTarget): string {
  assertNotificationTarget(target);
  return target.runtimeOwner === 'legacy'
    ? `game:${target.legacyGameId}`
    : `session:${target.sessionId}`;
}

export function legacyNotificationTarget(gameId: string): NotificationTarget {
  const target: NotificationTarget = {
    runtimeOwner: 'legacy',
    legacyGameId: gameId,
  };
  assertNotificationTarget(target);
  return target;
}

export function platformNotificationTarget(
  sessionId: string,
): NotificationTarget {
  const target: NotificationTarget = {
    runtimeOwner: 'platform',
    sessionId,
  };
  assertNotificationTarget(target);
  return target;
}
