import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/Config.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { Task } from '../memory/types.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Brain } from './Brain.js';
import type { TaskQueue } from './TaskQueue.js';
import type { PromptRegistry } from '../prompts/PromptRegistry.js';
import { MainLoop, extractIssueCategories } from './MainLoop.js';
import type { StatusSnapshot } from './types.js';
import type { ReviewIssue } from '../bridges/CodingAgent.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import { runProcess } from '../utils/process.js';

/** Helper to build a minimal ReviewIssue for testing */
function issue(
  description: string,
  severity: ReviewIssue['severity'] = 'medium',
  suggestion?: string,
): ReviewIssue {
  return { description, severity, source: 'claude', suggestion };
}

type MainLoopInternals = {
  setState(state: StatusSnapshot['state']): void;
  setCurrentTaskId(taskId: string | null): void;
  setPaused(paused: boolean): void;
  setRunning(running: boolean): void;
};

type MainLoopExecutionInternals = {
  prepareTaskBranch(
    task: Task,
    branchName: string,
    projectPath: string,
  ): Promise<{ originalBranch: string; startCommit: string }>;
  executeSubtasks(
    task: Task,
    branchName: string,
    projectPath: string,
  ): Promise<{ subtasks: Task['subtasks']; stuckAdjustments: string[]; aborted: boolean }>;
  runReviewCycle(
    task: Task,
    startCommit: string,
    stuckAdjustments: string[],
    projectPath: string,
  ): Promise<{
    aborted: boolean;
    reviewResult?: {
      passed: boolean;
      mustFix: ReviewIssue[];
      shouldFix: ReviewIssue[];
      summary: string;
    };
    reviewRetries?: number;
  }>;
  reflectOnTask(...args: unknown[]): Promise<void>;
};

type CycleConfigOverrides = {
  projectPath?: string;
  values?: {
    brain?: { scanInterval?: number };
    autonomy?: {
      maxRetries?: number;
      retryBaseDelayMs?: number;
      subtaskTimeout?: number;
    };
    git?: { branchPrefix?: string };
    evolution?: { metaReflectInterval?: number };
  };
};

type MainLoopCycleOverrides = {
  config?: CycleConfigOverrides;
  brain?: Partial<Brain>;
  taskQueue?: Partial<TaskQueue>;
  claude?: Partial<ClaudeBridge>;
  codex?: Partial<CodexBridge>;
  taskStore?: Partial<TaskStore>;
  globalMemory?: Partial<GlobalMemory>;
  costTracker?: Partial<CostTracker>;
};

type MainLoopCycleFixture = {
  loop: MainLoop;
  deps: {
    config: Config;
    brain: Brain;
    taskQueue: TaskQueue;
    claude: ClaudeBridge;
    codex: CodexBridge;
    taskStore: TaskStore;
    globalMemory: GlobalMemory;
    costTracker: CostTracker;
  };
};

