import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { GlobalMemory } from '../memory/GlobalMemory.js';
import type { TaskStore } from '../memory/TaskStore.js';

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
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `${toolName} failed: ${message}` }], isError: true };
}

export function createSystemDataMcpServer(deps: SystemDataMcpDeps) {
  const { projectPath, taskStore, globalMemory } = deps;

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'get_health_trend',
        'Get recent health score trend from scan results. Use to understand project trajectory.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          try {
            const scans = await taskStore.getRecentScans(projectPath, limit ?? 10);
            const trend = scans.map(s => ({
              date: s.created_at instanceof Date ? s.created_at.toISOString() : String(s.created_at),
              healthScore: s.health_score,
              issueCount: s.result?.issues?.length ?? 0,
              opportunityCount: s.result?.opportunities?.length ?? 0,
            }));
            return success(`Found ${trend.length} scan(s).`, { trend });
          } catch (e) {
            return error('get_health_trend', e);
          }
        },
      ),

      tool(
        'get_review_history',
        'Get recent review pass/fail rates and high-frequency issue categories.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          try {
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
          } catch (e) {
            return error('get_review_history', e);
          }
        },
      ),

      tool(
        'get_task_outcomes',
        'Get task success/failure/blocked statistics. Use to evaluate how similar tasks have fared.',
        { limit: z.number().int().min(1).max(100).optional() },
        async ({ limit }) => {
          try {
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
          } catch (e) {
            return error('get_task_outcomes', e);
          }
        },
      ),

      tool(
        'get_evaluation_scores',
        'Get historical evaluation scores to calibrate your own scoring.',
        { limit: z.number().int().min(1).max(50).optional() },
        async ({ limit }) => {
          try {
            const events = await taskStore.getRecentEvaluationEvents(projectPath, limit ?? 20);
            const mapped = events.map(e => ({
              passed: e.passed,
              score: e.score,
              reasoning: e.reasoning.slice(0, 200),
              date: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
            }));
            return success(`${mapped.length} evaluation event(s).`, { events: mapped });
          } catch (e) {
            return error('get_evaluation_scores', e);
          }
        },
      ),

      tool(
        'get_recurring_issues',
        'Get high-frequency issue categories from reviews. Use to check if a problem keeps reappearing.',
        { limit: z.number().int().min(1).max(30).optional() },
        async ({ limit }) => {
          try {
            const categories = await taskStore.getRecurringIssueCategories(projectPath, limit ?? 10);
            return success(`${categories.length} recurring issue categories.`, { categories });
          } catch (e) {
            return error('get_recurring_issues', e);
          }
        },
      ),

      tool(
        'search_memories',
        'Search global memory for relevant experiences, patterns, and lessons learned.',
        { query: z.string().min(1) },
        async ({ query }) => {
          try {
            const memories = await globalMemory.search(query, 10);
            const mapped = memories.map(m => ({
              title: m.title,
              category: m.category,
              content: m.content.slice(0, 300),
              confidence: m.confidence,
              tags: m.tags,
            }));
            return success(`${mapped.length} memory item(s).`, { memories: mapped });
          } catch (e) {
            return error('search_memories', e);
          }
        },
      ),
    ],
  });
}
