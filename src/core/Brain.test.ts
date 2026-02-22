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
import type { ProjectAnalysis } from './types.js';

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

test('createPlan uses analysis + task history and returns parsed task plan', async () => {
  const projectPath = '/tmp/brain-create-plan-test';
  const planCalls: PlanInvocation[] = [];
  const listTaskCalls: string[] = [];
  const relevantQueries: string[] = [];

  const claude = {
    plan: async (
      prompt: string,
      cwd: string,
      options?: { systemPrompt?: string; maxTurns?: number },
    ) => {
      planCalls.push({ prompt, cwd, options });
      return {
        success: true,
        output: JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              description: 'Add coverage for Brain planning flow',
              type: 'test',
              priority: 1,
              executor: 'codex',
              subtasks: [{ id: 'task-1.1', description: 'Test createPlan()', executor: 'codex' }],
              dependsOn: [],
              estimatedComplexity: 'low',
            },
          ],
          reasoning: 'Prioritize planning behavior coverage.',
        }),
        cost_usd: 0.67,
        duration_ms: 8,
      } satisfies AgentResult;
    },
    getLoadedPluginIds: () => [],
  } as unknown as ClaudeBridge;

  const globalMemory = {
    getRelevant: async (query: string) => {
      relevantQueries.push(query);
      return 'prioritize testing planning edge cases';
    },
  } as unknown as GlobalMemory;

  const projectMemory = {} as unknown as ProjectMemory;

  const taskStore = {
    listTasks: async (_cwd: string, status?: string) => {
      listTaskCalls.push(status ?? 'none');
      switch (status) {
        case 'queued':
          return [{ priority: 1, task_description: 'Add retry guards' }];
        case 'done':
          return [{ priority: 2, task_description: 'Improve scan logging' }];
        case 'blocked':
          return [{ priority: 0, task_description: 'Refactor DB layer' }];
        case 'failed':
          return [{ priority: 1, task_description: 'Harden reflection parser' }];
        default:
          return [];
      }
    },
  } as unknown as TaskStore;

  const brain = new Brain(claude, globalMemory, projectMemory, taskStore);
  const analysis: ProjectAnalysis = {
    issues: [
      {
        type: 'test',
        severity: 'high',
        description: 'Brain createPlan has no tests',
      },
    ],
    opportunities: [
      {
        type: 'quality',
        severity: 'low',
        description: 'Improve planning prompt observability',
      },
    ],
    projectHealth: 72,
    summary: 'Planning flow works but lacks confidence due to missing tests.',
  };

  const result = await brain.createPlan(projectPath, analysis);

  assert.equal(result.cost, 0.67);
  assert.equal(result.plan.tasks.length, 1);
  assert.equal(result.plan.tasks[0]?.id, 'task-1');
  assert.equal(result.plan.tasks[0]?.executor, 'codex');
  assert.equal(result.plan.reasoning, 'Prioritize planning behavior coverage.');

  assert.deepEqual(relevantQueries, ['task planning prioritization']);
  assert.deepEqual(listTaskCalls, ['queued', 'done', 'blocked', 'failed']);

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]?.cwd, projectPath);
  assert.equal(planCalls[0]?.options?.systemPrompt, BRAIN_SYSTEM_PROMPT);
  assert.match(planCalls[0]?.prompt ?? '', /Brain createPlan has no tests/);
  assert.match(planCalls[0]?.prompt ?? '', /- \[P1\] \[queued\] Add retry guards/);
  assert.match(planCalls[0]?.prompt ?? '', /- \[P2\] \[done\] Improve scan logging/);
  assert.match(planCalls[0]?.prompt ?? '', /- \[P0\] \[blocked\] Refactor DB layer/);
  assert.match(planCalls[0]?.prompt ?? '', /- \[P1\] \[failed\] Harden reflection parser/);
});

