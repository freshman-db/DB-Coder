import { createSdkMcpServer, tool, type InferShape } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import { getErrorMessage } from '../utils/parse.js';

const MCP_SERVER_NAME = 'db-coder-system-data';
const TASK_STATUSES = ['queued', 'active', 'done', 'failed', 'blocked', 'skipped', 'pending_review'] as const;

const GET_HEALTH_TREND_SCHEMA = { limit: z.number().int().min(1).max(50).optional() };
const GET_REVIEW_HISTORY_SCHEMA = { limit: z.number().int().min(1).max(50).optional() };
const GET_TASK_OUTCOMES_SCHEMA = { limit: z.number().int().min(1).max(100).optional() };
const GET_EVALUATION_SCORES_SCHEMA = { limit: z.number().int().min(1).max(50).optional() };
const GET_RECURRING_ISSUES_SCHEMA = { limit: z.number().int().min(1).max(30).optional() };
const SEARCH_MEMORIES_SCHEMA = { query: z.string().min(1) };
const GET_TASK_DETAIL_SCHEMA = { task_id: z.string().min(1) };
const GET_RECENT_TASKS_SCHEMA = {
  limit: z.number().int().min(1).max(50).optional(),
  status: z.enum(TASK_STATUSES).optional(),
};
const GET_TASK_LOGS_SCHEMA = { task_id: z.string().min(1) };
const GET_REVIEW_DETAILS_SCHEMA = { task_id: z.string().min(1) };
const GET_ADJUSTMENT_SUMMARY_SCHEMA = { limit: z.number().int().min(1).max(50).optional() };
const GET_PROMPT_VERSIONS_SCHEMA = { prompt_name: z.string().optional() };
const GET_COST_TREND_SCHEMA = { days: z.number().int().min(1).max(90).optional() };
const GET_GOAL_PROGRESS_SCHEMA = { goal_index: z.number().int().min(0).optional() };

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
};

export interface SystemDataMcpDeps {
  projectPath: string;
  taskStore: TaskStore;
  globalMemory: GlobalMemory;
}

type SystemDataTaskStore = SystemDataMcpDeps['taskStore'];
type SystemDataGlobalMemory = SystemDataMcpDeps['globalMemory'];

type ProjectTaskStore = {
  getRecentScans: (limit?: number) => ReturnType<SystemDataTaskStore['getRecentScans']>;
  getRecentReviewEvents: (limit?: number) => ReturnType<SystemDataTaskStore['getRecentReviewEvents']>;
  getRecurringIssueCategories: (limit?: number) => ReturnType<SystemDataTaskStore['getRecurringIssueCategories']>;
  listTasks: (status?: Parameters<SystemDataTaskStore['listTasks']>[1]) => ReturnType<SystemDataTaskStore['listTasks']>;
  getRecentEvaluationEvents: (limit?: number) => ReturnType<SystemDataTaskStore['getRecentEvaluationEvents']>;
  getTask: (taskId: string) => ReturnType<SystemDataTaskStore['getTask']>;
  getTaskLogs: (taskId: string) => ReturnType<SystemDataTaskStore['getTaskLogs']>;
  getReviewEvents: (taskId: string) => ReturnType<SystemDataTaskStore['getReviewEvents']>;
  getActiveAdjustments: (limit?: number) => ReturnType<SystemDataTaskStore['getActiveAdjustments']>;
  getActivePromptVersions: () => ReturnType<SystemDataTaskStore['getActivePromptVersions']>;
  getPromptVersionHistory: (promptName: string, limit?: number) => ReturnType<SystemDataTaskStore['getPromptVersionHistory']>;
  getRecentCosts: (days?: number) => ReturnType<SystemDataTaskStore['getRecentCosts']>;
  getLatestGoalProgress: () => ReturnType<SystemDataTaskStore['getLatestGoalProgress']>;
  getGoalProgressHistory: (goalIndex: number, limit?: number) => ReturnType<SystemDataTaskStore['getGoalProgressHistory']>;
};

