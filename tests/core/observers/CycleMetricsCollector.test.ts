import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CycleMetricsCollector } from '../../../src/core/observers/CycleMetricsCollector.js';

describe('CycleMetricsCollector', () => {
  it('tracks cycle success rate', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(true, 5000);
    collector.recordCycleEnd(true, 6000);
    collector.recordCycleEnd(false, 3000);

    const metrics = collector.getMetrics();
    assert.equal(metrics.totalCycles, 3);
    assert.ok(Math.abs(metrics.successRate - 2/3) < 0.01);
    assert.equal(metrics.consecutiveFailures, 1);
  });

  it('resets consecutive failures on success', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(true, 5000);

    assert.equal(collector.getMetrics().consecutiveFailures, 0);
  });

  it('tracks average duration', () => {
    const collector = new CycleMetricsCollector();
    collector.recordCycleEnd(true, 4000);
    collector.recordCycleEnd(true, 6000);

    assert.equal(collector.getMetrics().avgCycleDurationMs, 5000);
  });

  it('respects sliding window', () => {
    const collector = new CycleMetricsCollector(3);
    collector.recordCycleEnd(false, 1000);
    collector.recordCycleEnd(true, 2000);
    collector.recordCycleEnd(true, 3000);
    collector.recordCycleEnd(true, 4000);

    assert.equal(collector.getMetrics().totalCycles, 3);
    assert.equal(collector.getMetrics().successRate, 1.0);
  });

  it('tracks phase durations', () => {
    const collector = new CycleMetricsCollector();
    collector.recordPhaseDuration('execute', 10000);
    collector.recordPhaseDuration('execute', 20000);
    collector.recordPhaseDuration('verify', 500);

    const breakdown = collector.getMetrics().phaseAvgDurationMs;
    assert.equal(breakdown.execute, 15000);
    assert.equal(breakdown.verify, 500);
  });
});