function createMainLoopForCycle(overrides: MainLoopCycleOverrides = {}): MainLoopCycleFixture {
  const baseConfig = {
    projectPath: '/tmp/db-coder-main-loop-test',
    values: {
      brain: { scanInterval: 1 },
      autonomy: { maxRetries: 3, retryBaseDelayMs: 1, subtaskTimeout: 60 },
      git: { branchPrefix: 'db-coder/' },
      evolution: { metaReflectInterval: 5 },
    },
  };
  const config = {
    ...baseConfig,
    ...overrides.config,
    values: {
      ...baseConfig.values,
      ...overrides.config?.values,
      brain: {
        ...baseConfig.values.brain,
        ...(overrides.config?.values?.brain ?? {}),
      },
      autonomy: {
        ...baseConfig.values.autonomy,
        ...(overrides.config?.values?.autonomy ?? {}),
      },
      git: {
        ...baseConfig.values.git,
        ...(overrides.config?.values?.git ?? {}),
      },
      evolution: {
        ...baseConfig.values.evolution,
        ...(overrides.config?.values?.evolution ?? {}),
      },
    },
  } as unknown as Config;

  const brain = {
    hasChanges: async () => false,
    scanProject: async () => ({
      analysis: { issues: [], opportunities: [], projectHealth: 100, summary: 'No changes' },
      cost: 0,
    }),
    createPlan: async () => ({ plan: { tasks: [], reasoning: 'No tasks' }, cost: 0 }),
    reflect: async () => ({
      reflection: {
        experiences: [],
        taskSummary: 'No reflection',
        adjustments: [],
      },
      cost: 0,
    }),
    ...overrides.brain,
  } as unknown as Brain;

  const taskQueue = {
    enqueue: async () => [],
    getQueued: async () => [],
    getNext: async () => null,
    ...overrides.taskQueue,
  } as unknown as TaskQueue;

  const claude = {
    plan: async () => ({
      success: true,
      output: JSON.stringify({
        problemLegitimacy: 1,
        solutionProportionality: 1,
        expectedComplexity: 1,
        historicalSuccess: 1,
        reasoning: 'Default pass',
      }),
      cost_usd: 0,
      duration_ms: 0,
    }),
    execute: async () => ({
      success: true,
      output: 'ok',
      cost_usd: 0,
      duration_ms: 0,
    }),
    review: async () => ({
      passed: true,
      issues: [],
      summary: 'No review issues',
      cost_usd: 0,
    }),
    getMcpServerNames: () => [],
    getLoadedPluginIds: () => [],
    ...overrides.claude,
  } as unknown as ClaudeBridge;

  const codex = {
    plan: async () => ({
      success: true,
      output: 'No-op plan',
      cost_usd: 0,
      duration_ms: 0,
    }),
    execute: async () => ({
      success: true,
      output: 'ok',
      cost_usd: 0,
      duration_ms: 0,
    }),
    review: async () => ({
      passed: true,
      issues: [],
      summary: 'No review issues',
      cost_usd: 0,
    }),
    ...overrides.codex,
  } as unknown as CodexBridge;

  const taskStore = {
    addDailyCost: async () => {},
    getLastScan: async () => null,
    saveEvaluationEvent: async () => {},
    updateTask: async () => {},
    addLog: async () => {},
    saveReviewEvent: async () => {},
    getActivePromptVersions: async () => [],
    updatePromptVersionEffectiveness: async () => {},
    listTasks: async () => [],
    recoverActiveTasks: async () => 0,
    ...overrides.taskStore,
  } as unknown as TaskStore;

  const globalMemory = {
    getRelevant: async () => '',
    search: async () => [],
    add: async () => ({
      id: 1,
      category: 'experience',
      title: 'noop',
      content: 'noop',
      tags: [],
      source_project: null,
      confidence: 0.5,
      created_at: new Date(),
      updated_at: new Date(),
    }),
    updateConfidence: async () => {},
    ...overrides.globalMemory,
  } as unknown as GlobalMemory;

  const costTracker = {
    addCost: async () => {},
    checkBudget: async () => ({ allowed: true }),
    getDailySummary: async () => [],
    getSessionCost: () => 0,
    ...overrides.costTracker,
  } as unknown as CostTracker;

  const loop = new MainLoop(
    config,
    brain,
    taskQueue,
    claude,
    codex,
    taskStore,
    globalMemory,
    costTracker,
  );

  return {
    loop,
    deps: {
      config,
      brain,
      taskQueue,
      claude,
      codex,
      taskStore,
      globalMemory,
      costTracker,
    },
  };
}

function createMainLoop(): MainLoop {
  return createMainLoopForCycle().loop;
}

function collectStates(loop: MainLoop): { states: StatusSnapshot[]; remove: () => void } {
  const states: StatusSnapshot[] = [];
  const remove = loop.addStatusListener(snapshot => {
    states.push(snapshot);
  });
  return { states, remove };
}

function getMainLoopInternals(loop: MainLoop): MainLoopInternals {
  return loop as unknown as MainLoopInternals;
}

