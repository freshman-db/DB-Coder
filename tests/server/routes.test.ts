import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { Config } from "../../src/config/Config.js";
import type { MainLoop } from "../../src/core/MainLoop.js";
import type { PatrolManager } from "../../src/core/ModeManager.js";
import type { GlobalMemory } from "../../src/memory/GlobalMemory.js";
import type { TaskStore } from "../../src/memory/TaskStore.js";
import type { OperationalMetrics } from "../../src/memory/types.js";
import type { CostTracker } from "../../src/utils/cost.js";
import type { PlanChatManager } from "../../src/core/PlanChatManager.js";
import { log } from "../../src/utils/logger.js";
import {
  createMockRequest,
  createMockResponse,
  getRequestListener,
} from "./__test-helpers.js";
import type { MockResponseState } from "./__test-helpers.js";
import {
  createSseStream,
  emitSseEvent,
  HttpError,
  parseRouteId,
} from "../../src/server/routes.js";
import { Server } from "../../src/server/Server.js";

interface RequestOptions {
  method: "GET" | "POST";
  url: string;
  token?: string;
  authorization?: string;
  body?: unknown;
}

interface ServerFixtureOptions {
  apiToken?: string;
  loop?: Partial<MainLoop>;
  taskStore?: Partial<TaskStore>;
  costTracker?: Partial<CostTracker>;
  modeManager?: Partial<PatrolManager>;
  planChat?: Partial<PlanChatManager>;
}

interface ServerFixture {
  server: Server;
  token: string;
}

function createServerFixture(
  options: ServerFixtureOptions = {},
): ServerFixture {
  const token = options.apiToken ?? "test-token";

  const loop = {
    getState: () => "idle",
    getCurrentTaskId: () => null,
    isPaused: () => false,
    isRunning: () => false,
    addStatusListener: () => () => {},
    getStatusSnapshot: () => ({
      state: "idle",
      currentTaskId: null,
      patrolling: false,
      paused: false,
    }),
    pause: () => {},
    resume: () => {},
    triggerScan: async () => {},
    ...options.loop,
  } as unknown as MainLoop;

  const taskStore = {
    createTask: async () => ({ id: "task-1" }),
    listTasksPaged: async () => ({
      tasks: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
    getTask: async () => null,
    ...options.taskStore,
  } as unknown as TaskStore;

  const costTracker = {
    getDailySummary: async () => [],
    getSessionCost: () => 0,
    ...options.costTracker,
  } as unknown as CostTracker;

  const modeManager = {
    startPatrol: async () => {},
    stopPatrol: async () => {},
    ...options.modeManager,
  } as unknown as PatrolManager;

  const config = {
    projectPath: "/workspace/project",
    values: {
      apiToken: token,
      server: { host: "127.0.0.1", port: 18890 },
      brain: { scanInterval: 30 },
    },
  } as unknown as Config;

  const globalMemory = {} as GlobalMemory;

  return {
    server: new Server(
      config,
      loop,
      taskStore,
      globalMemory,
      costTracker,
      undefined,
      modeManager,
      options.planChat as unknown as import("../../src/core/PlanChatManager.js").PlanChatManager,
    ),
    token,
  };
}

async function dispatch(
  server: Server,
  options: RequestOptions,
): Promise<MockResponseState> {
  const listener = getRequestListener(server);
  const { response, state } = createMockResponse();
  await listener(createMockRequest(options), response);
  return state;
}

function parseJson<T>(state: MockResponseState): T {
  return JSON.parse(state.body) as T;
}

test("parseRouteId returns parsed number for a valid id parameter", () => {
  assert.equal(parseRouteId({ id: "42" }), 42);
});

test("parseRouteId throws HttpError with status 400 for a non-numeric id", () => {
  assert.throws(
    () => parseRouteId({ id: "abc" }),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal((error as HttpError).statusCode, 400);
      return true;
    },
  );
});

test("parseRouteId includes custom label in HttpError message when id is missing", () => {
  assert.throws(
    () => parseRouteId({}, "id", "plan ID"),
    (error: unknown) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal((error as HttpError).statusCode, 400);
      assert.equal((error as HttpError).message.includes("plan ID"), true);
      return true;
    },
  );
});

