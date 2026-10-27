import { performance } from 'node:perf_hooks';
import { ECapability } from '@board-platform/contracts/auth/permissions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformPerformanceController } from '@/administration/platform-performance.controller.js';
import { RuntimeTelemetry } from '@/administration/RuntimeTelemetry.js';
import { CAPABILITIES_KEY } from '@/auth/capabilities.decorator.js';

describe('platform process telemetry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports warmup honestly and samples CPU over elapsed time without game dependencies', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(10_100);
    vi.spyOn(process, 'cpuUsage')
      .mockReturnValueOnce({ user: 1_000_000, system: 200_000 })
      .mockReturnValueOnce({ user: 2_000_000, system: 700_000 });
    const telemetry = new RuntimeTelemetry();
    expect(telemetry.snapshot()).toMatchObject({
      cpuPercent: null,
      eventLoopLagMs: null,
      sampleWindowMs: 0,
    });
    telemetry.sample();
    const snapshot = new PlatformPerformanceController(telemetry).read();
    expect(snapshot).toMatchObject({ sampleWindowMs: 10_000, cpuPercent: 15 });
    expect(snapshot.memoryBytes.rss).toBeGreaterThan(0);
    expect(snapshot.memoryBytes.heapUsed).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(snapshot.capturedAt))).toBe(true);
    expect(
      Reflect.getMetadata(CAPABILITIES_KEY, PlatformPerformanceController),
    ).toEqual([ECapability.ANALYTICS_READ]);
    telemetry.onModuleDestroy();
  });
});
