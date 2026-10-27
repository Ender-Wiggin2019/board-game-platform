import type { AccessContext, SessionRoute } from './types.js';

/** The only wire version currently accepted by the player credential verifier. */
export const PLAYER_CREDENTIAL_VERSION = 1 as const;

/** A short-lived, game-service audience-bound player authorization. */
export interface PlayerCredentialClaims {
  readonly version: typeof PLAYER_CREDENTIAL_VERSION;
  readonly issuer: string;
  readonly audience: string;
  readonly route: SessionRoute;
  readonly principalId: string;
  readonly seatId?: string;
  readonly scopes: readonly string[];
  readonly authEpoch: string;
  readonly authorizationRevision: number;
  /** Milliseconds since Unix epoch. */
  readonly issuedAt: number;
  /** Milliseconds since Unix epoch. */
  readonly expiresAt: number;
}

export interface AuthorizationVersionKey {
  readonly platformId: string;
  readonly sessionId: string;
  readonly principalId: string;
}

/** Durable platform authorization state checked by an independent game server. */
export interface AuthorizationVersionRecord extends AuthorizationVersionKey {
  readonly route: SessionRoute;
  readonly seatId?: string;
  readonly scopes: readonly string[];
  readonly authEpoch: string;
  readonly authorizationRevision: number;
  readonly revokedAt?: number;
  readonly updatedAt: number;
}

/** An authenticated platform caller must be supplied for every mutation. */
export interface AuthorizationVersionAdvanceInput
  extends AuthorizationVersionKey {
  readonly authenticatedPlatformId: string;
  readonly route: SessionRoute;
  readonly seatId?: string;
  readonly scopes: readonly string[];
  readonly authEpoch: string;
  readonly authorizationRevision: number;
}

export interface AuthorizationVersionRevokeInput
  extends AuthorizationVersionKey {
  readonly authenticatedPlatformId: string;
  readonly authorizationRevision: number;
}

export interface AuthorizationVersionStore {
  /** Production runners must require a durable store; memory is development-only. */
  readonly capabilities?: {
    readonly durable: boolean;
  };
  get(key: AuthorizationVersionKey): Promise<AuthorizationVersionRecord | null>;
  advance(
    input: AuthorizationVersionAdvanceInput,
  ): Promise<AuthorizationVersionRecord>;
  revoke(
    input: AuthorizationVersionRevokeInput,
  ): Promise<AuthorizationVersionRecord>;
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}

/** The verifier returns the common server-side context, never browser input. */
export type PlayerCredentialAccessContext = AccessContext;
