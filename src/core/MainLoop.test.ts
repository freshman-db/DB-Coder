import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/Config.js';
import type { ClaudeBridge } from '../bridges/ClaudeBridge.js';
import type { CodexBridge } from '../bridges/CodexBridge.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { ProjectAnalysis, Task } from '../memory/types.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { CostTracker } from '../utils/cost.js';
import type { Brain } from './Brain.js';
import type { TaskQueue } from './TaskQueue.js';
import type { PromptRegistry } from '../prompts/PromptRegistry.js';
import { MainLoop, countTscErrors, extractIssueCategories, mergeReviews, setCountTscErrorsDepsForTests } from './MainLoop.js';
import type { EvaluationResult, MergedReviewResult, StatusSnapshot } from './types.js';
import type { ReviewIssue, ReviewResult } from '../bridges/CodingAgent.js';
import type { EvolutionEngine } from '../evolution/EvolutionEngine.js';
import { runProcess } from '../utils/process.js';
import type { LogEntry } from '../utils/logger.js';
import { log } from '../utils/logger.js';

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

type MainLoopEvaluationInternals = {
  evaluateTaskValue(task: Task, projectPath: string): Promise<EvaluationResult>;
};

type MainLoopReviewInternals = {
  runReviewCycle(
    task: Task,
    startCommit: string,
    stuckAdjustments: string[],
    projectPath: string,
  ): Promise<{ aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number }>;
  dualReview(
    task: Task,
    changedFiles: string[],
    reviewRetries: number,
  ): Promise<{ merged: MergedReviewResult; decision: 'approve' | 'retry' | 'reject'; cost_usd: number; duration_ms: number }>;
  buildFixPrompt(task: Task, reviewResult: MergedReviewResult, attempt: number, stuckAdjustments: string[]): Promise<string>;
  saveReviewEvent(
    taskId: string,
    attempt: number,
    result: MergedReviewResult,
    fixAgent: string | null,
    cost_usd: number,
    duration_ms: number,
  ): Promise<void>;
  checkBudgetOrAbort(taskId: string): Promise<boolean>;
};

type MainLoopStuckInternals = {
  handleStuck(
    task: Task,
    subtask: Task['subtasks'][number],
    error: string,
    stuckAdjustments: string[],
    iteration: number,
    maxRetries: number,
  ): Promise<boolean>;
  tryProcessAdjustments(
    taskId: string | null,
    adjustments: string[],
    outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
    appliedAdjustmentIds?: number[],
    errorContext?: string,
  ): Promise<void>;
};

type MainLoopPostExecutionInternals = {
  postExecutionCheck(
    baselineErrors: number,
    startCommit: string,
    projectPath: string,
  ): Promise<{ passed: boolean; reason?: string }>;
};

type TaskLogInsert = {
  task_id: string;
  phase: string;
  agent: string;
  input_summary: string | null;
  output_summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
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
    getModules: async () => [],
    getServiceState: async () => null,
    setServiceState: async () => {},
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

function getMainLoopEvaluationInternals(loop: MainLoop): MainLoopEvaluationInternals {
  return loop as unknown as MainLoopEvaluationInternals;
}

function getMainLoopReviewInternals(loop: MainLoop): MainLoopReviewInternals {
  return loop as unknown as MainLoopReviewInternals;
}

function getMainLoopStuckInternals(loop: MainLoop): MainLoopStuckInternals {
  return loop as unknown as MainLoopStuckInternals;
}

function getMainLoopPostExecutionInternals(loop: MainLoop): MainLoopPostExecutionInternals {
  return loop as unknown as MainLoopPostExecutionInternals;
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

function tscOutputWithErrors(count: number): string {
  return Array.from({ length: count }, (_, index) => (
    `src/file${index + 1}.ts(${index + 1},1): error TS2${index + 300}: synthetic error ${index + 1}`
  )).join('\n');
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

describe('mergeReviews safety', () => {
  const review = (
    source: 'claude' | 'codex',
    overrides: Partial<ReviewResult> = {},
  ): ReviewResult => ({
    passed: true,
    issues: [],
    summary: `${source} review`,
    cost_usd: 0,
    ...overrides,
  });

  const reviewIssue = (
    source: 'claude' | 'codex',
    severity: ReviewIssue['severity'] = 'high',
  ): ReviewIssue => ({
    description: 'Missing null guard before property access',
    file: 'src/core/MainLoop.ts',
    severity,
    source,
  });

  const detailedReviewIssue = (
    source: 'claude' | 'codex',
    overrides: Partial<Omit<ReviewIssue, 'source'>> = {},
  ): ReviewIssue => ({
    description: 'Missing null guard before property access',
    file: 'src/core/MainLoop.ts',
    severity: 'high',
    source,
    ...overrides,
  });

  test('both reviewers pass with empty issues', () => {
    const merged = mergeReviews(
      review('claude', { passed: true, issues: [] }),
      review('codex', { passed: true, issues: [] }),
    );

    assert.equal(merged.passed, true);
    assert.deepEqual(merged.mustFix, []);
    assert.deepEqual(merged.shouldFix, []);
  });

  test('claude-only issue becomes shouldFix', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'a.ts',
      description: 'Claude-only issue',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [] }),
    );

    assert.deepEqual(merged.mustFix, []);
    assert.deepEqual(merged.shouldFix, [claudeIssue]);
    assert.equal(merged.passed, true);
  });

  test('codex-only issue becomes shouldFix', () => {
    const codexIssue = detailedReviewIssue('codex', {
      file: 'a.ts',
      description: 'Codex-only issue',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.deepEqual(merged.mustFix, []);
    assert.deepEqual(merged.shouldFix, [codexIssue]);
    assert.equal(merged.passed, true);
  });

  test('severity escalation medium+high -> high', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'x.ts',
      description: 'null check missing in handler',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: 'x.ts',
      description: 'null check missing in handler',
      severity: 'high',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.mustFix[0]?.severity, 'high');
    assert.deepEqual(merged.shouldFix, []);
    assert.equal(merged.passed, false);
  });

  test('severity escalation low+critical -> critical', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'x.ts',
      description: 'guard missing in parser',
      severity: 'low',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: 'x.ts',
      description: 'guard missing in parser',
      severity: 'critical',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.mustFix[0]?.severity, 'critical');
    assert.deepEqual(merged.shouldFix, []);
    assert.equal(merged.passed, false);
  });

  test('undefined file does not create false intersection', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: undefined,
      description: 'handler crashes because null guard is missing before property access',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: undefined,
      description: 'add null guard before property access to avoid handler crash',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 0);
    assert.deepEqual(merged.shouldFix, [claudeIssue, codexIssue]);
    assert.equal(merged.passed, true);
  });

  test('same-file issues with Jaccard similarity above threshold intersect', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'a.ts',
      description: 'handler crashes because null guard is missing before property access',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: 'a.ts',
      description: 'add null guard before property access to avoid handler crash',
      severity: 'high',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.mustFix[0]?.file, 'a.ts');
    assert.equal(merged.mustFix[0]?.severity, 'high');
    assert.deepEqual(merged.shouldFix, []);
    assert.equal(merged.passed, false);
  });

  test('same-file issues with Jaccard similarity below threshold stay in shouldFix', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'a.ts',
      description: 'handler crashes because null guard is missing before property access',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: 'a.ts',
      description: 'revise analytics widget colors and alignment for the dashboard',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 0);
    assert.deepEqual(merged.shouldFix, [claudeIssue, codexIssue]);
    assert.equal(merged.passed, true);
  });

  test('issue with file does not intersect issue without file even when descriptions match', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'a.ts',
      description: 'missing null guard before property access',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: undefined,
      description: 'missing null guard before property access',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 0);
    assert.deepEqual(merged.shouldFix, [claudeIssue, codexIssue]);
  });

  test('codex-only dedup uses fuzzy matching for intersected mustFix issues', () => {
    const sharedClaudeIssue = detailedReviewIssue('claude', {
      file: 'shared.ts',
      description: 'handler crashes because null guard is missing before property access',
      severity: 'medium',
    });
    const sharedCodexIssue = detailedReviewIssue('codex', {
      file: 'shared.ts',
      description: 'add null guard before property access to avoid handler crash',
      severity: 'medium',
    });
    const codexOnlyIssue = detailedReviewIssue('codex', {
      file: 'codex-only.ts',
      description: 'codex-only issue',
      severity: 'low',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [sharedClaudeIssue] }),
      review('codex', { passed: true, issues: [sharedCodexIssue, codexOnlyIssue] }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.deepEqual(merged.shouldFix, [codexOnlyIssue]);
    assert.equal(merged.mustFix.length + merged.shouldFix.length, 2);
  });

  test('medium-only mustFix still passes', () => {
    const claudeIssue = detailedReviewIssue('claude', {
      file: 'medium.ts',
      description: 'medium severity shared issue',
      severity: 'medium',
    });
    const codexIssue = detailedReviewIssue('codex', {
      file: 'medium.ts',
      description: 'medium severity shared issue',
      severity: 'medium',
    });

    const merged = mergeReviews(
      review('claude', { passed: true, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.mustFix[0]?.severity, 'medium');
    assert.deepEqual(merged.shouldFix, []);
    assert.equal(merged.passed, true);
  });

  test('complex multi-issue partition', () => {
    const claudeIssues = [
      detailedReviewIssue('claude', {
        file: 'a.ts',
        description: 'null check missing in handler',
        severity: 'medium',
      }),
      detailedReviewIssue('claude', {
        file: 'b.ts',
        description: 'unrelated',
        severity: 'low',
      }),
    ];
    const codexIssues = [
      detailedReviewIssue('codex', {
        file: 'a.ts',
        description: 'null check missing in handler before property read',
        severity: 'high',
      }),
      detailedReviewIssue('codex', {
        file: 'c.ts',
        description: 'other thing',
        severity: 'medium',
      }),
    ];

    const merged = mergeReviews(
      review('claude', { passed: true, issues: claudeIssues }),
      review('codex', { passed: true, issues: codexIssues }),
    );

    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.mustFix[0]?.file, 'a.ts');
    assert.equal(merged.mustFix[0]?.severity, 'high');
    assert.equal(merged.shouldFix.length, 2);
    assert.ok(merged.shouldFix.some(i => i.file === 'b.ts' && i.description === 'unrelated' && i.source === 'claude'));
    assert.ok(!merged.shouldFix.some(i => i.file === 'a.ts' && i.source === 'codex'));
    assert.ok(merged.shouldFix.some(i => i.file === 'c.ts' && i.description === 'other thing' && i.source === 'codex'));
  });

  test('claude raw fail blocks merge result', () => {
    const merged = mergeReviews(
      review('claude', { passed: false, issues: [] }),
      review('codex', { passed: true, issues: [] }),
    );

    assert.equal(merged.passed, false);
    assert.equal(merged.mustFix.length, 0);
    assert.equal(merged.shouldFix.length, 1);
    assert.deepEqual(merged.shouldFix[0], {
      description: 'Claude reviewer explicitly failed without structured issues',
      severity: 'medium',
      source: 'claude',
    });
  });

  test('codex raw fail blocks merge result', () => {
    const merged = mergeReviews(
      review('claude', { passed: true, issues: [] }),
      review('codex', { passed: false, issues: [] }),
    );

    assert.equal(merged.passed, false);
    assert.equal(merged.mustFix.length, 0);
    assert.equal(merged.shouldFix.length, 1);
    assert.deepEqual(merged.shouldFix[0], {
      description: 'Codex reviewer explicitly failed without structured issues',
      severity: 'medium',
      source: 'codex',
    });
  });

  test('both raw fails add two synthetic should-fix issues', () => {
    const merged = mergeReviews(
      review('claude', { passed: false, issues: [] }),
      review('codex', { passed: false, issues: [] }),
    );

    assert.equal(merged.passed, false);
    assert.equal(merged.mustFix.length, 0);
    assert.equal(merged.shouldFix.length, 2);
    assert.equal(
      merged.shouldFix.filter(issue => issue.description.includes('explicitly failed without structured issues')).length,
      2,
    );
  });

  test('non-empty issues prevent raw fail synthesis and use normal merge logic', () => {
    const claudeIssue = reviewIssue('claude', 'high');
    const codexIssue = reviewIssue('codex', 'high');
    const merged = mergeReviews(
      review('claude', { passed: false, issues: [claudeIssue] }),
      review('codex', { passed: true, issues: [codexIssue] }),
    );

    assert.equal(merged.passed, false);
    assert.equal(merged.mustFix.length, 1);
    assert.equal(merged.shouldFix.length, 0);
    assert.equal(merged.mustFix[0]?.description, 'Missing null guard before property access');
    assert.ok(!merged.shouldFix.some(issue => issue.description.includes('explicitly failed without structured issues')));
  });

  test('intersecting issues still drive must-fix severity behavior', () => {
    const mediumMerged = mergeReviews(
      review('claude', { passed: true, issues: [reviewIssue('claude', 'medium')] }),
      review('codex', { passed: true, issues: [reviewIssue('codex', 'medium')] }),
    );
    assert.equal(mediumMerged.mustFix.length, 1);
    assert.equal(mediumMerged.passed, true);

    const highMerged = mergeReviews(
      review('claude', { passed: true, issues: [reviewIssue('claude', 'high')] }),
      review('codex', { passed: true, issues: [reviewIssue('codex', 'high')] }),
    );
    assert.equal(highMerged.mustFix.length, 1);
    assert.equal(highMerged.passed, false);
  });

  test('synthetic should-fix issues preserve reviewer source', () => {
    const merged = mergeReviews(
      review('claude', { passed: false, issues: [] }),
      review('codex', { passed: false, issues: [] }),
    );

    const syntheticSources = merged.shouldFix
      .filter(issue => issue.description.includes('explicitly failed without structured issues'))
      .map(issue => issue.source)
      .sort();

    assert.deepEqual(syntheticSources, ['claude', 'codex']);
  });
});

