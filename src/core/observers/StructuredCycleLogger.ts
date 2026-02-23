import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface CycleLogEntry {
  phase: string;
  timing: string;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export class StructuredCycleLogger {
  private entries: CycleLogEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  handle(event: CycleEvent): void {
    const entry: CycleLogEntry = {
      phase: event.phase,
      timing: event.timing,
      taskId: event.taskId,
      data: event.data,
      timestamp: event.timestamp,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    log.info(`[cycle] ${event.timing}:${event.phase}`, {
      taskId: event.taskId,
      ...this.summarizeData(event.data),
    });
  }

  getEntries(): CycleLogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }

  private summarizeData(data: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > 100) {
        summary[k] = v.slice(0, 100) + '...';
      } else {
        summary[k] = v;
      }
    }
    return summary;
  }
}
