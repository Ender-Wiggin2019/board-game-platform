import {
  EErrorCode,
  EErrorResponsibility,
  type IErrorI18n,
  type TNormalizedErrorPayload,
} from '@board-game/contracts';
import type { TFunction } from 'i18next';

/**
 * All server-error texts live under this client-owned namespace. The server
 * only names the semantics (`payload.i18n.key`, e.g. `waiting_room_exists`);
 * how it reads in each language is decided here, not on the server.
 */
const SERVER_ERROR_KEY_PREFIX = 'client.server_errors.';

/**
 * Per-code texts for payloads that carry neither an i18n key nor a usable
 * message. Anything with a
 * real message shows that message instead — never a generic that hides it.
 */
const CODE_FALLBACK_KEYS: Partial<Record<EErrorCode, string>> = {
  [EErrorCode.CONNECTION_ERROR]: 'client.server_errors.fallback.connection',
  [EErrorCode.PROTOCOL_UPGRADE_REQUIRED]:
    'client.server_errors.protocol_upgrade_required',
  [EErrorCode.SERVER_BUSY]: 'client.server_errors.server_busy',
  [EErrorCode.FORBIDDEN]: 'client.server_errors.fallback.forbidden',
  [EErrorCode.GAME_NOT_FOUND]: 'client.server_errors.fallback.game_not_found',
  [EErrorCode.INSUFFICIENT_RESOURCES]:
    'client.server_errors.fallback.insufficient_resources',
  [EErrorCode.INTERNAL_SERVER_ERROR]:
    'client.server_errors.internal_server_error',
  [EErrorCode.INVALID_ACTION]: 'client.server_errors.fallback.invalid_action',
  [EErrorCode.INVALID_FREE_ACTION]:
    'client.server_errors.fallback.invalid_free_action',
  [EErrorCode.INVALID_INPUT_RESPONSE]:
    'client.server_errors.fallback.invalid_input_response',
  [EErrorCode.INVALID_PHASE]: 'client.server_errors.fallback.invalid_phase',
  [EErrorCode.NOT_YOUR_TURN]: 'client.server_errors.fallback.not_your_turn',
  [EErrorCode.PLAYER_NOT_FOUND]:
    'client.server_errors.fallback.player_not_found',
  [EErrorCode.STALE_INPUT_RESPONSE]:
    'client.server_errors.fallback.stale_input',
  [EErrorCode.UNAUTHORIZED]: 'client.server_errors.fallback.unauthorized',
  [EErrorCode.VALIDATION_ERROR]: 'client.server_errors.fallback.validation',
};

/**
 * Resolution order: the throw site's semantic key (translated under the
 * client catalog, falling back to the plain message when uncatalogued) →
 * the plain message itself → per-code generic only when no message exists.
 */
export function translateServerErrorMessage(
  t: TFunction,
  rawMessage: string,
  code?: EErrorCode,
  i18n?: IErrorI18n,
): string {
  const message = rawMessage;

  if (i18n?.key) {
    return t(`${SERVER_ERROR_KEY_PREFIX}${i18n.key}`, {
      ...i18n.params,
      message,
      defaultValue: message,
    });
  }

  if (message) {
    return message;
  }

  if (code) {
    const fallbackKey = CODE_FALLBACK_KEYS[code];
    if (fallbackKey) {
      return t(fallbackKey, { message });
    }
  }

  return rawMessage;
}

export function translateErrorResponsibility(
  t: TFunction,
  responsibility: EErrorResponsibility,
): string {
  return t(`client.game.error.responsibility.${responsibility}`);
}

function resolveErrorRecoveryKey(
  error: TNormalizedErrorPayload,
  resyncRequested: boolean,
): string {
  if (resyncRequested) {
    return 'client.game.error.recovery.refreshing';
  }

  switch (error.responsibility) {
    case EErrorResponsibility.AUTHORIZATION:
      return 'client.game.error.recovery.authorization';
    case EErrorResponsibility.CONNECTION:
      return 'client.game.error.recovery.connection';
    case EErrorResponsibility.PLAYER_ACTION:
      return 'client.game.error.recovery.player_action';
    case EErrorResponsibility.SYSTEM:
      return error.retryable
        ? 'client.game.error.recovery.system_retryable'
        : 'client.game.error.recovery.system';
  }
}

export function formatServerErrorDescription(
  t: TFunction,
  error: TNormalizedErrorPayload,
  options: { resyncRequested?: boolean } = {},
): string {
  return [
    translateServerErrorMessage(t, error.message, error.code, error.i18n),
    translateErrorResponsibility(t, error.responsibility),
    t(resolveErrorRecoveryKey(error, options.resyncRequested === true)),
  ].join('\n');
}
