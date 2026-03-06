import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DbCoderConfig } from "../config/types.js";
import { log } from "../utils/logger.js";
import {
  validateConfigForStartup,
  validateRuntimeAvailability,
} from "./configValidation.js";

function createValidConfig(): DbCoderConfig {
  return {
    apiToken: "test-token",
    brain: {
      model: "opus",
      scanInterval: 3600,
      maxScanBudget: 1.0,
      claudeMdMaintenanceInterval: 15,
      claudeMdMaintenanceEnabled: true,
      chainScan: {
        enabled: true,
        interval: 5,
        maxBudget: 3.0,
        chainsPerTrigger: 2,
        rediscoveryInterval: 10,
      },
      language: "简体中文",
    },
    claude: { model: "opus", maxTaskBudget: 2.0, maxTurns: 30 },
    codex: {
      model: "gpt-5.3-codex",
      sandbox: "workspace-write",
      tokenPricing: {
        inputPerMillion: 2,
        cachedInputPerMillion: 0.5,
        outputPerMillion: 8,
      },
    },
    autonomy: {
      level: "full",
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      subtaskTimeout: 600,
      worker: "claude",
      maxReviewFixes: 1,
    },
    routing: {
      brain: { runtime: "claude-sdk", model: "opus" },
      plan: { runtime: "claude-sdk", model: "opus" },
      execute: { runtime: "claude-sdk", model: "opus" },
      review: { runtime: "codex-cli", model: "gpt-5.3-codex" },
      reflect: { runtime: "claude-sdk", model: "opus" },
      scan: { runtime: "claude-sdk", model: "opus" },
    },
    budget: { maxPerTask: 5.0, maxPerDay: 200.0, warningThreshold: 0.8 },
    memory: {
      claudeMemUrl: "http://localhost:37777",
      pgConnectionString: "postgresql://db:db@localhost:5432/db_coder",
    },
    git: {
      branchPrefix: "db-coder/",
      protectedBranches: ["main", "master"],
      branchRetentionDays: 7,
    },
    server: { host: "127.0.0.1", port: 18801 },
    mcp: { enabled: true },
    plugins: {},
    evolution: {
      goals: [
        {
          description: "Keep code quality high",
          priority: 1,
          status: "active",
        },
      ],
    },
    experimental: {
      brainDriven: false,
      strictModelRouting: false,
    },
  };
}

function withTempProject(run: (projectPath: string) => void): void {
  const projectPath = mkdtempSync(join(tmpdir(), "db-coder-startup-config-"));
  try {
    run(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

function withMockedLogError(run: (messages: string[]) => void): void {
  const logger = log as unknown as {
    error: (message: string, data?: unknown) => void;
  };
  const original = logger.error;
  const messages: string[] = [];
  logger.error = (message: string) => {
    messages.push(message);
  };

  try {
    run(messages);
  } finally {
    logger.error = original;
  }
}

test("validateConfigForStartup returns true when config is valid", () => {
  withTempProject((projectPath) => {
    withMockedLogError((messages) => {
      const isValid = validateConfigForStartup(
        createValidConfig(),
        projectPath,
      );

      assert.equal(isValid, true);
      assert.equal(messages.length, 0);
    });
  });
});

test("validateConfigForStartup returns false and logs validation details", () => {
  withTempProject((projectPath) => {
    withMockedLogError((messages) => {
      const config = createValidConfig();
      config.memory.claudeMemUrl = "ftp://localhost:37777";

      const isValid = validateConfigForStartup(config, projectPath);
      assert.equal(isValid, false);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /Invalid db-coder configuration:/);
      assert.match(
        messages[0],
        /memory\.claudeMemUrl must use http: or https: protocol/,
      );
    });
  });
});

test("validateRuntimeAvailability returns no issues when no codex phases configured", async () => {
  const routing = createValidConfig().routing;
  // Override review to claude-sdk so no codex phases exist
  routing.review = { runtime: "claude-sdk", model: "claude-opus-4-6" };

  const issues = await validateRuntimeAvailability(routing);
  assert.equal(issues.length, 0);
});

test("validateRuntimeAvailability detects codex-cli alias in routing", async () => {
  const routing = createValidConfig().routing;
  // All phases claude except review uses "codex" alias
  routing.brain = { runtime: "claude-sdk", model: "claude-opus-4-6" };
  routing.plan = { runtime: "claude-sdk", model: "claude-opus-4-6" };
  routing.execute = { runtime: "claude-sdk", model: "claude-opus-4-6" };
  routing.reflect = { runtime: "claude-sdk", model: "claude-opus-4-6" };
  routing.scan = { runtime: "claude-sdk", model: "claude-opus-4-6" };
  routing.review = { runtime: "codex", model: "gpt-5.3-codex" };

  // This test verifies the function runs without error and checks codex availability.
  // On machines with codex installed it returns [], on machines without it returns an issue.
  const issues = await validateRuntimeAvailability(routing);
  // Result depends on environment — just verify it returns an array
  assert.ok(Array.isArray(issues));
  // If codex is not available, it should mention the phase
  if (issues.length > 0) {
    assert.match(issues[0], /codex-cli is not available/);
    assert.match(issues[0], /review/);
  }
});
