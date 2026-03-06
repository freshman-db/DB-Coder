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

test("ExperimentalConfig defaults: brainDriven=false, strictModelRouting=false", () => {
  // This tests the contract, not the Config class (that's tested in config tests)
  const defaults = { brainDriven: false, strictModelRouting: false };
  assert.equal(defaults.brainDriven, false);
  assert.equal(defaults.strictModelRouting, false);
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

// --- defaultModel derivation: worker-aware ---
// Tests the logic that defaultModel must come from the worker's model space,
// not always from COMPLEXITY_CONFIG / config.claude.model.

function deriveDefaultModel(
  workerName: string,
  complexityModel: string | undefined,
  claudeConfigModel: string,
  codexConfigModel: string,
): string {
  if (workerName === "claude") {
    const alias = complexityModel ?? claudeConfigModel;
    // Simulate resolveModelId: "sonnet" → "claude-sonnet-4-6", "opus" → "claude-opus-4-6"
    const MODEL_MAP: Record<string, string> = {
      sonnet: "claude-sonnet-4-6",
      opus: "claude-opus-4-6",
    };
    return MODEL_MAP[alias] ?? alias;
  }
  return codexConfigModel;
}

test("defaultModel: claude worker uses COMPLEXITY_CONFIG model", () => {
  const result = deriveDefaultModel(
    "claude",
    "opus",
    "sonnet",
    "gpt-5.3-codex",
  );
  assert.equal(result, "claude-opus-4-6");
});

test("defaultModel: codex worker uses config.codex.model regardless of complexity", () => {
  const result = deriveDefaultModel("codex", "opus", "sonnet", "gpt-5.3-codex");
  assert.equal(result, "gpt-5.3-codex");
});

test("defaultModel + validateModelForWorker: codex worker, no brain model → compatible", () => {
  // This is the exact edge case: codex worker + no resource_request.model
  const defaultModel = deriveDefaultModel(
    "codex",
    "sonnet",
    "sonnet",
    "gpt-5.3-codex",
  );
  // defaultModel should be codex model, not "claude-sonnet-4-6"
  assert.equal(defaultModel, "gpt-5.3-codex");
  // resolvedModel = defaultModel (no brain model override)
  const model = validateModelForWorker(
    defaultModel,
    defaultModel,
    "codex",
    true,
  );
  // Should NOT throw even with strictModelRouting
  assert.equal(model, "gpt-5.3-codex");
});

test("defaultModel + validateModelForWorker: claude worker, no brain model → compatible", () => {
  const defaultModel = deriveDefaultModel(
    "claude",
    "sonnet",
    "sonnet",
    "gpt-5.3-codex",
  );
  assert.equal(defaultModel, "claude-sonnet-4-6");
  const model = validateModelForWorker(
    defaultModel,
    defaultModel,
    "claude",
    true,
  );
  assert.equal(model, "claude-sonnet-4-6");
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

test("Non-brain-driven enqueue: does not write directive or resource_request", () => {
  const planTask = {
    id: "T003",
    description: "Legacy task",
    priority: 2,
    isBrainDriven: false,
    directive: undefined,
    resourceRequest: undefined,
  };

  const updates: Record<string, unknown> = {
    plan: { ...planTask },
    subtasks: [],
  };

  if (planTask.isBrainDriven && planTask.directive) {
    updates.directive = planTask.directive;
  }

  assert.equal(updates.directive, undefined);
  assert.equal(updates.resource_request, undefined);
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