function getMainLoopExecutionInternals(loop: MainLoop): MainLoopExecutionInternals {
  return Object.getPrototypeOf(loop) as MainLoopExecutionInternals;
}

type PromptDeltaInternals = {
  updatePromptVersionEffectiveness(passed: boolean): Promise<void>;
};

function getPromptDeltaInternals(loop: MainLoop): PromptDeltaInternals {
  return loop as unknown as PromptDeltaInternals;
}

function createMainLoopForPromptDelta(taskStore: TaskStore): MainLoop {
  const config = {
    projectPath: '/tmp/db-coder-main-loop-test',
  } as unknown as Config;

  return new MainLoop(
    config,
    {} as unknown as Brain,
    {} as unknown as TaskQueue,
    {} as unknown as ClaudeBridge,
    {} as unknown as CodexBridge,
    taskStore,
    {} as unknown as GlobalMemory,
    {} as unknown as CostTracker,
  );
}

type DedupInternals = {
  checkBudgetOrAbort(taskId: string): Promise<boolean>;
  cleanupTaskBranch(branch: string): Promise<void>;
  tryProcessAdjustments(
    taskId: string | null,
    adjustments: string[],
    outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
    errorContext?: string,
  ): Promise<void>;
};

function getDedupInternals(loop: MainLoop): DedupInternals {
  return loop as unknown as DedupInternals;
}

