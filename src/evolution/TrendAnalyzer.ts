import type { TaskStore } from '../memory/TaskStore.js';
import type { HealthTrend, AreaTrend, TrendDirection } from './types.js';
import type { ScanResult, AnalysisItem } from '../memory/types.js';

export class TrendAnalyzer {
  constructor(private taskStore: TaskStore) {}

  async getHealthTrend(projectPath: string, windowSize = 10): Promise<HealthTrend | null> {
    const scans = await this.taskStore.getRecentScans(projectPath, windowSize);
    if (scans.length < 2) return null;

    const current = scans[0].health_score ?? 50;
    const previous = scans[1].health_score ?? 50;
    const delta = current - previous;

    return {
      current,
      previous,
      delta,
      direction: this.classifyDelta(delta),
      dataPoints: scans.length,
    };
  }

  async computeAreaTrends(projectPath: string, windowSize = 10): Promise<AreaTrend[]> {
    const scans = await this.taskStore.getRecentScans(projectPath, windowSize);
    if (scans.length < 2) return [];

    const recent = scans[0];
    const older = scans[Math.min(scans.length - 1, Math.floor(scans.length / 2))];

    const recentCounts = this.countIssuesByType(recent);
    const olderCounts = this.countIssuesByType(older);

    const allAreas = new Set([...Object.keys(recentCounts), ...Object.keys(olderCounts)]);
    const trends: AreaTrend[] = [];

    for (const area of allAreas) {
      const count = recentCounts[area] ?? 0;
      const previousCount = olderCounts[area] ?? 0;
      const delta = previousCount - count; // fewer issues = improving
      trends.push({
        area,
        count,
        previousCount,
        direction: this.classifyDelta(delta),
      });
    }

    return trends.sort((a, b) => a.count - b.count);
  }

  async formatTrendSummary(projectPath: string, windowSize = 10): Promise<string> {
    const health = await this.getHealthTrend(projectPath, windowSize);
    const areas = await this.computeAreaTrends(projectPath, windowSize);

    if (!health) return '';

    const parts: string[] = [];
    parts.push(`Health: ${health.current}/100 (${health.direction}, delta ${health.delta > 0 ? '+' : ''}${health.delta})`);

    const notable = areas.filter(a => a.direction !== 'stable');
    if (notable.length > 0) {
      const areaStrs = notable.map(a =>
        `${a.area}: ${a.direction} (${a.previousCount}→${a.count} issues)`
      );
      parts.push(`Areas: ${areaStrs.join('; ')}`);
    }

    return parts.join('\n');
  }

  private countIssuesByType(scan: ScanResult): Record<string, number> {
    const counts: Record<string, number> = {};
    const result = scan.result;
    if (!result || typeof result !== 'object') return counts;

    const issues: AnalysisItem[] = result.issues ?? [];
    for (const issue of issues) {
      const type = issue.type ?? 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
    }
    return counts;
  }

  private classifyDelta(delta: number): TrendDirection {
    if (delta > 3) return 'improving';
    if (delta < -3) return 'degrading';
    return 'stable';
  }
}