test("GET /api/tasks returns paginated task list JSON", async () => {
  let listArgs:
    | {
        projectPath: string;
        page: number | undefined;
        pageSize: number | undefined;
        status: unknown;
      }
    | undefined;

  const expected = {
    tasks: [
      {
        id: "task-1",
        task_description: "Write routes integration tests",
        priority: 1,
        status: "queued",
      },
    ],
    total: 1,
    page: 2,
    pageSize: 10,
  } as unknown as Awaited<ReturnType<TaskStore["listTasksPaged"]>>;

  const { server, token } = createServerFixture({
    taskStore: {
      listTasksPaged: async (projectPath, page, pageSize, status) => {
        listArgs = { projectPath, page, pageSize, status };
        return expected;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks?page=2&pageSize=10&status=queued,active",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<typeof expected>(state), expected);
  assert.deepEqual(listArgs, {
    projectPath: "/workspace/project",
    page: 2,
    pageSize: 10,
    status: ["queued", "active"],
  });
});

test("POST /api/tasks with valid body creates task and returns 201", async () => {
  let createArgs:
    | {
        projectPath: string;
        description: string;
        priority: number | undefined;
      }
    | undefined;

  const createdTask = {
    id: "task-99",
    task_description: "Ship API coverage",
    priority: 1,
    status: "queued",
  } as unknown as Awaited<ReturnType<TaskStore["createTask"]>>;

  const { server, token } = createServerFixture({
    taskStore: {
      createTask: async (projectPath, description, priority) => {
        createArgs = { projectPath, description, priority };
        return createdTask;
      },
    },
  });

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks",
    token,
    body: {
      description: "  Ship API coverage  ",
      priority: 1,
    },
  });

  assert.equal(state.statusCode, 201);
  assert.deepEqual(parseJson<typeof createdTask>(state), createdTask);
  assert.deepEqual(createArgs, {
    projectPath: "/workspace/project",
    description: "Ship API coverage",
    priority: 1,
  });
});

test("POST /api/tasks with invalid body returns 400", async () => {
  let createCalls = 0;

  const { server, token } = createServerFixture({
    taskStore: {
      createTask: async () => {
        createCalls += 1;
        return {} as Awaited<ReturnType<TaskStore["createTask"]>>;
      },
    },
  });

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks",
    token,
    body: {
      description: "   ",
    },
  });

  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: "description is required and must be a non-empty string.",
  });
  assert.equal(createCalls, 0);
});

test("GET /api/tasks/pending-review returns pending_review tasks array", async () => {
  const expectedTasks = [
    {
      id: "task-pr-1",
      task_description: "Review auth flow",
      status: "pending_review",
    },
    {
      id: "task-pr-2",
      task_description: "Review cache layer",
      status: "pending_review",
    },
  ] as unknown as Awaited<ReturnType<TaskStore["getPendingReviewTasks"]>>;
  let requestedProjectPath: string | undefined;

  const { server, token } = createServerFixture({
    taskStore: {
      getPendingReviewTasks: async (projectPath) => {
        requestedProjectPath = projectPath;
        return expectedTasks;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/pending-review",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<typeof expectedTasks>(state), expectedTasks);
  assert.equal(requestedProjectPath, "/workspace/project");
});

test("GET /api/tasks/:id still works after pending-review route reorder", async () => {
  const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const expectedTask = {
    id: taskId,
    task_description: "Implement feature X",
    status: "done",
  } as unknown as Awaited<ReturnType<TaskStore["getTask"]>>;
  const expectedLogs = [
    { id: 1, phase: "execute", output_summary: "done" },
  ] as unknown as Awaited<ReturnType<TaskStore["getTaskLogs"]>>;

  const { server, token } = createServerFixture({
    taskStore: {
      getTask: async (id) => {
        if (id === taskId) return expectedTask;
        return null;
      },
      getTaskLogs: async () => expectedLogs,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: `/api/tasks/${taskId}`,
    token,
  });

  assert.equal(state.statusCode, 200);
  const body = parseJson<Record<string, unknown>>(state);
  assert.equal(body.id, taskId);
  assert.equal(body.task_description, "Implement feature X");
  assert.deepEqual(body.logs, expectedLogs);
});

test("GET /api/plans/:id/messages parses plan ID and returns messages", async () => {
  let requestedId: number | undefined;
  const expectedMessages = [
    {
      id: 1,
      session_id: 9,
      role: "user",
      content: "review this",
      metadata: {},
      created_at: "2026-02-22T00:00:00.000Z",
    },
  ] as unknown as Awaited<ReturnType<TaskStore["getChatMessages"]>>;

  const { server, token } = createServerFixture({
    taskStore: {
      getChatMessages: async (id) => {
        requestedId = id;
        return expectedMessages;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/plans/9/messages",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<typeof expectedMessages>(state), expectedMessages);
  assert.equal(requestedId, 9);
});

test("GET /api/plans/:id/messages returns 400 for invalid plan ID", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/plans/not-a-number/messages",
    token,
  });

  assert.equal(state.statusCode, 400);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: "Invalid plan ID",
  });
});

test("POST /api/patrol/start returns 200 and calls mode manager startPatrol", async () => {
  let startCalls = 0;

  const { server, token } = createServerFixture({
    modeManager: {
      startPatrol: async () => {
        startCalls += 1;
      },
    },
  });

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/patrol/start",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<{ ok: boolean; patrolling: boolean }>(state), {
    ok: true,
    patrolling: true,
  });
  assert.equal(startCalls, 1);
});

test("POST /api/patrol/stop returns 200", async () => {
  let stopCalls = 0;

  const { server, token } = createServerFixture({
    modeManager: {
      stopPatrol: async () => {
        stopCalls += 1;
      },
    },
  });

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/patrol/stop",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<{ ok: boolean; patrolling: boolean }>(state), {
    ok: true,
    patrolling: false,
  });
  assert.equal(stopCalls, 1);
});