function createProjectTaskStore(taskStore: SystemDataTaskStore, projectPath: string): ProjectTaskStore {
  return {
    getRecentScans: (limit = 10) => taskStore.getRecentScans(projectPath, limit),
    getRecentReviewEvents: (limit = 20) => taskStore.getRecentReviewEvents(projectPath, limit),
    getRecurringIssueCategories: (limit = 10) => taskStore.getRecurringIssueCategories(projectPath, limit),
    listTasks: (status) => taskStore.listTasks(projectPath, status),
    getRecentEvaluationEvents: (limit = 20) => taskStore.getRecentEvaluationEvents(projectPath, limit),
    getTask: (taskId) => taskStore.getTask(taskId),
    getTaskLogs: (taskId) => taskStore.getTaskLogs(taskId),
    getReviewEvents: (taskId) => taskStore.getReviewEvents(taskId),
    getActiveAdjustments: (limit = 20) => taskStore.getActiveAdjustments(projectPath, limit),
    getActivePromptVersions: () => taskStore.getActivePromptVersions(projectPath),
    getPromptVersionHistory: (promptName, limit = 20) => taskStore.getPromptVersionHistory(projectPath, promptName as any, limit),
    getRecentCosts: (days = 7) => taskStore.getRecentCosts(days),
    getLatestGoalProgress: () => taskStore.getLatestGoalProgress(projectPath),
    getGoalProgressHistory: (goalIndex, limit = 10) => taskStore.getGoalProgressHistory(projectPath, goalIndex, limit),
  };
}

function success(message: string, data?: unknown): ToolResponse {
  return {
    content: [{ type: 'text', text: message }],
    ...(data !== undefined ? { structuredContent: data } : {}),
  };
}

function error(toolName: string, err: unknown): ToolResponse {
  const message = getErrorMessage(err);
  return { content: [{ type: 'text', text: `${toolName} failed: ${message}` }], isError: true };
}

export function safeTool<Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: Schema,
  handler: (args: InferShape<Schema>) => Promise<ToolResponse>,
) {
  return tool(name, description, schema, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      return error(name, e);
    }
  });
}

export function formatDate(d: Date | string | unknown): string {
  return d instanceof Date ? d.toISOString() : String(d ?? '');
}

export function formatDateNullable(d: Date | string | unknown): string | null {
  return d == null ? null : formatDate(d);
}

async function handleGetHealthTrend(
  { limit }: InferShape<typeof GET_HEALTH_TREND_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const scans = await taskStore.getRecentScans(limit ?? 10);
  const trend = scans.map(s => ({
    date: formatDate(s.created_at),
    healthScore: s.health_score,
    issueCount: s.result?.issues?.length ?? 0,
    opportunityCount: s.result?.opportunities?.length ?? 0,
  }));
  return success(`Found ${trend.length} scan(s).`, { trend });
}

async function handleGetReviewHistory(
  { limit }: InferShape<typeof GET_REVIEW_HISTORY_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const events = await taskStore.getRecentReviewEvents(limit ?? 20);
  const total = events.length;
  const passed = events.filter(e => e.passed).length;
  const categories = await taskStore.getRecurringIssueCategories(10);
  return success(`${total} reviews: ${passed} passed, ${total - passed} failed.`, {
    total,
    passed,
    failed: total - passed,
    passRate: total > 0 ? passed / total : 0,
    topIssueCategories: categories,
  });
}

async function handleGetTaskOutcomes(
  { limit }: InferShape<typeof GET_TASK_OUTCOMES_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const [done, failed, blocked, skipped] = await Promise.all([
    taskStore.listTasks('done'),
    taskStore.listTasks('failed'),
    taskStore.listTasks('blocked'),
    taskStore.listTasks('skipped'),
  ]);
  const all = [...done, ...failed, ...blocked, ...skipped]
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, limit ?? 50);

  const summary = all.map(t => ({
    description: t.task_description.slice(0, 120),
    status: t.status,
    priority: t.priority,
    costUsd: t.total_cost_usd,
  }));

  return success(`${all.length} completed tasks.`, {
    counts: { done: done.length, failed: failed.length, blocked: blocked.length, skipped: skipped.length },
    recentTasks: summary,
  });
}

