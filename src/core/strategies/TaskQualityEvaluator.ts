import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export type QualityLevel = 'high' | 'medium' | 'low';

export interface QualityScore {
  level: QualityLevel;
  diffSize: number;
  touchesCore: boolean;
  tscErrorDelta: number;
  hasTests: boolean;
}

export class TaskQualityEvaluator {
  private recentScores: QualityScore[] = [];

  evaluate(event: CycleEvent): QualityScore {
    const data = event.data;
    const diffSize = (data.filesChanged as number) ?? 0;
    const tscDelta = (data.tscErrorDelta as number) ?? 0;
    const hasTests = (data.hasTests as boolean) ?? false;
    const touchesCore = (data.touchesCore as boolean) ?? false;

    let points = 0;
    if (diffSize >= 3) points++;
    if (touchesCore) points++;
    if (tscDelta < 0) points++;
    if (hasTests) points++;

    const level: QualityLevel = points >= 3 ? 'high' : points >= 2 ? 'medium' : 'low';
    const score: QualityScore = { level, diffSize, touchesCore, tscErrorDelta: tscDelta, hasTests };

    this.recentScores.push(score);
    if (this.recentScores.length > 20) this.recentScores.shift();

    log.info('TaskQuality: evaluated', { level, points, diffSize, tscDelta, hasTests });
    return score;
  }

  getRecentLowValueCount(n = 5): number {
    return this.recentScores.slice(-n).filter(s => s.level === 'low').length;
  }

  getContextForBrain(): string {
    const lowCount = this.getRecentLowValueCount();
    if (lowCount >= 3) {
      return '## Quality Alert\nRecent tasks have been low-value. Focus on tasks that: fix bugs, reduce tsc errors, add tests, or modify core modules.';
    }
    return '';
  }
}
