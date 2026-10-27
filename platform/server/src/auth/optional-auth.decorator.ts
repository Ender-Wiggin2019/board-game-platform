import { SetMetadata } from '@nestjs/common';

/**
 * Let a route serve both anonymous migration drafts and authenticated drafts.
 * When a bearer token is present the global JWT guard still verifies it and
 * attaches the current principal; when it is absent the route remains public.
 */
export const OPTIONAL_AUTH_KEY = 'optionalAuth';
export const OptionalAuth = (): MethodDecorator =>
  SetMetadata(OPTIONAL_AUTH_KEY, true);