test('createPlan handles empty analysis gracefully and still returns a valid plan', async () => {
  const planCalls: PlanInvocation[] = [];
  const projectPath = '/tmp/brain-create-plan-empty-analysis';

  const claude = {
    plan: async (
      prompt: string,
      cwd: string,
      options?: { systemPrompt?: string; maxTurns?: number },
    ) => {
      planCalls.push({ prompt, cwd, options });
      return {
        success: true,
        output: JSON.stringify({
          tasks: [],
          reasoning: 'No urgent tasks; continue monitoring.',
        }),
        cost_usd: 0.11,
        duration_ms: 3,
      } satisfies AgentResult;
    },
    getLoadedPluginIds: () => [],
  } as unknown as ClaudeBridge;

  const globalMemory = {
    getRelevant: async () => '',
  } as unknown as GlobalMemory;

  const taskStore = {
    listTasks: async () => [],
  } as unknown as TaskStore;

  const brain = new Brain(claude, globalMemory, {} as ProjectMemory, taskStore);
  const result = await brain.createPlan(projectPath, {
    issues: [],
    opportunities: [],
    projectHealth: 98,
    summary: 'No notable issues or opportunities found in this scan.',
  });

  assert.equal(result.cost, 0.11);
  assert.deepEqual(result.plan.tasks, []);
  assert.equal(result.plan.reasoning, 'No urgent tasks; continue monitoring.');

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]?.cwd, projectPath);
  assert.match(planCalls[0]?.prompt ?? '', /"issues": \[\]/);
  assert.match(planCalls[0]?.prompt ?? '', /"opportunities": \[\]/);
  assert.match(planCalls[0]?.prompt ?? '', /Existing tasks[\s\S]*None/);
});

test('createPlan falls back safely when Claude returns invalid JSON', async () => {
  const claude = {
    plan: async () => ({
      success: true,
      output: 'Plan draft: focus on test debt, but no structured JSON returned.',
      cost_usd: 0.29,
      duration_ms: 5,
    } satisfies AgentResult),
    getLoadedPluginIds: () => [],
  } as unknown as ClaudeBridge;

  const globalMemory = {
    getRelevant: async () => '',
  } as unknown as GlobalMemory;

  const taskStore = {
    listTasks: async () => [],
  } as unknown as TaskStore;

  const brain = new Brain(claude, globalMemory, {} as ProjectMemory, taskStore);
  const result = await brain.createPlan('/tmp/brain-create-plan-invalid', {
    issues: [],
    opportunities: [],
    projectHealth: 60,
    summary: 'Needs improvement.',
  });

  assert.deepEqual(result.plan.tasks, []);
  assert.equal(result.plan.reasoning, 'Plan draft: focus on test debt, but no structured JSON returned.');
  assert.equal(result.cost, 0.29);
});

