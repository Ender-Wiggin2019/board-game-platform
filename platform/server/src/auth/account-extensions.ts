import type { INormalizedAccountName } from '@board-platform/contracts/auth/accountRules';
import type { ERole } from '@board-platform/contracts/auth/roles';
import type {
  IAccountProfile,
  IRegisterRequest,
} from '@board-platform/contracts/types/protocol/auth';
import { Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TUserRow } from '@/persistence/schema/users.js';

export const ACCOUNT_EXTENSIONS = Symbol('ACCOUNT_EXTENSIONS');

type MaybePromise<T> = T | Promise<T>;

/**
 * Optional game adapter hooks around the platform account lifecycle.
 *
 * The platform only calls these hooks; it never imports a game service,
 * cosmetic repository, migration service, or socket gateway. An adapter may
 * project its own profile fields and install game-specific preference and
 * onboarding routes while the account/session invariants remain platform-owned.
 */
export interface IAccountExtensions {
  /** Validate game-owned account-name constraints after platform normalization. */
  validateAccountName?: (input: INormalizedAccountName) => void;
  /** Keys owned by this game on the shared preference endpoint. */
  preferenceKeys?: readonly string[];
  /** Persist and validate the game-owned portion of a preference patch. */
  updatePreferences?: (input: {
    userId: string;
    patch: Readonly<Record<string, unknown>>;
  }) => MaybePromise<void>;
  extendProfile?: (input: {
    user: TUserRow;
    role: ERole;
    profile: IAccountProfile;
  }) => MaybePromise<Readonly<Record<string, unknown>>>;
  onAccountRegistered?: (input: {
    transaction: NodePgDatabase;
    user: TUserRow;
    request: IRegisterRequest;
  }) => MaybePromise<void>;
  onNameChanged?: (input: {
    userId: string;
    previousName: string;
    name: string;
  }) => MaybePromise<void>;
  onEmailChanged?: (input: {
    userId: string;
    email: string;
    emailKey: string;
  }) => MaybePromise<void>;
  onPasswordChanged?: (input: { userId: string }) => MaybePromise<void>;
  onPasswordReset?: (input: { userId: string }) => MaybePromise<void>;
  onLogoutAll?: (input: { userId: string }) => MaybePromise<void>;
  onSessionRevoked?: (input: { userId: string }) => MaybePromise<void>;
  onAuthorizationChanged?: (input: { userId: string }) => MaybePromise<void>;
}

export const NO_ACCOUNT_EXTENSIONS: IAccountExtensions = {};

/** Mutable registration point owned by the composition root. */
@Injectable()
export class AccountExtensionsRegistry {
  private readonly adapters = new Map<string, IAccountExtensions>();
  private composed: IAccountExtensions = NO_ACCOUNT_EXTENSIONS;

  public register(gameId: string, extensions: IAccountExtensions): void {
    const normalizedGameId = gameId.trim();
    if (!normalizedGameId)
      throw new Error('Account extension gameId is required');
    if (this.adapters.has(normalizedGameId)) {
      throw new Error(
        `Account extensions already registered for ${normalizedGameId}`,
      );
    }
    this.adapters.set(normalizedGameId, extensions);
    this.composed = composeExtensions(this.adapters);
  }

  public get(): IAccountExtensions {
    return this.composed;
  }

  public getForGame(gameId: string): IAccountExtensions | undefined {
    return this.adapters.get(gameId);
  }

  /**
   * Dispatches only keys explicitly claimed by a game adapter. The return
   * value lets the platform reject unknown fields without knowing any game's
   * preference vocabulary.
   */
  public async updatePreferences(
    userId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<readonly string[]> {
    const remaining = new Set(Object.keys(patch));
    const dispatches: Array<{
      extension: IAccountExtensions;
      patch: Readonly<Record<string, unknown>>;
    }> = [];
    for (const [, extension] of this.adapters) {
      const keys = extension.preferenceKeys ?? [];
      const owned = Object.fromEntries(
        keys
          .filter((key) => key in patch)
          .map((key) => {
            remaining.delete(key);
            return [key, patch[key]] as const;
          }),
      );
      if (Object.keys(owned).length > 0) {
        if (!extension.updatePreferences) {
          throw new Error('Account preference extension handler is missing');
        }
        dispatches.push({ extension, patch: owned });
      }
    }
    if (remaining.size > 0) return [...remaining];
    for (const { extension, patch: owned } of dispatches) {
      await extension.updatePreferences?.({ userId, patch: owned });
    }
    return [];
  }
}

function composeExtensions(
  adapters: ReadonlyMap<string, IAccountExtensions>,
): IAccountExtensions {
  const entries = [...adapters.entries()];
  return {
    validateAccountName: (input) => {
      for (const [, extension] of entries) {
        extension.validateAccountName?.(input);
      }
    },
    extendProfile: async (input) => {
      const projected: Record<string, unknown> = {};
      for (const [gameId, extension] of entries) {
        const fields = await extension.extendProfile?.(input);
        if (!fields) continue;
        for (const [key, value] of Object.entries(fields)) {
          if (key in input.profile || key in projected) {
            throw new Error(
              `Account profile extension field collision: ${gameId}.${key}`,
            );
          }
          projected[key] = value;
        }
      }
      return projected;
    },
    onAccountRegistered: (input) =>
      runLifecycle(entries, 'onAccountRegistered', input),
    onNameChanged: (input) => runLifecycle(entries, 'onNameChanged', input),
    onEmailChanged: (input) => runLifecycle(entries, 'onEmailChanged', input),
    onPasswordChanged: (input) =>
      runLifecycle(entries, 'onPasswordChanged', input),
    onPasswordReset: (input) => runLifecycle(entries, 'onPasswordReset', input),
    onLogoutAll: (input) => runLifecycle(entries, 'onLogoutAll', input),
    onSessionRevoked: (input) =>
      runLifecycle(entries, 'onSessionRevoked', input),
    onAuthorizationChanged: (input) =>
      runLifecycle(entries, 'onAuthorizationChanged', input),
  };
}

async function runLifecycle<
  K extends Exclude<
    keyof IAccountExtensions,
    'preferenceKeys' | 'updatePreferences'
  >,
>(
  entries: readonly (readonly [string, IAccountExtensions])[],
  key: K,
  input: Parameters<NonNullable<IAccountExtensions[K]>>[0],
): Promise<void> {
  for (const [, extension] of entries) {
    const callback = extension[key] as
      | ((value: typeof input) => MaybePromise<void>)
      | undefined;
    await callback?.(input);
  }
}
