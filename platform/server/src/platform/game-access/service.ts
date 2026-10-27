import { contractError } from '@board-game/contracts';
import type {
  GameAccessCatalogEntry,
  GameAccessCodeIssue,
  GameAccessCodeSummary,
  GameAccessEntitlementDefinition,
  GameAccessGrantSummary,
  GameAccessRegistration,
} from '@board-platform/contracts';
import {
  type CreateGameAccessCodeRecord,
  type GameAccessCodeRecord,
  type GameAccessGrantRecord,
  type GameAccessStore,
  GameAccessStoreError,
  generateGameAccessCode,
  hashGameAccessCode,
  normalizeGameAccessCode,
} from './store.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    throw contractError('INVALID_REQUEST', `platform.game_access.${field}`);
}

function cloneRegistration(
  registration: GameAccessRegistration,
): GameAccessRegistration {
  return {
    gameId: registration.gameId,
    releaseId: registration.releaseId,
    entitlements: registration.entitlements.map((definition) => ({
      ...definition,
    })),
    ...(registration.requiredEntitlement
      ? { requiredEntitlement: registration.requiredEntitlement }
      : {}),
  };
}

/** Registry for game-owned access policy. No registration means no gate. */
export class GameAccessRegistry {
  private readonly registrations = new Map<string, GameAccessRegistration>();

  register(registration: GameAccessRegistration): void {
    assertIdentifier(registration.gameId, 'game_id');
    assertIdentifier(registration.releaseId, 'release_id');
    if (!Array.isArray(registration.entitlements))
      throw contractError(
        'INVALID_REQUEST',
        'platform.game_access.entitlements',
      );
    const names = new Set<string>();
    for (const definition of registration.entitlements) {
      assertIdentifier(definition.entitlement, 'entitlement');
      if (names.has(definition.entitlement))
        throw contractError(
          'CONFLICT',
          'platform.game_access.entitlement_duplicate',
        );
      names.add(definition.entitlement);
      if (
        definition.label !== undefined &&
        (typeof definition.label !== 'string' || definition.label.length > 256)
      )
        throw contractError('INVALID_REQUEST', 'platform.game_access.label');
      if (
        definition.description !== undefined &&
        (typeof definition.description !== 'string' ||
          definition.description.length > 2_000)
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.game_access.description',
        );
    }
    if (
      registration.requiredEntitlement !== undefined &&
      !names.has(registration.requiredEntitlement)
    )
      throw contractError(
        'INVALID_REQUEST',
        'platform.game_access.required_entitlement',
      );
    const key = this.key(registration.gameId, registration.releaseId);
    if (this.registrations.has(key))
      throw contractError(
        'CONFLICT',
        'platform.game_access.registration_duplicate',
      );
    this.registrations.set(key, cloneRegistration(registration));
  }

  unregister(gameId: string, releaseId: string): void {
    this.registrations.delete(this.key(gameId, releaseId));
  }

  get(gameId: string, releaseId: string): GameAccessRegistration | undefined {
    const registration = this.registrations.get(this.key(gameId, releaseId));
    return registration ? cloneRegistration(registration) : undefined;
  }

  getForGame(gameId: string): GameAccessRegistration | undefined {
    const values = [...this.registrations.values()].filter(
      (registration) => registration.gameId === gameId,
    );
    const latest = values.at(-1);
    return latest ? cloneRegistration(latest) : undefined;
  }

  catalog(): readonly GameAccessCatalogEntry[] {
    return [...this.registrations.values()].map(cloneRegistration);
  }

  private key(gameId: string, releaseId: string): string {
    return JSON.stringify([gameId, releaseId]);
  }
}

export interface CreateGameAccessCodeInput {
  readonly actorId: string;
  readonly gameId: string;
  readonly entitlement: string;
  readonly maxUses?: number;
  readonly expiresAt?: Date;
  readonly now?: Date;
}

export class GameAccessService {
  readonly registry: GameAccessRegistry;

  constructor(
    readonly store: GameAccessStore,
    registry: GameAccessRegistry = new GameAccessRegistry(),
  ) {
    this.registry = registry;
  }

  register(registration: GameAccessRegistration): void {
    this.registry.register(registration);
  }

  unregister(gameId: string, releaseId: string): void {
    this.registry.unregister(gameId, releaseId);
  }

  catalog(): readonly GameAccessCatalogEntry[] {
    return this.registry.catalog();
  }