describe('MainLoop handleReviewResult decision logic', () => {
  const review = (
    source: 'claude' | 'codex',
    overrides: Partial<ReviewResult> = {},
  ): ReviewResult => ({
    passed: true,
    issues: [],
    summary: `${source} review`,
    cost_usd: 0,
    ...overrides,
  });

  const createFailedReviews = (): { claudeReview: ReviewResult; codexReview: ReviewResult } => {
    const description = 'Critical null guard missing before property access';
    const file = 'src/core/MainLoop.ts';

    return {
      claudeReview: review('claude', {
        passed: false,
        issues: [{ description, file, severity: 'critical', source: 'claude' }],
      }),
      codexReview: review('codex', {
        passed: true,
        issues: [{ description, file, severity: 'medium', source: 'codex' }],
      }),
    };
  };

  const invokeHandleReviewResult = (
    claudeReview: ReviewResult,
    codexReview: ReviewResult,
    reviewRetries: number,
    maxRetries = 3,
  ): ReturnType<typeof MainLoop.prototype['handleReviewResult']> => {
    const { loop } = createMainLoopForCycle({
      config: { values: { autonomy: { maxRetries } } },
    });
    const asAny = loop as unknown as {
      handleReviewResult: typeof MainLoop.prototype['handleReviewResult'];
    };
    return asAny.handleReviewResult(claudeReview, codexReview, reviewRetries);
  };

  test('approves when mergeReviews returns passed:true', () => {
    const result = invokeHandleReviewResult(
      review('claude', { passed: true, issues: [] }),
      review('codex', { passed: true, issues: [] }),
      0,
      3,
    );

    assert.equal(result.merged.passed, true);
    assert.equal(result.decision, 'approve');
  });

  test('retries when failed and retries < maxRetries', () => {
    const { claudeReview, codexReview } = createFailedReviews();
    const result = invokeHandleReviewResult(claudeReview, codexReview, 1, 3);

    assert.equal(result.merged.passed, false);
    assert.equal(result.decision, 'retry');
  });

  test('rejects when failed and retries >= maxRetries', () => {
    const { claudeReview, codexReview } = createFailedReviews();
    const result = invokeHandleReviewResult(claudeReview, codexReview, 3, 3);

    assert.equal(result.merged.passed, false);
    assert.equal(result.decision, 'reject');
  });

  test('rejects at exactly maxRetries boundary', () => {
    const { claudeReview, codexReview } = createFailedReviews();
    const result = invokeHandleReviewResult(claudeReview, codexReview, 3, 3);

    assert.equal(result.decision, 'reject');
  });

  test('retry at maxRetries-1', () => {
    const { claudeReview, codexReview } = createFailedReviews();
    const result = invokeHandleReviewResult(claudeReview, codexReview, 2, 3);

    assert.equal(result.decision, 'retry');
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
    const evaluationEvents: Array<{ task_id: string; passed: boolean; cost_usd: number }> = [];
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
            cost_usd: 0.002,
            duration_ms: 25,
          };
        },
      },
      taskStore: {
        addDailyCost: async (cost: number) => {
          addDailyCostCalls.push(cost);
        },
        saveEvaluationEvent: async event => {
          evaluationEvents.push(event as { task_id: string; passed: boolean; cost_usd: number });
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
    assert.deepEqual(addDailyCostCalls, [0.01, 0.005, 0.002]);
    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0]?.projectPath, '/tmp/db-coder-main-loop-test');
    assert.equal(enqueueCalls[0]?.plan, plan);
    assert.equal(evaluationEvents.length, 1);
    assert.equal(evaluationEvents[0]?.task_id, 'task-happy-1');
    assert.equal(evaluationEvents[0]?.passed, true);
    assert.equal(evaluationEvents[0]?.cost_usd, 0.002);
    assert.equal(scanProjectCalls, 1);
    assert.equal(createPlanCalls, 1);
    assert.equal(claudePlanCalls, 1);
    assert.equal(getNextCalls, 2);
    assert.equal(prepareTaskBranchCalls, 1);
    assert.equal(executeSubtasksCalls, 1);
    assert.equal(runReviewCycleCalls, 1);
    assert.equal(reflectOnTaskCalls, 1);
  });

  test('evolution engine assessment error — caught and continues', async () => {
    let assessGoalProgressCalls = 0;
    let applyPendingProposalsCalls = 0;
    let getNextCalls = 0;
    let prepareTaskBranchCalls = 0;
    let executeSubtasksCalls = 0;
    let runReviewCycleCalls = 0;
    let reflectOnTaskCalls = 0;
    const logs: LogEntry[] = [];

    const now = new Date();
    const scanAnalysis = {
      issues: [{ type: 'bugfix', severity: 'medium' as const, description: 'Fix stale cached query results' }],
      opportunities: [],
      projectHealth: 82,
      summary: 'One stale-cache issue found',
    };
    const plan = {
      tasks: [{
        id: 'T-EVO-1',
        description: 'Fix stale cached query results',
        priority: 1,
        executor: 'codex' as const,
        subtasks: [{ id: 'S1', description: 'Adjust cache invalidation', executor: 'codex' as const }],
        dependsOn: [],
        estimatedComplexity: 'low' as const,
      }],
      reasoning: 'Address stale cache behavior',
    };
    const mockTask: Task = {
      id: 'task-evo-error-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Fix stale cached query results',
      phase: 'init',
      priority: 1,
      plan: plan.tasks[0],
      subtasks: [{ id: 'S1', description: 'Adjust cache invalidation', executor: 'codex', status: 'pending' }],
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
        hasChanges: async () => true,
        scanProject: async () => ({ analysis: scanAnalysis, cost: 0 }),
        createPlan: async () => ({ plan, cost: 0 }),
      },
      taskQueue: {
        enqueue: async () => [],
        getNext: async () => {
          getNextCalls++;
          return getNextCalls === 1 ? mockTask : null;
        },
      },
      taskStore: {
        getLastScan: async projectPath => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return {
            id: 17,
            project_path: projectPath,
            commit_hash: 'abc123',
            depth: 'normal',
            result: scanAnalysis,
            health_score: 82,
            cost_usd: 0,
            module_name: null,
            created_at: now,
          };
        },
      },
    });

    loop.setEvolutionEngine({
      assessGoalProgress: async (projectPath: string, analysis: ProjectAnalysis, scanId: number | null) => {
        assessGoalProgressCalls++;
        assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
        assert.equal(analysis, scanAnalysis);
        assert.equal(scanId, 17);
        throw new Error('db fail');
      },
      applyPendingProposals: async () => {
        applyPendingProposalsCalls++;
      },
    } as unknown as EvolutionEngine);

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
        reviewResult: { passed: false, mustFix: [], shouldFix: [], summary: 'Mock review outcome' },
        reviewRetries: 0,
      };
    };
    executionInternals.reflectOnTask = async () => {
      reflectOnTaskCalls++;
    };

    const removeLogListener = log.addListener(entry => {
      logs.push(entry);
    });
    internals.setRunning(true);
    const { states, remove } = collectStates(loop);
    try {
      await assert.doesNotReject(loop.runCycle());
    } finally {
      removeLogListener();
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

    assert.equal(assessGoalProgressCalls, 1);
    assert.equal(applyPendingProposalsCalls, 0);
    assert.equal(getNextCalls, 2);
    assert.equal(prepareTaskBranchCalls, 1);
    assert.equal(executeSubtasksCalls, 1);
    assert.equal(runReviewCycleCalls, 1);
    assert.equal(reflectOnTaskCalls, 1);
    assert.deepEqual(transitions, ['scanning', 'planning', 'evaluating', 'executing', 'idle']);
    assert.ok(
      logs.some(entry => entry.level === 'warn' && entry.message.includes('Evolution goal assessment failed: Error: db fail')),
      'Expected warning log for evolution assessment failure',
    );
  });

  test('scan finds no actionable items — planning skipped', async () => {
    let createPlanCalls = 0;
    let enqueueCalls = 0;
    let getNextCalls = 0;
    const logs: LogEntry[] = [];

    const { loop } = createMainLoopForCycle({
      brain: {
        hasChanges: async (projectPath: string) => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return true;
        },
        scanProject: async (projectPath: string) => {
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return {
            analysis: {
              issues: [],
              opportunities: [],
              projectHealth: 95,
              summary: 'No actionable items found',
            },
            cost: 0,
          };
        },
        createPlan: async () => {
          createPlanCalls++;
          return { plan: { tasks: [], reasoning: 'Should not run' }, cost: 0 };
        },
      },
      taskQueue: {
        enqueue: async () => {
          enqueueCalls++;
          return [];
        },
        getNext: async () => {
          getNextCalls++;
          return null;
        },
      },
    });

    const { states, remove } = collectStates(loop);
    const removeLogListener = log.addListener(entry => {
      logs.push(entry);
    });

    try {
      await loop.runCycle();
    } finally {
      removeLogListener();
      remove();
    }

    assert.equal(createPlanCalls, 0);
    assert.equal(enqueueCalls, 0);
    assert.equal(getNextCalls, 1);
    assert.deepEqual(states.map(snapshot => snapshot.state), ['scanning', 'idle']);
    assert.ok(
      logs.some(entry => entry.level === 'info' && entry.message.includes('no actionable items')),
      'Expected an info log mentioning no actionable items',
    );
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

  test('budget exceeded — task loop breaks before evaluation and execution', async () => {
    let getQueuedCalls = 0;
    let getNextCalls = 0;
    let checkBudgetCalls = 0;
    let evaluateTaskValueCalls = 0;
    let executeTaskCalls = 0;
    const updates: Array<{ taskId: string; patch: unknown }> = [];

    const now = new Date();
    const queuedTask: Task = {
      id: 'task-budget-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Task should be blocked by budget guard',
      phase: 'init',
      priority: 1,
      plan: null,
      subtasks: [{ id: 'S1', description: 'Should never execute', executor: 'codex', status: 'pending' }],
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
          return false;
        },
      },
      taskQueue: {
        getQueued: async (projectPath: string) => {
          getQueuedCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return [queuedTask];
        },
        getNext: async (projectPath: string) => {
          getNextCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          return queuedTask;
        },
      },
      taskStore: {
        updateTask: async (taskId: string, patch: unknown) => {
          updates.push({ taskId, patch });
        },
      },
      costTracker: {
        checkBudget: async (taskId: string) => {
          checkBudgetCalls++;
          assert.equal(taskId, 'task-budget-1');
          return { allowed: false, reason: 'limit' };
        },
      },
    });

    const internals = getMainLoopInternals(loop);
    const loopWithTaskMethods = loop as unknown as {
      evaluateTaskValue(task: Task, projectPath: string): Promise<unknown>;
      executeTask(task: Task): Promise<void>;
    };
    const originalEvaluateTaskValue = loopWithTaskMethods.evaluateTaskValue;
    const originalExecuteTask = loopWithTaskMethods.executeTask;

    loopWithTaskMethods.evaluateTaskValue = async () => {
      evaluateTaskValueCalls++;
      return {
        passed: true,
        score: {
          problemLegitimacy: 1,
          solutionProportionality: 1,
          expectedComplexity: 1,
          historicalSuccess: 1,
          total: 4,
        },
        reasoning: 'Should not be reached',
        cost_usd: 0,
        duration_ms: 0,
      };
    };
    loopWithTaskMethods.executeTask = async () => {
      executeTaskCalls++;
    };

    internals.setRunning(true);
    const { states, remove } = collectStates(loop);

    try {
      await loop.runCycle();
    } finally {
      remove();
      internals.setRunning(false);
      loopWithTaskMethods.evaluateTaskValue = originalEvaluateTaskValue;
      loopWithTaskMethods.executeTask = originalExecuteTask;
    }

    assert.equal(getQueuedCalls, 1);
    assert.equal(getNextCalls, 1);
    assert.equal(checkBudgetCalls, 1);
    assert.equal(evaluateTaskValueCalls, 0);
    assert.equal(executeTaskCalls, 0);
    assert.deepEqual(states.map(snapshot => snapshot.state), ['scanning', 'idle']);
    assert.equal(loop.getState(), 'idle');
    assert.deepEqual(updates, [
      {
        taskId: 'task-budget-1',
        patch: { status: 'blocked', phase: 'blocked' },
      },
    ]);
  });

  test('evaluation rejects task — task marked pending_review, executeTask not called', async () => {
    let getQueuedCalls = 0;
    let getNextCalls = 0;
    let executeTaskCalls = 0;
    const addDailyCostCalls: number[] = [];
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];
    const evaluationEvents: Array<{ task_id: string; passed: boolean; score: { total: number }; cost_usd: number }> = [];

    const now = new Date();
    const mockTask: Task = {
      id: 'task-rejected-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Low value task that should be reviewed first',
      phase: 'init',
      priority: 2,
      plan: null,
      subtasks: [{ id: 'S1', description: 'Should never execute', executor: 'codex', status: 'pending' }],
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
        plan: async () => ({
          success: true,
          output: JSON.stringify({
            problemLegitimacy: -1,
            solutionProportionality: -1,
            expectedComplexity: 0,
            historicalSuccess: 0,
            reasoning: 'Task has negative ROI right now',
          }),
          cost_usd: 0.003,
          duration_ms: 30,
        }),
      },
      taskStore: {
        addDailyCost: async (cost: number) => {
          addDailyCostCalls.push(cost);
        },
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch });
        },
        saveEvaluationEvent: async (event: unknown) => {
          evaluationEvents.push(event as { task_id: string; passed: boolean; score: { total: number }; cost_usd: number });
        },
      },
    });

    const internals = getMainLoopInternals(loop);
    const loopWithExecuteTask = loop as unknown as { executeTask(task: Task): Promise<void> };
    const originalExecuteTask = loopWithExecuteTask.executeTask;
    loopWithExecuteTask.executeTask = async () => {
      executeTaskCalls++;
    };

    try {
      internals.setRunning(true);
      await loop.runCycle();
    } finally {
      internals.setRunning(false);
      loopWithExecuteTask.executeTask = originalExecuteTask;
    }

    assert.equal(getQueuedCalls, 1);
    assert.equal(getNextCalls, 2);
    assert.equal(executeTaskCalls, 0);
    assert.deepEqual(addDailyCostCalls, [0.003]);
    assert.deepEqual(updateTaskCalls, [{
      taskId: 'task-rejected-1',
      patch: {
        status: 'pending_review',
        evaluation_score: {
          problemLegitimacy: -1,
          solutionProportionality: -1,
          expectedComplexity: 0,
          historicalSuccess: 0,
          total: -2,
        },
        evaluation_reasoning: 'Task has negative ROI right now',
      },
    }]);
    assert.equal(evaluationEvents.length, 1);
    assert.equal(evaluationEvents[0]?.task_id, 'task-rejected-1');
    assert.equal(evaluationEvents[0]?.passed, false);
    assert.equal(evaluationEvents[0]?.score.total, -2);
    assert.equal(evaluationEvents[0]?.cost_usd, 0.003);
  });

  test('evaluation boundary total=0 rejects task — task marked pending_review, executeTask not called', async () => {
    let getQueuedCalls = 0;
    let getNextCalls = 0;
    let executeTaskCalls = 0;
    const addDailyCostCalls: number[] = [];
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];
    const evaluationEvents: Array<{ task_id: string; passed: boolean; score: { total: number } }> = [];

    const now = new Date();
    const mockTask: Task = {
      id: 'task-boundary-0',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Task with neutral value should be reviewed',
      phase: 'init',
      priority: 2,
      plan: null,
      subtasks: [{ id: 'S1', description: 'Should not execute at total=0', executor: 'codex', status: 'pending' }],
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
        plan: async () => ({
          success: true,
          output: JSON.stringify({
            problemLegitimacy: 0,
            solutionProportionality: 0,
            expectedComplexity: 0,
            historicalSuccess: 0,
            reasoning: 'Boundary total should fail',
          }),
          cost_usd: 0,
          duration_ms: 0,
        }),
      },
      taskStore: {
        addDailyCost: async (cost: number) => {
          addDailyCostCalls.push(cost);
        },
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch });
        },
        saveEvaluationEvent: async (event: unknown) => {
          evaluationEvents.push(event as { task_id: string; passed: boolean; score: { total: number } });
        },
      },
    });

    const internals = getMainLoopInternals(loop);
    const loopWithExecuteTask = loop as unknown as { executeTask(task: Task): Promise<void> };
    const originalExecuteTask = loopWithExecuteTask.executeTask;
    loopWithExecuteTask.executeTask = async () => {
      executeTaskCalls++;
    };

    try {
      internals.setRunning(true);
      await loop.runCycle();
    } finally {
      internals.setRunning(false);
      loopWithExecuteTask.executeTask = originalExecuteTask;
    }

    assert.equal(getQueuedCalls, 1);
    assert.equal(getNextCalls, 2);
    assert.equal(executeTaskCalls, 0);
    assert.deepEqual(addDailyCostCalls, []);
    assert.deepEqual(updateTaskCalls, [{
      taskId: 'task-boundary-0',
      patch: {
        status: 'pending_review',
        evaluation_score: {
          problemLegitimacy: 0,
          solutionProportionality: 0,
          expectedComplexity: 0,
          historicalSuccess: 0,
          total: 0,
        },
        evaluation_reasoning: 'Boundary total should fail',
      },
    }]);
    assert.equal(evaluationEvents.length, 1);
    assert.equal(evaluationEvents[0]?.task_id, 'task-boundary-0');
    assert.equal(evaluationEvents[0]?.passed, false);
    assert.equal(evaluationEvents[0]?.score.total, 0);
  });

  test('evaluateTaskValue fail-open on claude.plan error and passes internal MCP server', async () => {
    const now = new Date();
    const mockTask: Task = {
      id: 'task-eval-error-1',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Evaluation should fail open on bridge error',
      phase: 'init',
      priority: 1,
      plan: null,
      subtasks: [{ id: 'S1', description: 'Subtask for evaluation context', executor: 'codex', status: 'pending' }],
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

    let planCalls = 0;
    let internalMcpServers: Record<string, unknown> | undefined;

    const { loop } = createMainLoopForCycle({
      claude: {
        plan: async (_prompt: string, projectPath: string, options?: { internalMcpServers?: Record<string, unknown> }) => {
          planCalls++;
          assert.equal(projectPath, '/tmp/db-coder-main-loop-test');
          internalMcpServers = options?.internalMcpServers;
          throw new Error('claude plan exploded');
        },
      },
    });

    const evaluationInternals = getMainLoopEvaluationInternals(loop);
    const result = await evaluationInternals.evaluateTaskValue(mockTask, '/tmp/db-coder-main-loop-test');

    assert.equal(planCalls, 1);
    assert.equal(result.passed, true);
    assert.equal(result.score.problemLegitimacy, 0);
    assert.equal(result.score.solutionProportionality, 0);
    assert.equal(result.score.expectedComplexity, 0);
    assert.equal(result.score.historicalSuccess, 0);
    assert.equal(result.score.total, 1);
    assert.equal(result.cost_usd, 0);
    assert.ok(result.duration_ms >= 0);
    assert.match(result.reasoning, /Evaluation error: Error: claude plan exploded/);
    assert.ok(internalMcpServers, 'Expected internal MCP servers to be passed to claude.plan');
    assert.ok(
      internalMcpServers && Object.hasOwn(internalMcpServers, 'db-coder-system-data'),
      'Expected db-coder-system-data internal MCP server',
    );
  });
});