async function handleGetEvaluationScores(
  { limit }: InferShape<typeof GET_EVALUATION_SCORES_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const events = await taskStore.getRecentEvaluationEvents(limit ?? 20);
  const mapped = events.map(e => ({
    passed: e.passed,
    score: e.score,
    reasoning: e.reasoning.slice(0, 200),
    date: formatDate(e.created_at),
  }));
  return success(`${mapped.length} evaluation event(s).`, { events: mapped });
}

async function handleGetRecurringIssues(
  { limit }: InferShape<typeof GET_RECURRING_ISSUES_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const categories = await taskStore.getRecurringIssueCategories(limit ?? 10);
  return success(`${categories.length} recurring issue categories.`, { categories });
}

async function handleSearchMemories(
  { query }: InferShape<typeof SEARCH_MEMORIES_SCHEMA>,
  _taskStore: ProjectTaskStore,
  globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const memories = await globalMemory.search(query, 10);
  const mapped = memories.map(m => ({
    title: m.title,
    category: m.category,
    content: m.content.slice(0, 300),
    confidence: m.confidence,
    tags: m.tags,
  }));
  return success(`${mapped.length} memory item(s).`, { memories: mapped });
}

async function handleGetTaskDetail(
  { task_id }: InferShape<typeof GET_TASK_DETAIL_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const [task, logs, reviews] = await Promise.all([
    taskStore.getTask(task_id),
    taskStore.getTaskLogs(task_id),
    taskStore.getReviewEvents(task_id),
  ]);
  if (!task) return success(`Task ${task_id} not found.`, null);
  return success(`Task ${task_id}: ${task.status}`, {
    id: task.id,
    description: task.task_description,
    status: task.status,
    phase: task.phase,
    priority: task.priority,
    plan: task.plan,
    subtasks: task.subtasks,
    reviewResults: task.review_results,
    iteration: task.iteration,
    costUsd: task.total_cost_usd,
    gitBranch: task.git_branch,
    dependsOn: task.depends_on,
    createdAt: formatDate(task.created_at),
    logs: logs.map(l => ({
      phase: l.phase,
      agent: l.agent,
      input: l.input_summary,
      output: l.output_summary,
      costUsd: l.cost_usd,
      durationMs: l.duration_ms,
      date: formatDate(l.created_at),
    })),
    reviews: reviews.map(r => ({
      attempt: r.attempt,
      passed: r.passed,
      mustFixCount: r.must_fix_count,
      shouldFixCount: r.should_fix_count,
      issueCategories: r.issue_categories,
      fixAgent: r.fix_agent,
      costUsd: r.cost_usd,
    })),
  });
}

async function handleGetRecentTasks(
  { limit, status }: InferShape<typeof GET_RECENT_TASKS_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const tasks = await taskStore.listTasks(status);
  const sliced = tasks.slice(0, limit ?? 20);
  const mapped = sliced.map(t => ({
    id: t.id,
    description: t.task_description,
    status: t.status,
    phase: t.phase,
    priority: t.priority,
    costUsd: t.total_cost_usd,
    createdAt: formatDate(t.created_at),
  }));
  return success(`${mapped.length} task(s).`, { tasks: mapped });
}

async function handleGetTaskLogs(
  { task_id }: InferShape<typeof GET_TASK_LOGS_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const logs = await taskStore.getTaskLogs(task_id);
  const mapped = logs.map(l => ({
    phase: l.phase,
    agent: l.agent,
    input: l.input_summary,
    output: l.output_summary,
    costUsd: l.cost_usd,
    durationMs: l.duration_ms,
    date: formatDate(l.created_at),
  }));
  return success(`${mapped.length} log(s) for task ${task_id}.`, { logs: mapped });
}

