import { JwtService } from '@nestjs/jwt';
import {
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_ISSUER,
  getJwtModuleOptions,
  getJwtRuntimeConfig,
  getJwtVerifyOptions,
} from '@/auth/jwtConfig.js';

it('uses the validated runtime secret and fixed issuer/audience contract', () => {
  expect(getJwtRuntimeConfig()).toMatchObject({
    secret: expect.any(String),
    issuer: DEFAULT_JWT_ISSUER,
    audience: DEFAULT_JWT_AUDIENCE,
  });
  expect(getJwtVerifyOptions()).toEqual({
    algorithms: ['HS256'],
    issuer: DEFAULT_JWT_ISSUER,
    audience: DEFAULT_JWT_AUDIENCE,
  });
});

it('issues default access tokens for 180 days and retains signature verification', () => {
  const jwt = new JwtService(getJwtModuleOptions());
  const token = jwt.sign({ sub: 'user-1' });
  const claims = jwt.verify<{ iat: number; exp: number }>(token);
  expect(claims.exp - claims.iat).toBe(180 * 24 * 60 * 60);
});