test("API requests without a valid Bearer token return 401", async () => {
  let listCalled = false;
  const { server } = createServerFixture({
    apiToken: "secret-token",
    taskStore: {
      listTasksPaged: async () => {
        listCalled = true;
        return { tasks: [], total: 0, page: 1, pageSize: 20 };
      },
    },
  });

  const missingToken = await dispatch(server, {
    method: "GET",
    url: "/api/tasks",
  });

  assert.equal(missingToken.statusCode, 401);
  assert.equal(missingToken.headers["www-authenticate"], "Bearer");
  assert.deepEqual(parseJson<{ error: string }>(missingToken), {
    error: "Unauthorized",
  });

  const wrongToken = await dispatch(server, {
    method: "GET",
    url: "/api/tasks",
    token: "wrong-token",
  });

  assert.equal(wrongToken.statusCode, 401);
  assert.deepEqual(parseJson<{ error: string }>(wrongToken), {
    error: "Unauthorized",
  });
  assert.equal(listCalled, false);
});

test("GET /api/status returns health-style status fields", async () => {
  let taskLookupId: string | null = null;
  const dailyCosts = [
    { date: "2026-02-22", total_cost_usd: 0.42, task_count: 1 },
  ];

  const { server, token } = createServerFixture({
    loop: {
      getState: () => "planning",
      getCurrentTaskId: () => "task-42",
      isPaused: () => true,
      isRunning: () => true,
    },
    taskStore: {
      getTask: async (id) => {
        taskLookupId = id;
        return { task_description: "Review public API routes" } as Awaited<
          ReturnType<TaskStore["getTask"]>
        >;
      },
    },
    costTracker: {
      getDailySummary: async () => dailyCosts,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/status",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.equal(taskLookupId, "task-42");
  assert.deepEqual(parseJson<Record<string, unknown>>(state), {
    state: "planning",
    currentTaskId: "task-42",
    currentTaskTitle: "Review public API routes",
    paused: true,
    patrolling: true,
    scanInterval: 30,
    projectPath: "/workspace/project",
    dailyCosts,
  });
});

test("GET /api/metrics returns operational metrics and prefers loop projectPath when available", async () => {
  let requestedProjectPath: string | undefined;
  const expectedMetrics: OperationalMetrics = {
    cycleCount: 12,
    avgCycleDurationMs: 1450.5,
    taskPassRate: 0.8,
    dailyCostUsd: 3.25,
    queueDepth: 4,
    tasksByStatus: {
      queued: 4,
      done: 8,
      failed: 2,
    },
    recentHealthScores: [82, 79, 85],
  };

  const { server, token } = createServerFixture({
    loop: {
      projectPath: "/workspace/loop-project",
    } as Partial<MainLoop> & { projectPath: string },
    taskStore: {
      getOperationalMetrics: async (projectPath) => {
        requestedProjectPath = projectPath;
        return expectedMetrics;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/metrics",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.equal(requestedProjectPath, "/workspace/loop-project");
  assert.deepEqual(parseJson<OperationalMetrics>(state), expectedMetrics);
});

test("GET /api/metrics falls back to config projectPath and returns empty metric payload unchanged", async () => {
  let requestedProjectPath: string | undefined;
  const emptyMetrics: OperationalMetrics = {
    cycleCount: 0,
    avgCycleDurationMs: 0,
    taskPassRate: 0,
    dailyCostUsd: 0,
    queueDepth: 0,
    tasksByStatus: {},
    recentHealthScores: [],
  };

  const { server, token } = createServerFixture({
    taskStore: {
      getOperationalMetrics: async (projectPath) => {
        requestedProjectPath = projectPath;
        return emptyMetrics;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/metrics",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.equal(requestedProjectPath, "/workspace/project");
  assert.deepEqual(parseJson<OperationalMetrics>(state), emptyMetrics);
});

test("GET /api/metrics returns the operational metrics response shape", async () => {
  const expectedMetrics: OperationalMetrics = {
    cycleCount: 2,
    avgCycleDurationMs: 3210,
    taskPassRate: 0.5,
    dailyCostUsd: 1.2,
    queueDepth: 6,
    tasksByStatus: {
      queued: 6,
      done: 1,
      failed: 1,
    },
    recentHealthScores: [90, 92],
  };

  const { server, token } = createServerFixture({
    taskStore: {
      getOperationalMetrics: async () => expectedMetrics,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/metrics",
    token,
  });

  const payload = parseJson<OperationalMetrics>(state);

  assert.equal(state.statusCode, 200);
  assert.deepEqual(Object.keys(payload).sort(), [
    "avgCycleDurationMs",
    "cycleCount",
    "dailyCostUsd",
    "queueDepth",
    "recentHealthScores",
    "taskPassRate",
    "tasksByStatus",
  ]);
  assert.equal(typeof payload.cycleCount, "number");
  assert.equal(typeof payload.avgCycleDurationMs, "number");
  assert.equal(typeof payload.taskPassRate, "number");
  assert.equal(typeof payload.dailyCostUsd, "number");
  assert.equal(typeof payload.queueDepth, "number");
  assert.equal(Array.isArray(payload.recentHealthScores), true);
  assert.equal(typeof payload.tasksByStatus, "object");
  assert.equal(Array.isArray(payload.tasksByStatus), false);
  for (const value of Object.values(payload.tasksByStatus)) {
    assert.equal(typeof value, "number");
  }
});

test("GET /api/metrics requires auth and does not query metrics without a valid token", async () => {
  let metricsCalls = 0;
  const { server } = createServerFixture({
    apiToken: "metrics-token",
    taskStore: {
      getOperationalMetrics: async () => {
        metricsCalls += 1;
        return {
          cycleCount: 0,
          avgCycleDurationMs: 0,
          taskPassRate: 0,
          dailyCostUsd: 0,
          queueDepth: 0,
          tasksByStatus: {},
          recentHealthScores: [],
        };
      },
    },
  });

  const missingToken = await dispatch(server, {
    method: "GET",
    url: "/api/metrics",
  });

  assert.equal(missingToken.statusCode, 401);
  assert.deepEqual(parseJson<{ error: string }>(missingToken), {
    error: "Unauthorized",
  });

  const wrongToken = await dispatch(server, {
    method: "GET",
    url: "/api/metrics",
    token: "wrong-token",
  });

  assert.equal(wrongToken.statusCode, 401);
  assert.deepEqual(parseJson<{ error: string }>(wrongToken), {
    error: "Unauthorized",
  });
  assert.equal(metricsCalls, 0);
});

test("createSseStream writes SSE headers and event payloads", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response, state } = createMockResponse();

  const stream = createSseStream(req, response);
  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["content-type"], "text/event-stream");
  assert.equal(state.headers["cache-control"], "no-cache");
  assert.equal(state.headers.connection, "keep-alive");
  assert.equal(state.headers["access-control-allow-origin"], "*");

  const wroteEvent = stream.write("status", { ok: true });
  assert.equal(wroteEvent, true);
  assert.equal(state.body, 'event: status\ndata: {"ok":true}\n\n');

  stream.cleanup();
});

test("emitSseEvent broadcasts shutdown notifications to active streams", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response, state } = createMockResponse();
  const stream = createSseStream(req, response);

  const recipients = emitSseEvent("shutdown", { reason: "systemd-stop" });
  assert.equal(recipients >= 1, true);
  assert.equal(state.body.includes("event: shutdown"), true);
  assert.equal(state.body.includes('data: {"reason":"systemd-stop"}'), true);

  stream.cleanup();
});

test("emitSseEvent falls back to message event when event name is blank", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response, state } = createMockResponse();
  const stream = createSseStream(req, response);

  emitSseEvent("  ", { ok: true });
  assert.equal(state.body.includes("event: message"), true);

  stream.cleanup();
});

test("createSseStream writes heartbeat comments on interval ticks", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response, state } = createMockResponse();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let heartbeatTick: (() => void) | undefined;
  let heartbeatDelayMs: number | undefined;
  const timerHandle = { id: "heartbeat-timer" } as unknown as ReturnType<
    typeof setInterval
  >;

  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
  ): ReturnType<typeof setInterval> => {
    heartbeatDelayMs = delay;
    heartbeatTick = () => callback();
    return timerHandle;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  try {
    const stream = createSseStream(req, response);
    assert.equal(heartbeatDelayMs, 15_000);
    assert.equal(typeof heartbeatTick, "function");

    heartbeatTick?.();
    assert.equal(state.body, ": heartbeat\n\n");

    stream.cleanup();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("createSseStream automatically closes stale connections after timeout", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response } = createMockResponse();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const heartbeatTimer = { id: "heartbeat-timer" } as unknown as ReturnType<
    typeof setInterval
  >;
  const timeoutTimer = { id: "timeout-timer" } as unknown as ReturnType<
    typeof setTimeout
  >;
  let timeoutTick: (() => void) | undefined;
  let timeoutDelayMs: number | undefined;
  let clearIntervalCalls = 0;
  let clearTimeoutCalls = 0;
  let endCalls = 0;

  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
  ): ReturnType<typeof setInterval> => {
    void callback;
    return heartbeatTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((
    timer: ReturnType<typeof setInterval> | undefined,
  ): void => {
    if (timer === heartbeatTimer) {
      clearIntervalCalls += 1;
    }
  }) as typeof clearInterval;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
  ): ReturnType<typeof setTimeout> => {
    timeoutDelayMs = delay;
    timeoutTick = () => callback();
    return timeoutTimer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    timer: ReturnType<typeof setTimeout> | undefined,
  ): void => {
    if (timer === timeoutTimer) {
      clearTimeoutCalls += 1;
    }
  }) as typeof clearTimeout;

  const responseWithTracking = response as unknown as {
    end: (chunk?: string | Buffer) => void;
  };
  const originalEnd = responseWithTracking.end;
  responseWithTracking.end = (chunk?: string | Buffer): void => {
    endCalls += 1;
    originalEnd(chunk);
  };

  try {
    const stream = createSseStream(req, response);
    assert.equal(timeoutDelayMs, 30 * 60 * 1_000);
    assert.equal(typeof timeoutTick, "function");
    assert.equal(req.listenerCount("close"), 1);

    timeoutTick?.();

    assert.equal(endCalls, 1);
    assert.equal(clearIntervalCalls, 1);
    assert.equal(clearTimeoutCalls, 1);
    assert.equal(req.listenerCount("close"), 0);
    assert.equal(stream.write("status", { ok: true }), false);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("createSseStream cleanup prevents double-close and write after cleanup returns false", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response } = createMockResponse();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerHandle = { id: "cleanup-timer" } as unknown as ReturnType<
    typeof setInterval
  >;
  let clearIntervalCalls = 0;

  globalThis.setInterval = ((
    callback: (...args: unknown[]) => void,
  ): ReturnType<typeof setInterval> => {
    void callback;
    return timerHandle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((
    timer: ReturnType<typeof setInterval> | undefined,
  ): void => {
    if (timer === timerHandle) {
      clearIntervalCalls += 1;
    }
  }) as typeof clearInterval;

  try {
    const stream = createSseStream(req, response);
    assert.equal(req.listenerCount("close"), 1);

    stream.cleanup();
    stream.cleanup();
    req.emit("close");
    req.emit("close");

    assert.equal(req.listenerCount("close"), 0);
    assert.equal(clearIntervalCalls, 1);
    assert.equal(stream.write("status", { ok: false }), false);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("createSseStream keeps pre-serialized string payloads intact", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response, state } = createMockResponse();

  const stream = createSseStream(req, response);
  const wroteEvent = stream.write("status", '{"ok":true}');
  assert.equal(wroteEvent, true);
  assert.equal(state.body, 'event: status\ndata: {"ok":true}\n\n');

  stream.cleanup();
});

test("createSseStream validates nullish request and response inputs", () => {
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token: "token",
  });
  const { response } = createMockResponse();

  assert.throws(
    () => createSseStream(undefined as unknown as IncomingMessage, response),
    /IncomingMessage instance\./,
  );
  assert.throws(
    () => createSseStream(req, undefined as unknown as ServerResponse),
    /ServerResponse instance\./,
  );
});

test("GET /api/logs returns SSE headers", async () => {
  const { server, token } = createServerFixture();
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["content-type"], "text/event-stream");
  assert.equal(state.headers["cache-control"], "no-cache");
  assert.equal(state.headers.connection, "keep-alive");

  req.emit("close");
});

test("GET /api/logs enforces max SSE connections and releases slots on close", async () => {
  const { server, token } = createServerFixture();
  const listener = getRequestListener(server);
  const openRequests: IncomingMessage[] = [];

  for (let i = 0; i < 50; i += 1) {
    const req = createMockRequest({
      method: "GET",
      url: "/api/logs",
      token,
    });
    const { response, state } = createMockResponse();
    await listener(req, response);
    assert.equal(state.statusCode, 200);
    openRequests.push(req);
  }

  const overflowReq = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token,
  });
  const { response: overflowRes, state: overflowState } = createMockResponse();
  await listener(overflowReq, overflowRes);
  assert.equal(overflowState.statusCode, 503);
  assert.deepEqual(parseJson<{ error: string }>(overflowState), {
    error: "SSE connection limit exceeded. Please retry later.",
  });

  const releasedReq = openRequests.shift();
  releasedReq?.emit("close");

  const replacementReq = createMockRequest({
    method: "GET",
    url: "/api/logs",
    token,
  });
  const { response: replacementRes, state: replacementState } =
    createMockResponse();
  await listener(replacementReq, replacementRes);
  assert.equal(replacementState.statusCode, 200);

  for (const req of openRequests) {
    req.emit("close");
  }
  replacementReq.emit("close");
});

test("SSE connection limits are tracked independently per endpoint", async () => {
  const { server, token } = createServerFixture();
  const listener = getRequestListener(server);
  const logRequests: IncomingMessage[] = [];

  for (let i = 0; i < 50; i += 1) {
    const req = createMockRequest({
      method: "GET",
      url: "/api/logs",
      token,
    });
    const { response, state } = createMockResponse();
    await listener(req, response);
    assert.equal(state.statusCode, 200);
    logRequests.push(req);
  }

  const statusReq = createMockRequest({
    method: "GET",
    url: "/api/status/stream",
    token,
  });
  const { response: statusRes, state: statusState } = createMockResponse();
  await listener(statusReq, statusRes);
  assert.equal(statusState.statusCode, 200);

  for (const req of logRequests) {
    req.emit("close");
  }
  statusReq.emit("close");
});

test("GET /api/logs warns when active SSE connections exceed 80% of the limit", async () => {
  const { server, token } = createServerFixture();
  const listener = getRequestListener(server);
  const openRequests: IncomingMessage[] = [];
  const originalWarn = log.warn;
  const warningCalls: Array<{ message: string; data: unknown }> = [];

  log.warn = ((message: string, data?: unknown): void => {
    warningCalls.push({ message, data });
  }) as typeof log.warn;

  try {
    for (let i = 0; i < 41; i += 1) {
      const req = createMockRequest({
        method: "GET",
        url: "/api/logs",
        token,
      });
      const { response, state } = createMockResponse();
      await listener(req, response);
      assert.equal(state.statusCode, 200);
      openRequests.push(req);
    }

    const warning = warningCalls.find(
      (call) =>
        call.message === "SSE connection count is nearing endpoint limit.",
    );
    assert.ok(warning);
    assert.deepEqual(warning.data, {
      endpoint: "/api/logs",
      activeConnections: 41,
      connectionLimit: 50,
    });
  } finally {
    log.warn = originalWarn;
    for (const req of openRequests) {
      req.emit("close");
    }
  }
});

test("GET /api/status/stream returns SSE headers and cleans up status listeners", async () => {
  let removeCalls = 0;
  let statusListenerAttached = false;

  const { server, token } = createServerFixture({
    loop: {
      addStatusListener: () => {
        statusListenerAttached = true;
        return () => {
          removeCalls += 1;
        };
      },
    },
  });
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: "GET",
    url: "/api/status/stream",
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["content-type"], "text/event-stream");
  assert.equal(state.headers["cache-control"], "no-cache");
  assert.equal(state.headers.connection, "keep-alive");
  assert.equal(statusListenerAttached, true);
  assert.match(state.body, /event: status/);

  req.emit("close");
  assert.equal(removeCalls, 1);
});

