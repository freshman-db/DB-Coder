import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DbCoderConfig } from "../../src/config/types.js";
import {
  ConfigValidationError,
  validateConfig,
} from "../../src/utils/validateConfig.js";

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
  const projectPath = mkdtempSync(join(tmpdir(), "db-coder-validate-config-"));
  try {
    run(projectPath);
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

function assertValidationIssue(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    if (!(err instanceof ConfigValidationError)) return false;
    return err.issues.some((issue) => pattern.test(issue));
  });
}

function getValidationError(fn: () => void): ConfigValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected validateConfig to throw ConfigValidationError");
}

test("validateConfig accepts a valid config", () => {
  withTempProject((projectPath) => {
    assert.doesNotThrow(() => validateConfig(createValidConfig(), projectPath));
  });
});

test("validateConfig rejects negative budget values", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.budget.maxPerTask = -1;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /budget\.maxPerTask must be >= 0/,
    );
  });
});

test("validateConfig rejects empty required strings", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.memory.pgConnectionString = "   ";

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /memory\.pgConnectionString must be a non-empty string/,
    );
  });
});

test("validateConfig rejects invalid server port numbers", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.server.port = 70000;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /server\.port must be <= 65535/,
    );
  });
});

test("validateConfig rejects missing project paths", () => {
  const missingPath = join(tmpdir(), `db-coder-missing-${Date.now()}`);
  assertValidationIssue(
    () => validateConfig(createValidConfig(), missingPath),
    /projectPath does not exist/,
  );
});

test("validateConfig rejects memory URLs with unsupported protocols", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.memory.claudeMemUrl = "ftp://localhost:37777";

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /memory\.claudeMemUrl must use http: or https: protocol/,
    );
  });
});

test("validateConfig requires each custom MCP server to define command or url", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.mcp.custom = {
      local: { type: "stdio" },
    };

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /mcp\.custom\.local must define either a non-empty command or url/,
    );
  });
});

test("validateConfig rejects custom MCP server URLs with unsupported protocols", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.mcp.custom = {
      remote: { url: "ws://localhost:9999" },
    };

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /mcp\.custom\.remote\.url must use http: or https: protocol/,
    );
  });
});

test("validateConfig rejects evolution goals with invalid status values", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.evolution.goals = [
      {
        description: "Ship a parser",
        priority: 1,
        status: "blocked" as "active" | "paused" | "done",
      },
    ];

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /evolution\.goals\[0\]\.status must be one of: active, paused, done/,
    );
  });
});

test("validateConfig rejects evolution goals with invalid completedAt values", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.evolution.goals = [
      {
        description: "Finish API hardening",
        priority: 1,
        completedAt: "not-a-date",
      },
    ];

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /evolution\.goals\[0\]\.completedAt must be an ISO date string/,
    );
  });
});

test("validateConfig rejects non-boolean experimental.brainDriven", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    (config as unknown as Record<string, unknown>).experimental = {
      brainDriven: "yes",
      strictModelRouting: false,
    };

    const error = getValidationError(() => validateConfig(config, projectPath));
    assert.ok(error.issues.some((i) => i.includes("experimental.brainDriven")));
  });
});

test("validateConfig rejects non-boolean experimental.strictModelRouting", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    (config as unknown as Record<string, unknown>).experimental = {
      brainDriven: false,
      strictModelRouting: 1,
    };

    const error = getValidationError(() => validateConfig(config, projectPath));
    assert.ok(
      error.issues.some((i) => i.includes("experimental.strictModelRouting")),
    );
  });
});

test("validateConfig accepts valid experimental config", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.experimental = { brainDriven: true, strictModelRouting: true };

    assert.doesNotThrow(() => validateConfig(config, projectPath));
  });
});

test("validateConfig reports issues for empty config objects", () => {
  withTempProject((projectPath) => {
    const error = getValidationError(() =>
      validateConfig({} as DbCoderConfig, projectPath),
    );

    assert.ok(error.issues.length > 0);
    assert.ok(error.issues.includes("apiToken must be a non-empty string"));
    assert.ok(error.issues.includes("brain must be an object"));
    assert.match(error.message, /Invalid db-coder configuration:/);
  });
});

test("ConfigValidationError exposes the provided issues array", () => {
  const issues = ["alpha", "beta"];
  const error = new ConfigValidationError(issues);

  assert.equal(error.name, "ConfigValidationError");
  assert.deepEqual(error.issues, issues);
});

test("validateConfig rejects incompatible model-runtime combinations in routing", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    // GPT model on claude-sdk runtime
    config.routing.review = { runtime: "claude-sdk", model: "gpt-5.3-codex" };

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /routing\.review: model "gpt-5\.3-codex" is incompatible with runtime "claude-sdk"/,
    );
  });
});

test("validateConfig rejects Claude model on codex-cli runtime", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.routing.execute = { runtime: "codex-cli", model: "claude-opus-4-6" };

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /routing\.execute: model "claude-opus-4-6" is incompatible with runtime "codex-cli"/,
    );
  });
});

test("validateConfig accepts compatible model-runtime combinations", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.routing.brain = { runtime: "claude-sdk", model: "claude-opus-4-6" };
    config.routing.review = { runtime: "codex-cli", model: "gpt-5.3-codex" };

    assert.doesNotThrow(() => validateConfig(config, projectPath));
  });
});

test("validateConfig accepts runtime aliases with compatible models", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    // "claude" alias should be treated as claude-sdk
    config.routing.brain = { runtime: "claude", model: "claude-sonnet-4-6" };
    // "codex" alias should be treated as codex-sdk (same model compatibility)
    config.routing.review = { runtime: "codex", model: "gpt-5.3-codex" };

    assert.doesNotThrow(() => validateConfig(config, projectPath));
  });
});

test("validateConfig rejects alias with incompatible model", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    // "claude" alias with GPT model
    config.routing.plan = { runtime: "claude", model: "gpt-5.3-codex" };

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /routing\.plan: model "gpt-5\.3-codex" is incompatible with runtime "claude"/,
    );
  });
});

test("validateConfig does not mutate config when trimming string values", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    const originalUrl = "  http://localhost:37777  ";
    config.memory.claudeMemUrl = originalUrl;

    assert.doesNotThrow(() => validateConfig(config, projectPath));
    assert.equal(config.memory.claudeMemUrl, originalUrl);
  });
});

test("validateConfig rejects maxReviewFixes of 0", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.autonomy.maxReviewFixes = 0;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /autonomy\.maxReviewFixes must be >= 1/,
    );
  });
});

test("validateConfig rejects non-integer maxReviewFixes", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.autonomy.maxReviewFixes = 2.5;

    assertValidationIssue(
      () => validateConfig(config, projectPath),
      /autonomy\.maxReviewFixes must be an integer/,
    );
  });
});

test("validateConfig accepts valid maxReviewFixes", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    config.autonomy.maxReviewFixes = 3;

    assert.doesNotThrow(() => validateConfig(config, projectPath));
  });
});

test("validateConfig accepts config without maxReviewFixes", () => {
  withTempProject((projectPath) => {
    const config = createValidConfig();
    delete (config.autonomy as unknown as Record<string, unknown>)
      .maxReviewFixes;

    assert.doesNotThrow(() => validateConfig(config, projectPath));
  });
});
