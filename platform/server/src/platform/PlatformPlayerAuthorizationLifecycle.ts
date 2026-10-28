import type { IAccountExtensions } from '../auth/account-extensions.js';
import {
  PlatformPlayerConnections,
  type PlatformPlayerRevokeAccountResult,
} from './PlatformPlayerConnections.js';

export const PLATFORM_PLAYER_AUTHORIZATION_EXTENSION_ID =
  'platform-player-authorization';

export class PlatformPlayerAuthorizationLifecycleError extends Error {
  readonly name = 'PlatformPlayerAuthorizationLifecycleError';
  constructor(readonly report: PlatformPlayerRevokeAccountResult) {
    super('platform.player.authorization_revocation_incomplete');
  }
}

/** Bridges account security lifecycle hooks to every remote game binding. */
export class PlatformPlayerAuthorizationLifecycle {
  constructor(private readonly connections: PlatformPlayerConnections) {}

  extensions(): IAccountExtensions {
    const revoke = async ({ userId }: { readonly userId: string }) => {
      const report = await this.connections.revokeAccount(userId);
      if (report.failures.length > 0)
        throw new PlatformPlayerAuthorizationLifecycleError(report);
    };
    return {
      onSessionRevoked: revoke,
      onLogoutAll: revoke,
      onEmailChanged: revoke,
      onPasswordChanged: revoke,
      onPasswordReset: revoke,
      onAuthorizationChanged: revoke,
    };
  }
}
