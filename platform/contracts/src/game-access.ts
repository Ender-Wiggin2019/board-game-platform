/** A game-owned entitlement that can be granted by an access code. */
export interface GameAccessEntitlementDefinition {
  readonly entitlement: string;
  readonly label?: string;
  readonly description?: string;
}

/** Immutable access policy registered with one game release. */
export interface GameAccessRegistration {
  readonly gameId: string;
  readonly releaseId: string;
  readonly entitlements: readonly GameAccessEntitlementDefinition[];
  /** When present, room admission requires this entitlement. */
  readonly requiredEntitlement?: string;
}

export interface GameAccessCatalogEntry extends GameAccessRegistration {}

export interface GameAccessCodeSummary {
  readonly codeId: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly maxUses?: number;
  readonly usedCount: number;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface GameAccessCodeIssue {
  readonly code: string;
  readonly summary: GameAccessCodeSummary;
}

export interface GameAccessGrantSummary {
  readonly grantId: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly codeId: string;
  readonly redeemedAt: string;
}
