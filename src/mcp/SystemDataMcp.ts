import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskStore } from "../memory/TaskStore.js";
import { getErrorMessage } from "../utils/parse.js";

export interface SystemDataMcpDeps {
  projectPath: string;
  taskStore: TaskStore;
}

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(data: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown): ToolResponse {
  return {
    content: [{ type: "text", text: getErrorMessage(err) }],
    isError: true,
  };
}

/**
 * Wraps a tool handler with try/catch so DB errors return isError
 * instead of crashing the MCP server.
 */
function safeTool<S extends z.ZodRawShape>(
  name: string,
  desc: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK InferShape vs z.infer mismatch
  return tool(name, desc, schema, async (args: any) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(err);
    }
  });
}

/** Build all MCP tool definitions — exported for testing. */
export function buildToolDefs(deps: SystemDataMcpDeps) {
  const { projectPath, taskStore } = deps;

  return [
    // --- Read-only data tools ---

    safeTool(
      "get_blocked_summary",
      "Get count of blocked/failed tasks and their recent failure patterns with last log entry",
      {
        windowHours: z
          .number()
          .optional()
          .describe("Lookback window in hours (default 48)"),
      },
      async (args) => {
        const summary = await taskStore.getBlockedTaskSummary(
          projectPath,
          args.windowHours ?? 48,
        );
        return textResult(summary);
      },
    ),

    safeTool(
      "get_recent_tasks",
      "List recent tasks, optionally filtered by status",
      {
        status: z
          .string()
          .optional()
          .describe(
            "Filter by status: queued, active, done, failed, blocked, skipped",
          ),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
      async (args) => {
        const tasks = await taskStore.listTasks(
          projectPath,
          args.status as Parameters<typeof taskStore.listTasks>[1],
        );
        const limited = tasks.slice(0, args.limit ?? 20);
        return textResult(
          limited.map((t) => ({
            id: t.id,
            status: t.status,
            phase: t.phase,
            priority: t.priority,
            description: t.task_description,
            iteration: t.iteration,
            costUsd: t.total_cost_usd,
            updatedAt: t.updated_at,
          })),
        );
      },
    ),

    safeTool(
      "get_task_detail",
      "Get full details for a single task by ID",
      { taskId: z.string().describe("Task UUID") },
      async (args) => {
        const task = await taskStore.getTask(args.taskId);
        if (!task) return textResult({ error: "Task not found" });
        return textResult(task);
      },
    ),

    safeTool(
      "get_task_logs",
      "Get execution logs for a task (output_summary truncated to 500 chars; full text stored in DB)",
      { taskId: z.string().describe("Task UUID") },
      async (args) => {
        const logs = await taskStore.getTaskLogs(args.taskId);
        const summarized = logs.map((l) => ({
          ...l,
          output_summary: l.output_summary
            ? l.output_summary.length > 500
              ? l.output_summary.slice(0, 500) + "… [truncated]"
              : l.output_summary
            : l.output_summary,
        }));
        return textResult(summarized);
      },
    ),

    safeTool(
      "get_operational_metrics",
      "Get task statistics: done/failed/blocked counts, pass rate, queue depth, daily cost",
      {},
      async () => {
        const metrics = await taskStore.getOperationalMetrics(projectPath);
        return textResult(metrics);
      },
    ),

    safeTool(
      "get_cost_trend",
      "Get daily cost trend for recent days",
      {
        days: z.number().optional().describe("Number of days (default 7)"),
      },
      async (args) => {
        const costs = await taskStore.getRecentCosts(args.days ?? 7);
        return textResult(costs);
      },
    ),

    // --- Action tools ---

    safeTool(
      "create_task",
      "Create a new task in the queue. Use [PIPELINE-FIX] prefix for pipeline repair tasks.",
      {
        description: z.string().describe("Task description"),
        priority: z
          .number()
          .optional()
          .describe("Priority 0-3 (0=urgent, default 2)"),
      },
      async (args) => {
        const task = await taskStore.createTask(
          projectPath,
          args.description,
          args.priority ?? 2,
        );
        return textResult({
          created: true,
          taskId: task.id,
          description: task.task_description,
        });
      },
    ),

    safeTool(
      "requeue_blocked_tasks",
      "Re-queue blocked/failed tasks so they can be retried",
      {
        taskIds: z.array(z.string()).describe("Array of task UUIDs to requeue"),
      },
      async (args) => {
        const count = await taskStore.requeueBlockedTasks(
          projectPath,
          args.taskIds,
        );
        return textResult({
          requeued: count,
          requested: args.taskIds.length,
        });
      },
    ),
  ];
}

export function createSystemDataMcpServer(deps: SystemDataMcpDeps) {
  return createSdkMcpServer({
    name: "db-coder-system-data",
    version: "2.0.0",
    tools: buildToolDefs(deps),
  });
}
