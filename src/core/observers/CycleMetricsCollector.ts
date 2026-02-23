import type { CycleEvent } from '../CycleEvents.js';

export interface CycleMetrics {
  totalCycles: number;
  successRate: number;
  avgCycleDurationMs: number;
  consecutiveFailures: number;
  phaseAvgDurationMs: Record<string, number>;
}

interface CycleRecord {
  productive: boolean;
  durationMs: number;
}

export class CycleMetricsCollector {
  private cycles: CycleRecord[] = [];
  private phaseDurations: Map<string, number[]> = new Map();
  private maxCycles: number;
  private _consecutiveFailures = 0;

  constructor(maxCycles = 100) {
    this.maxCycles = maxCycles;
  }

  handle(event: CycleEvent): void {
    if (event.timing === 'after' || event.timing === 'error') {
      const durationMs = event.data.durationMs as number | undefined;
      if (typeof durationMs === 'number') {
        this.recordPhaseDuration(event.phase, durationMs);
      }
    }
  }

  recordCycleEnd(productive: boolean, durationMs: number): void {
    this.cycles.push({ productive, durationMs });
    if (this.cycles.length > this.maxCycles) this.cycles.shift();
    if (productive) {
      this._consecutiveFailures = 0;
    } else {
      this._consecutiveFailures++;
    }
  }

  recordPhaseDuration(phase: string, durationMs: number): void {
    if (!this.phaseDurations.has(phase)) this.phaseDurations.set(phase, []);
    const arr = this.phaseDurations.get(phase)!;
    arr.push(durationMs);
    if (arr.length > this.maxCycles) arr.shift();
  }

  getMetrics(): CycleMetrics {
    const total = this.cycles.length;
    const successes = this.cycles.filter(c => c.productive).length;
    const avgDuration = total > 0
      ? this.cycles.reduce((sum, c) => sum + c.durationMs, 0) / total
      : 0;

    const phaseAvg: Record<string, number> = {};
    for (const [phase, durations] of this.phaseDurations) {
      phaseAvg[phase] = durations.reduce((a, b) => a + b, 0) / durations.length;
    }

    return {
      totalCycles: total,
      successRate: total > 0 ? successes / total : 0,
      avgCycleDurationMs: avgDuration,
      consecutiveFailures: this._consecutiveFailures,
      phaseAvgDurationMs: phaseAvg,
    };
  }
}
