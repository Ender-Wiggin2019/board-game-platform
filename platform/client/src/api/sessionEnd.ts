export type TSessionEnd = { reason: 'server-disconnect' };

const listeners = new Set<(event: TSessionEnd) => void>();

export function onSessionEnd(
  handler: (event: TSessionEnd) => void,
): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function emitSessionEnd(event: TSessionEnd): void {
  for (const handler of listeners) handler(event);
}