async function handleGetReviewDetails(
  { task_id }: InferShape<typeof GET_REVIEW_DETAILS_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const reviews = await taskStore.getReviewEvents(task_id);
  const mapped = reviews.map(r => ({
    attempt: r.attempt,
    passed: r.passed,
    mustFixCount: r.must_fix_count,
    shouldFixCount: r.should_fix_count,
    issueCategories: r.issue_categories,
    fixAgent: r.fix_agent,
    durationMs: r.duration_ms,
    costUsd: r.cost_usd,
    date: formatDate(r.created_at),
  }));
  return success(`${mapped.length} review(s) for task ${task_id}.`, { reviews: mapped });
}

async function handleGetAdjustmentSummary(
  { limit }: InferShape<typeof GET_ADJUSTMENT_SUMMARY_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const adjustments = await taskStore.getActiveAdjustments(limit ?? 20);
  const mapped = adjustments.map(a => ({
    id: a.id,
    text: a.text,
    category: a.category,
    effectiveness: a.effectiveness,
    taskId: a.task_id,
    createdAt: formatDate(a.created_at),
  }));
  return success(`${mapped.length} active adjustment(s).`, { adjustments: mapped });
}

async function handleGetPromptVersions(
  { prompt_name }: InferShape<typeof GET_PROMPT_VERSIONS_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  if (prompt_name) {
    const history = await taskStore.getPromptVersionHistory(prompt_name, 20);
    const mapped = history.map(v => ({
      version: v.version,
      status: v.status,
      patches: v.patches,
      rationale: v.rationale,
      confidence: v.confidence,
      effectiveness: v.effectiveness,
      tasksEvaluated: v.tasks_evaluated,
      baselineMetrics: v.baseline_metrics,
      currentMetrics: v.current_metrics,
      activatedAt: formatDateNullable(v.activated_at),
      createdAt: formatDate(v.created_at),
    }));
    return success(`${mapped.length} version(s) for "${prompt_name}".`, { versions: mapped });
  }
  const active = await taskStore.getActivePromptVersions();
  const mapped = active.map(v => ({
    promptName: v.prompt_name,
    version: v.version,
    effectiveness: v.effectiveness,
    tasksEvaluated: v.tasks_evaluated,
    confidence: v.confidence,
    activatedAt: formatDateNullable(v.activated_at),
  }));
  return success(`${mapped.length} active prompt version(s).`, { versions: mapped });
}

async function handleGetCostTrend(
  { days }: InferShape<typeof GET_COST_TREND_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  const costs = await taskStore.getRecentCosts(days ?? 7);
  return success(`${costs.length} day(s) of cost data.`, { costs });
}

async function handleGetGoalProgress(
  { goal_index }: InferShape<typeof GET_GOAL_PROGRESS_SCHEMA>,
  taskStore: ProjectTaskStore,
  _globalMemory: SystemDataGlobalMemory,
): Promise<ToolResponse> {
  if (goal_index !== undefined) {
    const history = await taskStore.getGoalProgressHistory(goal_index, 10);
    const mapped = history.map(g => ({
      progressPct: g.progress_pct,
      evidence: g.evidence,
      scanId: g.scan_id,
      date: formatDate(g.created_at),
    }));
    return success(`${mapped.length} progress record(s) for goal #${goal_index}.`, { history: mapped });
  }
  const latest = await taskStore.getLatestGoalProgress();
  const mapped = latest.map(g => ({
    goalIndex: g.goal_index,
    progressPct: g.progress_pct,
    evidence: g.evidence,
    date: formatDate(g.created_at),
  }));
  return success(`${mapped.length} goal(s) with progress.`, { goals: mapped });
}