test("GET /api/plans/:id/stream returns 503 when planChat not injected", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/plans/42/stream",
    token,
  });

  assert.equal(state.statusCode, 503);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: "Plan chat not available",
  });
});

test("POST /api/plans/chat returns 503 when planChat not injected", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/plans/chat",
    token,
  });

  assert.equal(state.statusCode, 503);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: "Plan chat not available",
  });
});

test("POST /api/plans/:id/message returns 503 when planChat not injected", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/plans/7/message",
    token,
    body: { message: "Run dependency audit" },
  });

  assert.equal(state.statusCode, 503);
  assert.deepEqual(parseJson<{ error: string }>(state), {
    error: "Plan chat not available",
  });
});

test("GET /api/plans/:id/stream returns SSE headers and cleans up listener on close", async () => {
  let removeCalls = 0;
  let listenerAttached = false;

  const { server, token } = createServerFixture({
    planChat: {
      addListener: () => {
        listenerAttached = true;
        return () => {
          removeCalls += 1;
        };
      },
    },
  });
  const listener = getRequestListener(server);
  const req = createMockRequest({
    method: "GET",
    url: "/api/plans/5/stream",
    token,
  });
  const { response, state } = createMockResponse();

  await listener(req, response);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["content-type"], "text/event-stream");
  assert.equal(state.headers["cache-control"], "no-cache");
  assert.equal(listenerAttached, true);

  req.emit("close");
  assert.equal(removeCalls, 1);
});

