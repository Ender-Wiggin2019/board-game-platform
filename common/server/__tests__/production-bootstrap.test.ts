import type { JsonValue } from '@board-game/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GameServerMaintenanceStatus,
  type GameServerRunner,
  installGameServerLifecycle,
  runGameServer,
} from '../src/index.js';

function fakeRunner(overrides: Partial<GameServerRunner<JsonValue>> = {}) {
  return {
    mode: 'production' as const,
    description: {} as GameServerRunner<JsonValue>['description'],
    host: {} as GameServerRunner<JsonValue>['host'],
    backend: {} as GameServerRunner<JsonValue>['backend'],
    commandServices: new Map(),
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    recoverOnce: vi.fn(async () => ({
      timers: [],
      resources: [],
      facts: [],
      recovery: [],
    })),
    recoverAutomationOnce: vi.fn(async () => []),
    ...overrides,
  } as unknown as GameServerRunner<JsonValue>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('game server production bootstrap', () => {
  it('runs prepare, startup recovery, maintenance and idempotent cleanup', async () => {
    const recoverOnce = vi.fn(async () => ({
      timers: [],
      resources: [],
      facts: [],
      recovery: [],
    }));
    const recoverAutomationOnce = vi.fn(async () => []);
    const close = vi.fn(async () => undefined);
    const runner = fakeRunner({ close, recoverOnce, recoverAutomationOnce });
    const prepare = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const installed = installGameServerLifecycle(runner, {
      intervalMs: 10,
      prepare,
      cleanup,
    });

    await expect(runGameServer(installed)).resolves.toBe(installed);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(recoverOnce).toHaveBeenCalledTimes(1);
    expect(recoverAutomationOnce).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recoverOnce.mock.calls.length).toBeGreaterThan(1);
    expect(recoverAutomationOnce.mock.calls.length).toBeGreaterThan(1);

    await installed.close();
    await installed.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects intervals outside the bounded maintenance window', () => {
    expect(() =>
      installGameServerLifecycle(fakeRunner(), { intervalMs: 9 }),
    ).toThrow('GAME_SERVER_MAINTENANCE_INTERVAL_INVALID');
    expect(() =>
      installGameServerLifecycle(fakeRunner(), { intervalMs: 60_001 }),
    ).toThrow('GAME_SERVER_MAINTENANCE_INTERVAL_INVALID');
  });

  it('closes a runner when startup recovery fails', async () => {
    const startupError = new Error('startup recovery failed');
    const close = vi.fn(async () => undefined);
    const runner = fakeRunner({
      close,
      recoverOnce: vi.fn(async () => {
        throw startupError;
      }),
    });
    const cleanup = vi.fn(async () => undefined);
    const installed = installGameServerLifecycle(runner, {
      intervalMs: 10,
      cleanup,
    });

    await expect(runGameServer(installed)).rejects.toBe(startupError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports retry and recovery without leaking private errors or stopping maintenance', async () => {
    const events: GameServerMaintenanceStatus[] = [];
    let calls = 0;
    const runner = fakeRunner({
      recoverOnce: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error('private-command-payload');
        return { timers: [], resources: [], facts: [], recovery: [] };
      }),
    });
    const installed = installGameServerLifecycle(runner, {
      intervalMs: 10,
      onMaintenanceStatus: (status) => events.push(status),
    });
    await runGameServer(installed);
    try {
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[0]).toMatchObject({
        status: 'pass-failed',
        errorCode: 'MAINTENANCE_PASS_FAILED',
      });
      expect(events[1]).toMatchObject({ status: 'pass-succeeded' });
      expect(JSON.stringify(events)).not.toContain('private-command-payload');
      expect(calls).toBeGreaterThan(2);
    } finally {
      await installed.close();
    }
  });
});
