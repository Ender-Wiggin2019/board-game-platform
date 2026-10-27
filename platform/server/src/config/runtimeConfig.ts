const DEVELOPMENT_JWT_SECRET = 'seti-dev-secret-change-in-production';
const DEFAULT_PORT = 3000;
const DEFAULT_PUBLIC_ORIGIN = 'http://localhost:5173';
const PRODUCTION_HOST = '127.0.0.1';
const DEVELOPMENT_HOST = '127.0.0.1';
const MIN_JWT_SECRET_LENGTH = 32;
export type TNodeEnvironment = 'development' | 'test' | 'production';
export type TRuntimeConfigEnv = Readonly<Record<string, string | undefined>>;

export interface IRuntimeDatabaseConfig {
  readonly url?: string;
}

export interface IRuntimeServerConfig {
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
}

export interface IRuntimeNetworkConfig {
  readonly interfaceName: string | null;
  readonly egressLimitMbps: number | null;
}

export interface IRuntimeAuthConfig {
  readonly jwtSecret: string;
}

export interface IVapidRuntimeConfig {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export interface IRuntimeConfig {
  readonly nodeEnv: TNodeEnvironment;
  readonly server: IRuntimeServerConfig;
  readonly network: IRuntimeNetworkConfig;
  readonly database: IRuntimeDatabaseConfig;
  readonly auth: IRuntimeAuthConfig;
  readonly vapid?: IVapidRuntimeConfig;
}
export type RuntimeConfig = Readonly<IRuntimeConfig>;
let cachedProcessConfig: RuntimeConfig | undefined;
export function loadProductionConfig(
  env: TRuntimeConfigEnv = process.env,
): RuntimeConfig {
  if (env === process.env && cachedProcessConfig) return cachedProcessConfig;
  const nodeEnv = parseNodeEnvironment(env.NODE_ENV);
  const production = nodeEnv === 'production';
  const databaseUrl = parseDatabaseUrl(env.DATABASE_URL, production);
  const vapid = parseVapidConfig(env);
  const config = deepFreeze({
    nodeEnv,
    server: {
      host: production ? PRODUCTION_HOST : DEVELOPMENT_HOST,
      port: parsePort(env.PORT),
      publicOrigin: parsePublicOrigin(env, production),
    },
    network: parseNetworkConfig(env),
    database: { ...(databaseUrl ? { url: databaseUrl } : {}) },
    auth: { jwtSecret: parseJwtSecret(env.JWT_SECRET, production) },
    ...(vapid ? { vapid } : {}),
  });
  if (env === process.env) cachedProcessConfig = config;
  return config;
}
export function getRuntimeConfig(): RuntimeConfig {
  return loadProductionConfig();
}
export function resetRuntimeConfigCacheForTests(): void {
  cachedProcessConfig = undefined;
}
export function getRuntimeConfigSummary(config: RuntimeConfig) {
  return {
    nodeEnv: config.nodeEnv,
    server: config.server,
    network: config.network,
    database: { configured: config.database.url !== undefined },
    auth: { jwtSecretConfigured: config.auth.jwtSecret.length > 0 },
    vapid: { configured: config.vapid !== undefined },
  };
}
export function formatRuntimeConfigSummary(config: RuntimeConfig): string {
  return JSON.stringify(getRuntimeConfigSummary(config));
}
export function isAllowedOrigin(
  origin: string | undefined,
  config: RuntimeConfig,
): boolean {
  const normalized = origin?.trim();
  if (!normalized) return config.nodeEnv !== 'production';

  try {
    return new URL(normalized).origin === config.server.publicOrigin;
  } catch {
    return false;
  }
}

function parseNodeEnvironment(value: string | undefined): TNodeEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'production') return 'production';
  if (normalized === 'test') return 'test';
  if (value === undefined || normalized === 'development') {
    return 'development';
  }
  throw new Error('NODE_ENV must be one of development, test, or production');
}

function parseDatabaseUrl(
  rawValue: string | undefined,
  production: boolean,
): string | undefined {
  const value = rawValue?.trim();
  if (!value) {
    if (production) {
      throw new Error('DATABASE_URL is required in production');
    }
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  return value;
}

function parseJwtSecret(
  rawValue: string | undefined,
  production: boolean,
): string {
  const value =
    rawValue === undefined || rawValue === ''
      ? DEVELOPMENT_JWT_SECRET
      : rawValue;
  if (value.trim().length === 0) {
    throw new Error('JWT_SECRET must not be whitespace-only');
  }
  if (
    production &&
    (value === DEVELOPMENT_JWT_SECRET || value.length < MIN_JWT_SECRET_LENGTH)
  ) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`,
    );
  }
  return value;
}

function parsePublicOrigin(
  env: TRuntimeConfigEnv,
  production: boolean,
): string {
  if (env.CORS_ORIGIN !== undefined) {
    throw new Error('CORS_ORIGIN is unsupported; use PUBLIC_ORIGIN');
  }
  const configured = env.PUBLIC_ORIGIN?.trim();
  const value = configured || (production ? undefined : DEFAULT_PUBLIC_ORIGIN);

  if (!value) {
    throw new Error('PUBLIC_ORIGIN is required in production');
  }
  if (value === '*') {
    throw new Error('PUBLIC_ORIGIN must be a concrete HTTP(S) origin');
  }

  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== '' && origin.pathname !== '/')
  ) {
    throw new Error('PUBLIC_ORIGIN must be a valid HTTP(S) origin');
  }
  if (production && origin.protocol !== 'https:') {
    throw new Error('PUBLIC_ORIGIN must use HTTPS in production');
  }
  return origin.origin;
}

function parsePort(rawValue: string | undefined): number {
  if (rawValue === undefined) return DEFAULT_PORT;
  const value = rawValue.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseNetworkConfig(env: TRuntimeConfigEnv): IRuntimeNetworkConfig {
  const rawLimit = env.SETI_PUBLIC_EGRESS_LIMIT_MBPS?.trim();
  const egressLimitMbps =
    rawLimit === undefined || rawLimit === '' ? null : Number(rawLimit);
  if (
    egressLimitMbps !== null &&
    (!Number.isFinite(egressLimitMbps) || egressLimitMbps <= 0)
  ) {
    throw new Error('SETI_PUBLIC_EGRESS_LIMIT_MBPS must be a positive number');
  }

  return {
    interfaceName: env.SETI_NETWORK_INTERFACE?.trim() || null,
    egressLimitMbps,
  };
}

function parseVapidConfig(
  env: TRuntimeConfigEnv,
): IVapidRuntimeConfig | undefined {
  const publicKey = optionalString(env.SETI_VAPID_PUBLIC_KEY);
  const privateKey = optionalString(env.SETI_VAPID_PRIVATE_KEY);
  const subject = optionalString(env.SETI_VAPID_SUBJECT);
  if (!publicKey && !privateKey && !subject) return undefined;

  const missing = [
    !publicKey ? 'SETI_VAPID_PUBLIC_KEY' : undefined,
    !privateKey ? 'SETI_VAPID_PRIVATE_KEY' : undefined,
    !subject ? 'SETI_VAPID_SUBJECT' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(`VAPID configuration is incomplete: ${missing.join(', ')}`);
  }
  if (!publicKey || !privateKey || !subject) {
    throw new Error('VAPID configuration is incomplete');
  }
  if (!subject.startsWith('mailto:') || subject.length <= 'mailto:'.length) {
    throw new Error('SETI_VAPID_SUBJECT must be a non-empty mailto: address');
  }

  return { publicKey, privateKey, subject };
}

export function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