test("GET /api/plans/:id/stream enforces max SSE connections and releases slots on close", async () => {
  const { server, token } = createServerFixture({
    planChat: {
      addListener: () => () => {},
    },
  });
  const listener = getRequestListener(server);
  const openRequests: IncomingMessage[] = [];

  for (let i = 0; i < 50; i += 1) {
    const req = createMockRequest({
      method: "GET",
      url: "/api/plans/1/stream",
      token,
    });
    const { response, state } = createMockResponse();
    await listener(req, response);
    assert.equal(state.statusCode, 200);
    openRequests.push(req);
  }

  const overflowReq = createMockRequest({
    method: "GET",
    url: "/api/plans/1/stream",
    token,
  });
  const { response: overflowRes, state: overflowState } = createMockResponse();
  await listener(overflowReq, overflowRes);
  assert.equal(overflowState.statusCode, 503);
  assert.deepEqual(parseJson<{ error: string }>(overflowState), {
    error: "SSE connection limit exceeded. Please retry later.",
  });

  const releasedReq = openRequests.shift();
  releasedReq?.emit("close");

  const replacementReq = createMockRequest({
    method: "GET",
    url: "/api/plans/1/stream",
    token,
  });
  const { response: replacementRes, state: replacementState } =
    createMockResponse();
  await listener(replacementReq, replacementRes);
  assert.equal(replacementState.statusCode, 200);

  for (const req of openRequests) {
    req.emit("close");
  }
  replacementReq.emit("close");
});