test('reflect calls ClaudeBridge and stores experiences in memory systems', async () => {
  const projectPath = '/tmp/brain-reflect-project';
  const planCalls: PlanInvocation[] = [];
  const addCalls: Array<{
    category: string;
    title: string;
    content: string;
    tags: string[];
    source_project: string;
    confidence: number;
  }> = [];
  const searchCalls: Array<{ query: string; limit: number }> = [];
  const confidenceUpdates: Array<{ id: number; delta: number }> = [];
  const projectSaves: Array<{ text: string; title?: string; project?: string }> = [];

  const claude = {
    plan: async (
      prompt: string,
      cwd: string,
      options?: { systemPrompt?: string; maxTurns?: number },
    ) => {
      planCalls.push({ prompt, cwd, options });
      return {
        success: true,
        output: JSON.stringify({
          experiences: [
            {
              category: 'habit',
              title: 'Test planning edge cases',
              content: 'Always cover empty analysis input for plan generation.',
              tags: ['tests', 'planning'],
            },
            {
              category: 'not-real-category',
              title: 'Avoid parser ambiguity',
              content: 'Require strict JSON and keep fallback behavior predictable.',
              tags: ['parsing', 'reliability'],
            },
          ],
          taskSummary: 'Added createPlan + reflect tests, including fallback paths.',
          adjustments: ['Expand coverage to research() in next pass.'],
        }),
        cost_usd: 0.53,
        duration_ms: 7,
      } satisfies AgentResult;
    },
  } as unknown as ClaudeBridge;

  const globalMemory = {
    add: async (memory: {
      category: string;
      title: string;
      content: string;
      tags: string[];
      source_project: string;
      confidence: number;
    }) => {
      addCalls.push(memory);
      return {
        id: addCalls.length,
        ...memory,
        created_at: new Date(0),
        updated_at: new Date(0),
      };
    },
    search: async (query: string, limit = 10) => {
      searchCalls.push({ query, limit });
      return [
        {
          id: 1001,
          title: 'Legacy retry strategy',
        },
        {
          id: 1002,
          title: 'Test planning edge cases',
        },
      ];
    },
    updateConfidence: async (id: number, delta: number) => {
      confidenceUpdates.push({ id, delta });
    },
  } as unknown as GlobalMemory;

  const projectMemory = {
    save: async (text: string, title?: string, project?: string) => {
      projectSaves.push({ text, title, project });
      return true;
    },
  } as unknown as ProjectMemory;

  const brain = new Brain(claude, globalMemory, projectMemory, {} as TaskStore);
  const result = await brain.reflect(
    projectPath,
    'Add test coverage for createPlan and reflect',
    'All tests pass locally.',
    'Review passed without blocking issues.',
    'success',
  );

  assert.equal(result.cost, 0.53);
  assert.equal(result.reflection.experiences.length, 2);
  assert.equal(result.reflection.taskSummary, 'Added createPlan + reflect tests, including fallback paths.');
  assert.deepEqual(result.reflection.adjustments, ['Expand coverage to research() in next pass.']);

  assert.equal(planCalls.length, 1);
  assert.equal(planCalls[0]?.cwd, projectPath);
  assert.equal(planCalls[0]?.options?.systemPrompt, BRAIN_SYSTEM_PROMPT);
  assert.equal(planCalls[0]?.options?.maxTurns, 5);
  assert.match(planCalls[0]?.prompt ?? '', /Task: Add test coverage for createPlan and reflect/);
  assert.match(planCalls[0]?.prompt ?? '', /Outcome: success/);

  assert.equal(addCalls.length, 2);
  assert.equal(addCalls[0]?.category, 'habit');
  assert.equal(addCalls[1]?.category, 'experience');
  assert.equal(addCalls[0]?.source_project, projectPath);
  assert.equal(addCalls[1]?.source_project, projectPath);
  assert.deepEqual(searchCalls, [{ query: 'Add test coverage for createPlan and reflect', limit: 5 }]);
  assert.deepEqual(confidenceUpdates, [{ id: 1001, delta: 0.1 }]);

  assert.equal(projectSaves.length, 1);
  assert.equal(projectSaves[0]?.title, 'Task: Add test coverage for createPlan and reflect');
  assert.match(projectSaves[0]?.text ?? '', /^Task completed: Add test coverage for createPlan and reflect\n/);
  assert.match(projectSaves[0]?.text ?? '', /Added createPlan \+ reflect tests/);
});

test('reflect falls back safely when Claude returns invalid JSON', async () => {
  const addCalls: unknown[] = [];
  const projectSaves: Array<{ text: string; title?: string }> = [];

  const claude = {
    plan: async () => ({
      success: true,
      output: 'Reflection notes only. No JSON available for parsing.',
      cost_usd: 0.19,
      duration_ms: 4,
    } satisfies AgentResult),
  } as unknown as ClaudeBridge;

  const globalMemory = {
    add: async (memory: unknown) => {
      addCalls.push(memory);
      return memory;
    },
    search: async () => [],
    updateConfidence: async () => {},
  } as unknown as GlobalMemory;

  const projectMemory = {
    save: async (text: string, title?: string) => {
      projectSaves.push({ text, title });
      return true;
    },
  } as unknown as ProjectMemory;

  const brain = new Brain(claude, globalMemory, projectMemory, {} as TaskStore);
  const result = await brain.reflect(
    '/tmp/brain-reflect-invalid-json',
    'Handle malformed reflection output',
    'Task output',
    'Review output',
    'failed',
  );

  assert.deepEqual(result.reflection.experiences, []);
  assert.deepEqual(result.reflection.adjustments, []);
  assert.equal(result.reflection.taskSummary, 'Reflection notes only. No JSON available for parsing.');
  assert.equal(result.cost, 0.19);

  assert.equal(addCalls.length, 0);
  assert.equal(projectSaves.length, 1);
  assert.equal(projectSaves[0]?.title, 'Task: Handle malformed reflection output');
  assert.equal(
    projectSaves[0]?.text,
    'Task failed: Handle malformed reflection output\nReflection notes only. No JSON available for parsing.',
  );
});