function createMainLoopForDedupHelpers(options: {
  projectPath?: string;
  taskStore?: TaskStore;
  costTracker?: CostTracker;
} = {}): MainLoop {
  const config = {
    projectPath: options.projectPath ?? '/tmp/db-coder-main-loop-test',
  } as unknown as Config;

  return new MainLoop(
    config,
    {} as unknown as Brain,
    {} as unknown as TaskQueue,
    {} as unknown as ClaudeBridge,
    {} as unknown as CodexBridge,
    options.taskStore ?? ({} as TaskStore),
    {} as unknown as GlobalMemory,
    options.costTracker ?? ({} as CostTracker),
  );
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const result = await runProcess('git', args, { cwd: repoPath });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function initGitRepo(): Promise<{ repoPath: string; defaultBranch: string }> {
  const repoPath = mkdtempSync(join(tmpdir(), 'db-coder-main-loop-'));
  await runGit(repoPath, ['init']);
  await runGit(repoPath, ['config', 'user.email', 'tests@example.com']);
  await runGit(repoPath, ['config', 'user.name', 'DB Coder Tests']);
  writeFileSync(join(repoPath, 'README.md'), 'seed\n');
  await runGit(repoPath, ['add', 'README.md']);
  await runGit(repoPath, ['commit', '-m', 'init']);

  const defaultBranch = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { repoPath, defaultBranch };
}

describe('extractIssueCategories', () => {
  test('matches known patterns', () => {
    const cats = extractIssueCategories([
      issue('type mismatch in return value'),
      issue('missing null check leads to crash'),
      issue('potential XSS vulnerability in template', 'high'),
    ]);
    assert.ok(cats.includes('type-error'));
    assert.ok(cats.includes('null-safety'));
    assert.ok(cats.includes('security'));
  });

  test('uses severity fallback when no pattern matches', () => {
    const cats = extractIssueCategories([
      issue('this code looks off', 'low'),
    ]);
    assert.ok(cats.includes('severity-low'));
    assert.equal(cats.length, 1);
  });

  test('per-issue fallback: unmatched issue gets severity even when earlier issues matched', () => {
    // This is the exact scenario that the global-check bug would miss:
    // first issue matches a pattern, second doesn't — second must still get a fallback.
    const cats = extractIssueCategories([
      issue('type error in function signature', 'high'),
      issue('this code looks off', 'low'),
    ]);
    assert.ok(cats.includes('type-error'), 'first issue should match type-error');
    assert.ok(cats.includes('severity-low'), 'second issue should get severity fallback');
  });

  test('returns empty array for empty input', () => {
    const cats = extractIssueCategories([]);
    assert.deepEqual(cats, []);
  });

  test('includes suggestion text in pattern matching', () => {
    const cats = extractIssueCategories([
      issue('fix this function', 'medium', 'add try catch to handle errors'),
    ]);
    assert.ok(cats.includes('error-handling'));
  });

  test('single issue matching multiple patterns produces multiple categories', () => {
    const cats = extractIssueCategories([
      issue('null check missing which causes a type error', 'high'),
    ]);
    assert.ok(cats.includes('null-safety'));
    assert.ok(cats.includes('type-error'));
    assert.ok(!cats.some(c => c.startsWith('severity-')), 'matched issue should not get fallback');
  });
});

describe('MainLoop runCycle integration', () => {
  test('happy path — full scan→plan→evaluate→execute flow', async () => {
    let scanProjectCalls = 0;
    let createPlanCalls = 0;
    let getNextCalls = 0;
    let claudePlanCalls = 0;
    let prepareTaskBranchCalls = 0;
    let executeSubtasksCalls = 0;
    let runReviewCycleCalls = 0;
    let reflectOnTaskCalls = 0;

    const addDailyCostCalls: number[] = [];
    const enqueueCalls: Array<{ projectPath: string; plan: unknown }> = [];

    const now = new Date();
    const scanAnalysis = {
      issues: [{ type: 'bugfix', severity: 'medium' as const, description: 'Fix flaky integration path' }],
      opportunities: [],
      projectHealth: 78,
      summary: 'One actionable issue detected',
    };
    const plan = {
      tasks: [{
        id: 'T001',
        description: 'Fix flaky integration path',
        priority: 1,
        executor: 'codex' as const,
        subtasks: [{ id: 'S1', description: 'Implement focused fix', executor: 'codex' as const }],
        dependsOn: [],
        estimatedComplexity: 'low' as const,
      }],
      reasoning: 'Address the issue from scan',
    };
    const mockTask: Task = {
      id: 'task-happy-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Fix flaky integration path',
      phase: 'init',
      priority: 1,
      plan: plan.tasks[0],
      subtasks: [{ id: 'S1', description: 'Implement focused fix', executor: 'codex', status: 'pending' }],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'queued',
      created_at: now,
      updated_at: now,
    };

    const { loop } = createMainLoopForCycle({
      brain: {
        hasChanges: async (projectPath: string) => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return true;
        },
        scanProject: async (projectPath: string) => {
          scanProjectCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return { analysis: scanAnalysis, cost: 0.01 };
        },
        createPlan: async (projectPath: string, analysis) => {
          createPlanCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          assert.equal(analysis, scanAnalysis);
          return { plan, cost: 0.005 };
        },
      },
      taskQueue: {
        enqueue: async (projectPath: string, queuedPlan) => {
          enqueueCalls.push({ projectPath, plan: queuedPlan });
          return [];
        },
        getNext: async (projectPath: string) => {
          getNextCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return getNextCalls === 1 ? mockTask : null;
        },
      },
      claude: {
        plan: async () => {
          claudePlanCalls++;
          return {
            success: true,
            output: JSON.stringify({
              problemLegitimacy: 1,
              solutionProportionality: 1,
              expectedComplexity: 1,
              historicalSuccess: 1,
              reasoning: 'High value task',
            }),
            cost_usd: 0,
            duration_ms: 0,
          };
        },
      },
      taskStore: {
        addDailyCost: async (cost: number) => {
          addDailyCostCalls.push(cost);
        },
      },
    });

    const internals = getMainLoopInternals(loop);
    const executionInternals = getMainLoopExecutionInternals(loop);
    const originalPrepareTaskBranch = executionInternals.prepareTaskBranch;
    const originalExecuteSubtasks = executionInternals.executeSubtasks;
    const originalRunReviewCycle = executionInternals.runReviewCycle;
    const originalReflectOnTask = executionInternals.reflectOnTask;

    executionInternals.prepareTaskBranch = async () => {
      prepareTaskBranchCalls++;
      return { originalBranch: 'main', startCommit: '' };
    };
    executionInternals.executeSubtasks = async task => {
      executeSubtasksCalls++;
      return { subtasks: task.subtasks, stuckAdjustments: [], aborted: false };
    };
    executionInternals.runReviewCycle = async () => {
      runReviewCycleCalls++;
      return {
        aborted: false,
        reviewResult: { passed: false, mustFix: [], shouldFix: [], summary: 'Short-circuit review' },
        reviewRetries: 0,
      };
    };
    executionInternals.reflectOnTask = async () => {
      reflectOnTaskCalls++;
    };

    internals.setRunning(true);
    const { states, remove } = collectStates(loop);

    try {
      await loop.runCycle();
    } finally {
      remove();
      internals.setRunning(false);
      executionInternals.prepareTaskBranch = originalPrepareTaskBranch;
      executionInternals.executeSubtasks = originalExecuteSubtasks;
      executionInternals.runReviewCycle = originalRunReviewCycle;
      executionInternals.reflectOnTask = originalReflectOnTask;
    }

    const transitions = states
      .map(snapshot => snapshot.state)
      .filter((state, index, all) => index === 0 || all[index - 1] !== state);

    assert.deepEqual(transitions, ['scanning', 'planning', 'evaluating', 'executing', 'idle']);
    assert.deepEqual(addDailyCostCalls, [0.01, 0.005]);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0]?.projectPath, '/tmp/db-coder-main-loop-test');
    assert.equal(enqueueCalls[0]?.plan, plan);
    assert.equal(scanProjectCalls, 1);
    assert.equal(createPlanCalls, 1);
    assert.equal(claudePlanCalls, 1);
    assert.equal(getNextCalls, 2);
    assert.equal(prepareTaskBranchCalls, 1);
    assert.equal(executeSubtasksCalls, 1);
    assert.equal(runReviewCycleCalls, 1);
    assert.equal(reflectOnTaskCalls, 1);
  });

  test('no changes and no queued tasks — returns idle immediately', async () => {
    let scanProjectCalls = 0;
    let createPlanCalls = 0;
    let getNextCalls = 0;

    const { loop } = createMainLoopForCycle({
      brain: {
        hasChanges: async (projectPath: string) => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return false;
        },
        scanProject: async () => {
          scanProjectCalls++;
          return {
            analysis: { issues: [], opportunities: [], projectHealth: 100, summary: 'No changes' },
            cost: 0,
          };
        },
        createPlan: async () => {
          createPlanCalls++;
          return { plan: { tasks: [], reasoning: 'No tasks' }, cost: 0 };
        },
      },
      taskQueue: {
        getQueued: async (projectPath: string) => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return [];
        },
        getNext: async () => {
          getNextCalls++;
          return null;
        },
      },
    });

    const { states, remove } = collectStates(loop);
    await loop.runCycle();
    remove();

    assert.deepEqual(states.map(snapshot => snapshot.state), ['scanning', 'idle']);
    assert.equal(scanProjectCalls, 0);
    assert.equal(createPlanCalls, 0);
    assert.equal(getNextCalls, 0);
  });

  test('no changes but queued tasks — skips scan and processes queue', async () => {
    let scanProjectCalls = 0;
    let getQueuedCalls = 0;
    let getNextCalls = 0;
    let claudePlanCalls = 0;
    let prepareTaskBranchCalls = 0;
    let executeSubtasksCalls = 0;
    let runReviewCycleCalls = 0;
    let reflectOnTaskCalls = 0;

    const now = new Date();
    const mockTask: Task = {
      id: 'task-queued-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Process a queued task without scanning',
      phase: 'init',
      priority: 1,
      plan: null,
      subtasks: [{ id: 'S1', description: 'Apply queued fix', executor: 'codex', status: 'pending' }],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'queued',
      created_at: now,
      updated_at: now,
    };

    const { loop } = createMainLoopForCycle({
      brain: {
        hasChanges: async () => false,
        scanProject: async () => {
          scanProjectCalls++;
          return {
            analysis: { issues: [], opportunities: [], projectHealth: 100, summary: 'No changes' },
            cost: 0,
          };
        },
      },
      taskQueue: {
        getQueued: async (projectPath: string) => {
          getQueuedCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return [mockTask];
        },
        getNext: async (projectPath: string) => {
          getNextCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return getNextCalls === 1 ? mockTask : null;
        },
      },
      claude: {
        plan: async () => {
          claudePlanCalls++;
          return {
            success: true,
            output: JSON.stringify({
              problemLegitimacy: 1,
              solutionProportionality: 1,
              expectedComplexity: 1,
              historicalSuccess: 1,
              reasoning: 'Queued task is worth executing',
            }),
            cost_usd: 0,
            duration_ms: 0,
          };
        },
      },
    });

    const internals = getMainLoopInternals(loop);
    const executionInternals = getMainLoopExecutionInternals(loop);
    const originalPrepareTaskBranch = executionInternals.prepareTaskBranch;
    const originalExecuteSubtasks = executionInternals.executeSubtasks;
    const originalRunReviewCycle = executionInternals.runReviewCycle;
    const originalReflectOnTask = executionInternals.reflectOnTask;

    executionInternals.prepareTaskBranch = async () => {
      prepareTaskBranchCalls++;
      return { originalBranch: 'main', startCommit: '' };
    };
    executionInternals.executeSubtasks = async task => {
      executeSubtasksCalls++;
      return { subtasks: task.subtasks, stuckAdjustments: [], aborted: false };
    };
    executionInternals.runReviewCycle = async () => {
      runReviewCycleCalls++;
      return {
        aborted: false,
        reviewResult: { passed: false, mustFix: [], shouldFix: [], summary: 'Mock review failure' },
        reviewRetries: 0,
      };
    };
    executionInternals.reflectOnTask = async () => {
      reflectOnTaskCalls++;
    };

    try {
      internals.setRunning(true);
      await loop.runCycle();
    } finally {
      internals.setRunning(false);
      executionInternals.prepareTaskBranch = originalPrepareTaskBranch;
      executionInternals.executeSubtasks = originalExecuteSubtasks;
      executionInternals.runReviewCycle = originalRunReviewCycle;
      executionInternals.reflectOnTask = originalReflectOnTask;
    }

    assert.equal(scanProjectCalls, 0);
    assert.equal(getQueuedCalls, 1);
    assert.equal(getNextCalls, 2);
    assert.equal(claudePlanCalls, 1);
    assert.equal(prepareTaskBranchCalls, 1);
    assert.equal(executeSubtasksCalls, 1);
    assert.equal(runReviewCycleCalls, 1);
    assert.equal(reflectOnTaskCalls, 1);
  });
});