  async createCode(
    input: CreateGameAccessCodeInput,
  ): Promise<GameAccessCodeIssue> {
    assertIdentifier(input.actorId, 'actor_id');
    const registration = this.registrationForGame(input.gameId);
    const definition = this.entitlement(registration, input.entitlement);
    const maxUses = input.maxUses;
    if (
      maxUses !== undefined &&
      (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)
    )
      throw contractError('INVALID_REQUEST', 'platform.game_access.max_uses');
    const now = input.now ?? new Date();
    if (input.expiresAt !== undefined) {
      if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now)
        throw contractError(
          'INVALID_REQUEST',
          'platform.game_access.expires_at',
        );
    }
    const code = generateGameAccessCode();
    const recordInput: CreateGameAccessCodeRecord = {
      gameId: input.gameId,
      entitlement: definition.entitlement,
      codeHash: hashGameAccessCode(code),
      ...(maxUses === undefined ? {} : { maxUses }),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdBy: input.actorId,
      createdAt: now,
    };
    const record = await this.store.createCode(recordInput);
    return { code, summary: this.codeSummary(record) };
  }

  async listCodes(gameId: string): Promise<readonly GameAccessCodeSummary[]> {
    this.registrationForGame(gameId);
    const records = await this.store.listCodes(gameId);
    return records.map((record) => this.codeSummary(record));
  }

  async revokeCode(
    gameId: string,
    codeId: string,
    now: Date = new Date(),
  ): Promise<GameAccessCodeSummary> {
    this.registrationForGame(gameId);
    assertIdentifier(codeId, 'code_id');
    try {
      return this.codeSummary(await this.store.revokeCode(gameId, codeId, now));
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async redeem(
    gameId: string,
    principalId: string,
    code: string,
  ): Promise<GameAccessGrantSummary> {
    this.registrationForGame(gameId);
    assertIdentifier(principalId, 'principal_id');
    if (
      typeof code !== 'string' ||
      normalizeGameAccessCode(code).length < 8 ||
      normalizeGameAccessCode(code).length > 128
    )
      throw contractError('INVALID_REQUEST', 'platform.game_access.code');
    try {
      const record = await this.store.redeemCode({
        gameId,
        principalId,
        codeHash: hashGameAccessCode(code),
        sourceRecordId: `game-access:redemption:${gameId}:${hashGameAccessCode(code)}:${principalId}`,
      });
      return this.grantSummary(record);
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async grants(
    gameId: string,
    principalId: string,
  ): Promise<readonly GameAccessGrantSummary[]> {
    this.registrationForGame(gameId);
    assertIdentifier(principalId, 'principal_id');
    const grants = await this.store.listGrants(gameId, principalId);
    return grants.map((grant) => this.grantSummary(grant));
  }

  /** Returns true when the registered release has no required entitlement. */
  async allows(
    gameId: string,
    releaseId: string,
    principalId: string,
  ): Promise<boolean> {
    const registration = this.registry.get(gameId, releaseId);
    if (!registration?.requiredEntitlement) return true;
    return this.store.hasEntitlement(
      gameId,
      principalId,
      registration.requiredEntitlement,
    );
  }

  requiredEntitlement(gameId: string, releaseId: string): string | undefined {
    return this.registry.get(gameId, releaseId)?.requiredEntitlement;
  }

  private registrationForGame(gameId: string): GameAccessRegistration {
    assertIdentifier(gameId, 'game_id');
    const registration = this.registry.getForGame(gameId);
    if (!registration)
      throw contractError('NOT_FOUND', 'platform.game_access.game_unavailable');
    return registration;
  }

  private entitlement(
    registration: GameAccessRegistration,
    name: string,
  ): GameAccessEntitlementDefinition {
    assertIdentifier(name, 'entitlement');
    const definition = registration.entitlements.find(
      (candidate) => candidate.entitlement === name,
    );
    if (!definition)
      throw contractError(
        'NOT_FOUND',
        'platform.game_access.entitlement_unavailable',
      );
    return definition;
  }

  private codeSummary(record: GameAccessCodeRecord): GameAccessCodeSummary {
    return {
      codeId: record.codeId,
      gameId: record.gameId,
      entitlement: record.entitlement,
      ...(record.maxUses === undefined ? {} : { maxUses: record.maxUses }),
      usedCount: record.usedCount,
      ...(record.expiresAt
        ? { expiresAt: record.expiresAt.toISOString() }
        : {}),
      ...(record.revokedAt
        ? { revokedAt: record.revokedAt.toISOString() }
        : {}),
      createdBy: record.createdBy,
      createdAt: record.createdAt.toISOString(),
    };
  }

  private grantSummary(record: GameAccessGrantRecord): GameAccessGrantSummary {
    return {
      grantId: record.grantId,
      gameId: record.gameId,
      entitlement: record.entitlement,
      codeId: record.codeId,
      redeemedAt: record.redeemedAt.toISOString(),
    };
  }

  private mapStoreError(error: unknown): never {
    if (!(error instanceof GameAccessStoreError)) throw error;
    const messageKey = {
      CODE_NOT_FOUND: 'platform.game_access.code_not_found',
      CODE_REVOKED: 'platform.game_access.code_revoked',
      CODE_EXPIRED: 'platform.game_access.code_expired',
      CODE_EXHAUSTED: 'platform.game_access.code_exhausted',
    }[error.code];
    throw contractError('CONFLICT', messageKey);
  }
}
