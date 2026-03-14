import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { PlanChatManager, validatePlanOutput } from "../../src/core/PlanChatManager.js";
import type { TaskStore } from "../../src/memory/TaskStore.js";
import type { Config } from "../../src/config/Config.js";
import type { RuntimeAdapter } from "../../src/runtime/RuntimeAdapter.js";

function createMockTaskStore(
  activeSessions: {
    id: number;
    chat_session_id: string | null;
    chat_status: string;
  }[] = [],
) {
  const statusUpdates: { id: number; status: string }[] = [];
  return {
    store: {
      getActiveChatSessions: mock.fn(async () => activeSessions),
      updateChatStatus: mock.fn(async (id: number, status: string) => {
        statusUpdates.push({ id, status });
      }),
    } as unknown as TaskStore,
    statusUpdates,
  };
}

function createMockConfig(projectPath = "/test/project"): Config {
  return {
    projectPath,
    values: {
      brain: { model: "sonnet", maxScanBudget: 1 },
      routing: { plan: { runtime: "claude-sdk", model: "claude-opus-4-6" } },
    },
  } as unknown as Config;
}

function createMockRuntime(): RuntimeAdapter {
  return {
    name: "mock-runtime",
    capabilities: {
      nativeOutputSchema: true,
      eventStreaming: true,
      sessionPersistence: true,
      sandboxControl: true,
      toolSurface: true,
      extendedThinking: false,
    },
    run: mock.fn(async () => ({
      text: "",
      costUsd: 0,
      durationMs: 0,
      isError: false,
      errors: [],
    })),
    isAvailable: mock.fn(async () => true),
    supportsModel: mock.fn(() => true),
  };
}

describe("validatePlanOutput", () => {
  test("returns undefined for null", () => {
    assert.equal(validatePlanOutput(null), undefined);
  });

  test("returns undefined for non-object primitives", () => {
    assert.equal(validatePlanOutput("string"), undefined);
    assert.equal(validatePlanOutput(42), undefined);
    assert.equal(validatePlanOutput(true), undefined);
  });

  test("returns undefined when summary is missing", () => {
    assert.equal(validatePlanOutput({ tasks: [] }), undefined);
  });

  test("returns undefined when summary is not a string", () => {
    assert.equal(validatePlanOutput({ summary: 123, tasks: [] }), undefined);
  });

  test("returns undefined when tasks is missing", () => {
    assert.equal(validatePlanOutput({ summary: "ok" }), undefined);
  });

  test("returns undefined when tasks is not an array", () => {
    assert.equal(
      validatePlanOutput({ summary: "ok", tasks: "bad" }),
      undefined,
    );
  });

  test("returns valid plan with all valid tasks", () => {
    const result = validatePlanOutput({
      summary: "Plan summary",
      tasks: [
        { description: "task one", priority: 1 },
        { description: "task two", priority: 2 },
      ],
    });
    assert.deepEqual(result, {
      summary: "Plan summary",
      tasks: [
        { description: "task one", priority: 1 },
        { description: "task two", priority: 2 },
      ],
    });
  });

  test("filters out tasks with missing description", () => {
    const result = validatePlanOutput({
      summary: "s",
      tasks: [{ priority: 1 }, { description: "good task", priority: 2 }],
    });
    assert.deepEqual(result, {
      summary: "s",
      tasks: [{ description: "good task", priority: 2 }],
    });
  });

  test("filters out tasks with non-string description", () => {
    const result = validatePlanOutput({
      summary: "s",
      tasks: [
        { description: 99, priority: 1 },
        { description: "valid", priority: 0 },
      ],
    });
    assert.deepEqual(result, {
      summary: "s",
      tasks: [{ description: "valid", priority: 0 }],
    });
  });

  test("filters out tasks with non-number priority", () => {
    const result = validatePlanOutput({
      summary: "s",
      tasks: [
        { description: "bad prio", priority: "high" },
        { description: "good", priority: 1 },
      ],
    });
    assert.deepEqual(result, {
      summary: "s",
      tasks: [{ description: "good", priority: 1 }],
    });
  });

  test("returns plan with empty tasks array when all tasks are invalid", () => {
    const result = validatePlanOutput({
      summary: "s",
      tasks: [{ description: 1, priority: "bad" }, null, "string item"],
    });
    assert.deepEqual(result, { summary: "s", tasks: [] });
  });

  test("returns plan with empty tasks array for empty tasks input", () => {
    const result = validatePlanOutput({ summary: "no tasks yet", tasks: [] });
    assert.deepEqual(result, { summary: "no tasks yet", tasks: [] });
  });
});

