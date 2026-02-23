import { log } from '../../utils/logger.js';

export interface ProjectHealth {
  tscErrors: number;
  recentSuccessRate: number;
  blockedTaskCount: number;
}

export type GetProjectHealthFn = () => Promise<ProjectHealth>;

export class DynamicPriorityStrategy {
  constructor(private getHealth: GetProjectHealthFn) {}

  async getContextForBrain(): Promise<string> {
    const health = await this.getHealth();
    const suggestions: string[] = [];

    if (health.tscErrors > 10) {
      suggestions.push(`TypeScript has ${health.tscErrors} errors — prioritize bug fixes`);
    }
    if (health.recentSuccessRate < 0.5) {
      suggestions.push(`Recent success rate is ${(health.recentSuccessRate * 100).toFixed(0)}% — try simpler tasks`);
    }
    if (health.blockedTaskCount > 3) {
      suggestions.push(`${health.blockedTaskCount} tasks are blocked — try to unblock them`);
    }

    if (suggestions.length === 0) return '';
    return `## Priority Suggestions\n${suggestions.map(s => `- ${s}`).join('\n')}`;
  }
}
