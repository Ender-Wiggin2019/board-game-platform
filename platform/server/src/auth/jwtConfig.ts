import type {
  JwtModuleOptions,
  JwtSignOptions,
  JwtVerifyOptions,
} from '@nestjs/jwt';
import { getRuntimeConfig } from '@/config/runtimeConfig.js';

export const JWT_ALGORITHM = 'HS256' as const;
/** Stable framework JWT identifiers for platform-owned account sessions. */
export const DEFAULT_JWT_ISSUER = 'board-platform-server';
export const DEFAULT_JWT_AUDIENCE = 'board-platform-client';
export const ACCESS_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface IJwtRuntimeConfig {
  secret: string;
  issuer: string;
  audience: string;
}

export function getJwtRuntimeConfig(): IJwtRuntimeConfig {
  return {
    secret: getRuntimeConfig().auth.jwtSecret,
    issuer: DEFAULT_JWT_ISSUER,
    audience: DEFAULT_JWT_AUDIENCE,
  };
}

/**
 * Every verification path pins the same application issuer and audience.
 * Tests that create an isolated JwtService must issue tokens with this
 * contract instead of weakening verification.
 */
export function getJwtVerifyOptions(): JwtVerifyOptions {
  const config = getJwtRuntimeConfig();
  return {
    algorithms: [JWT_ALGORITHM],
    issuer: config.issuer,
    audience: config.audience,
  };
}

export function getJwtSignOptions(): JwtSignOptions {
  const config = getJwtRuntimeConfig();
  return {
    algorithm: JWT_ALGORITHM,
    issuer: config.issuer,
    audience: config.audience,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export function getJwtModuleOptions(): JwtModuleOptions {
  const config = getJwtRuntimeConfig();
  return {
    global: true,
    secret: config.secret,
    signOptions: getJwtSignOptions(),
    verifyOptions: getJwtVerifyOptions(),
  };
}
