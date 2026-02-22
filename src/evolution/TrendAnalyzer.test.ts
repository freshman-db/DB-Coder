import assert from 'node:assert/strict';
import test from 'node:test';
import { TrendAnalyzer } from './TrendAnalyzer.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { AnalysisItem, ProjectAnalysis, ScanResult } from '../memory/types.js';

function makeIssue(type: string): AnalysisItem {
  return {
    type,
    severity: 'low',
    description: `${type} issue`,
  };
}

function makeResult(issues: AnalysisItem[]): ProjectAnalysis {
  return {
    issues,
    opportunities: [],
    projectHealth: 80,
    summary: 'ok',
  };
}

function makeScanWithResult(id: number, result: ProjectAnalysis): ScanResult {
  return {
    id,
    project_path: '/repo',
    commit_hash: `commit-${id}`,
    depth: 'quick',
    result,
    health_score: 80,
    cost_usd: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeScan(id: number, issueTypes: string[]): ScanResult {
  return makeScanWithResult(id, makeResult(issueTypes.map(makeIssue)));
}

function createAnalyzer(scans: ScanResult[]): TrendAnalyzer {
  const taskStore: Pick<TaskStore, 'getRecentScans'> = {
    getRecentScans: async (_projectPath: string, limit = 10) => scans.slice(0, limit),
  };
  return new TrendAnalyzer(taskStore as TaskStore);
}

test('computeAreaTrends calculates area deltas from result.issues', async () => {
  const analyzer = createAnalyzer([
    makeScan(1, ['bug', 'style']),
    makeScan(2, ['bug', 'bug', 'bug', 'bug', 'bug', 'style']),
  ]);

  const trends = await analyzer.computeAreaTrends('/repo');
  const trendByArea = new Map(trends.map(trend => [trend.area, trend]));

  assert.equal(trends.length, 2);
  assert.equal(trendByArea.get('bug')?.count, 1);
  assert.equal(trendByArea.get('bug')?.previousCount, 5);
  assert.equal(trendByArea.get('bug')?.direction, 'improving');
  assert.equal(trendByArea.get('style')?.count, 1);
  assert.equal(trendByArea.get('style')?.previousCount, 1);
  assert.equal(trendByArea.get('style')?.direction, 'stable');
});

test('computeAreaTrends handles scan results missing issues at runtime', async () => {
  const malformedResult = {
    opportunities: [],
    projectHealth: 80,
    summary: 'raw payload',
  } as unknown as ProjectAnalysis;

  const analyzer = createAnalyzer([
    makeScanWithResult(1, malformedResult),
    makeScan(2, ['bug', 'bug', 'bug', 'bug']),
  ]);

  const trends = await analyzer.computeAreaTrends('/repo');

  assert.deepEqual(trends, [
    {
      area: 'bug',
      count: 0,
      previousCount: 4,
      direction: 'improving',
    },
  ]);
});
