import { isCancel } from 'axios';
import { getAuthRefreshRetryDelay } from './authRefreshCoordinator.js';

interface IHttpStatusError {
  status?: number;
}

/** Retry transport/5xx failures twice; never amplify client-side failures. */
export function shouldRetryHttpQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (isCancel(error)) return false;
  const status = (error as IHttpStatusError | undefined)?.status;
  return failureCount < 2 && (status === undefined || status >= 500);
}

export function getHttpQueryRetryDelay(
  attempt: number,
  error: unknown,
): number {
  return getAuthRefreshRetryDelay(error, attempt);
}
