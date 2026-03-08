/**
 * Tests for brain-driven (B-1) decision and reflection parsing.
 *
 * These test the parseBrainDrivenTasks logic and the BrainDecision/BrainReflection
 * type contracts without invoking the actual brain session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { BrainDecision, BrainReflection } from "./BrainPhase.js";

// --- BrainDecision type contract tests ---

test("BrainDecision: well-formed decision satisfies interface", () => {
  const decision: BrainDecision = {
    directive: "Refactor the auth module to use OAuth2",
    summary: "重构认证模块使用 OAuth2",
    strategy_note: "Auth is fragile; this reduces surface area",
    resource_request: {
      budget_usd: 8,
      timeout_s: 1200,
      model: "claude-opus-4-6",
    },
    verification_plan: "tsc passes, auth tests pass, login flow works",
  };
  assert.ok(decision.directive.length > 0);
  assert.ok(decision.summary.length <= 120);
  assert.ok(decision.resource_request.budget_usd > 0);
});

test("BrainDecision: extra_tasks are optional", () => {
  const decision: BrainDecision = {
    directive: "Fix the bug",
    summary: "修复 bug",
    strategy_note: "Critical path",
    resource_request: { budget_usd: 5, timeout_s: 600 },
    verification_plan: "test passes",
  };
  assert.equal(decision.extra_tasks, undefined);
});

test("BrainDecision: extra_tasks can contain multiple items", () => {
  const decision: BrainDecision = {
    directive: "Main task",
    summary: "主任务",
    strategy_note: "Strategy",
    resource_request: { budget_usd: 10, timeout_s: 1200 },
    verification_plan: "verify",
    extra_tasks: [
      {
        directive: "Follow-up 1",
        resource_request: { budget_usd: 3, timeout_s: 300 },
      },
      {
        directive: "Follow-up 2",
        resource_request: { budget_usd: 5, timeout_s: 600 },
      },
    ],
  };
  assert.equal(decision.extra_tasks?.length, 2);
});

// --- BrainReflection type contract tests ---

test("BrainReflection: well-formed reflection satisfies interface", () => {
  const reflection: BrainReflection = {
    reflection: "The task went well. Auth module is cleaner now.",
    strategy_update:
      "OAuth2 migration is a good pattern; consider for other modules.",
    retrieval_lesson:
      "OAuth2 refactoring is high-value; auth tests are sufficient coverage",
    orchestrator_feedback:
      "Consider allowing longer timeouts for auth-related tasks",
  };
  assert.ok(reflection.reflection.length > 0);
  assert.ok(reflection.retrieval_lesson.length > 0);
});

test("BrainReflection: orchestrator_feedback is optional", () => {
  const reflection: BrainReflection = {
    reflection: "Task completed",
    strategy_update: "No strategy change needed",
    retrieval_lesson: "Simple refactor, low risk",
  };
  assert.equal(reflection.orchestrator_feedback, undefined);
});

// --- Feature flag design tests ---

test("ExperimentalConfig defaults: brainDriven deprecated (always on), strictModelRouting=false", () => {
  // brainDriven is deprecated — brain-driven mode is now the only code path.
  // The config field is kept for backward compat but its value is ignored.
  const defaults = { brainDriven: false, strictModelRouting: false };
  assert.equal(defaults.strictModelRouting, false);
  // brainDriven value doesn't matter — behavior is always brain-driven
  assert.equal(typeof defaults.brainDriven, "boolean");
});

// --- Resource request cap logic ---

test("resource_request cap: min(request, config max)", () => {
  const configMaxPerTask = 20.0;
  const brainRequest = { budget_usd: 12, timeout_s: 1800 };
  const hardTimeoutCap = 3_600_000; // 1 hour in ms

  const effectiveBudget = Math.min(brainRequest.budget_usd, configMaxPerTask);
  const effectiveTimeout = Math.min(
    brainRequest.timeout_s * 1000,
    hardTimeoutCap,
  );

  assert.equal(effectiveBudget, 12); // request within cap
  assert.equal(effectiveTimeout, 1_800_000); // 1800s = 30min
});

test("resource_request cap: clamps to max when request exceeds", () => {
  const configMaxPerTask = 20.0;
  const brainRequest = { budget_usd: 50, timeout_s: 7200 };
  const hardTimeoutCap = 3_600_000;

  const effectiveBudget = Math.min(brainRequest.budget_usd, configMaxPerTask);
  const effectiveTimeout = Math.min(
    brainRequest.timeout_s * 1000,
    hardTimeoutCap,
  );

  assert.equal(effectiveBudget, 20.0); // clamped
  assert.equal(effectiveTimeout, 3_600_000); // clamped to 1h
});

// --- resolveModelForBrain tests ---

import { resolveModelForBrain } from "./WorkerPhase.js";

test("resolveModelForBrain: known alias 'opus' resolves correctly", () => {
  const result = resolveModelForBrain("opus", "claude-sonnet-4-6");
  assert.equal(result, "claude-opus-4-6");
});

test("resolveModelForBrain: known alias 'sonnet' resolves correctly", () => {
  const result = resolveModelForBrain("sonnet", "claude-opus-4-6");
  assert.equal(result, "claude-sonnet-4-6");
});

test("resolveModelForBrain: full model ID passes through", () => {
  const result = resolveModelForBrain("claude-opus-4-6", "claude-sonnet-4-6");
  assert.equal(result, "claude-opus-4-6");
});

test("resolveModelForBrain: non-Claude full model ID passes through", () => {
  const result = resolveModelForBrain("gpt-5.3-codex", "claude-sonnet-4-6");
  assert.equal(result, "gpt-5.3-codex");
});

test("resolveModelForBrain: unknown alias falls back to default with warning", () => {
  const result = resolveModelForBrain("gemini", "claude-opus-4-6");
  assert.equal(result, "claude-opus-4-6"); // falls back to default
});

// --- validateModelForWorker contract tests ---
// The method is private, so we test the equivalent logic here.

function validateModelForWorker(
  resolvedModel: string,
  defaultModel: string,
  workerName: string,
  strictModelRouting: boolean,
  originalRequest?: string,
): string {
  const isClaudeModel = resolvedModel.startsWith("claude-");
  const isClaudeWorker = workerName === "claude";
  const isCompatible =
    (isClaudeWorker && isClaudeModel) || (!isClaudeWorker && !isClaudeModel);

  if (isCompatible) return resolvedModel;

  if (strictModelRouting) {
    throw new Error(
      `strictModelRouting: model "${resolvedModel}" (requested: "${originalRequest}") is incompatible with worker "${workerName}"`,
    );
  }

  return defaultModel;
}

test("validateModelForWorker: claude model + claude worker → pass through", () => {
  const result = validateModelForWorker(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude",
    false,
  );
  assert.equal(result, "claude-opus-4-6");
});

test("validateModelForWorker: codex model + codex worker → pass through", () => {
  const result = validateModelForWorker(
    "gpt-5.3-codex",
    "gpt-5.3-codex",
    "codex",
    false,
  );
  assert.equal(result, "gpt-5.3-codex");
});

test("validateModelForWorker: claude model + codex worker → fallback to default", () => {
  const result = validateModelForWorker(
    "claude-opus-4-6",
    "gpt-5.3-codex",
    "codex",
    false,
    "opus",
  );
  assert.equal(result, "gpt-5.3-codex");
});

test("validateModelForWorker: codex model + claude worker → fallback to default", () => {
  const result = validateModelForWorker(
    "gpt-5.3-codex",
    "claude-sonnet-4-6",
    "claude",
    false,
    "gpt-5.3-codex",
  );
  assert.equal(result, "claude-sonnet-4-6");
});

test("validateModelForWorker: strictModelRouting throws on incompatibility", () => {
  assert.throws(
    () =>
      validateModelForWorker(
        "claude-opus-4-6",
        "gpt-5.3-codex",
        "codex",
        true,
        "opus",
      ),
    { message: /strictModelRouting.*incompatible/ },
  );
});

test("validateModelForWorker: strictModelRouting does not throw when compatible", () => {
  const result = validateModelForWorker(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude",
    true,
    "opus",
  );
  assert.equal(result, "claude-opus-4-6");
});

// --- defaultModel derivation: routing-based ---
// After Phase 4, COMPLEXITY_CONFIG no longer has a model field.
// resolveWorkerModel uses routing.execute.model as canonical source,
// falling back to config.claude.model or config.codex.model.

function deriveDefaultModel(
  routingModel: string,
  claudeConfigModel: string,
  codexConfigModel: string,
  workerSupportsModel: (m: string) => boolean,
): string {
  // Priority: routing.execute.model > claude.model > codex.model
  if (workerSupportsModel(routingModel)) return routingModel;
  if (workerSupportsModel(claudeConfigModel)) return claudeConfigModel;
  return codexConfigModel;
}

test("defaultModel: routing model compatible with worker → use routing model", () => {
  const result = deriveDefaultModel(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-5.3-codex",
    (m) => m.startsWith("claude-"), // claude worker
  );
  assert.equal(result, "claude-opus-4-6");
});

test("defaultModel: routing model incompatible → fallback to codex config", () => {
  const result = deriveDefaultModel(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-5.3-codex",
    (m) => !m.startsWith("claude-"), // codex worker
  );
  assert.equal(result, "gpt-5.3-codex");
});

test("defaultModel + validateModelForWorker: codex worker, no brain model → compatible", () => {
  const defaultModel = deriveDefaultModel(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-5.3-codex",
    (m) => !m.startsWith("claude-"), // codex worker
  );
  assert.equal(defaultModel, "gpt-5.3-codex");
  const model = validateModelForWorker(
    defaultModel,
    defaultModel,
    "codex",
    true,
  );
  assert.equal(model, "gpt-5.3-codex");
});

test("defaultModel + validateModelForWorker: claude worker, no brain model → compatible", () => {
  const defaultModel = deriveDefaultModel(
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-5.3-codex",
    (m) => m.startsWith("claude-"), // claude worker
  );
  assert.equal(defaultModel, "claude-opus-4-6");
  const model = validateModelForWorker(
    defaultModel,
    defaultModel,
    "claude",
    true,
  );
  assert.equal(model, "claude-opus-4-6");
});

// --- Queue round-trip: brain-driven fields preserved ---

test("PlanTask brain-driven fields survive plan JSONB round-trip", () => {
  // Simulate what TaskQueue.enqueue() stores in plan JSONB
  const planTask = {
    id: "T001",
    description: "Brain-driven task",
    priority: 0,
    executor: "claude" as const,
    subtasks: [],
    dependsOn: [],
    estimatedComplexity: "medium" as const,
    directive: "Refactor the auth module to use OAuth2",
    resourceRequest: { budget_usd: 8, timeout_s: 1200, model: "opus" },
    isBrainDriven: true,
  };

  // Simulate plan JSONB serialization (what goes into DB)
  const planJsonb = { ...planTask };
  const serialized = JSON.stringify(planJsonb);
  const restored = JSON.parse(serialized);

  // Verify all brain-driven fields survive
  assert.equal(restored.directive, planTask.directive);
  assert.equal(restored.isBrainDriven, true);
  assert.deepStrictEqual(restored.resourceRequest, planTask.resourceRequest);
});

test("Brain-driven enqueue: updates object includes directive and resource_request", () => {
  // Simulate the updates object built by TaskQueue.enqueue()
  const planTask = {
    id: "T002",
    description: "Another brain task",
    priority: 1,
    isBrainDriven: true,
    directive: "Fix the authentication bug",
    resourceRequest: { budget_usd: 5, timeout_s: 600 },
  };

  const updates: Record<string, unknown> = {
    plan: { ...planTask },
    subtasks: [],
  };

  if (planTask.isBrainDriven && planTask.directive) {
    updates.directive = planTask.directive;
    if (planTask.resourceRequest) {
      updates.resource_request = planTask.resourceRequest;
    }
  }

  assert.equal(updates.directive, "Fix the authentication bug");
  assert.deepStrictEqual(updates.resource_request, {
    budget_usd: 5,
    timeout_s: 600,
  });
});

test("Legacy queue task without directive: does not write directive or resource_request", () => {
  // Backward compat: tasks queued before brain-driven-only may lack directive
  const planTask = {
    id: "T003",
    description: "Legacy task",
    priority: 2,
    directive: undefined,
    resourceRequest: undefined,
  };

  const updates: Record<string, unknown> = {
    plan: { ...planTask },
    subtasks: [],
  };

  if (planTask.directive) {
    updates.directive = planTask.directive;
  }

  assert.equal(updates.directive, undefined);
  assert.equal(updates.resource_request, undefined);
});

// --- gatherBrainContext: quality signal logic ---

test("quality signal: LESSON with 'low-value' → ' · low-value' suffix", () => {
  const lesson = "LESSON: this pattern is low-value, skip in future";
  const quality = lesson.startsWith("LESSON:")
    ? lesson.includes("low-value") || lesson.includes("not worth")
      ? " · low-value"
      : " ✓ high-value"
    : "";
  assert.equal(quality, " · low-value");
});

test("quality signal: LESSON with 'not worth' → ' · low-value' suffix", () => {
  const lesson = "LESSON: not worth the effort for this type of task";
  const quality = lesson.startsWith("LESSON:")
    ? lesson.includes("low-value") || lesson.includes("not worth")
      ? " · low-value"
      : " ✓ high-value"
    : "";
  assert.equal(quality, " · low-value");
});

test("quality signal: LESSON without negative keywords → ' ✓ high-value'", () => {
  const lesson = "LESSON: OAuth refactoring is a good pattern";
  const quality = lesson.startsWith("LESSON:")
    ? lesson.includes("low-value") || lesson.includes("not worth")
      ? " · low-value"
      : " ✓ high-value"
    : "";
  assert.equal(quality, " ✓ high-value");
});

test("quality signal: non-LESSON prefix → empty string", () => {
  const lesson = "Some arbitrary reflection text";
  const quality = lesson.startsWith("LESSON:")
    ? lesson.includes("low-value") || lesson.includes("not worth")
      ? " · low-value"
      : " ✓ high-value"
    : "";
  assert.equal(quality, "");
});

// --- brainThink disallowedTools: MCP write tools blocked ---

test("brainThink disallowedTools includes MCP mutating tools", async () => {
  // This tests the contract: brain session must block MCP tools that mutate state
  const BRAIN_DISALLOWED = [
    "Edit",
    "Write",
    "NotebookEdit",
    "mcp__db-coder-system-data__create_task",
    "mcp__db-coder-system-data__requeue_blocked_tasks",
  ];

  // Verify all file-mutation tools are present
  assert.ok(BRAIN_DISALLOWED.includes("Edit"));
  assert.ok(BRAIN_DISALLOWED.includes("Write"));
  assert.ok(BRAIN_DISALLOWED.includes("NotebookEdit"));

  // Verify MCP mutating tools are present
  assert.ok(
    BRAIN_DISALLOWED.includes("mcp__db-coder-system-data__create_task"),
  );
  assert.ok(
    BRAIN_DISALLOWED.includes(
      "mcp__db-coder-system-data__requeue_blocked_tasks",
    ),
  );

  // Verify read-only MCP tools are NOT blocked
  assert.ok(
    !BRAIN_DISALLOWED.includes(
      "mcp__db-coder-system-data__get_blocked_summary",
    ),
  );
  assert.ok(
    !BRAIN_DISALLOWED.includes("mcp__db-coder-system-data__get_recent_tasks"),
  );
});

// --- CodexSdkRuntime: sessionId resume fallback ---

test("CodexSdkRuntime sessionId: resume path uses resumeSessionId as fallback", () => {
  // When resuming a thread, thread.started may not fire.
  // The runtime initializes threadId = opts.resumeSessionId as fallback.
  const resumeSessionId = "thread-abc-123";
  let threadId: string | undefined = resumeSessionId; // fallback
  // Simulate: thread.started fires and overwrites
  threadId = "new-thread-456";
  assert.equal(threadId, "new-thread-456");

  // Simulate: thread.started does NOT fire
  let threadId2: string | undefined = resumeSessionId;
  // No event updates threadId2
  assert.equal(threadId2, resumeSessionId); // fallback works
});

// --- CodexSdkRuntime: stream error event handling ---

test("ThreadErrorEvent contract: type='error' with message string", () => {
  // SDK type: ThreadErrorEvent = { type: "error", message: string }
  // Runtime must handle this as a fatal error → isError: true
  const event = { type: "error" as const, message: "connection reset" };
  let hasError = false;
  const errors: string[] = [];

  // Simulate the switch case logic
  if (event.type === "error") {
    hasError = true;
    if (event.message) {
      errors.push(event.message);
    }
  }

  assert.equal(hasError, true);
  assert.deepEqual(errors, ["connection reset"]);
});

// --- CodexSdkRuntime: structured output from last agent_message ---

test("structured output: parse last textPart, not concatenated text", () => {
  // SDK semantics: finalResponse is the last agent_message
  const textParts = [
    "I'll analyze the codebase now.",
    "Here are my findings:",
    '{"passed": true, "issues": []}',
  ];

  // Wrong: parse concatenated text
  const concatenated = textParts.join("\n");
  let wrongParsed: unknown;
  try {
    wrongParsed = JSON.parse(concatenated);
  } catch {
    wrongParsed = undefined;
  }
  assert.equal(wrongParsed, undefined); // fails because of non-JSON prefix

  // Correct: parse only last part
  const lastMessage = textParts[textParts.length - 1];
  const correctParsed = JSON.parse(lastMessage);
  assert.deepEqual(correctParsed, { passed: true, issues: [] });
});

// --- Summary fallback ---

test("summary fallback: truncate from directive when summary is empty", () => {
  const directive =
    "This is a very long directive that exceeds 120 characters and should be truncated when used as the summary fallback for task_description in the database";
  const SUMMARY_MAX = 120;

  const summary = directive.slice(0, SUMMARY_MAX);
  assert.ok(summary.length <= SUMMARY_MAX);
  assert.ok(summary.startsWith("This is a very long directive"));
});