describe("PlanChatManager.restoreSessions", () => {
  test("restores chatting sessions without DB write-back", async () => {
    const { store, statusUpdates } = createMockTaskStore([
      { id: 1, chat_session_id: "sess-a", chat_status: "chatting" },
      { id: 2, chat_session_id: "sess-b", chat_status: "chatting" },
    ]);
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    const count = await mgr.restoreSessions();

    assert.equal(count, 2);
    assert.equal(mgr.getSessionStatus(1), "chatting");
    assert.equal(mgr.getSessionStatus(2), "chatting");
    assert.equal(statusUpdates.length, 0);
  });

  test("normalises researching/generating to chatting and writes back to DB", async () => {
    const { store, statusUpdates } = createMockTaskStore([
      { id: 3, chat_session_id: "sess-c", chat_status: "researching" },
      { id: 4, chat_session_id: "sess-d", chat_status: "generating" },
    ]);
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    const count = await mgr.restoreSessions();

    assert.equal(count, 2);
    assert.equal(mgr.getSessionStatus(3), "chatting");
    assert.equal(mgr.getSessionStatus(4), "chatting");
    assert.deepEqual(statusUpdates, [
      { id: 3, status: "chatting" },
      { id: 4, status: "chatting" },
    ]);
  });

  test("skips sessions already in memory and returns actual restored count", async () => {
    const { store } = createMockTaskStore([
      { id: 5, chat_session_id: "sess-e", chat_status: "chatting" },
      { id: 6, chat_session_id: "sess-f", chat_status: "chatting" },
    ]);
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    // First restore
    const first = await mgr.restoreSessions();
    assert.equal(first, 2);

    // Second restore — both already in memory
    const second = await mgr.restoreSessions();
    assert.equal(second, 0);
  });

  test("returns 0 when no active sessions exist", async () => {
    const { store } = createMockTaskStore([]);
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    const count = await mgr.restoreSessions();

    assert.equal(count, 0);
  });

  test("restores session with null chat_session_id as empty string", async () => {
    const { store } = createMockTaskStore([
      { id: 7, chat_session_id: null, chat_status: "chatting" },
    ]);
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    await mgr.restoreSessions();

    assert.equal(mgr.getSessionStatus(7), "chatting");
  });

  test("still restores session to memory when DB write-back fails", async () => {
    let callCount = 0;
    const store = {
      getActiveChatSessions: mock.fn(async () => [
        { id: 10, chat_session_id: "s-10", chat_status: "researching" },
        { id: 11, chat_session_id: "s-11", chat_status: "generating" },
        { id: 12, chat_session_id: "s-12", chat_status: "chatting" },
      ]),
      updateChatStatus: mock.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("DB write failed");
      }),
    } as unknown as TaskStore;
    const mgr = new PlanChatManager(
      store,
      createMockConfig(),
      createMockRuntime(),
    );

    const count = await mgr.restoreSessions();

    // All 3 restored — usability over DB consistency
    assert.equal(count, 3);
    assert.equal(mgr.getSessionStatus(10), "chatting");
    assert.equal(mgr.getSessionStatus(11), "chatting");
    assert.equal(mgr.getSessionStatus(12), "chatting");
  });
});
