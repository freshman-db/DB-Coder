import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { Config } from '../config/Config.js';
import type { TaskStore } from '../memory/TaskStore.js';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { ProjectAnalysis, RecurringIssueCategory, ReviewEvent, Task } from '../memory/types.js';
import type { PromptPatch, PromptVersion } from './types.js';
import type { TrendAnalyzer } from './TrendAnalyzer.js';
import { EvolutionEngine } from './EvolutionEngine.js';

type ParsedMetaReflectOutput = {
  patches: Array<{
    promptName: string;
    patches: PromptPatch[];
    rationale: string;
    confidence: number;
  }>;
  analysis: string;
};

type EvolutionEngineInternals = {
  buildMetaReflectPrompt(): string;
  storeProposedPatches(
    parsed: ParsedMetaReflectOutput,
    projectPath: string,
    maxActive: number,
  ): Promise<void>;
};

function makeTask(index: number, cost: number): Task {
  return {
    id: `task-${index}`,
    project_path: '/repo',
    task_description: `Task ${index}`,
    phase: 'done',
    priority: 2,
    plan: null,
    subtasks: [],
    review_results: [],
    iteration: 1,
    total_cost_usd: cost,
    git_branch: null,
    start_commit: null,
    depends_on: [],
    status: 'done',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeDoneTask(index: number, description: string): Task {
  return {
    ...makeTask(index, 0),
    task_description: description,
  };
}

function createEvolutionEngine(
  taskStore: Partial<TaskStore>,
  trendAnalyzer: Partial<TrendAnalyzer>,
  configValues: Record<string, unknown> = {},
): EvolutionEngine {
  return new EvolutionEngine(
    taskStore as TaskStore,
    {} as GlobalMemory,
    { values: configValues } as unknown as Config,
    trendAnalyzer as TrendAnalyzer,
  );
}

describe('EvolutionEngine.metaReflect', () => {
  test('orchestrates prompt build, plan with MCP server, parse, and storage in order', async () => {
    const calls: string[] = [];
    let billedCost = 0;

    const taskStore: Partial<TaskStore> = {
      addDailyCost: async (cost: number) => {
        billedCost += cost;
      },
    };

    const engine = createEvolutionEngine(taskStore, {});
    const parsed: ParsedMetaReflectOutput = {
      patches: [{
        promptName: 'plan',
        patches: [{ op: 'append', content: 'Strengthen checklist.', reason: 'Reduce misses.' }],
        rationale: 'Improve planning quality',
        confidence: 0.8,
      }],
      analysis: 'Plan checks are weak.',
    };

    (engine as any).buildMetaReflectPrompt = () => {
      calls.push('buildPrompt');
      return 'meta prompt';
    };
    (engine as any).parseMetaReflectOutput = (output: string) => {
      assert.equal(output, '{"patches":[],"analysis":"ignored"}');
      calls.push('parseOutput');
      return parsed;
    };
    (engine as any).storeProposedPatches = async (
      parsedOutput: ParsedMetaReflectOutput,
      projectPath: string,
      maxActive: number,
    ) => {
      assert.equal(parsedOutput, parsed);
      assert.equal(projectPath, '/repo');
      assert.equal(maxActive, 3);
      calls.push('storePatches');
    };

    const claude = {
      plan: async (prompt: string, cwd: string, options: { maxTurns: number; internalMcpServers?: Record<string, unknown> }) => {
        assert.equal(prompt, 'meta prompt');
        assert.equal(cwd, '/repo');
        assert.equal(options.maxTurns, 10);
        assert.ok(options.internalMcpServers?.['db-coder-system-data'], 'should pass MCP server');
        calls.push('claudePlan');
        return {
          success: true,
          output: '{"patches":[],"analysis":"ignored"}',
          cost_usd: 1.23,
          duration_ms: 10,
        };
      },
    };

    await engine.metaReflect('/repo', claude as any);

    assert.deepEqual(calls, ['buildPrompt', 'claudePlan', 'parseOutput', 'storePatches']);
    assert.equal(billedCost, 1.23);
  });

  test('returns early when parsed output has no actionable patches', async () => {
    const calls: string[] = [];
    let billedCost = 0;

    const taskStore: Partial<TaskStore> = {
      addDailyCost: async (cost: number) => {
        billedCost += cost;
      },
    };
    const engine = createEvolutionEngine(taskStore, {});

    (engine as any).buildMetaReflectPrompt = () => {
      calls.push('buildPrompt');
      return 'meta prompt';
    };
    (engine as any).parseMetaReflectOutput = () => {
      calls.push('parseOutput');
      return null;
    };
    (engine as any).storeProposedPatches = async () => {
      calls.push('storePatches');
    };

    const claude = {
      plan: async (_prompt: string, _cwd: string, options: { internalMcpServers?: Record<string, unknown> }) => {
        assert.ok(options.internalMcpServers?.['db-coder-system-data']);
        calls.push('claudePlan');
        return {
          success: true,
          output: '{}',
          cost_usd: 0,
          duration_ms: 5,
        };
      },
    };

    await engine.metaReflect('/repo', claude as any);

    assert.deepEqual(calls, ['buildPrompt', 'claudePlan', 'parseOutput']);
    assert.equal(billedCost, 0);
  });
});

describe('EvolutionEngine.buildMetaReflectPrompt', () => {
  test('builds a prompt that instructs Claude to use MCP tools', () => {
    const engine = createEvolutionEngine({}, {});
    const internals = engine as unknown as EvolutionEngineInternals;
    const prompt = internals.buildMetaReflectPrompt();

    assert.match(prompt, /get_health_trend/);
    assert.match(prompt, /get_task_detail/);
    assert.match(prompt, /get_review_details/);
    assert.match(prompt, /get_adjustment_summary/);
    assert.match(prompt, /get_prompt_versions/);
    assert.match(prompt, /get_cost_trend/);
    assert.match(prompt, /get_goal_progress/);
    assert.match(prompt, /get_recent_tasks/);
    assert.match(prompt, /get_task_logs/);
    assert.match(prompt, /search_memories/);
    assert.match(prompt, /Available Prompt Names/);
    assert.match(prompt, /brain_system, scan, plan, reflect, executor, reviewer, evaluator/);
    assert.match(prompt, /"patches"/);
  });
});

describe('EvolutionEngine.storeProposedPatches', () => {
  test('stores eligible proposals then runs promotion and rollback', async () => {
    const activePromptVersion: PromptVersion = {
      id: 11,
      project_path: '/repo',
      prompt_name: 'scan',
      version: 1,
      patches: [{ op: 'append', content: 'Check nulls.', reason: 'Reduce crashes.' }],
      rationale: 'Current active scan patch',
      confidence: 0.8,
      effectiveness: 0.05,
      status: 'active',
      baseline_metrics: null,
      current_metrics: null,
      tasks_evaluated: 3,
      activated_at: new Date('2026-01-03T00:00:00.000Z'),
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-03T00:00:00.000Z'),
    };

    const savedVersions: Array<{
      project_path: string;
      prompt_name: string;
      version: number;
      patches: PromptPatch[];
      rationale: string;
      confidence: number;
      baseline_metrics: {
        passRate: number;
        avgCostUsd: number;
        issueCount: number;
        tasksEvaluated: number;
      } | null;
    }> = [];

    let activeLookupCount = 0;
    let promoteCalls = 0;
    let rollbackCalls = 0;

    const reviewEvents: ReviewEvent[] = [
      {
        id: 1,
        task_id: 'task-1',
        attempt: 1,
        passed: true,
        must_fix_count: 0,
        should_fix_count: 0,
        issue_categories: [],
        fix_agent: null,
        duration_ms: 10,
        cost_usd: 0.01,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 2,
        task_id: 'task-2',
        attempt: 1,
        passed: false,
        must_fix_count: 1,
        should_fix_count: 1,
        issue_categories: ['null-safety'],
        fix_agent: null,
        duration_ms: 20,
        cost_usd: 0.02,
        created_at: new Date('2026-01-01T00:01:00.000Z'),
      },
    ];
    const recentTasks = [makeTask(1, 0.4), makeTask(2, 0.5)];
    const issueCategories: RecurringIssueCategory[] = [
      { category: 'null-safety', count: 2 },
      { category: 'type-error', count: 1 },
    ];

    const taskStore: Partial<TaskStore> = {
      getRecentReviewEvents: async (projectPath: string, limit = 20) => {
        assert.equal(projectPath, '/repo');
        assert.equal(limit, 20);
        return reviewEvents;
      },
      listTasks: async (projectPath: string, status) => {
        assert.equal(projectPath, '/repo');
        assert.equal(status, 'done');
        return recentTasks;
      },
      getRecurringIssueCategories: async (projectPath: string, limit = 10) => {
        assert.equal(projectPath, '/repo');
        assert.equal(limit, 10);
        return issueCategories;
      },
      getActivePromptVersions: async (projectPath: string) => {
        assert.equal(projectPath, '/repo');
        activeLookupCount += 1;
        return activeLookupCount === 1 ? [activePromptVersion] : [];
      },
      getNextPromptVersion: async (projectPath: string, promptName) => {
        assert.equal(projectPath, '/repo');
        assert.equal(promptName, 'plan');
        return 4;
      },
      savePromptVersion: async (pv) => {
        savedVersions.push({
          project_path: pv.project_path,
          prompt_name: pv.prompt_name,
          version: pv.version,
          patches: pv.patches,
          rationale: pv.rationale,
          confidence: pv.confidence,
          baseline_metrics: pv.baseline_metrics,
        });
        return {} as PromptVersion;
      },
    };

    const engine = createEvolutionEngine(taskStore, {});
    (engine as any).promoteReadyCandidates = async (projectPath: string) => {
      assert.equal(projectPath, '/repo');
      promoteCalls += 1;
      return 1;
    };
    (engine as any).rollbackDegradedVersions = async (projectPath: string) => {
      assert.equal(projectPath, '/repo');
      rollbackCalls += 1;
      return 0;
    };

    const internals = engine as unknown as EvolutionEngineInternals;
    const parsed: ParsedMetaReflectOutput = {
      patches: [
        {
          promptName: 'scan',
          patches: [{ op: 'append', content: 'Keep scanning strict.', reason: 'Reduce misses.' }],
          rationale: 'Improve scan consistency',
          confidence: 0.7,
        },
        {
          promptName: 'plan',
          patches: [{ op: 'append', content: 'Add checklist.', reason: 'Catch regressions.' }],
          rationale: 'Address planning misses',
          confidence: 0.81,
        },
      ],
      analysis: 'Plan prompt needs more rigor.',
    };

    await internals.storeProposedPatches(parsed, '/repo', 1);

    assert.equal(savedVersions.length, 1);
    assert.deepEqual(savedVersions[0], {
      project_path: '/repo',
      prompt_name: 'plan',
      version: 4,
      patches: [{ op: 'append', content: 'Add checklist.', reason: 'Catch regressions.' }],
      rationale: 'Address planning misses',
      confidence: 0.81,
      baseline_metrics: {
        passRate: 0.5,
        avgCostUsd: 0.45,
        issueCount: 3,
        tasksEvaluated: 2,
      },
    });
    assert.equal(promoteCalls, 1);
    assert.equal(rollbackCalls, 1);
  });

  test('throws when parsed is nullish or inputs are invalid', async () => {
    const engine = createEvolutionEngine({}, {});
    const internals = engine as unknown as EvolutionEngineInternals;

    const validParsed: ParsedMetaReflectOutput = {
      patches: [{
        promptName: 'scan',
        patches: [{ op: 'append', content: 'x', reason: 'y' }],
        rationale: 'r',
        confidence: 0.8,
      }],
      analysis: '',
    };

    await assert.rejects(
      internals.storeProposedPatches(undefined as unknown as ParsedMetaReflectOutput, '/repo', 1),
      /parsed meta-reflect output is required for prompt patch storage/,
    );

    await assert.rejects(
      internals.storeProposedPatches(validParsed, '   ', 1),
      /projectPath is required for prompt patch storage/,
    );

    await assert.rejects(
      internals.storeProposedPatches(validParsed, '/repo', 0),
      /maxActive must be a positive number/,
    );
  });
});

describe('EvolutionEngine.assessGoalProgress', () => {
  test('matches Chinese default goals to keyword-related completed tasks', async () => {
    const goals = [
      { description: '提升代码质量：修复类型错误，统一编码规范', priority: 1, status: 'active' as const },
      { description: '减少代码重复：识别和整合重复模式', priority: 2, status: 'active' as const },
      { description: '简化复杂代码：缩短函数长度，降低嵌套深度', priority: 2, status: 'active' as const },
      { description: '提高测试覆盖：为关键路径添加测试', priority: 2, status: 'active' as const },
      { description: '主动开发功能：识别架构的自然延伸并实现', priority: 3, status: 'active' as const },
    ];

    const completedTasks = [
      makeDoneTask(1, 'Fix type mismatch and lint violations in auth module'),
      makeDoneTask(2, 'Extract duplicate helper logic for dedup cleanup'),
      makeDoneTask(3, 'Refactor nested branching to simplify control flow'),
      makeDoneTask(4, 'Improve test coverage for payment API'),
      makeDoneTask(5, 'Implement feature preview panel for reports'),
    ];

    const savedProgress: Array<{ goal_index: number; progress_pct: number; evidence: string }> = [];
    const taskStore: Partial<TaskStore> = {
      listTasks: async (projectPath: string, status) => {
        assert.equal(projectPath, '/repo');
        assert.equal(status, 'done');
        return completedTasks;
      },
      saveGoalProgress: async (gp) => {
        savedProgress.push({
          goal_index: gp.goal_index,
          progress_pct: gp.progress_pct,
          evidence: gp.evidence,
        });
        return {
          id: savedProgress.length,
          project_path: gp.project_path,
          goal_index: gp.goal_index,
          progress_pct: gp.progress_pct,
          evidence: gp.evidence,
          scan_id: gp.scan_id,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        };
      },
      getGoalProgressHistory: async () => [],
    };

    const analysis: ProjectAnalysis = {
      issues: [],
      opportunities: [],
      projectHealth: 50,
      summary: 'Stable',
    };

    const engine = createEvolutionEngine(taskStore, {}, { evolution: { goals } });
    await engine.assessGoalProgress('/repo', analysis, 9);

    assert.equal(savedProgress.length, goals.length);
    assert.deepEqual(savedProgress.map(g => g.progress_pct), [26, 26, 26, 26, 26]);
    assert.deepEqual(savedProgress.map(g => g.evidence), [
      '1 related tasks done, health=50',
      '1 related tasks done, health=50',
      '1 related tasks done, health=50',
      '1 related tasks done, health=50',
      '1 related tasks done, health=50',
    ]);
  });

  test('extracts fallback Chinese keywords from punctuation-separated goal text', async () => {
    const goals = [
      { description: '重构目标：消除重复逻辑，提升可读性', priority: 2, status: 'active' as const },
    ];

    const capturedProgress: { value?: { progress_pct: number; evidence: string } } = {};
    const taskStore: Partial<TaskStore> = {
      listTasks: async () => [makeDoneTask(1, '清理重复分支逻辑并抽离公共函数')],
      saveGoalProgress: async (gp) => {
        capturedProgress.value = { progress_pct: gp.progress_pct, evidence: gp.evidence };
        return {
          id: 1,
          project_path: gp.project_path,
          goal_index: gp.goal_index,
          progress_pct: gp.progress_pct,
          evidence: gp.evidence,
          scan_id: gp.scan_id,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        };
      },
      getGoalProgressHistory: async () => [],
    };

    const analysis: ProjectAnalysis = {
      issues: [],
      opportunities: [],
      projectHealth: 40,
      summary: 'Needs cleanup',
    };

    const engine = createEvolutionEngine(taskStore, {}, { evolution: { goals } });
    await engine.assessGoalProgress('/repo', analysis, null);

    assert.equal(capturedProgress.value?.progress_pct, 23);
    assert.equal(capturedProgress.value?.evidence, '1 related tasks done, health=40');
  });
});