describe('MainLoop dualReview', () => {
  test('returns auto-pass and warning when changed files are empty', async () => {
    let claudeReviewCalls = 0;
    let codexReviewCalls = 0;
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const warnLogs: LogEntry[] = [];

    const { loop } = createMainLoopForCycle({
      claude: {
        review: async () => {
          claudeReviewCalls++;
          return { passed: true, issues: [], summary: 'claude', cost_usd: 0 };
        },
      },
      codex: {
        review: async () => {
          codexReviewCalls++;
          return { passed: true, issues: [], summary: 'codex', cost_usd: 0 };
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });

    const reviewInternals = getMainLoopReviewInternals(loop);
    const now = new Date();
    const task: Task = {
      id: 'task-dual-review-empty-files',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Skip review when there are no changed files',
      phase: 'reviewing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    const removeLogListener = log.addListener((entry) => {
      if (entry.level === 'warn') {
        warnLogs.push(entry);
      }
    });

    let result: Awaited<ReturnType<MainLoopReviewInternals['dualReview']>>;
    try {
      result = await reviewInternals.dualReview(task, [], 0);
    } finally {
      removeLogListener();
    }

    assert.equal(result.decision, 'approve');
    assert.equal(result.cost_usd, 0);
    assert.equal(result.duration_ms, 0);
    assert.deepEqual(result.merged, {
      passed: true,
      mustFix: [],
      shouldFix: [],
      summary: 'No changed files to review',
    });
    assert.equal(claudeReviewCalls, 0);
    assert.equal(codexReviewCalls, 0);
    assert.deepEqual(addCostCalls, []);
    assert.ok(
      warnLogs.some(entry => entry.message === 'dualReview called with no changed files — skipping review'),
      'Expected warning when dualReview receives no changed files',
    );
  });
});

describe('MainLoop runReviewCycle', () => {
  test('auto-passes without invoking reviewers when start commit is empty', async () => {
    const warnLogs: LogEntry[] = [];
    let claudeReviewCalls = 0;
    let codexReviewCalls = 0;
    const { repoPath } = await initGitRepo();

    try {
      const { loop } = createMainLoopForCycle({
        config: { projectPath: repoPath },
        claude: {
          review: async () => {
            claudeReviewCalls++;
            return { passed: true, issues: [], summary: 'claude', cost_usd: 0 };
          },
        },
        codex: {
          review: async () => {
            codexReviewCalls++;
            return { passed: true, issues: [], summary: 'codex', cost_usd: 0 };
          },
        },
      });
      const reviewInternals = getMainLoopReviewInternals(loop);
      const now = new Date();
      const task: Task = {
        id: 'task-review-start-commit-missing',
        project_path: repoPath,
        task_description: 'Warn when review changed files cannot be determined',
        phase: 'executing',
        priority: 1,
        plan: null,
        subtasks: [],
        review_results: [],
        iteration: 0,
        total_cost_usd: 0,
        git_branch: null,
        start_commit: null,
        depends_on: [],
        status: 'active',
        created_at: now,
        updated_at: now,
      };

      const removeLogListener = log.addListener((entry) => {
        if (entry.level === 'warn') {
          warnLogs.push(entry);
        }
      });

      try {
        const result = await reviewInternals.runReviewCycle(task, '', [], repoPath);
        assert.deepEqual(result, {
          aborted: false,
          reviewResult: {
            passed: true,
            mustFix: [],
            shouldFix: [],
            summary: 'No changed files to review',
          },
          reviewRetries: 0,
        });
      } finally {
        removeLogListener();
      }

      assert.equal(claudeReviewCalls, 0);
      assert.equal(codexReviewCalls, 0);
      assert.ok(
        warnLogs.some(entry => entry.message === 'startCommit is empty (getHeadCommit failed) — changed files cannot be determined, review will auto-pass'),
        'Expected startCommit root-cause warning when changed files are empty',
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('auto-passes without invoking reviewers when start commit is valid but changed files are empty', async () => {
    const infoLogs: LogEntry[] = [];
    let claudeReviewCalls = 0;
    let codexReviewCalls = 0;
    const { repoPath } = await initGitRepo();

    try {
      const startCommit = await runGit(repoPath, ['rev-parse', 'HEAD']);
      const { loop } = createMainLoopForCycle({
        config: { projectPath: repoPath },
        claude: {
          review: async () => {
            claudeReviewCalls++;
            return { passed: true, issues: [], summary: 'claude', cost_usd: 0 };
          },
        },
        codex: {
          review: async () => {
            codexReviewCalls++;
            return { passed: true, issues: [], summary: 'codex', cost_usd: 0 };
          },
        },
      });
      const reviewInternals = getMainLoopReviewInternals(loop);
      const now = new Date();
      const task: Task = {
        id: 'task-review-no-files-since-start-commit',
        project_path: repoPath,
        task_description: 'Info log when review has no changed files',
        phase: 'executing',
        priority: 1,
        plan: null,
        subtasks: [],
        review_results: [],
        iteration: 0,
        total_cost_usd: 0,
        git_branch: null,
        start_commit: null,
        depends_on: [],
        status: 'active',
        created_at: now,
        updated_at: now,
      };

      const removeLogListener = log.addListener((entry) => {
        if (entry.level === 'info') {
          infoLogs.push(entry);
        }
      });

      try {
        const result = await reviewInternals.runReviewCycle(task, startCommit, [], repoPath);
        assert.deepEqual(result, {
          aborted: false,
          reviewResult: {
            passed: true,
            mustFix: [],
            shouldFix: [],
            summary: 'No changed files to review',
          },
          reviewRetries: 0,
        });
      } finally {
        removeLogListener();
      }

      assert.equal(claudeReviewCalls, 0);
      assert.equal(codexReviewCalls, 0);
      assert.ok(
        infoLogs.some(entry => entry.message === 'No files changed since start commit — review will auto-pass'),
        'Expected no-change info log when changed files are empty',
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('persists progressive review_results arrays across retry rounds', async () => {
    let codexFixCalls = 0;
    let claudeFixCalls = 0;
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];
    const addLogCalls: TaskLogInsert[] = [];
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const longFixOutput = 'x'.repeat(620);

    const { loop } = createMainLoopForCycle({
      codex: {
        execute: async () => {
          codexFixCalls++;
          return { success: true, output: longFixOutput, cost_usd: 0.75, duration_ms: 123 };
        },
      },
      claude: {
        execute: async () => {
          claudeFixCalls++;
          return { success: true, output: 'claude fix', cost_usd: 0, duration_ms: 0 };
        },
      },
      taskStore: {
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch: structuredClone(patch) });
        },
        addLog: async (entry) => {
          addLogCalls.push(structuredClone(entry) as TaskLogInsert);
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });

    const executionInternals = getMainLoopExecutionInternals(loop);
    const reviewInternals = getMainLoopReviewInternals(loop);
    const originalDualReview = reviewInternals.dualReview;
    const originalBuildFixPrompt = reviewInternals.buildFixPrompt;
    const originalSaveReviewEvent = reviewInternals.saveReviewEvent;
    const originalCheckBudgetOrAbort = reviewInternals.checkBudgetOrAbort;

    const reviewRound0: MergedReviewResult = {
      passed: false,
      mustFix: [issue('Round 0 must-fix')],
      shouldFix: [],
      summary: 'review-round-0',
    };
    const reviewRound1: MergedReviewResult = {
      passed: true,
      mustFix: [],
      shouldFix: [],
      summary: 'review-round-1',
    };

    let dualReviewCalls = 0;
    reviewInternals.checkBudgetOrAbort = async () => false;
    reviewInternals.buildFixPrompt = async () => 'Fix review issues.';
    reviewInternals.saveReviewEvent = async () => {};
    reviewInternals.dualReview = async (_task, _changedFiles, reviewRetries) => {
      dualReviewCalls++;
      if (reviewRetries === 0) {
        return { merged: reviewRound0, decision: 'retry', cost_usd: 0, duration_ms: 0 };
      }
      assert.equal(reviewRetries, 1);
      return { merged: reviewRound1, decision: 'approve', cost_usd: 0, duration_ms: 0 };
    };

    const now = new Date();
    const task: Task = {
      id: 'task-review-progressive-arrays',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Accumulate review results across retries',
      phase: 'executing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    let reviewCycleResult: Awaited<ReturnType<MainLoopExecutionInternals['runReviewCycle']>>;
    try {
      const runReviewCycle = executionInternals.runReviewCycle.bind(loop);
      reviewCycleResult = await runReviewCycle(task, 'HEAD', [], '/tmp/db-coder-main-loop-test');
    } finally {
      reviewInternals.dualReview = originalDualReview;
      reviewInternals.buildFixPrompt = originalBuildFixPrompt;
      reviewInternals.saveReviewEvent = originalSaveReviewEvent;
      reviewInternals.checkBudgetOrAbort = originalCheckBudgetOrAbort;
    }

    assert.equal(reviewCycleResult.aborted, false);
    if (reviewCycleResult.aborted) return;
    assert.equal(reviewCycleResult.reviewRetries, 1);
    assert.equal(reviewCycleResult.reviewResult?.summary, 'review-round-1');
    assert.equal(dualReviewCalls, 2);
    assert.equal(codexFixCalls, 1);
    assert.equal(claudeFixCalls, 0);
    assert.deepEqual(addCostCalls, [
      { taskId: task.id, amount: 0.75 },
    ]);
    assert.equal(addLogCalls.length, 1);
    assert.equal(addLogCalls[0]?.phase, 'fix');
    assert.equal(addLogCalls[0]?.agent, 'codex');
    assert.equal(addLogCalls[0]?.input_summary, 'Fix attempt 1');
    assert.equal(addLogCalls[0]?.output_summary, longFixOutput.slice(0, 500));
    assert.equal(addLogCalls[0]?.cost_usd, 0.75);
    assert.equal(addLogCalls[0]?.duration_ms, 123);

    const reviewResultsUpdates = updateTaskCalls
      .map(call => call.patch)
      .filter((patch): patch is { review_results: MergedReviewResult[] } => {
        if (typeof patch !== 'object' || patch === null) return false;
        return Array.isArray((patch as { review_results?: unknown[] }).review_results);
      })
      .map(patch => patch.review_results.map(result => result.summary));

    assert.deepEqual(reviewResultsUpdates, [
      ['review-round-0'],
      ['review-round-0', 'review-round-1'],
    ]);
    assert.deepEqual(task.review_results, []);
  });

  test('skips cost tracking for zero-cost fixes', async () => {
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const addLogCalls: TaskLogInsert[] = [];
    let codexFixCalls = 0;

    const { loop } = createMainLoopForCycle({
      codex: {
        execute: async () => {
          codexFixCalls++;
          return { success: true, output: 'zero-cost fix', cost_usd: 0, duration_ms: 32 };
        },
      },
      taskStore: {
        addLog: async (entry) => {
          addLogCalls.push(structuredClone(entry) as TaskLogInsert);
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });

    const reviewInternals = getMainLoopReviewInternals(loop);
    const originalDualReview = reviewInternals.dualReview;
    const originalBuildFixPrompt = reviewInternals.buildFixPrompt;
    const originalSaveReviewEvent = reviewInternals.saveReviewEvent;
    const originalCheckBudgetOrAbort = reviewInternals.checkBudgetOrAbort;

    const firstReview: MergedReviewResult = {
      passed: false,
      mustFix: [issue('needs a no-cost fix')],
      shouldFix: [],
      summary: 'needs-fix',
    };
    const finalReview: MergedReviewResult = {
      passed: true,
      mustFix: [],
      shouldFix: [],
      summary: 'approved',
    };

    reviewInternals.checkBudgetOrAbort = async () => false;
    reviewInternals.buildFixPrompt = async () => 'Fix review issues.';
    reviewInternals.saveReviewEvent = async () => {};
    reviewInternals.dualReview = async (_task, _changedFiles, reviewRetries) => {
      if (reviewRetries === 0) {
        return { merged: firstReview, decision: 'retry', cost_usd: 0, duration_ms: 0 };
      }
      assert.equal(reviewRetries, 1);
      return { merged: finalReview, decision: 'approve', cost_usd: 0, duration_ms: 0 };
    };

    const now = new Date();
    const task: Task = {
      id: 'task-review-zero-cost-fix',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Skip addCost for zero-cost fix',
      phase: 'executing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    let reviewCycleResult: { aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number };
    try {
      reviewCycleResult = await reviewInternals.runReviewCycle(task, 'HEAD', [], '/tmp/db-coder-main-loop-test');
    } finally {
      reviewInternals.dualReview = originalDualReview;
      reviewInternals.buildFixPrompt = originalBuildFixPrompt;
      reviewInternals.saveReviewEvent = originalSaveReviewEvent;
      reviewInternals.checkBudgetOrAbort = originalCheckBudgetOrAbort;
    }

    assert.equal(reviewCycleResult.aborted, false);
    if (reviewCycleResult.aborted) return;
    assert.equal(codexFixCalls, 1);
    assert.deepEqual(addCostCalls, []);
    assert.equal(addLogCalls.length, 1);
    assert.equal(addLogCalls[0]?.phase, 'fix');
    assert.equal(addLogCalls[0]?.agent, 'codex');
    assert.equal(addLogCalls[0]?.cost_usd, 0);
  });

  test('retries fix after failure without committing or re-reviewing failed attempts', async () => {
    const { repoPath } = await initGitRepo();
    writeFileSync(join(repoPath, 'README.md'), 'seed\nretry path change\n');

    let codexFixCalls = 0;
    let claudeFixCalls = 0;
    const addLogCalls: TaskLogInsert[] = [];
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const warnLogs: LogEntry[] = [];
    const failedFixOutput = 'f'.repeat(620);

    try {
      const { loop } = createMainLoopForCycle({
        config: { projectPath: repoPath },
        codex: {
          execute: async () => {
            codexFixCalls++;
            return {
              success: false,
              output: failedFixOutput,
              cost_usd: 0.4,
              duration_ms: 45,
              stopReason: 'maxTurns',
            };
          },
        },
        claude: {
          execute: async () => {
            claudeFixCalls++;
            return { success: true, output: 'claude fix', cost_usd: 0.6, duration_ms: 60 };
          },
        },
        taskStore: {
          addLog: async (entry) => {
            addLogCalls.push(structuredClone(entry) as TaskLogInsert);
          },
        },
        costTracker: {
          addCost: async (taskId: string, amount: number) => {
            addCostCalls.push({ taskId, amount });
          },
        },
      });

      const reviewInternals = getMainLoopReviewInternals(loop);
      const originalDualReview = reviewInternals.dualReview;
      const originalBuildFixPrompt = reviewInternals.buildFixPrompt;
      const originalSaveReviewEvent = reviewInternals.saveReviewEvent;
      const originalCheckBudgetOrAbort = reviewInternals.checkBudgetOrAbort;

      const firstReview: MergedReviewResult = {
        passed: false,
        mustFix: [issue('Initial review issue')],
        shouldFix: [],
        summary: 'initial-review',
      };
      const finalReview: MergedReviewResult = {
        passed: true,
        mustFix: [],
        shouldFix: [],
        summary: 'final-review',
      };
      const seenRetryCounts: number[] = [];

      reviewInternals.checkBudgetOrAbort = async () => false;
      reviewInternals.buildFixPrompt = async () => 'Fix review issues.';
      reviewInternals.saveReviewEvent = async () => {};
      reviewInternals.dualReview = async (_task, _changedFiles, reviewRetries) => {
        seenRetryCounts.push(reviewRetries);
        if (seenRetryCounts.length === 1) {
          assert.equal(reviewRetries, 0);
          return { merged: firstReview, decision: 'retry', cost_usd: 0, duration_ms: 0 };
        }
        assert.equal(reviewRetries, 2);
        return { merged: finalReview, decision: 'approve', cost_usd: 0, duration_ms: 0 };
      };

      const now = new Date();
      const task: Task = {
        id: 'task-review-fix-retry-after-failure',
        project_path: repoPath,
        task_description: 'Retry fix when first attempt fails',
        phase: 'executing',
        priority: 1,
        plan: null,
        subtasks: [],
        review_results: [],
        iteration: 0,
        total_cost_usd: 0,
        git_branch: null,
        start_commit: null,
        depends_on: [],
        status: 'active',
        created_at: now,
        updated_at: now,
      };

      const removeLogListener = log.addListener((entry) => {
        if (entry.level === 'warn' && entry.message === 'Fix agent failed') {
          warnLogs.push(entry);
        }
      });

      let reviewCycleResult: { aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number };
      try {
        reviewCycleResult = await reviewInternals.runReviewCycle(task, 'HEAD', [], repoPath);
      } finally {
        removeLogListener();
        reviewInternals.dualReview = originalDualReview;
        reviewInternals.buildFixPrompt = originalBuildFixPrompt;
        reviewInternals.saveReviewEvent = originalSaveReviewEvent;
        reviewInternals.checkBudgetOrAbort = originalCheckBudgetOrAbort;
      }

      assert.equal(reviewCycleResult.aborted, false);
      if (reviewCycleResult.aborted) return;
      assert.equal(reviewCycleResult.reviewRetries, 2);
      assert.equal(reviewCycleResult.reviewResult.summary, 'final-review');
      assert.deepEqual(seenRetryCounts, [0, 2]);
      assert.equal(codexFixCalls, 1);
      assert.equal(claudeFixCalls, 1);
      assert.deepEqual(addCostCalls, [
        { taskId: task.id, amount: 0.4 },
        { taskId: task.id, amount: 0.6 },
      ]);

      const fixLogs = addLogCalls.filter(entry => entry.phase === 'fix');
      assert.equal(fixLogs.length, 2);
      assert.equal(fixLogs[0]?.agent, 'codex');
      assert.equal(fixLogs[0]?.input_summary, 'Fix attempt 1');
      assert.equal(fixLogs[0]?.output_summary, failedFixOutput.slice(0, 500));
      assert.equal(fixLogs[0]?.cost_usd, 0.4);
      assert.equal(fixLogs[1]?.agent, 'claude');
      assert.equal(fixLogs[1]?.input_summary, 'Fix attempt 2');
      assert.equal(fixLogs[1]?.output_summary, 'claude fix');
      assert.equal(fixLogs[1]?.cost_usd, 0.6);

      const commitSubjects = await runGit(repoPath, ['log', '--pretty=%s', '-5']);
      const commitMessages = commitSubjects.split('\n').filter(Boolean);
      assert.ok(commitMessages.includes('db-coder: fix review issues (attempt 2, claude)'));
      assert.ok(!commitMessages.includes('db-coder: fix review issues (attempt 1, codex)'));

      assert.ok(
        warnLogs.some((entry) => {
          const data = entry.data as { attempt?: number; agent?: string; stopReason?: string } | undefined;
          return data?.attempt === 1 && data.agent === 'codex' && data.stopReason === 'maxTurns';
        }),
        'Expected fix failure warning log with attempt metadata',
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('accumulates review_results across retries instead of overwriting prior attempts', async () => {
    let codexFixCalls = 0;
    let claudeFixCalls = 0;
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];

    const { loop } = createMainLoopForCycle({
      codex: {
        execute: async () => {
          codexFixCalls++;
          return { success: true, output: 'codex fix', cost_usd: 0, duration_ms: 0 };
        },
      },
      claude: {
        execute: async () => {
          claudeFixCalls++;
          return { success: true, output: 'claude fix', cost_usd: 0, duration_ms: 0 };
        },
      },
      taskStore: {
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch: structuredClone(patch) });
        },
      },
    });

    const reviewInternals = getMainLoopReviewInternals(loop);
    const originalDualReview = reviewInternals.dualReview;
    const originalBuildFixPrompt = reviewInternals.buildFixPrompt;
    const originalSaveReviewEvent = reviewInternals.saveReviewEvent;
    const originalCheckBudgetOrAbort = reviewInternals.checkBudgetOrAbort;

    const existingReview: MergedReviewResult = {
      passed: false,
      mustFix: [issue('Existing review result')],
      shouldFix: [],
      summary: 'existing-review',
    };
    const retryRound0: MergedReviewResult = {
      passed: false,
      mustFix: [issue('Round 0 must-fix')],
      shouldFix: [],
      summary: 'retry-round-0',
    };
    const retryRound1: MergedReviewResult = {
      passed: false,
      mustFix: [issue('Round 1 must-fix')],
      shouldFix: [],
      summary: 'retry-round-1',
    };
    const retryRound2: MergedReviewResult = {
      passed: true,
      mustFix: [],
      shouldFix: [],
      summary: 'retry-round-2',
    };

    const reviewSequence = [retryRound0, retryRound1, retryRound2];
    const decisions = ['retry', 'retry', 'approve'] as const;
    const seenRetryCounts: number[] = [];

    reviewInternals.checkBudgetOrAbort = async () => false;
    reviewInternals.buildFixPrompt = async () => 'Fix review issues.';
    reviewInternals.saveReviewEvent = async () => {};
    reviewInternals.dualReview = async (_task, _changedFiles, reviewRetries) => {
      seenRetryCounts.push(reviewRetries);
      const sequenceIndex = seenRetryCounts.length - 1;
      const merged = reviewSequence[sequenceIndex];
      const decision = decisions[sequenceIndex];
      assert.ok(merged, `Missing review sequence entry at index ${sequenceIndex}`);
      assert.ok(decision, `Missing review decision at index ${sequenceIndex}`);
      return { merged, decision, cost_usd: 0, duration_ms: 0 };
    };

    const now = new Date();
    const task: Task = {
      id: 'task-review-accumulate',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Accumulate review results for each retry',
      phase: 'executing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [existingReview],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    let reviewCycleResult: { aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number };
    try {
      reviewCycleResult = await reviewInternals.runReviewCycle(task, 'HEAD', [], '/tmp/db-coder-main-loop-test');
    } finally {
      reviewInternals.dualReview = originalDualReview;
      reviewInternals.buildFixPrompt = originalBuildFixPrompt;
      reviewInternals.saveReviewEvent = originalSaveReviewEvent;
      reviewInternals.checkBudgetOrAbort = originalCheckBudgetOrAbort;
    }

    assert.equal(reviewCycleResult.aborted, false);
    if (reviewCycleResult.aborted) return;
    assert.equal(reviewCycleResult.reviewRetries, 2);
    assert.equal(reviewCycleResult.reviewResult.summary, 'retry-round-2');
    assert.deepEqual(seenRetryCounts, [0, 1, 2]);
    assert.equal(codexFixCalls, 1);
    assert.equal(claudeFixCalls, 1);

    const reviewResultsUpdates = updateTaskCalls
      .map(call => call.patch)
      .filter((patch): patch is { review_results: MergedReviewResult[] } => {
        if (typeof patch !== 'object' || patch === null) return false;
        return Array.isArray((patch as { review_results?: unknown[] }).review_results);
      })
      .map(patch => patch.review_results.map(result => result.summary));

    assert.deepEqual(reviewResultsUpdates, [
      ['existing-review', 'retry-round-0'],
      ['existing-review', 'retry-round-0', 'retry-round-1'],
      ['existing-review', 'retry-round-0', 'retry-round-1', 'retry-round-2'],
    ]);
    assert.deepEqual(task.review_results, [existingReview]);
  });

  test('writes exactly one review result when the first review approves', async () => {
    let codexFixCalls = 0;
    let claudeFixCalls = 0;
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];

    const { loop } = createMainLoopForCycle({
      codex: {
        execute: async () => {
          codexFixCalls++;
          return { success: true, output: 'codex fix', cost_usd: 0, duration_ms: 0 };
        },
      },
      claude: {
        execute: async () => {
          claudeFixCalls++;
          return { success: true, output: 'claude fix', cost_usd: 0, duration_ms: 0 };
        },
      },
      taskStore: {
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch: structuredClone(patch) });
        },
      },
    });

    const reviewInternals = getMainLoopReviewInternals(loop);
    const originalDualReview = reviewInternals.dualReview;
    const originalBuildFixPrompt = reviewInternals.buildFixPrompt;
    const originalSaveReviewEvent = reviewInternals.saveReviewEvent;
    const originalCheckBudgetOrAbort = reviewInternals.checkBudgetOrAbort;

    const firstPassResult: MergedReviewResult = {
      passed: true,
      mustFix: [],
      shouldFix: [],
      summary: 'approved-first-pass',
    };

    reviewInternals.checkBudgetOrAbort = async () => false;
    reviewInternals.buildFixPrompt = async () => 'Unused';
    reviewInternals.saveReviewEvent = async () => {};
    reviewInternals.dualReview = async () => ({
      merged: firstPassResult,
      decision: 'approve',
      cost_usd: 0,
      duration_ms: 0,
    });

    const now = new Date();
    const task: Task = {
      id: 'task-review-first-pass',
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Approve on first review',
      phase: 'executing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    let reviewCycleResult: { aborted: true } | { aborted: false; reviewResult: MergedReviewResult; reviewRetries: number };
    try {
      reviewCycleResult = await reviewInternals.runReviewCycle(task, 'HEAD', [], '/tmp/db-coder-main-loop-test');
    } finally {
      reviewInternals.dualReview = originalDualReview;
      reviewInternals.buildFixPrompt = originalBuildFixPrompt;
      reviewInternals.saveReviewEvent = originalSaveReviewEvent;
      reviewInternals.checkBudgetOrAbort = originalCheckBudgetOrAbort;
    }

    assert.equal(reviewCycleResult.aborted, false);
    if (reviewCycleResult.aborted) return;
    assert.equal(reviewCycleResult.reviewRetries, 0);
    assert.equal(reviewCycleResult.reviewResult.summary, 'approved-first-pass');
    assert.equal(codexFixCalls, 0);
    assert.equal(claudeFixCalls, 0);

    const reviewResultsUpdates = updateTaskCalls
      .map(call => call.patch)
      .filter((patch): patch is { review_results: MergedReviewResult[] } => {
        if (typeof patch !== 'object' || patch === null) return false;
        return Array.isArray((patch as { review_results?: unknown[] }).review_results);
      })
      .map(patch => patch.review_results.map(result => result.summary));

    assert.deepEqual(reviewResultsUpdates, [['approved-first-pass']]);
  });
});

describe('MainLoop handleStuck', () => {
  function createHandleStuckTask(taskId: string): Task {
    const now = new Date();
    return {
      id: taskId,
      project_path: '/tmp/db-coder-main-loop-test',
      task_description: 'Handle repeated subtask failures',
      phase: 'executing',
      priority: 1,
      plan: null,
      subtasks: [],
      review_results: [],
      iteration: 0,
      total_cost_usd: 0,
      git_branch: null,
      start_commit: null,
      depends_on: [],
      status: 'active',
      created_at: now,
      updated_at: now,
    };
  }

  function createHandleStuckSubtask(): Task['subtasks'][number] {
    return {
      id: 'subtask-stuck-1',
      description: 'Retry flaky implementation',
      executor: 'codex',
      status: 'failed',
    };
  }

  test('boundary: iteration === maxRetries still retries', async () => {
    const reflectCalls: Array<{ result: string; outcome: string }> = [];
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];

    const { loop } = createMainLoopForCycle({
      brain: {
        reflect: async (_projectPath, _taskDescription, result, _reviewSummary, outcome) => {
          reflectCalls.push({ result, outcome: outcome ?? 'success' });
          return {
            reflection: {
              experiences: [],
              taskSummary: 'Boundary reflection',
              adjustments: ['unused'],
            },
            cost: 0.4,
          };
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });

    const stuckInternals = getMainLoopStuckInternals(loop);
    const task = createHandleStuckTask('task-stuck-boundary');
    const subtask = createHandleStuckSubtask();
    const stuckAdjustments: string[] = [];

    const shouldRetry = await stuckInternals.handleStuck(task, subtask, 'boom', stuckAdjustments, 3, 3);

    assert.equal(shouldRetry, true);
    assert.equal(reflectCalls.length, 0);
    assert.deepEqual(addCostCalls, []);
    assert.deepEqual(stuckAdjustments, []);
  });

  test('graduated behavior: iteration 1 simple retry, 2 reflect, 3+ generic retries', async () => {
    const reflectCalls: Array<{ result: string; outcome: string }> = [];
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const adjustmentCalls: Array<{
      taskId: string | null;
      adjustments: string[];
      outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries';
    }> = [];

    const { loop } = createMainLoopForCycle({
      brain: {
        reflect: async (_projectPath, _taskDescription, result, _reviewSummary, outcome) => {
          reflectCalls.push({ result, outcome: outcome ?? 'success' });
          return {
            reflection: {
              experiences: [],
              taskSummary: 'Second-attempt reflection',
              adjustments: ['split into smaller steps'],
            },
            cost: 0.25,
          };
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });
    loop.setEvolutionEngine({
      processAdjustments: async (
        _projectPath: string,
        taskId: string | null,
        adjustments: string[],
        outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
      ) => {
        adjustmentCalls.push({ taskId, adjustments: [...adjustments], outcome });
      },
    } as unknown as EvolutionEngine);

    const stuckInternals = getMainLoopStuckInternals(loop);
    const task = createHandleStuckTask('task-stuck-graduated');
    const subtask = createHandleStuckSubtask();
    const stuckAdjustments: string[] = [];

    const iteration1Retry = await stuckInternals.handleStuck(task, subtask, 'boom', stuckAdjustments, 1, 5);
    const iteration2Retry = await stuckInternals.handleStuck(task, subtask, 'boom', stuckAdjustments, 2, 5);
    const iteration3Retry = await stuckInternals.handleStuck(task, subtask, 'boom', stuckAdjustments, 3, 5);
    const iteration4Retry = await stuckInternals.handleStuck(task, subtask, 'boom', stuckAdjustments, 4, 5);

    assert.equal(iteration1Retry, true);
    assert.equal(iteration2Retry, true);
    assert.equal(iteration3Retry, true);
    assert.equal(iteration4Retry, true);
    assert.equal(reflectCalls.length, 1);
    assert.match(reflectCalls[0]?.result ?? '', /failed: boom/);
    assert.equal(reflectCalls[0]?.outcome, 'blocked_stuck');
    assert.deepEqual(addCostCalls, [
      { taskId: task.id, amount: 0.25 },
    ]);
    assert.deepEqual(stuckAdjustments, ['split into smaller steps']);
    assert.deepEqual(adjustmentCalls, [
      {
        taskId: task.id,
        adjustments: ['split into smaller steps'],
        outcome: 'blocked_stuck',
      },
    ]);
  });

  test('termination: iteration > maxRetries returns false and blocks task', async () => {
    const reflectCalls: Array<{ result: string; outcome: string }> = [];
    const addCostCalls: Array<{ taskId: string; amount: number }> = [];
    const updateTaskCalls: Array<{ taskId: string; patch: unknown }> = [];
    const adjustmentCalls: Array<{
      taskId: string | null;
      adjustments: string[];
      outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries';
    }> = [];

    const { loop } = createMainLoopForCycle({
      brain: {
        reflect: async (_projectPath, _taskDescription, result, _reviewSummary, outcome) => {
          reflectCalls.push({ result, outcome: outcome ?? 'success' });
          return {
            reflection: {
              experiences: [],
              taskSummary: 'Give up and escalate',
              adjustments: ['escalate blocker'],
            },
            cost: 0.15,
          };
        },
      },
      taskStore: {
        updateTask: async (taskId: string, patch: unknown) => {
          updateTaskCalls.push({ taskId, patch: structuredClone(patch) });
        },
      },
      costTracker: {
        addCost: async (taskId: string, amount: number) => {
          addCostCalls.push({ taskId, amount });
        },
      },
    });
    loop.setEvolutionEngine({
      processAdjustments: async (
        _projectPath: string,
        taskId: string | null,
        adjustments: string[],
        outcome: 'success' | 'failed' | 'blocked_stuck' | 'blocked_max_retries',
      ) => {
        adjustmentCalls.push({ taskId, adjustments: [...adjustments], outcome });
      },
    } as unknown as EvolutionEngine);

    const stuckInternals = getMainLoopStuckInternals(loop);
    const task = createHandleStuckTask('task-stuck-termination');
    const subtask = createHandleStuckSubtask();
    const stuckAdjustments: string[] = [];

    const shouldRetry = await stuckInternals.handleStuck(task, subtask, 'still failing', stuckAdjustments, 4, 3);

    assert.equal(shouldRetry, false);
    assert.equal(reflectCalls.length, 1);
    assert.match(reflectCalls[0]?.result ?? '', /failed 4 times: still failing/);
    assert.equal(reflectCalls[0]?.outcome, 'blocked_stuck');
    assert.deepEqual(addCostCalls, [
      { taskId: task.id, amount: 0.15 },
    ]);
    assert.deepEqual(stuckAdjustments, ['escalate blocker']);
    assert.deepEqual(adjustmentCalls, [
      {
        taskId: task.id,
        adjustments: ['escalate blocker'],
        outcome: 'blocked_stuck',
      },
    ]);
    assert.deepEqual(updateTaskCalls, [
      { taskId: task.id, patch: { status: 'blocked', phase: 'blocked' } },
    ]);
  });
});

describe('countTscErrors', { concurrency: false }, () => {
  afterEach(() => {
    setCountTscErrorsDepsForTests();
  });

  test('returns TypeScript error count when tsc reports errors', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: tscOutputWithErrors(3),
        stderr: '',
      }),
    });

    const errors = await countTscErrors('/tmp/db-coder-count-tsc-errors');

    assert.equal(errors, 3);
  });

  test('returns -1 when tsc process crashes', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => {
        throw new Error('spawn npx ENOENT');
      },
    });

    const errors = await countTscErrors('/tmp/db-coder-count-tsc-crash');

    assert.equal(errors, -1);
  });

  test('returns -1 when runProcess rejects with timeout', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => {
        throw new Error('TypeScript compilation timed out');
      },
    });

    const errors = await countTscErrors('/tmp/db-coder-count-tsc-timeout');

    assert.equal(errors, -1);
  });

  test('returns 0 when tsconfig.json is missing', async () => {
    let runProcessCalled = false;
    setCountTscErrorsDepsForTests({
      existsSync: () => false,
      runProcess: async () => {
        runProcessCalled = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const errors = await countTscErrors('/tmp/db-coder-count-tsc-no-config');

    assert.equal(errors, 0);
    assert.equal(runProcessCalled, false);
  });

  test('returns 0 when tsc exits cleanly with no errors', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 0,
        stdout: 'Found 0 errors. Watching for file changes.\n',
        stderr: '',
      }),
    });

    const errors = await countTscErrors('/tmp/db-coder-count-tsc-clean');

    assert.equal(errors, 0);
  });
});