// --- blocked-summary endpoint ---

test("GET /api/tasks/blocked-summary returns summary from taskStore", async () => {
  const expectedSummary = {
    blockedCount: 3,
    recentFailures: [
      {
        taskId: "f1",
        description: "test",
        phase: "execute",
        agent: "worker",
        outputSummary: "failed",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  let calledWith: { projectPath: string; windowHours: number } | undefined;

  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async (
        projectPath: string,
        windowHours: number,
      ) => {
        calledWith = { projectPath, windowHours };
        return expectedSummary as never;
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(parseJson<typeof expectedSummary>(state), expectedSummary);
  assert.equal(calledWith?.projectPath, "/workspace/project");
  assert.equal(calledWith?.windowHours, 48); // default
});

test("GET /api/tasks/blocked-summary with windowHours=24 passes custom value", async () => {
  let calledWindowHours: number | undefined;

  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async (_pp: string, windowHours: number) => {
        calledWindowHours = windowHours;
        return { blockedCount: 0, recentFailures: [] };
      },
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary?windowHours=24",
    token,
  });

  assert.equal(state.statusCode, 200);
  assert.equal(calledWindowHours, 24);
});

test("GET /api/tasks/blocked-summary returns 400 for non-positive windowHours", async () => {
  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async () => ({
        blockedCount: 0,
        recentFailures: [],
      }),
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary?windowHours=-5",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("GET /api/tasks/blocked-summary returns 400 for non-integer windowHours", async () => {
  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async () => ({
        blockedCount: 0,
        recentFailures: [],
      }),
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary?windowHours=abc",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("GET /api/tasks/blocked-summary rejects fractional, trailing-garbage, and scientific notation", async () => {
  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async () => ({
        blockedCount: 0,
        recentFailures: [],
      }),
    },
  });

  for (const bad of ["1.5", "12abc", "1e2", "0", "00", " 3"]) {
    const state = await dispatch(server, {
      method: "GET",
      url: `/api/tasks/blocked-summary?windowHours=${encodeURIComponent(bad)}`,
      token,
    });
    assert.equal(state.statusCode, 400, `windowHours="${bad}" should be 400`);
  }
});

