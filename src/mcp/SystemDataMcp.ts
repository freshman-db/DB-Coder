import { createSdkMcpServer, tool, type InferShape } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';
import { getErrorMessage } from '../utils/parse.js';

const MCP_SERVER_NAME = 'db-coder-system-data';

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

export function createSystemDataMcpServer(deps: SystemDataMcpDeps) {
  const { projectPath, taskStore, globalMemory } = deps;

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      safeTool(
        'get_health_trend',
        'Get recent health score trend from scan results. Use to understand project trajectory.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          const scans = await taskStore.getRecentScans(projectPath, limit ?? 10);
          const trend = scans.map(s => ({
            date: formatDate(s.created_at),
            healthScore: s.health_score,
            issueCount: s.result?.issues?.length ?? 0,
            opportunityCount: s.result?.opportunities?.length ?? 0,
          }));
          return success(`Found ${trend.length} scan(s).`, { trend });
        },
      ),

      safeTool(
        'get_review_history',
        'Get recent review pass/fail rates and high-frequency issue categories.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          const events = await taskStore.getRecentReviewEvents(projectPath, limit ?? 20);
          const total = events.length;
          const passed = events.filter(e => e.passed).length;
          const categories = await taskStore.getRecurringIssueCategories(projectPath, 10);
          return success(`${total} reviews: ${passed} passed, ${total - passed} failed.`, {
            total,
            passed,
            failed: total - passed,
            passRate: total > 0 ? passed / total : 0,
            topIssueCategories: categories,
          });
        },
      ),

      safeTool(
        'get_task_outcomes',
        'Get task success/failure/blocked statistics. Use to evaluate how similar tasks have fared.',
        { limit: z.number().int().min(1).max(100).optional() },
        async ({ limit }) => {
          const [done, failed, blocked, skipped] = await Promise.all([
            taskStore.listTasks(projectPath, 'done'),
            taskStore.listTasks(projectPath, 'failed'),
            taskStore.listTasks(projectPath, 'blocked'),
            taskStore.listTasks(projectPath, 'skipped'),
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
        },
      ),

      safeTool(
        'get_evaluation_scores',
        'Get historical evaluation scores to calibrate your own scoring.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          const events = await taskStore.getRecentEvaluationEvents(projectPath, limit ?? 20);
          const mapped = events.map(e => ({
            passed: e.passed,
            score: e.score,
            reasoning: e.reasoning.slice(0, 200),
            date: formatDate(e.created_at),
          }));
          return success(`${mapped.length} evaluation event(s).`, { events: mapped });
        },
      ),

      safeTool(
        'get_recurring_issues',
        'Get high-frequency issue categories from reviews. Use to check if a problem keeps reappearing.',
        { limit: z.number().int().min(1).max(30).optional() },
        async ({ limit }) => {
          const categories = await taskStore.getRecurringIssueCategories(projectPath, limit ?? 10);
          return success(`${categories.length} recurring issue categories.`, { categories });
        },
      ),

      safeTool(
        'search_memories',
        'Search global memory for relevant experiences, patterns, and lessons learned.',
        { query: z.string().min(1) },
        async ({ query }) => {
          const memories = await globalMemory.search(query, 10);
          const mapped = memories.map(m => ({
            title: m.title,
            category: m.category,
            content: m.content.slice(0, 300),
            confidence: m.confidence,
            tags: m.tags,
          }));
          return success(`${mapped.length} memory item(s).`, { memories: mapped });
        },
      ),

      safeTool(
        'get_task_detail',
        'Get full details of a single task including plan, subtasks, review results, and execution logs.',
        { task_id: z.string().min(1) },
        async ({ task_id }) => {
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
        },
      ),

      safeTool(
        'get_recent_tasks',
        'Get recent tasks with full descriptions. Optionally filter by status.',
        {
          limit: z.number().int().min(1).max(50).optional(),
          status: z.enum(['queued', 'active', 'done', 'failed', 'blocked', 'skipped', 'pending_review']).optional(),
        },
        async ({ limit, status }) => {
          const tasks = await taskStore.listTasks(projectPath, status);
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
        },
      ),

      safeTool(
        'get_task_logs',
        'Get execution logs for a task showing each phase\'s input/output/cost/duration.',
        { task_id: z.string().min(1) },
        async ({ task_id }) => {
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
        },
      ),

      safeTool(
        'get_review_details',
        'Get all review rounds for a single task with issue details.',
        { task_id: z.string().min(1) },
        async ({ task_id }) => {
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
        },
      ),

      safeTool(
        'get_adjustment_summary',
        'Get currently active adjustments with effectiveness scores and categories.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          const adjustments = await taskStore.getActiveAdjustments(projectPath, limit ?? 20);
          const mapped = adjustments.map(a => ({
            id: a.id,
            text: a.text,
            category: a.category,
            effectiveness: a.effectiveness,
            taskId: a.task_id,
            createdAt: formatDate(a.created_at),
          }));
          return success(`${mapped.length} active adjustment(s).`, { adjustments: mapped });
        },
      ),

      safeTool(
        'get_prompt_versions',
        'Get prompt patch history. Without prompt_name returns all active versions; with it returns version history.',
        { prompt_name: z.string().optional() },
        async ({ prompt_name }) => {
          if (prompt_name) {
            const history = await taskStore.getPromptVersionHistory(projectPath, prompt_name as any, 20);
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
          const active = await taskStore.getActivePromptVersions(projectPath);
          const mapped = active.map(v => ({
            promptName: v.prompt_name,
            version: v.version,
            effectiveness: v.effectiveness,
            tasksEvaluated: v.tasks_evaluated,
            confidence: v.confidence,
            activatedAt: formatDateNullable(v.activated_at),
          }));
          return success(`${mapped.length} active prompt version(s).`, { versions: mapped });
        },
      ),

      safeTool(
        'get_cost_trend',
        'Get daily cost trend showing spending over recent days.',
        { days: z.number().int().min(1).max(90).optional() },
        async ({ days }) => {
          const costs = await taskStore.getRecentCosts(days ?? 7);
          return success(`${costs.length} day(s) of cost data.`, { costs });
        },
      ),

      safeTool(
        'get_goal_progress',
        'Get evolution goal progress. Without goal_index returns latest progress for all goals; with it returns history for that goal.',
        { goal_index: z.number().int().min(0).optional() },
        async ({ goal_index }) => {
          if (goal_index !== undefined) {
            const history = await taskStore.getGoalProgressHistory(projectPath, goal_index, 10);
            const mapped = history.map(g => ({
              progressPct: g.progress_pct,
              evidence: g.evidence,
              scanId: g.scan_id,
              date: formatDate(g.created_at),
            }));
            return success(`${mapped.length} progress record(s) for goal #${goal_index}.`, { history: mapped });
          }
          const latest = await taskStore.getLatestGoalProgress(projectPath);
          const mapped = latest.map(g => ({
            goalIndex: g.goal_index,
            progressPct: g.progress_pct,
            evidence: g.evidence,
            date: formatDate(g.created_at),
          }));
          return success(`${mapped.length} goal(s) with progress.`, { goals: mapped });
        },
      ),
    ],
  });
}
