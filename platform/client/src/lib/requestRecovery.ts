import { EErrorCode } from '@board-game/contracts';
import { getErrorStatus } from '../api/authRefreshCoordinator.js';

export type TRequestFailureKind =
  | 'offline'
  | 'connection'
  | 'service'
  | 'rateLimited'
  | 'signin'
  | 'browser'
  | 'version'
  | 'unexpected';

export function isRecoverableRequestFailure(error: unknown): boolean {
  return resolveRequestFailure(error) !== 'unexpected';
}

/** Describe what the user can observe, without guessing that a 500 is an update. */
export function resolveRequestFailure(
  error: unknown,
  online = typeof navigator === 'undefined' || navigator.onLine,
): TRequestFailureKind {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = candidate?.code;
  const message =
    typeof candidate?.message === 'string' ? candidate.message : '';
  const status = getErrorStatus(error);
  if (code === EErrorCode.PROTOCOL_UPGRADE_REQUIRED || status === 426)
    return 'version';
  if (message.startsWith('Auth refresh coordination')) return 'browser';
  if (status === 401) return 'signin';
  if (status === 429) return 'rateLimited';
  if (status !== undefined && status >= 500) return 'service';
  if (code === EErrorCode.INTERNAL_SERVER_ERROR) return 'service';
  if (status === undefined && !online) return 'offline';
  if (
    code === EErrorCode.CONNECTION_ERROR ||
    code === 'ERR_NETWORK' ||
    code === 'ECONNABORTED' ||
    /network|offline|timeout|timed out|failed to fetch/i.test(message)
  )
    return 'connection';
  return 'unexpected';
}
