import { resolve } from 'node:path';
import type { TrustedSourceIdentity } from '@board-game/core';
import {
  type PlatformInstallation,
  readPlatformInstallation,
  validateLocalReleaseReferences,
} from '@board-platform/cli/config';

export interface StandalonePlatformConfig {
  readonly installation: PlatformInstallation;
  readonly platformId: string;
  readonly databaseUrl: string;
  readonly configPath: string;
  readonly lockPath: string;
  readonly workspaceRoot: string;
  readonly allowInsecureLocalhost: boolean;
  /** Explicit platform signing key used only to mint short-lived player tokens. */
  readonly playerCredentialPrivateKey?: string;
  readonly playerCredentialAudience?: string;
  readonly playerCredentialTtlMs?: number;
  readonly playerApprovedGameScopes?: readonly string[];
  /** Explicit fact ingress token and its one binding identity. */
  readonly factIngressToken?: string;
  readonly factIngressSource?: TrustedSourceIdentity;
  /** Secret references for every approved binding; values are never persisted. */
  readonly factIngressCredentials?: readonly {
    readonly tokenRef: string;
    readonly source: TrustedSourceIdentity;
  }[];
  readonly factIngressHost?: string;
  readonly factIngressPort?: number;
}

const DEFAULT_CONFIG_PATH = 'platform.config.json';
const DEFAULT_LOCK_PATH = 'games.lock.json';

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  message = `${name} is required`,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

function postgresUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PLATFORM_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
    throw new Error('PLATFORM_DATABASE_URL must be a valid PostgreSQL URL');
  return value;
}

function booleanEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return false;
  if (value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  throw new Error(`${name} must be true or false`);
}

