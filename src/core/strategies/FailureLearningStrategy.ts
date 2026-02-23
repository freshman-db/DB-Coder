import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

interface FailureRecord {
  taskDescription: string;
  reason: string;
  timestamp: number;
  consecutiveCount: number;
}

const MAX_COOLDOWN = 16;
const FAILURE_THRESHOLD = 3;

export class FailureLearningStrategy {
  private failures: FailureRecord[] = [];
  private failureCounts: Map<string, number> = new Map();

  recordFailure(event: CycleEvent): void {
    const description = (event.data.taskDescription as string) ?? '';
    const reason = (event.data.verification as { reason?: string })?.reason
      ?? (event.data.error as string) ?? 'unknown';
    const keyword = this.extractKeyword(description);

    const count = (this.failureCounts.get(keyword) ?? 0) + 1;
    this.failureCounts.set(keyword, count);

    this.failures.push({ taskDescription: description, reason, timestamp: event.timestamp, consecutiveCount: count });
    if (this.failures.length > 50) this.failures.shift();

    log.info('FailureLearning: recorded failure', { keyword, count, reason: reason.slice(0, 80) });
  }

  recordSuccess(taskDescription: string): void {
    const keyword = this.extractKeyword(taskDescription);
    this.failureCounts.delete(keyword);
  }

  shouldLowerPriority(taskDescription: string): boolean {
    const keyword = this.extractKeyword(taskDescription);
    return (this.failureCounts.get(keyword) ?? 0) >= FAILURE_THRESHOLD;
  }

  getCooldownCycles(failureCount: number): number {
    return Math.min(2 ** failureCount, MAX_COOLDOWN);
  }

  getContextForBrain(): string {
    if (this.failures.length === 0) return '';
    const recent = this.failures.slice(-5);
    const lines = recent.map(f =>
      `- "${f.taskDescription.slice(0, 60)}" failed: ${f.reason.slice(0, 60)} (${f.consecutiveCount}x)`
    );
    return `## Recent Failures\n${lines.join('\n')}\nConsider different approaches for similar tasks.`;
  }

  private extractKeyword(description: string): string {
    const lower = description.toLowerCase();
    const keywords = ['refactor', 'test', 'fix', 'add', 'remove', 'update', 'optimize', 'simplify'];
    for (const kw of keywords) {
      if (lower.includes(kw)) return kw;
    }
    return lower.slice(0, 20);
  }
}
