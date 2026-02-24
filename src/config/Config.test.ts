import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

import { Config } from "./Config.js";

test("Config generates and persists apiToken when missing", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "db-coder-config-test-"));
  const homeDir = join(tempRoot, "home");
  const projectDir = join(tempRoot, "project");
  const configDir = join(homeDir, ".db-coder");
  const configPath = join(configDir, "config.json");
  const previousHome = process.env.HOME;

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ server: { host: "127.0.0.1" } }, null, 2),
    "utf-8",
  );

  process.env.HOME = homeDir;

  try {
    const first = new Config(projectDir);
    assert.equal(typeof first.values.apiToken, "string");
    assert.ok(first.values.apiToken.length > 0);

    const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as {
      apiToken?: string;
      server?: { host?: string };
    };
    assert.equal(persisted.apiToken, first.values.apiToken);
    assert.equal(persisted.server?.host, "127.0.0.1");

    const second = new Config(projectDir);
    assert.equal(second.values.apiToken, first.values.apiToken);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// Helper: create a temp project with a .db-coder.json override and return Config
function configWithOverride(override: Record<string, unknown>): {
  config: Config;
  cleanup: () => void;
} {
  const tempRoot = mkdtempSync(join(tmpdir(), "db-coder-deepmerge-"));
  const homeDir = join(tempRoot, "home");
  const projectDir = join(tempRoot, "project");
  const configDir = join(homeDir, ".db-coder");

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  // Provide a dummy apiToken in global config so Config doesn't try to persist
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ apiToken: "test-token-abc123" }, null, 2),
    "utf-8",
  );

  // Write the project-level override
  writeFileSync(
    join(projectDir, ".db-coder.json"),
    JSON.stringify(override, null, 2),
    "utf-8",
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;

  const config = new Config(projectDir);

  // Restore HOME immediately
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  return {
    config,
    cleanup: () => rmSync(tempRoot, { recursive: true, force: true }),
  };
}

describe("deepMerge nested object handling", () => {
  test("partial override of nested object preserves sibling defaults", () => {
    const { config, cleanup } = configWithOverride({
      codex: { tokenPricing: { inputPerMillion: 99 } },
    });
    try {
      assert.equal(config.values.codex.tokenPricing?.inputPerMillion, 99);
      assert.equal(
        config.values.codex.tokenPricing?.cachedInputPerMillion,
        0.175,
        "cachedInputPerMillion should retain default",
      );
      assert.equal(
        config.values.codex.tokenPricing?.outputPerMillion,
        14,
        "outputPerMillion should retain default",
      );
      // First-level siblings should also be preserved
      assert.equal(config.values.codex.model, "gpt-5.3-codex");
      assert.equal(config.values.codex.sandbox, "workspace-write");
    } finally {
      cleanup();
    }
  });

  test("arrays are replaced entirely, not merged element-by-element", () => {
    const customGoals = [
      { description: "custom goal", priority: 1, status: "active" as const },
    ];
    const { config, cleanup } = configWithOverride({
      evolution: { goals: customGoals },
    });
    try {
      assert.equal(config.values.evolution.goals.length, 1);
      assert.equal(config.values.evolution.goals[0].description, "custom goal");
    } finally {
      cleanup();
    }
  });

  test("recursion stops at depth 3 — deeply nested user objects are replaced not merged", () => {
    // mcp.custom is at depth 3 (mcp -> custom -> serverName -> fields)
    // The server entry should be replaced as a whole, not deep-merged
    const { config, cleanup } = configWithOverride({
      mcp: {
        enabled: true,
        custom: {
          myServer: { command: "my-cmd", args: ["--flag"] },
        },
      },
    });
    try {
      assert.equal(config.values.mcp.enabled, true);
      assert.deepEqual(config.values.mcp.custom?.myServer, {
        command: "my-cmd",
        args: ["--flag"],
      });
    } finally {
      cleanup();
    }
  });
});