test("GET /api/tasks/blocked-summary is not shadowed by :id route", async () => {
  const { server, token } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async () => ({
        blockedCount: 0,
        recentFailures: [],
      }),
      getTask: async () => null,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary",
    token,
  });

  // Should hit blocked-summary, not :id with id="blocked-summary"
  assert.equal(state.statusCode, 200);
  const body = parseJson<Record<string, unknown>>(state);
  assert.ok("blockedCount" in body);
});

test("GET /api/tasks/blocked-summary returns 401 without auth", async () => {
  const { server } = createServerFixture({
    taskStore: {
      getBlockedTaskSummary: async () => ({
        blockedCount: 0,
        recentFailures: [],
      }),
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/blocked-summary",
  });

  assert.equal(state.statusCode, 401);
});

// --- task-logs endpoint ---

test("GET /api/tasks/:id/logs returns logs with truncated output_summary", async () => {
  const longSummary = "x".repeat(600);
  const shortSummary = "short";
  const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  const { server, token } = createServerFixture({
    taskStore: {
      getTask: async (id: string) =>
        id === taskId ? ({ id: taskId, status: "done" } as never) : null,
      getTaskLogs: async () =>
        [
          { id: 1, output_summary: longSummary },
          { id: 2, output_summary: shortSummary },
          { id: 3, output_summary: null },
        ] as never,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: `/api/tasks/${taskId}/logs`,
    token,
  });

  assert.equal(state.statusCode, 200);
  const logs = parseJson<Array<{ output_summary: string | null }>>(state);
  assert.equal(logs.length, 3);
  assert.ok(logs[0].output_summary!.endsWith("… [truncated]"));
  assert.equal(logs[0].output_summary!.length, 500 + "… [truncated]".length);
  assert.equal(logs[1].output_summary, shortSummary);
  assert.equal(logs[2].output_summary, null);
});

test("GET /api/tasks/:id/logs returns 400 for invalid UUID", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/not-a-uuid/logs",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("GET /api/tasks/:id/logs returns 404 for nonexistent task", async () => {
  const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  const { server, token } = createServerFixture({
    taskStore: {
      getTask: async () => null,
    },
  });

  const state = await dispatch(server, {
    method: "GET",
    url: `/api/tasks/${taskId}/logs`,
    token,
  });

  assert.equal(state.statusCode, 404);
});

// --- requeue endpoint ---

test("POST /api/tasks/requeue returns requeued count", async () => {
  const ids = [
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "11111111-2222-3333-4444-555555555555",
  ];
  let calledWith: { projectPath: string; taskIds: string[] } | undefined;

  const { server, token } = createServerFixture({
    taskStore: {
      requeueBlockedTasks: async (projectPath: string, taskIds: string[]) => {
        calledWith = { projectPath, taskIds };
        return 2;
      },
    },
  });

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/requeue",
    token,
    body: { taskIds: ids },
  });

  assert.equal(state.statusCode, 200);
  const body = parseJson<{ requeued: number; requested: number }>(state);
  assert.equal(body.requeued, 2);
  assert.equal(body.requested, 2);
  assert.deepEqual(calledWith?.taskIds, ids);
});

