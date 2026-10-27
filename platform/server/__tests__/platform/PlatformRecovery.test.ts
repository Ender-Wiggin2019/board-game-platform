import type { SystemTickResult } from '@board-game/host';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApplicationRuntime } from '@/platform/PlatformApplicationRuntime.js';
import { PlatformRecovery } from '@/platform/platform.module.js';

vi.mock('@/platform/schema.js', () => ({
  assertPlatformSchemaReady: vi.fn(async () => undefined),
}));

afterEach(() => vi.restoreAllMocks());

describe('PlatformRecovery shutdown', () => {
  it('ignores an already queued timer callback while waiting for an AI scan', async () => {
    let scheduled: () => void = () => undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      scheduled = callback as () => void;
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setInterval
      >;
    });
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    let completeAi: (results: readonly SystemTickResult[]) => void = () =>
      undefined;
    const ai = new Promise<readonly SystemTickResult[]>((resolve) => {
      completeAi = resolve;
    });
    const runtime = {
      recoverOnce: vi.fn(async () => ({
        starts: [],
        delivery: { failed: 0 },
        consumers: [],
        timers: [],
        resources: [],
        maintenance: [],
      })),
      recoverAutomationOnce: vi.fn(() => ai),
      drain: vi.fn(async () => undefined),
    };
    const recovery = new PlatformRecovery(
      runtime as unknown as PlatformApplicationRuntime,
      {} as Pool,
    );
    await recovery.onApplicationBootstrap();
    expect(runtime.recoverOnce).toHaveBeenCalledOnce();
    expect(runtime.recoverAutomationOnce).toHaveBeenCalledOnce();

    const shutdown = recovery.beforeApplicationShutdown();
    scheduled();
    await Promise.resolve();
    expect(runtime.recoverOnce).toHaveBeenCalledOnce();
    expect(runtime.recoverAutomationOnce).toHaveBeenCalledOnce();
    expect(runtime.drain).not.toHaveBeenCalled();

    completeAi([]);
    await shutdown;
    expect(runtime.drain).toHaveBeenCalledOnce();
  });
});