describe('MainLoop status listeners', () => {
  test('registers and removes listeners', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    const { states, remove } = collectStates(loop);

    internals.setState('scanning');
    assert.equal(states.length, 1);
    assert.equal(states[0]?.state, 'scanning');

    remove();
    internals.setState('planning');
    assert.equal(states.length, 1);
  });

  test('broadcasts latest state fields to listeners', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    const { states } = collectStates(loop);

    internals.setRunning(true);
    internals.setState('executing');
    internals.setCurrentTaskId('task-123');
    internals.setPaused(true);

    assert.deepEqual(states.at(-1), {
      state: 'executing',
      currentTaskId: 'task-123',
      patrolling: true,
      paused: true,
    });
  });

  test('does not broadcast when values do not change', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    let calls = 0;

    loop.addStatusListener(() => {
      calls++;
    });

    internals.setState('idle');
    internals.setCurrentTaskId(null);
    internals.setPaused(false);
    internals.setRunning(false);

    assert.equal(calls, 0);
  });

  test('continues broadcasting when one listener throws', () => {
    const loop = createMainLoop();
    const internals = getMainLoopInternals(loop);
    let received: StatusSnapshot | undefined;

    loop.addStatusListener(() => {
      throw new Error('listener failed');
    });
    loop.addStatusListener(snapshot => {
      received = snapshot;
    });

    assert.doesNotThrow(() => {
      internals.setState('scanning');
    });

    assert.deepEqual(received, {
      state: 'scanning',
      currentTaskId: null,
      patrolling: false,
      paused: false,
    });
  });
});