function optionalString(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function optionalPort(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = optionalString(env, name);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} must be an integer between 1 and 65535`);
  return port;
}

function optionalTtl(env: NodeJS.ProcessEnv): number | undefined {
  const value = optionalString(env, 'PLATFORM_PLAYER_CREDENTIAL_TTL_MS');
  if (value === undefined) return undefined;
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 5 * 60 * 1_000)
    throw new Error(
      'PLATFORM_PLAYER_CREDENTIAL_TTL_MS must be between 1 and 300000',
    );
  return ttl;
}

function optionalScopes(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  const value = optionalString(env, 'PLATFORM_PLAYER_GAME_SCOPES');
  if (value === undefined) return undefined;
  const scopes = value
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length)
    throw new Error('PLATFORM_PLAYER_GAME_SCOPES must contain unique scopes');
  return scopes;
}

function optionalFactSource(
  env: NodeJS.ProcessEnv,
): TrustedSourceIdentity | undefined {
  const values = [
    'PLATFORM_FACT_SOURCE_GAME_ID',
    'PLATFORM_FACT_SOURCE_RELEASE_ID',
    'PLATFORM_FACT_SOURCE_BINDING_ID',
    'PLATFORM_FACT_SOURCE_OWNERSHIP_EPOCH',
  ].map((name) => optionalString(env, name));
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined))
    throw new Error(
      'PLATFORM_FACT_SOURCE_GAME_ID, RELEASE_ID, BINDING_ID and OWNERSHIP_EPOCH are required together',
    );
  return {
    gameId: values[0] as string,
    releaseId: values[1] as string,
    backendBindingId: values[2] as string,
    ownershipEpoch: values[3] as string,
  };
}

function optionalFactCredentials(env: NodeJS.ProcessEnv):
  | readonly {
      readonly tokenRef: string;
      readonly source: TrustedSourceIdentity;
    }[]
  | undefined {
  const raw = optionalString(env, 'PLATFORM_FACT_CREDENTIALS_JSON');
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PLATFORM_FACT_CREDENTIALS_JSON must be valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 256)
    throw new Error(
      'PLATFORM_FACT_CREDENTIALS_JSON must contain 1 to 256 credentials',
    );
  const values = parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`fact credential ${index} is invalid`);
    const record = value as Record<string, unknown>;
    const allowed = new Set([
      'tokenRef',
      'gameId',
      'releaseId',
      'backendBindingId',
      'ownershipEpoch',
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key)))
      throw new Error(`fact credential ${index} contains an unsupported field`);
    const tokenRef = record.tokenRef;
    const source = [
      record.gameId,
      record.releaseId,
      record.backendBindingId,
      record.ownershipEpoch,
    ];
    if (
      typeof tokenRef !== 'string' ||
      !tokenRef.startsWith('env:') ||
      source.some(
        (item) => typeof item !== 'string' || item.trim().length === 0,
      )
    )
      throw new Error(`fact credential ${index} is invalid`);
    return {
      tokenRef,
      source: {
        gameId: source[0] as string,
        releaseId: source[1] as string,
        backendBindingId: source[2] as string,
        ownershipEpoch: source[3] as string,
      },
    };
  });
  const keys = values.map((value) =>
    JSON.stringify([
      value.source.gameId,
      value.source.releaseId,
      value.source.backendBindingId,
    ]),
  );
  if (new Set(keys).size !== keys.length)
    throw new Error(
      'PLATFORM_FACT_CREDENTIALS_JSON contains duplicate bindings',
    );
  return values;
}

/**
 * Loads only the standalone platform's explicit installation files and env
 * references. It deliberately does not load .env files or SETI.env.
 */
export async function loadStandaloneConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<StandalonePlatformConfig> {
  const configPath = resolve(
    cwd,
    env.PLATFORM_CONFIG_PATH ?? DEFAULT_CONFIG_PATH,
  );
  const lockPath = resolve(cwd, env.PLATFORM_LOCK_PATH ?? DEFAULT_LOCK_PATH);
  const workspaceRoot = resolve(cwd, env.PLATFORM_WORKSPACE_ROOT ?? cwd);
  const installation = await readPlatformInstallation(configPath, lockPath);
  await validateLocalReleaseReferences(installation, workspaceRoot);

  if (installation.config.platform.databaseUrlEnv !== 'PLATFORM_DATABASE_URL')
    throw new Error(
      'platform.config.platform.databaseUrlEnv must be PLATFORM_DATABASE_URL for the standalone server',
    );
  const platformId = env.PLATFORM_ID?.trim();
  if (platformId && platformId !== installation.config.platform.id)
    throw new Error('PLATFORM_ID must match platform.config.platform.id');

  const databaseUrl = postgresUrl(
    requiredEnv(
      env,
      'PLATFORM_DATABASE_URL',
      'PLATFORM_DATABASE_URL is required; standalone platform never falls back to DATABASE_URL',
    ),
  );
  if (!env.JWT_SECRET?.trim())
    throw new Error(
      'JWT_SECRET is required for the standalone platform server; use an explicit secret',
    );

  const playerCredentialPrivateKey = optionalString(
    env,
    'PLATFORM_PLAYER_PRIVATE_KEY',
  );
  const playerCredentialAudience = optionalString(
    env,
    'PLATFORM_PLAYER_AUDIENCE',
  );
  if (
    (playerCredentialPrivateKey === undefined) !==
    (playerCredentialAudience === undefined)
  )
    throw new Error(
      'PLATFORM_PLAYER_PRIVATE_KEY and PLATFORM_PLAYER_AUDIENCE are required together',
    );
  if (env.NODE_ENV === 'production') {
    if (!playerCredentialPrivateKey || !playerCredentialAudience)
      throw new Error(
        'Production standalone platform requires explicit player credential key and audience',
      );
  }
  const factIngressToken = optionalString(env, 'PLATFORM_FACT_INGRESS_TOKEN');
  const factIngressSource = optionalFactSource(env);
  const factIngressCredentials = optionalFactCredentials(env);
  const playerCredentialTtlMs = optionalTtl(env);
  const playerApprovedGameScopes = optionalScopes(env);
  const factIngressHost = optionalString(env, 'PLATFORM_FACT_INGRESS_HOST');
  const factIngressPort = optionalPort(env, 'PLATFORM_FACT_INGRESS_PORT');
  if (factIngressCredentials && (factIngressToken || factIngressSource))
    throw new Error(
      'Use PLATFORM_FACT_CREDENTIALS_JSON instead of single fact ingress credentials',
    );
  if ((factIngressToken === undefined) !== (factIngressSource === undefined))
    throw new Error(
      'PLATFORM_FACT_INGRESS_TOKEN and explicit fact source fields are required together',
    );
  if (
    env.NODE_ENV === 'production' &&
    Object.values(installation.config.games).some((game) => game.enabled) &&
    !factIngressToken &&
    !factIngressCredentials
  )
    throw new Error(
      'Production standalone platform requires explicit fact ingress credentials',
    );
  if (
    env.NODE_ENV === 'production' &&
    (factIngressToken || factIngressCredentials) &&
    factIngressPort === undefined
  )
    throw new Error(
      'Production standalone platform requires PLATFORM_FACT_INGRESS_PORT',
    );

  return {
    installation,
    platformId: installation.config.platform.id,
    databaseUrl,
    configPath,
    lockPath,
    workspaceRoot,
    allowInsecureLocalhost: booleanEnv(
      env,
      'PLATFORM_ALLOW_INSECURE_LOCALHOST',
    ),
    ...(playerCredentialPrivateKey === undefined
      ? {}
      : { playerCredentialPrivateKey }),
    ...(playerCredentialAudience === undefined
      ? {}
      : { playerCredentialAudience }),
    ...(playerCredentialTtlMs === undefined ? {} : { playerCredentialTtlMs }),
    ...(playerApprovedGameScopes === undefined
      ? {}
      : { playerApprovedGameScopes }),
    ...(factIngressToken === undefined ? {} : { factIngressToken }),
    ...(factIngressSource === undefined ? {} : { factIngressSource }),
    ...(factIngressCredentials === undefined ? {} : { factIngressCredentials }),
    ...(factIngressHost === undefined ? {} : { factIngressHost }),
    ...(factIngressPort === undefined ? {} : { factIngressPort }),
  };
}

/** Apply only the process settings consumed by shared platform modules. */
export function applyStandaloneEnvironment(
  config: StandalonePlatformConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.DATABASE_URL = config.databaseUrl;
  env.SETI_MAIL_PROCESS_MODE = 'standalone';
  env.SETI_MAIL_PROCESS_ROLE = 'http';
  if (env.PLATFORM_PORT?.trim()) env.PORT = env.PLATFORM_PORT;
  if (env.PLATFORM_PUBLIC_ORIGIN?.trim())
    env.PUBLIC_ORIGIN = env.PLATFORM_PUBLIC_ORIGIN;
  if (env.PLATFORM_HOST?.trim()) env.HOST = env.PLATFORM_HOST;
}
