import { ERole } from './roles.js';

/**
 * Capabilities owned by the platform account and session boundary.
 *
 * Game adapters may layer their own capability vocabulary over this set, but
 * platform authorization must not depend on a particular game's rules.
 */
export enum ECapability {
  /** Play any registered game through the platform. */
  GAME_PLAY = 'game.play',
  /** Inspect any registered game, including games without membership. */
  GAME_INSPECT_ANY = 'game.inspect.any',
  /** Mutate any registered game through platform maintenance operations. */
  GAME_MODIFY_ANY = 'game.modify.any',
  /** Destructive maintenance such as history rollback or truncation. */
  GAME_ROLLBACK = 'game.rollback',
  ADMIN_ACCESS = 'admin.access',
  /** List and update account roles. */
  USER_MANAGE = 'user.manage',
  /** Grant and revoke Navigator access. Superadmin only. */
  NAVIGATOR_MANAGE = 'navigator.manage',
  /** Navigator membership benefits and identity. */
  NAVIGATOR_BENEFITS = 'navigator.benefits',
  /** Publish platform-wide user-center messages. */
  MESSAGE_PUBLISH = 'message.publish',
  /** Read platform account, session, and operational analytics. */
  ANALYTICS_READ = 'analytics.read',
  /** Manage retained platform history and archives. */
  ARCHIVE_MANAGE = 'archive.manage',
  /** Opt into optional turn notifications; account-security mail is unrestricted. */
  TURN_EMAIL_REMINDERS = 'notifications.turn-email',
}

/** Product access and operator capabilities are mapped explicitly per role. */
const PLAYER_CAPABILITIES = [ECapability.GAME_PLAY] as const;

const NAVIGATOR_CAPABILITIES = [
  ...PLAYER_CAPABILITIES,
  ECapability.NAVIGATOR_BENEFITS,
  ECapability.TURN_EMAIL_REMINDERS,
] as const;

export const ROLE_CAPABILITIES: Record<ERole, readonly ECapability[]> = {
  [ERole.GUEST]: [],
  [ERole.PLAYER]: PLAYER_CAPABILITIES,
  [ERole.NAVIGATOR]: NAVIGATOR_CAPABILITIES,
  [ERole.TESTER]: NAVIGATOR_CAPABILITIES,
  [ERole.ADMIN]: [
    ...NAVIGATOR_CAPABILITIES,
    ECapability.ADMIN_ACCESS,
    ECapability.GAME_INSPECT_ANY,
    ECapability.GAME_MODIFY_ANY,
    ECapability.GAME_ROLLBACK,
    ECapability.USER_MANAGE,
    ECapability.MESSAGE_PUBLISH,
    ECapability.ANALYTICS_READ,
    ECapability.ARCHIVE_MANAGE,
  ],
  [ERole.SUPERADMIN]: Object.values(ECapability),
};

export function can(role: ERole, capability: ECapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function capabilitiesOf(role: ERole): ECapability[] {
  return Object.values(ECapability).filter((capability) =>
    can(role, capability),
  );
}
