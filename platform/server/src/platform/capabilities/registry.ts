import {
  assertGameServiceStatisticsDescription,
  contractError,
  GAME_CAPABILITIES,
  type GameCapability,
  type GameCatalogEntry,
  type GameMetadata,
} from '@board-game/contracts';
import {
  type GameCapabilityRegistration,
  type GameCatalogReader,
  ratingPolicies,
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function requireId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !ID_PATTERN.test(value)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.invalid',
      false,
      {
        field,
      },
    );
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.invalid',
      false,
      {
        field,
      },
    );
}

function validateMetadata(metadata: GameMetadata): void {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.invalid',
    );
  requireId(metadata.gameId, 'metadata.gameId');
  requireText(metadata.name, 'metadata.name');
  requireText(metadata.description, 'metadata.description');
  requireId(metadata.themeId, 'metadata.themeId');
  if (metadata.coverUrl !== undefined)
    requireText(metadata.coverUrl, 'metadata.coverUrl');
}

function capabilityList(
  capabilities: readonly GameCapability[],
): ReadonlySet<GameCapability> {
  if (!Array.isArray(capabilities) || capabilities.length === 0)
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.capabilities',
    );
  const values = new Set<GameCapability>();
  for (const capability of capabilities) {
    if (!(GAME_CAPABILITIES as readonly string[]).includes(capability))
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.capabilities',
      );
    if (values.has(capability))
      throw contractError(
        'CONFLICT',
        'platform.game.registration.capability_duplicate',
      );
    values.add(capability);
  }
  return values;
}

function validatePolicies(registration: GameCapabilityRegistration): void {
  if (!Array.isArray(registration.policyVersions))
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.policy_versions',
    );
  const keys = new Set<string>();
  for (const policy of registration.policyVersions) {
    if (!policy || typeof policy !== 'object')
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.policy_versions',
      );
    requireText(policy.version, 'policy.version');
    const key = `${policy.kind}:${policy.version}`;
    if (keys.has(key))
      throw contractError(
        'CONFLICT',
        'platform.game.registration.policy_duplicate',
      );
    keys.add(key);
  }
  const has = (kind: string, version: string) => keys.has(`${kind}:${version}`);
  if (
    registration.achievements &&
    !has('achievement', registration.achievements.definitionVersion)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.policy_missing',
    );
  if (
    registration.rewards &&
    !has('reward', registration.rewards.definitionVersion)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.policy_missing',
    );
  if (registration.rating) {
    const policies = ratingPolicies(registration.rating);
    if (policies.length === 0)
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.rating_policy',
      );
    for (const rating of policies) {
      if (
        !has('rating', rating.policyVersion) ||
        !has('progression', rating.progressionPolicyVersion)
      )
        throw contractError(
          'INVALID_REQUEST',
          'platform.game.registration.policy_missing',
        );
    }
  }
}

function validateAssets(registration: GameCapabilityRegistration): void {
  if (!Array.isArray(registration.assets))
    throw contractError('INVALID_REQUEST', 'platform.game.registration.assets');
  const assets = new Set<string>();
  for (const definition of registration.assets) {
    if (!definition || typeof definition !== 'object')
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.assets',
      );
    requireId(definition.asset, 'assets.asset');
    if (definition.kind !== 'currency' && definition.kind !== 'asset')
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.assets',
      );
    if (definition.label !== undefined)
      requireText(definition.label, 'assets.label');
    if (assets.has(definition.asset))
      throw contractError(
        'CONFLICT',
        'platform.game.registration.asset_duplicate',
      );
    assets.add(definition.asset);
  }
}

