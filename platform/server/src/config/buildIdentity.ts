import { readFileSync } from 'node:fs';
import { getRuntimeConfig } from './runtimeConfig.js';

const requiredProtocol: Record<string, number> = {};
/** Installed games register the protocol versions that their release must satisfy. */
export function registerBuildProtocol(
  protocol: Readonly<Record<string, number>>,
): void {
  for (const [key, version] of Object.entries(protocol)) {
    if (
      requiredProtocol[key] !== undefined &&
      requiredProtocol[key] !== version
    )
      throw new Error(`Conflicting release protocol: ${key}`);
    if (requiredProtocol[key] !== version) cachedIdentity = undefined;
    requiredProtocol[key] = version;
  }
}

export interface IBuildIdentity {
  readonly commitSha: string;
  readonly version: string;
  readonly definitionsHash: string;
  readonly databaseSchema: string;
  readonly protocol: Readonly<Record<string, number>>;
}

let cachedIdentity: IBuildIdentity | undefined;

export function parseBuildIdentity(value: unknown): IBuildIdentity {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid release manifest');
  const manifest = value as Record<string, unknown>;
  if (
    manifest.manifestVersion !== 1 ||
    typeof manifest.commitSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(manifest.commitSha) ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    typeof manifest.databaseSchema !== 'string' ||
    !/^\d{4}_[a-z0-9_]+$/.test(manifest.databaseSchema) ||
    typeof manifest.definitionsHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.definitionsHash)
  ) {
    throw new Error('Invalid release build identity');
  }
  const protocol = manifest.protocol as Record<string, unknown> | undefined;
  if (
    !protocol ||
    typeof protocol !== 'object' ||
    Array.isArray(protocol) ||
    Object.values(protocol).some(
      (version) => !Number.isSafeInteger(version) || Number(version) < 0,
    ) ||
    Object.entries(requiredProtocol).some(
      ([key, version]) => protocol[key] !== version,
    )
  ) {
    throw new Error('Release protocol contract mismatch');
  }
  return Object.freeze({
    commitSha: manifest.commitSha,
    version: manifest.version,
    definitionsHash: manifest.definitionsHash,
    databaseSchema: manifest.databaseSchema,
    protocol: Object.freeze({ ...protocol }) as Readonly<
      Record<string, number>
    >,
  });
}

/** Load the identity only after runtime validation, before accepting traffic. */
export function getBuildIdentity(): IBuildIdentity {
  if (cachedIdentity) return cachedIdentity;
  if (getRuntimeConfig().nodeEnv !== 'production') {
    return Object.freeze({
      commitSha: '',
      version: 'development',
      definitionsHash: '',
      databaseSchema: 'development',
      protocol: Object.freeze({ ...requiredProtocol }),
    });
  }
  cachedIdentity = parseBuildIdentity(
    JSON.parse(
      readFileSync(
        new URL('../../../../.codex/release-manifest.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  return cachedIdentity;
}