describe('MainLoop prompt effectiveness deltas', () => {
  test('applies positive delta to every active prompt version when task passed', async () => {
    const updates: Array<{ id: number; delta: number }> = [];
    const taskStore = {
      getActivePromptVersions: async () => [{ id: 101 }, { id: 202 }],
      updatePromptVersionEffectiveness: async (id: number, delta: number) => {
        updates.push({ id, delta });
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.deepEqual(updates, [
      { id: 101, delta: 0.1 },
      { id: 202, delta: 0.1 },
    ]);
  });

  test('applies negative delta when task failed', async () => {
    const updates: Array<{ id: number; delta: number }> = [];
    const taskStore = {
      getActivePromptVersions: async () => [{ id: 7 }],
      updatePromptVersionEffectiveness: async (id: number, delta: number) => {
        updates.push({ id, delta });
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(false);

    assert.deepEqual(updates, [{ id: 7, delta: -0.15 }]);
  });

  test('does nothing when there are no active prompt versions', async () => {
    let updateCalls = 0;
    const taskStore = {
      getActivePromptVersions: async () => [],
      updatePromptVersionEffectiveness: async () => {
        updateCalls++;
      },
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.equal(updateCalls, 0);
  });

  test('returns early when prompt registry is not set', async () => {
    let queried = false;
    const taskStore = {
      getActivePromptVersions: async () => {
        queried = true;
        return [];
      },
      updatePromptVersionEffectiveness: async () => {},
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);

    await getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true);

    assert.equal(queried, false);
  });

  test('swallows storage errors during prompt effectiveness updates', async () => {
    const taskStore = {
      getActivePromptVersions: async () => {
        throw new Error('db unavailable');
      },
      updatePromptVersionEffectiveness: async () => {},
    } as unknown as TaskStore;
    const loop = createMainLoopForPromptDelta(taskStore);
    loop.setPromptRegistry({} as PromptRegistry);

    await assert.doesNotReject(getPromptDeltaInternals(loop).updatePromptVersionEffectiveness(true));
  });
});

describe('MainLoop dedup helpers', () => {
  test('checkBudgetOrAbort continues when budget allows', async () => {
    let updateCalls = 0;
    const taskStore = {
      updateTask: async () => {
        updateCalls++;
      },
    } as unknown as TaskStore;
    const costTracker = {
      checkBudget: async (taskId: string) => {
        assert.equal(taskId, 'task-allow');
        return { allowed: true };
      },
    } as unknown as CostTracker;
    const loop = createMainLoopForDedupHelpers({ taskStore, costTracker });

    const aborted = await getDedupInternals(loop).checkBudgetOrAbort('task-allow');

    assert.equal(aborted, false);
    assert.equal(updateCalls, 0);
  });

  test('checkBudgetOrAbort blocks task when budget is exceeded', async () => {
    const updates: Array<{ taskId: string; patch: unknown }> = [];
    const taskStore = {
      updateTask: async (taskId: string, patch: unknown) => {
        updates.push({ taskId, patch });
      },
    } as unknown as TaskStore;
    const costTracker = {
      checkBudget: async () => ({ allowed: false, reason: 'hard limit reached' }),
    } as unknown as CostTracker;
    const loop = createMainLoopForDedupHelpers({ taskStore, costTracker });

    const aborted = await getDedupInternals(loop).checkBudgetOrAbort('task-block');

    assert.equal(aborted, true);
    assert.deepEqual(updates, [
      { taskId: 'task-block', patch: { status: 'blocked', phase: 'blocked' } },
    ]);
  });

  test('checkBudgetOrAbort handles empty task IDs as a boundary input', async () => {
    let seenTaskId: string | null = null;
    const costTracker = {
      checkBudget: async (taskId: string) => {
        seenTaskId = taskId;
        return { allowed: true };
      },
    } as unknown as CostTracker;
    const loop = createMainLoopForDedupHelpers({ costTracker, taskStore: {} as TaskStore });

    const aborted = await getDedupInternals(loop).checkBudgetOrAbort('');

    assert.equal(aborted, false);
    assert.equal(seenTaskId, '');
  });

  test('cleanupTaskBranch deletes an existing branch', async () => {
    const { repoPath, defaultBranch } = await initGitRepo();
    try {
      await runGit(repoPath, ['checkout', '-b', 'db-task-cleanup']);
      await runGit(repoPath, ['checkout', defaultBranch]);

      const loop = createMainLoopForDedupHelpers({ projectPath: repoPath, taskStore: {} as TaskStore, costTracker: {} as CostTracker });
      await getDedupInternals(loop).cleanupTaskBranch('db-task-cleanup');

      const branchList = await runGit(repoPath, ['branch', '--list', 'db-task-cleanup']);
      assert.equal(branchList, '');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('cleanupTaskBranch swallows cleanup errors', async () => {
    const loop = createMainLoopForDedupHelpers({
      projectPath: '/tmp/non-existent-main-loop-repo',
      taskStore: {} as TaskStore,
      costTracker: {} as CostTracker,
    });

    await assert.doesNotReject(getDedupInternals(loop).cleanupTaskBranch('missing-branch'));
  });

  test('cleanupTaskBranch tolerates empty branch names', async () => {
    const { repoPath } = await initGitRepo();
    try {
      const loop = createMainLoopForDedupHelpers({ projectPath: repoPath, taskStore: {} as TaskStore, costTracker: {} as CostTracker });
      await assert.doesNotReject(getDedupInternals(loop).cleanupTaskBranch(''));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('tryProcessAdjustments forwards adjustments to the evolution engine', async () => {
    const calls: Array<[string, string | null, string[], string]> = [];
    const loop = createMainLoopForDedupHelpers({
      taskStore: {} as TaskStore,
      costTracker: {} as CostTracker,
    });
    loop.setEvolutionEngine({
      processAdjustments: async (
        projectPath: string,
        taskId: string | null,
        adjustments: string[],
        outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
      ) => {
        calls.push([projectPath, taskId, adjustments, outcome]);
      },
    } as unknown as EvolutionEngine);

    await getDedupInternals(loop).tryProcessAdjustments('task-adjust', ['prefer smaller patches'], 'failed');

    assert.deepEqual(calls, [[
      '/tmp/db-coder-main-loop-test',
      'task-adjust',
      ['prefer smaller patches'],
      'failed',
    ]]);
  });

  test('tryProcessAdjustments swallows evolution-engine failures', async () => {
    const loop = createMainLoopForDedupHelpers({
      taskStore: {} as TaskStore,
      costTracker: {} as CostTracker,
    });
    loop.setEvolutionEngine({
      processAdjustments: async () => {
        throw new Error('write failed');
      },
    } as unknown as EvolutionEngine);

    await assert.doesNotReject(
      getDedupInternals(loop).tryProcessAdjustments('task-adjust', ['a'], 'blocked_stuck'),
    );
  });

  test('tryProcessAdjustments no-ops for empty adjustments and missing engine', async () => {
    let calls = 0;
    const loop = createMainLoopForDedupHelpers({
      taskStore: {} as TaskStore,
      costTracker: {} as CostTracker,
    });
    loop.setEvolutionEngine({
      processAdjustments: async () => {
        calls++;
      },
    } as unknown as EvolutionEngine);

    await getDedupInternals(loop).tryProcessAdjustments('task-adjust', [], 'success');
    assert.equal(calls, 0);

    const loopWithoutEngine = createMainLoopForDedupHelpers({
      taskStore: {} as TaskStore,
      costTracker: {} as CostTracker,
    });
    await assert.doesNotReject(
      getDedupInternals(loopWithoutEngine).tryProcessAdjustments('task-adjust', ['x'], 'success'),
    );
  });
});