function validateRegistration(registration: GameCapabilityRegistration): void {
  if (!registration || typeof registration !== 'object')
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.invalid',
    );
  validateMetadata(registration.metadata);
  requireId(registration.releaseId, 'releaseId');
  if (registration.metadata.gameId.length === 0)
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.invalid',
    );
  const capabilities = capabilityList(registration.capabilities);
  validatePolicies(registration);
  validateAssets(registration);

  const requireCapability = (
    capability: GameCapability,
    present: boolean,
  ): void => {
    if (present !== capabilities.has(capability))
      throw contractError(
        'INVALID_REQUEST',
        'platform.game.registration.capability_mismatch',
        false,
        {
          capability,
        },
      );
  };
  requireCapability('achievements', registration.achievements !== undefined);
  requireCapability('rewards', registration.rewards !== undefined);
  requireCapability('rating', registration.rating !== undefined);
  requireCapability('profile', registration.profile !== undefined);
  requireCapability(
    'rankings',
    registration.rankings !== undefined ||
      registration.rating?.readRankings !== undefined,
  );
  if (capabilities.has('wallet') && registration.assets.length === 0)
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.assets_required',
    );
  if (
    registration.rewards &&
    typeof registration.rewards.createAwards !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.reward_policy',
    );
  if (
    registration.achievements &&
    typeof registration.achievements.consume !== 'function' &&
    typeof registration.achievements.read !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.achievement_policy',
    );
  if (
    registration.shellSummary &&
    typeof registration.shellSummary.read !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.shell_summary',
    );
  if (
    registration.sessionAttention &&
    typeof registration.sessionAttention.interpret !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.session_attention',
    );
  if (
    registration.sessionAttention?.roomCapacity &&
    typeof registration.sessionAttention.roomCapacity !== 'function'
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.room_capacity',
    );
  if (registration.statistics?.description !== undefined)
    assertGameServiceStatisticsDescription(registration.statistics.description);
  if (
    registration.statistics?.query !== undefined &&
    registration.statistics.description === undefined
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.statistics_description',
    );
  if (
    capabilities.has('statistics') !==
    (registration.statistics?.query !== undefined)
  )
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.capability_mismatch',
      false,
      { capability: 'statistics' },
    );
  if (registration.wallet && !capabilities.has('wallet'))
    throw contractError(
      'INVALID_REQUEST',
      'platform.game.registration.capability_mismatch',
    );
}

function descriptor(
  registration: GameCapabilityRegistration,
): GameCatalogEntry {
  return {
    metadata: { ...registration.metadata },
    releaseId: registration.releaseId,
    capabilities: [...registration.capabilities],
    policyVersions: registration.policyVersions.map((policy) => ({
      ...policy,
    })),
    assets: registration.assets.map((asset) => ({ ...asset })),
  };
}

function key(gameId: string, releaseId: string): string {
  return JSON.stringify([gameId, releaseId]);
}

/** Composition-root registry for game public capabilities and pinned releases. */
export class GameCapabilityRegistry implements GameCatalogReader {
  private readonly registrations = new Map<
    string,
    GameCapabilityRegistration
  >();

  public register(registration: GameCapabilityRegistration): this {
    validateRegistration(registration);
    const registrationKey = key(
      registration.metadata.gameId,
      registration.releaseId,
    );
    if (this.registrations.has(registrationKey))
      throw contractError('CONFLICT', 'platform.game.registration.duplicate');
    const frozen: GameCapabilityRegistration = {
      ...registration,
      metadata: Object.freeze({ ...registration.metadata }),
      capabilities: Object.freeze([...registration.capabilities]),
      policyVersions: Object.freeze(
        registration.policyVersions.map((policy) =>
          Object.freeze({ ...policy }),
        ),
      ),
      assets: Object.freeze(
        registration.assets.map((asset) => Object.freeze({ ...asset })),
      ),
    };
    this.registrations.set(registrationKey, Object.freeze(frozen));
    return this;
  }

  /** Resolves an exact pinned release; no latest-release fallback is allowed. */
  public resolve(
    gameId: string,
    releaseId: string,
  ): GameCapabilityRegistration {
    requireId(gameId, 'gameId');
    requireId(releaseId, 'releaseId');
    const registration = this.registrations.get(key(gameId, releaseId));
    if (!registration)
      throw contractError('NOT_FOUND', 'platform.game.registration.missing');
    return registration;
  }

  public get(gameId: string, releaseId: string): GameCatalogEntry | null {
    const registration = this.registrations.get(key(gameId, releaseId));
    return registration ? descriptor(registration) : null;
  }

  public list(gameId?: string): readonly GameCatalogEntry[] {
    if (gameId !== undefined) requireId(gameId, 'gameId');
    return [...this.registrations.values()]
      .filter(
        (registration) =>
          gameId === undefined || registration.metadata.gameId === gameId,
      )
      .sort(
        (left, right) =>
          left.metadata.gameId.localeCompare(right.metadata.gameId) ||
          left.releaseId.localeCompare(right.releaseId),
      )
      .map(descriptor);
  }
}
