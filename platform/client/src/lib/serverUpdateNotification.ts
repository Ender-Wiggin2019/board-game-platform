import type { EErrorCode } from '@board-game/contracts';

export const SERVER_UPDATE_REQUIRED_EVENT = 'seti:server-update-required';
const SERVER_UPDATE_RECOVERED_EVENT = 'seti:server-update-recovered';

export interface IServerUpdateNotification {
  source: 'http' | 'websocket';
  message: string;
  code?: EErrorCode;
  status?: number;
  /** Only reads may be retried globally; player actions must not be replayed. */
  retryable?: boolean;
  retry?: () => Promise<unknown>;
  retryAt?: number;
  requestKey?: string;
  requestSequence?: number;
}

interface IRecoveredRequest {
  requestKey: string;
  requestSequence: number;
}

export function notifyServerUpdateRecovered(
  recovered: IRecoveredRequest,
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<IRecoveredRequest>(SERVER_UPDATE_RECOVERED_EVENT, {
      detail: recovered,
    }),
  );
}

export function onServerUpdateRecovered(
  handler: (recovered: IRecoveredRequest) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void =>
    handler((event as CustomEvent<IRecoveredRequest>).detail);
  window.addEventListener(SERVER_UPDATE_RECOVERED_EVENT, listener);
  return () =>
    window.removeEventListener(SERVER_UPDATE_RECOVERED_EVENT, listener);
}

type TServerUpdateHandler = (notification: IServerUpdateNotification) => void;

export function notifyServerUpdateRequired(
  notification: IServerUpdateNotification,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<IServerUpdateNotification>(SERVER_UPDATE_REQUIRED_EVENT, {
      detail: notification,
    }),
  );
}

export function onServerUpdateRequired(
  handler: TServerUpdateHandler,
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const listener = (event: Event): void => {
    handler((event as CustomEvent<IServerUpdateNotification>).detail);
  };

  window.addEventListener(SERVER_UPDATE_REQUIRED_EVENT, listener);
  return () =>
    window.removeEventListener(SERVER_UPDATE_REQUIRED_EVENT, listener);
}
