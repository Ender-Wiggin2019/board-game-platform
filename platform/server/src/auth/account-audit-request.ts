import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const requestIds = new AsyncLocalStorage<string>();

interface IAuditRequest {
  headers: { 'x-request-id'?: string | string[] };
}

interface IAuditResponse {
  setHeader(name: string, value: string): void;
}

/** Correlates account audit rows with one HTTP request without storing its body. */
export function attachAuditRequestId(
  request: IAuditRequest,
  response: IAuditResponse,
  next: () => void,
): void {
  const header = request.headers['x-request-id'];
  const supplied = typeof header === 'string' ? header : undefined;
  const requestId =
    supplied && /^[a-zA-Z0-9:._-]{1,80}$/u.test(supplied)
      ? supplied
      : randomUUID();
  response.setHeader('x-request-id', requestId);
  requestIds.run(requestId, next);
}

export function currentAuditRequestId(): string | null {
  return requestIds.getStore() ?? null;
}