function defineSystemDataTool<Schema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: Schema,
  handler: (
    args: InferShape<Schema>,
    taskStore: ProjectTaskStore,
    globalMemory: SystemDataGlobalMemory,
  ) => Promise<ToolResponse>,
) {
  return (taskStore: ProjectTaskStore, globalMemory: SystemDataGlobalMemory) =>
    safeTool(name, description, schema, (args) => handler(args, taskStore, globalMemory));
}

const SYSTEM_DATA_TOOL_BUILDERS = [
  defineSystemDataTool(
    'get_health_trend',
    'Get recent health score trend from scan results. Use to understand project trajectory.',
    GET_HEALTH_TREND_SCHEMA,
    handleGetHealthTrend,
  ),
  defineSystemDataTool(
    'get_review_history',
    'Get recent review pass/fail rates and high-frequency issue categories.',
    GET_REVIEW_HISTORY_SCHEMA,
    handleGetReviewHistory,
  ),
  defineSystemDataTool(
    'get_task_outcomes',
    'Get task success/failure/blocked statistics. Use to evaluate how similar tasks have fared.',
    GET_TASK_OUTCOMES_SCHEMA,
    handleGetTaskOutcomes,
  ),
  defineSystemDataTool(
    'get_evaluation_scores',
    'Get historical evaluation scores to calibrate your own scoring.',
    GET_EVALUATION_SCORES_SCHEMA,
    handleGetEvaluationScores,
  ),
  defineSystemDataTool(
    'get_recurring_issues',
    'Get high-frequency issue categories from reviews. Use to check if a problem keeps reappearing.',
    GET_RECURRING_ISSUES_SCHEMA,
    handleGetRecurringIssues,
  ),
  defineSystemDataTool(
    'search_memories',
    'Search global memory for relevant experiences, patterns, and lessons learned.',
    SEARCH_MEMORIES_SCHEMA,
    handleSearchMemories,
  ),
  defineSystemDataTool(
    'get_task_detail',
    'Get full details of a single task including plan, subtasks, review results, and execution logs.',
    GET_TASK_DETAIL_SCHEMA,
    handleGetTaskDetail,
  ),
  defineSystemDataTool(
    'get_recent_tasks',
    'Get recent tasks with full descriptions. Optionally filter by status.',
    GET_RECENT_TASKS_SCHEMA,
    handleGetRecentTasks,
  ),
  defineSystemDataTool(
    'get_task_logs',
    "Get execution logs for a task showing each phase's input/output/cost/duration.",
    GET_TASK_LOGS_SCHEMA,
    handleGetTaskLogs,
  ),
  defineSystemDataTool(
    'get_review_details',
    'Get all review rounds for a single task with issue details.',
    GET_REVIEW_DETAILS_SCHEMA,
    handleGetReviewDetails,
  ),
  defineSystemDataTool(
    'get_adjustment_summary',
    'Get currently active adjustments with effectiveness scores and categories.',
    GET_ADJUSTMENT_SUMMARY_SCHEMA,
    handleGetAdjustmentSummary,
  ),
  defineSystemDataTool(
    'get_prompt_versions',
    'Get prompt patch history. Without prompt_name returns all active versions; with it returns version history.',
    GET_PROMPT_VERSIONS_SCHEMA,
    handleGetPromptVersions,
  ),
  defineSystemDataTool(
    'get_cost_trend',
    'Get daily cost trend showing spending over recent days.',
    GET_COST_TREND_SCHEMA,
    handleGetCostTrend,
  ),
  defineSystemDataTool(
    'get_goal_progress',
    'Get evolution goal progress. Without goal_index returns latest progress for all goals; with it returns history for that goal.',
    GET_GOAL_PROGRESS_SCHEMA,
    handleGetGoalProgress,
  ),
];

export function createSystemDataMcpServer(deps: SystemDataMcpDeps) {
  const taskStore = createProjectTaskStore(deps.taskStore, deps.projectPath);
  const tools = SYSTEM_DATA_TOOL_BUILDERS.map(buildTool => buildTool(taskStore, deps.globalMemory));

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools,
  });
}
