function parseUrl(name: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a valid URL`);
  }
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

const DEFAULT_DEV_API_URL = '/api';
const DEFAULT_DEV_WS_URL = 'http://localhost:3000';

function parseApiBaseUrl(value: unknown): string {
  const normalized = parseUrl('VITE_API_URL', value).replace(/\/+$/, '');
  if (!normalized.endsWith('/api')) {
    throw new Error('VITE_API_URL must include the /api REST namespace');
  }
  return normalized;
}

function parseDebugRoutes(value: unknown): boolean {
  if (value === undefined || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error('VITE_ENABLE_DEBUG_ROUTES must be "true" or "false"');
}

export interface TClientEnv {
  VITE_API_URL: string;
  VITE_WS_URL: string;
  VITE_ENABLE_DEBUG_ROUTES: boolean;
}

export interface TClientEnvInput {
  production: boolean;
  apiUrl?: unknown;
  wsUrl?: unknown;
  enableDebugRoutes?: unknown;
  locationOrigin?: unknown;
}

/**
 * Read the host application's Vite mode at runtime. Package builds must keep
 * this indirection so a prebuilt game package still follows the host's dev or
 * production mode when it is loaded by Vite.
 */
export function isClientProduction(): boolean {
  return import.meta.env.PROD;
}

/**
 * Read a host Vite variable without baking its value into a package build.
 * Game packages use this for their own deployment flags and metadata; the
 * platform only provides the generic lookup and does not own those names.
 */
export function readClientEnv(name: string): string | undefined {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

export function isClientDevelopment(): boolean {
  return !isClientProduction();
}

function currentOrigin(value: unknown): string {
  const origin =
    value ??
    (typeof window !== 'undefined' ? window.location.origin : undefined) ??
    DEFAULT_DEV_WS_URL;
  return parseUrl('window.location.origin', origin).replace(/\/+$/, '');
}

/**
 * Production static assets use the origin that served them. Development may
 * override the direct backend URLs for E2E or a remote local server; when
 * omitted, Vite proxies the relative defaults to localhost.
 */
export function resolveClientEnv(input: TClientEnvInput): TClientEnv {
  if (input.production) {
    return {
      VITE_API_URL: '/api',
      VITE_WS_URL: currentOrigin(input.locationOrigin),
      VITE_ENABLE_DEBUG_ROUTES: false,
    };
  }

  return {
    VITE_API_URL:
      input.apiUrl === undefined
        ? DEFAULT_DEV_API_URL
        : parseApiBaseUrl(input.apiUrl),
    VITE_WS_URL:
      input.wsUrl === undefined
        ? currentOrigin(input.locationOrigin)
        : parseUrl('VITE_WS_URL', input.wsUrl),
    VITE_ENABLE_DEBUG_ROUTES: parseDebugRoutes(input.enableDebugRoutes),
  };
}

export const CLIENT_ENV = resolveClientEnv({
  production: isClientProduction(),
  apiUrl: readClientEnv('VITE_API_URL'),
  wsUrl: readClientEnv('VITE_WS_URL'),
  enableDebugRoutes: readClientEnv('VITE_ENABLE_DEBUG_ROUTES'),
  locationOrigin:
    typeof window !== 'undefined' ? window.location.origin : undefined,
});