describe('MainLoop postExecutionCheck', { concurrency: false }, () => {
  afterEach(() => {
    setCountTscErrorsDepsForTests();
  });

  test('fails when current TypeScript check crashes', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => {
        throw new Error('compiler crashed');
      },
    });

    const loop = createMainLoopForDedupHelpers({ projectPath: '/tmp/db-coder-post-check-crash' });
    const result = await getMainLoopPostExecutionInternals(loop).postExecutionCheck(0, '', '/tmp/db-coder-post-check-crash');

    assert.deepEqual(result, {
      passed: false,
      reason: 'TypeScript compilation crashed — cannot verify error count',
    });
  });

  test('fails when baseline check failed and current check succeeds', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: tscOutputWithErrors(5),
        stderr: '',
      }),
    });

    const loop = createMainLoopForDedupHelpers({ projectPath: '/tmp/db-coder-post-check-baseline-failed' });
    const result = await getMainLoopPostExecutionInternals(loop).postExecutionCheck(-1, '', '/tmp/db-coder-post-check-baseline-failed');

    assert.deepEqual(result, {
      passed: false,
      reason: 'Baseline TypeScript check failed — cannot compare error counts',
    });
  });

  test('fails when current error count increases over baseline', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: tscOutputWithErrors(5),
        stderr: '',
      }),
    });

    const loop = createMainLoopForDedupHelpers({ projectPath: '/tmp/db-coder-post-check-increase' });
    const result = await getMainLoopPostExecutionInternals(loop).postExecutionCheck(3, '', '/tmp/db-coder-post-check-increase');

    assert.deepEqual(result, {
      passed: false,
      reason: 'TypeScript errors increased: 3 → 5 (+2)',
    });
  });

  test('passes when current errors are lower than baseline', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 2,
        stdout: tscOutputWithErrors(3),
        stderr: '',
      }),
    });

    const loop = createMainLoopForDedupHelpers({ projectPath: '/tmp/db-coder-post-check-improved' });
    const result = await getMainLoopPostExecutionInternals(loop).postExecutionCheck(5, '', '/tmp/db-coder-post-check-improved');

    assert.deepEqual(result, { passed: true });
  });

  test('passes when baseline and current errors are both zero', async () => {
    setCountTscErrorsDepsForTests({
      existsSync: () => true,
      runProcess: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    });

    const loop = createMainLoopForDedupHelpers({ projectPath: '/tmp/db-coder-post-check-zero' });
    const result = await getMainLoopPostExecutionInternals(loop).postExecutionCheck(0, '', '/tmp/db-coder-post-check-zero');

    assert.deepEqual(result, { passed: true });
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

test('restartPending stops task execution loop — second queued task is not executed', async () => {
  let getNextCalls = 0;
  let executeTaskCalls = 0;

  const now = new Date();
  const makeTask = (id: string): Task => ({
    id,
    project_path: '/tmp/db-coder-main-loop-test',
    task_description: `Task ${id}`,
    phase: 'init',
    priority: 1,
    plan: null,
    subtasks: [{ id: 'S1', description: 'sub', executor: 'codex', status: 'pending' }],
    review_results: [],
    iteration: 0,
    total_cost_usd: 0,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: 'queued',
    created_at: now,
    updated_at: now,
  });

  const task1 = makeTask('task-restart-1');
  const task2 = makeTask('task-restart-2');

  const { loop } = createMainLoopForCycle({
    brain: {
      hasChanges: async () => false,
    },
    taskQueue: {
      getQueued: async () => [task1, task2],
      getNext: async () => {
        getNextCalls++;
        if (getNextCalls === 1) return task1;
        if (getNextCalls === 2) return task2;
        return null;
      },
    },
    taskStore: {
      saveEvaluationEvent: async () => {},
    },
  });

  const internals = getMainLoopInternals(loop);
  const loopWithMethods = loop as unknown as {
    evaluateTaskValue(task: Task, projectPath: string): Promise<EvaluationResult>;
    executeTask(task: Task): Promise<void>;
    restartPending: boolean;
  };
  const originalEvaluateTaskValue = loopWithMethods.evaluateTaskValue;
  const originalExecuteTask = loopWithMethods.executeTask;

  loopWithMethods.evaluateTaskValue = async () => ({
    passed: true,
    score: { problemLegitimacy: 1, solutionProportionality: 1, expectedComplexity: 1, historicalSuccess: 1, total: 4 },
    reasoning: 'pass',
    cost_usd: 0,
    duration_ms: 0,
  });
  loopWithMethods.executeTask = async () => {
    executeTaskCalls++;
    // Simulate self-build setting restartPending during first task execution
    loopWithMethods.restartPending = true;
  };

  internals.setRunning(true);
  try {
    await loop.runCycle();
  } finally {
    internals.setRunning(false);
    loopWithMethods.evaluateTaskValue = originalEvaluateTaskValue;
    loopWithMethods.executeTask = originalExecuteTask;
  }

  assert.equal(executeTaskCalls, 1, 'only first task should execute before restart');
  assert.equal(getNextCalls, 1, 'should not fetch second task when restartPending');
});