test("POST /api/tasks/requeue returns 400 for empty taskIds", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/requeue",
    token,
    body: { taskIds: [] },
  });

  assert.equal(state.statusCode, 400);
});

test("POST /api/tasks/requeue returns 400 for non-array taskIds", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/requeue",
    token,
    body: { taskIds: "not-an-array" },
  });

  assert.equal(state.statusCode, 400);
});

test("POST /api/tasks/requeue returns 400 for invalid UUID in taskIds", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/requeue",
    token,
    body: { taskIds: ["not-a-valid-uuid"] },
  });

  assert.equal(state.statusCode, 400);
});

test("POST /api/tasks/requeue returns 401 without auth", async () => {
  const { server } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/requeue",
    body: { taskIds: ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"] },
  });

  assert.equal(state.statusCode, 401);
});

// --- UUID validation on existing routes ---

test("GET /api/tasks/:id returns 400 for invalid UUID", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "GET",
    url: "/api/tasks/not-a-uuid",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("POST /api/tasks/:id/approve returns 400 for invalid UUID", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/not-a-uuid/approve",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("POST /api/tasks/:id/skip returns 400 for invalid UUID", async () => {
  const { server, token } = createServerFixture();

  const state = await dispatch(server, {
    method: "POST",
    url: "/api/tasks/not-a-uuid/skip",
    token,
  });

  assert.equal(state.statusCode, 400);
});

test("GET /api/plans/:id/stream handles sync first event during addListener without listener leak", async () => {
  let removeCalls = 0;

  const { server, token } = createServerFixture({
    planChat: {
      addListener: (
        _id: number,
        cb: (event: string, data: unknown) => void,
      ) => {
        // Simulate real PlanChatManager: fires initial status synchronously
        cb("status", { status: "active" });
        return () => {
          removeCalls += 1;
        };
      },
    },
  });
  const reqListener = getRequestListener(server);
  const req = createMockRequest({
    method: "GET",
    url: "/api/plans/3/stream",
    token,
  });
  const { response, state } = createMockResponse();

  await reqListener(req, response);

  assert.equal(state.statusCode, 200);
  assert.match(state.body, /event: status/);

  req.emit("close");
  assert.equal(removeCalls, 1);
});
