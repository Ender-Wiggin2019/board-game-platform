import { afterEach, describe, expect, it, vi } from 'vitest';

const performanceNow = vi.hoisted(() => vi.fn(() => 0));

vi.mock('node:perf_hooks', async () => {
  const actual =
    await vi.importActual<typeof import('node:perf_hooks')>('node:perf_hooks');
  return {
    ...actual,
    performance: {
      ...actual.performance,
      now: performanceNow,
    },
  };
});

import {
  PERFORMANCE_BUDGETS,
  runPerformanceVerification,
} from '../src/performance.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function runWithMeasuredDuration(durationMs: number) {
  let tick = 0;
  performanceNow.mockImplementation(() => {
    const value = tick * durationMs;
    tick += 1;
    return value;
  });
  try {
    return await runPerformanceVerification({
      sampleCount: 3,
      environments: ['embedded', 'remote'],
    });
  } finally {
    performanceNow.mockReset();
  }
}

describe('platform performance verification', () => {
  it('reports all four fixtures with embedded and remote Host measurements', async () => {
    const result = await runWithMeasuredDuration(1);
    expect(result.reports).toHaveLength(8);
    expect(result.reports.map((report) => report.fixture)).toEqual([
      'fixture-sequential-turn',
      'fixture-sequential-turn',
      'fixture-simultaneous-hidden',
      'fixture-simultaneous-hidden',
      'fixture-cooperative-team',
      'fixture-cooperative-team',
      'fixture-solo-progress',
      'fixture-solo-progress',
    ]);
    for (const report of result.reports) {
      expect(report.count).toBe(3);
      expect(report.medianMs).toBeGreaterThanOrEqual(0);
      expect(report.p95Ms).toBeGreaterThanOrEqual(report.medianMs);
      expect(report.payloadBytes).toBeGreaterThan(0);
      expect(report.encodedBytes).toBeGreaterThan(0);
      expect(report.budget).toEqual(PERFORMANCE_BUDGETS);
      expect(report.passed).toBe(true);
    }
    expect(result.passed).toBe(true);
  });

  it('fails reports and the overall result when the timing budget is exceeded', async () => {
    const durationMs = PERFORMANCE_BUDGETS.p95Ms + 1;
    const result = await runWithMeasuredDuration(durationMs);
    expect(result.reports).toHaveLength(8);
    for (const report of result.reports) {
      expect(report.p95Ms).toBe(durationMs);
      expect(report.passed).toBe(false);
    }
    expect(result.passed).toBe(false);
  });

  it('keeps explicit budgets immutable in the report', () => {
    expect(PERFORMANCE_BUDGETS).toEqual({
      p95Ms: 250,
      payloadBytes: 131072,
      encodedStateBytes: 524288,
    });
  });
});
