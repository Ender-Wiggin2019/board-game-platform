import { type QueryClient } from '@tanstack/react-query';
import { notifyServerUpdateRecovered } from './serverUpdateNotification.js';

interface IRequestRecoveryIdentity {
  requestKey: string;
  requestSequence: number;
}

function readRecoveryIdentity(error: unknown): IRequestRecoveryIdentity | null {
  if (!error || typeof error !== 'object') return null;

  const candidate = error as {
    requestKey?: unknown;
    requestSequence?: unknown;
  };
  if (
    typeof candidate.requestKey !== 'string' ||
    typeof candidate.requestSequence !== 'number' ||
    !Number.isFinite(candidate.requestSequence)
  ) {
    return null;
  }
  return {
    requestKey: candidate.requestKey,
    requestSequence: candidate.requestSequence,
  };
}

export function subscribeQueryRecovery(queryClient: QueryClient): () => void {
  const failedReads = new WeakMap<object, IRequestRecoveryIdentity>();

  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed') {
      failedReads.delete(event.query);
      return;
    }
    if (event.type !== 'updated') return;

    if (event.action.type === 'failed' || event.action.type === 'error') {
      const identity = readRecoveryIdentity(event.action.error);
      if (identity) {
        failedReads.set(event.query, identity);
      }
      return;
    }
    if (event.action.type !== 'success' || event.action.manual === true) {
      return;
    }

    const identity = failedReads.get(event.query);
    if (!identity) return;
    failedReads.delete(event.query);
    notifyServerUpdateRecovered(identity);
  });
}
