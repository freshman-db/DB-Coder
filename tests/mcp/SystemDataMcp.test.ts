import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSystemDataMcpServer, buildToolDefs } from "../../src/mcp/SystemDataMcp.js";
import type { TaskStore } from "../../src/memory/TaskStore.js";

/** Minimal mock that satisfies the subset of TaskStore used by SystemDataMcp. */
function mockTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getBlockedTaskSummary: async () => ({
      blockedCount: 0,
      recentFailures: [],
    }),
    listTasks: async () => [],
    getTask: async () => null,
    getTaskLogs: async () => [],
    getOperationalMetrics: async () => ({
      cycleCount: 0,
      avgCycleDurationMs: 0,
      taskPassRate: 0,
      dailyCostUsd: 0,
      queueDepth: 0,
      tasksByStatus: {},
      recentHealthScores: [],
    }),
    getRecentCosts: async () => [],
    createTask: async (_pp: string, desc: string, priority: number) =>
      ({
        id: "new-task-id",
        task_description: desc,
        priority,
        status: "queued",
      }) as Awaited<ReturnType<TaskStore["createTask"]>>,
    requeueBlockedTasks: async () => 0,
    ...overrides,
  } as unknown as TaskStore;
}

type ToolDef = ReturnType<typeof buildToolDefs>[number];

function findTool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

async function callTool(t: ToolDef, args: Record<string, unknown>) {
  // Cast to any — each tool has its own schema but we test via the common interface
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = t.handler as (
    a: any,
    e: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
  return handler(args, {});
}

describe("createSystemDataMcpServer", () => {
  it("returns a valid MCP server config with name and instance", () => {
    const store = mockTaskStore();
    const server = createSystemDataMcpServer({
      projectPath: "/test",
      taskStore: store,
    });

    assert.equal(server.name, "db-coder-system-data");
    assert.equal(server.type, "sdk");
    assert.ok(server.instance, "should have an MCP server instance");
  });
});

describe("buildToolDefs", () => {
  it("returns 8 tool definitions", () => {
    const tools = buildToolDefs({
      projectPath: "/test",
      taskStore: mockTaskStore(),
    });
    assert.equal(tools.length, 8);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("get_blocked_summary"));
    assert.ok(names.includes("create_task"));
    assert.ok(names.includes("requeue_blocked_tasks"));
  });
});

describe("MCP tool handlers", () => {
  it("get_blocked_summary returns summary from TaskStore", async () => {
    const store = mockTaskStore({
      getBlockedTaskSummary: async () => ({
        blockedCount: 5,
        recentFailures: [
          {
            taskId: "t1",
            description: "Fix something",
            phase: "verify",
            agent: "worker",
            outputSummary: "tsc failed",
            updatedAt: new Date("2026-01-01"),
          },
        ],
      }),
    });

    const tools = buildToolDefs({ projectPath: "/test", taskStore: store });
    const result = await callTool(findTool(tools, "get_blocked_summary"), {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.blockedCount, 5);
    assert.equal(data.recentFailures.length, 1);
    assert.equal(data.recentFailures[0].taskId, "t1");
  });

  it("create_task calls TaskStore.createTask with correct args", async () => {
    let capturedArgs: { pp: string; desc: string; prio: number } | null = null;
    const store = mockTaskStore({
      createTask: async (pp: string, desc: string, prio: number) => {
        capturedArgs = { pp, desc, prio };
        return {
          id: "created-id",
          task_description: desc,
          priority: prio,
          status: "queued",
        } as Awaited<ReturnType<TaskStore["createTask"]>>;
      },
    });

    const tools = buildToolDefs({ projectPath: "/test", taskStore: store });
    const result = await callTool(findTool(tools, "create_task"), {
      description: "[PIPELINE-FIX] fix specReview",
      priority: 0,
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.created, true);
    assert.equal(data.taskId, "created-id");
    assert.ok(capturedArgs);
    assert.equal((capturedArgs as { pp: string }).pp, "/test");
    assert.equal(
      (capturedArgs as { desc: string }).desc,
      "[PIPELINE-FIX] fix specReview",
    );
    assert.equal((capturedArgs as { prio: number }).prio, 0);
  });

  it("requeue_blocked_tasks calls TaskStore.requeueBlockedTasks", async () => {
    let capturedIds: string[] = [];
    const store = mockTaskStore({
      requeueBlockedTasks: async (_pp: string, ids: string[]) => {
        capturedIds = ids;
        return ids.length;
      },
    });

    const tools = buildToolDefs({ projectPath: "/test", taskStore: store });
    const result = await callTool(findTool(tools, "requeue_blocked_tasks"), {
      taskIds: ["a", "b", "c"],
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.requeued, 3);
    assert.equal(data.requested, 3);
    assert.deepEqual(capturedIds, ["a", "b", "c"]);
  });

  it("safeTool catches errors and returns isError", async () => {
    const store = mockTaskStore({
      getBlockedTaskSummary: async () => {
        throw new Error("DB connection lost");
      },
    });

    const tools = buildToolDefs({ projectPath: "/test", taskStore: store });
    const result = await callTool(findTool(tools, "get_blocked_summary"), {});

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("DB connection lost"));
  });

  it("get_task_detail returns not found for missing task", async () => {
    const store = mockTaskStore({ getTask: async () => null });

    const tools = buildToolDefs({ projectPath: "/test", taskStore: store });
    const result = await callTool(findTool(tools, "get_task_detail"), {
      taskId: "nonexistent",
    });

    const data = JSON.parse(result.content[0].text);
    assert.equal(data.error, "Task not found");
  });
});
