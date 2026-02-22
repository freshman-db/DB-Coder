import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentResult } from '../bridges/CodingAgent.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { ProjectMemory } from '../memory/ProjectMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import { BRAIN_SYSTEM_PROMPT } from '../prompts/brain.js';
import { runProcess } from '../utils/process.js';
import { Brain } from './Brain.js';

type PlanInvocation = {
  prompt: string;
  cwd: string;
  options?: {
    systemPrompt?: string;
    maxTurns?: number;
  };
};

type SavedScanRecord = {
  project_path: string;
  commit_hash: string;
  depth: 'quick' | 'normal' | 'deep';
  result: {
    issues: unknown[];
    opportunities: unknown[];
    projectHealth: number;
    summary: string;
  };
  health_score: number | null;
  cost_usd: number | null;
};

async function runGit(repoPath: string, args: string[]): Promise<void> {
  const result = await runProcess('git', args, { cwd: repoPath });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

async function createGitProject(): Promise<string> {
  const repoPath = mkdtempSync(join(tmpdir(), 'brain-scan-test-'));
  await runGit(repoPath, ['init']);
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com']);
  await runGit(repoPath, ['config', 'user.name', 'DB Coder Tests']);
  writeFileSync(join(repoPath, 'README.md'), '# test\n');
  await runGit(repoPath, ['add', 'README.md']);
  await runGit(repoPath, ['commit', '-m', 'init']);
  return repoPath;
}

function createBrainFixture(planResult: AgentResult): {
  brain: Brain;
  planCalls: PlanInvocation[];
  savedScans: SavedScanRecord[];
} {
  const planCalls: PlanInvocation[] = [];
  const savedScans: SavedScanRecord[] = [];

  const claude = {
    plan: async (
      prompt: string,
      cwd: string,
      options?: { systemPrompt?: string; maxTurns?: number },
    ) => {
      planCalls.push({ prompt, cwd, options });
      return planResult;
    },
    getMcpServerNames: () => [],
    getLoadedPluginIds: () => [],
  } as unknown as ClaudeBridge;

  const globalMemory = {
    getRelevant: async () => 'global-memory',
  } as unknown as GlobalMemory;

  const projectMemory = {
    search: async () => [],
  } as unknown as ProjectMemory;

  const taskStore = {
    getLastScan: async () => null,
    listTasks: async () => [],
    saveScanResult: async (scan: SavedScanRecord) => {
      savedScans.push(scan);
    },
  } as unknown as TaskStore;

  return {
    brain: new Brain(claude, globalMemory, projectMemory, taskStore),
    planCalls,
    savedScans,
  };
}

test('scanProject calls ClaudeBridge with scan prompt and parses analysis JSON', async (t) => {
  const repoPath = await createGitProject();
  t.after(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  const output = [
    'Scan finished.',
    JSON.stringify({
      issues: [
        {
          type: 'quality',
          severity: 'medium',
          description: 'Missing tests for Brain',
          file: 'src/core/Brain.ts',
          suggestion: 'Add unit tests for scanProject',
        },
      ],
      opportunities: [
        {
          type: 'test',
          severity: 'low',
          description: 'Expand happy-path coverage',
          suggestion: 'Add end-to-end smoke tests',
        },
      ],
      projectHealth: 84,
      summary: 'Core functionality is stable with minor coverage gaps.',
    }),
  ].join('\n');

  const { brain, planCalls, savedScans } = createBrainFixture({
    success: true,
    output,
    cost_usd: 1.75,
    duration_ms: 10,
  });

  const result = await brain.scanProject(repoPath, 'normal');

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]?.cwd, repoPath);
  assert.equal(planCalls[0]?.options?.systemPrompt, BRAIN_SYSTEM_PROMPT);
  assert.equal(planCalls[0]?.options?.maxTurns, 20);
  assert.match(planCalls[0]?.prompt ?? '', new RegExp(`Scan the project at ${repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(planCalls[0]?.prompt ?? '', /Scan depth: normal/);

  assert.equal(result.cost, 1.75);
  assert.equal(result.analysis.projectHealth, 84);
  assert.equal(result.analysis.summary, 'Core functionality is stable with minor coverage gaps.');
  assert.equal(result.analysis.issues.length, 1);
  assert.equal(result.analysis.opportunities.length, 1);

  assert.equal(savedScans.length, 1);
  assert.equal(savedScans[0]?.project_path, repoPath);
  assert.equal(savedScans[0]?.depth, 'normal');
  assert.equal(savedScans[0]?.health_score, 84);
  assert.equal(savedScans[0]?.cost_usd, 1.75);
  assert.equal(typeof savedScans[0]?.commit_hash, 'string');
  assert.ok((savedScans[0]?.commit_hash?.length ?? 0) > 0);
});

test('scanProject falls back safely when Claude returns invalid JSON', async (t) => {
  const repoPath = await createGitProject();
  t.after(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  const invalidOutput = 'Scan complete. No structured output available.';
  const { brain, planCalls, savedScans } = createBrainFixture({
    success: true,
    output: invalidOutput,
    cost_usd: 0.42,
    duration_ms: 5,
  });

  const result = await brain.scanProject(repoPath, 'quick');

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]?.options?.maxTurns, 10);

  assert.deepEqual(result.analysis.issues, []);
  assert.deepEqual(result.analysis.opportunities, []);
  assert.equal(result.analysis.projectHealth, 50);
  assert.equal(result.analysis.summary, invalidOutput);
  assert.equal(result.cost, 0.42);

  assert.equal(savedScans.length, 1);
  assert.equal(savedScans[0]?.depth, 'quick');
  assert.equal(savedScans[0]?.health_score, 50);
  assert.equal(savedScans[0]?.result.projectHealth, 50);
  assert.equal(savedScans[0]?.result.summary, invalidOutput);
});
