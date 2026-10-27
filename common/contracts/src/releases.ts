import {
  assertClientRuntimeManifest,
  CLIENT_RUNTIME_SCHEMA,
  type ClientRuntimeManifest,
} from './client-artifacts.js';
import { contractError } from './errors.js';
import {
  assertMatchesSchema,
  type JsonSchema,
  type SchemaDescriptor,
} from './schema.js';
import type { ModeDefinition } from './types.js';
import { assertModeDefinition } from './validation.js';

export interface ReleaseArtifact {
  readonly artifactId: string;
  readonly digest: string;
}

/** Immutable code/content identity. Deployment bindings and credentials live elsewhere. */
export interface ReleaseManifest {
  readonly manifestVersion: '1.0' | '1.1';
  readonly gameId: string;
  readonly releaseId: string;
  readonly displayVersion: string;
  readonly publisherId: string;
  readonly integration: {
    readonly profile: 'native-module-v1' | 'legacy-service-v1';
    readonly protocolMajor: 1;
    readonly requiredFeatures: readonly string[];
  };
  readonly artifacts: {
    readonly client: ReleaseArtifact;
    readonly server: ReleaseArtifact;
    readonly publicAssets: ReleaseArtifact;
    readonly privateContent?: ReleaseArtifact;
  };
  readonly versions: {
    readonly ruleset: string;
    readonly content: string;
    readonly stateSchema: number;
    readonly viewSchema: number;
    readonly commandSchema: number;
    readonly resultSchema: number;
    readonly eventSchema: number;
  };
  readonly capabilities: {
    readonly minPlayers: number;
    readonly maxPlayers: number;
    readonly features: readonly string[];
  };
  readonly modes: readonly ModeDefinition[];
  readonly presentation: {
    readonly mount: 'platform-route';
    readonly layoutProfile: string;
    readonly locales: readonly string[];
  };
  readonly budgetProfile: string;
  /** Required by manifest 1.1; 1.0 remains the embedded compatibility format. */
  readonly clientRuntime?: ClientRuntimeManifest;
}

const id: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
};
const version: JsonSchema = { type: 'integer', minimum: 1, maximum: 1_000_000 };
const strings: JsonSchema = { type: 'array', items: id, maxItems: 64 };
const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const artifact = object({
  artifactId: id,
  digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
});

export const RELEASE_MANIFEST_SCHEMA: SchemaDescriptor = {
  name: 'platform.release-manifest',
  version: 1,
  maxBytes: 128 * 1024,
  schema: object(
    {
      manifestVersion: { type: 'string', enum: ['1.0', '1.1'] },
      gameId: id,
      releaseId: id,
      displayVersion: id,
      publisherId: id,
      integration: object({
        profile: {
          type: 'string',
          enum: ['native-module-v1', 'legacy-service-v1'],
        },
        protocolMajor: { type: 'integer', minimum: 1, maximum: 1 },
        requiredFeatures: strings,
      }),
      artifacts: object(
        {
          client: artifact,
          server: artifact,
          publicAssets: artifact,
          privateContent: artifact,
        },
        ['client', 'server', 'publicAssets'],
      ),
      versions: object({
        ruleset: id,
        content: id,
        stateSchema: version,
        viewSchema: version,
        commandSchema: version,
        resultSchema: version,
        eventSchema: version,
      }),
      capabilities: object({
        minPlayers: version,
        maxPlayers: version,
        features: strings,
      }),
      modes: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: object({
          id,
          entry: { type: 'string', enum: ['room', 'direct-solo'] },
          minPlayers: version,
          maxPlayers: version,
          history: {
            type: 'string',
            enum: ['summary-and-replay', 'progress-only', 'ephemeral-result'],
          },
          platformRating: { type: 'boolean' },
          concurrency: { type: 'string', enum: ['revision', 'prompt'] },
        }),
      },
      presentation: object({
        mount: { type: 'string', enum: ['platform-route'] },
        layoutProfile: id,
        locales: { type: 'array', minItems: 1, maxItems: 64, items: id },
      }),
      budgetProfile: id,
      clientRuntime: CLIENT_RUNTIME_SCHEMA,
    },
    [
      'manifestVersion',
      'gameId',
      'releaseId',
      'displayVersion',
      'publisherId',
      'integration',
      'artifacts',
      'versions',
      'capabilities',
      'modes',
      'presentation',
      'budgetProfile',
    ],
  ),
};

export function assertReleaseManifest(
  value: unknown,
): asserts value is ReleaseManifest {
  assertMatchesSchema(value, RELEASE_MANIFEST_SCHEMA);
  const manifest = value as unknown as ReleaseManifest;
  if (
    (manifest.manifestVersion === '1.1') !==
    (manifest.clientRuntime !== undefined)
  )
    throw contractError(
      'INVALID_REQUEST',
      'release.client_runtime.version_mismatch',
    );
  if (manifest.clientRuntime)
    assertClientRuntimeManifest(manifest.clientRuntime);
  const { minPlayers, maxPlayers } = manifest.capabilities;
  if (minPlayers > maxPlayers)
    throw contractError('INVALID_REQUEST', 'release.players.invalid');
  const ids = new Set<string>();
  for (const mode of manifest.modes) {
    assertModeDefinition(mode);
    if (
      ids.has(mode.id) ||
      mode.minPlayers < minPlayers ||
      mode.maxPlayers > maxPlayers
    )
      throw contractError(
        'INVALID_REQUEST',
        'release.mode.outside_capabilities',
      );
    ids.add(mode.id);
  }
  for (const values of [
    manifest.capabilities.features,
    manifest.integration.requiredFeatures,
    manifest.presentation.locales,
  ])
    if (new Set(values).size !== values.length)
      throw contractError('INVALID_REQUEST', 'release.capabilities.duplicate');
}

/** A positive whitelist projection; server and private-content identities never reach browsers. */
export function publicReleaseManifest(
  manifest: ReleaseManifest,
  availability: {
    readonly approvedFeatures: readonly string[];
    readonly runtimeFeatures: readonly string[];
    readonly approvedModes: readonly string[];
    readonly runtimeModes: readonly string[];
  },
) {
  assertReleaseManifest(manifest);
  const features = manifest.capabilities.features.filter(
    (feature) =>
      availability.approvedFeatures.includes(feature) &&
      availability.runtimeFeatures.includes(feature),
  );
  const modes = manifest.modes.filter(
    (mode) =>
      availability.approvedModes.includes(mode.id) &&
      availability.runtimeModes.includes(mode.id),
  );
  return structuredClone({
    manifestVersion: manifest.manifestVersion,
    gameId: manifest.gameId,
    releaseId: manifest.releaseId,
    displayVersion: manifest.displayVersion,
    artifacts: {
      client: manifest.artifacts.client,
      publicAssets: manifest.artifacts.publicAssets,
    },
    capabilities: {
      minPlayers: manifest.capabilities.minPlayers,
      maxPlayers: manifest.capabilities.maxPlayers,
      features,
    },
    modes,
    presentation: manifest.presentation,
    ...(manifest.clientRuntime
      ? { clientRuntime: manifest.clientRuntime }
      : {}),
  });
}
