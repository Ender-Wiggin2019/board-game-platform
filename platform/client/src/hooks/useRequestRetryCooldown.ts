import { useEffect, useMemo, useState } from 'react';
import { getAuthRefreshRetryAfterMs } from '@/api/authRefreshCoordinator';

export function useRequestRetryCooldown(
  error: unknown,
  retryAt?: number,
): { retryAt: number | undefined; seconds: number } {
  const failureRetryAt = useMemo(() => {
    const delay = getAuthRefreshRetryAfterMs(error);
    return delay > 0 ? Date.now() + delay : undefined;
  }, [error]);
  const deadline = retryAt ?? failureRetryAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (deadline === undefined || deadline <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return {
    retryAt: deadline,
    seconds:
      deadline === undefined
        ? 0
        : Math.max(0, Math.ceil((deadline - now) / 1_000)),
  };
}
