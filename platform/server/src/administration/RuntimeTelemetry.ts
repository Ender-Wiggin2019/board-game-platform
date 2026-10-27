import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { IPlatformPerformanceSnapshot } from '@board-platform/contracts/types/protocol/administration';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** Constant-space process telemetry, independent of game registration and traffic. */
export class RuntimeTelemetry implements OnModuleInit, OnModuleDestroy {
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private timer?: ReturnType<typeof setInterval>;
  private previousCpu = process.cpuUsage();
  private previousTime = performance.now();
  private measurement: Pick<
    IPlatformPerformanceSnapshot,
    'sampleWindowMs' | 'cpuPercent' | 'eventLoopLagMs'
  > = { sampleWindowMs: 0, cpuPercent: null, eventLoopLagMs: null };

  public onModuleInit(): void {
    this.eventLoop.enable();
    this.timer = setInterval(() => this.sample(), 10_000);
    this.timer.unref();
  }

  public onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.eventLoop.disable();
  }

  public sample(): void {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsed = now - this.previousTime;
    if (elapsed <= 0) return;
    const cpuMicros =
      cpu.user - this.previousCpu.user + cpu.system - this.previousCpu.system;
    this.measurement = {
      sampleWindowMs: Math.round(elapsed),
      cpuPercent: Math.round((cpuMicros / (elapsed * 1_000)) * 10_000) / 100,
      eventLoopLagMs: Number.isFinite(this.eventLoop.mean)
        ? {
            mean: this.eventLoop.mean / 1_000_000,
            p95: this.eventLoop.percentile(95) / 1_000_000,
            max: this.eventLoop.max / 1_000_000,
          }
        : null,
    };
    this.previousCpu = cpu;
    this.previousTime = now;
    this.eventLoop.reset();
  }

  public snapshot(): IPlatformPerformanceSnapshot {
    return {
      capturedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memoryBytes: process.memoryUsage(),
      ...this.measurement,
    };
  }
}
