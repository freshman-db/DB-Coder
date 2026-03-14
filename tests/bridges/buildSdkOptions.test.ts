import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildSdkOptions,
  type SdkExtras,
} from "../../src/bridges/buildSdkOptions.js";
import type { SessionOptions } from "../../src/bridges/ClaudeCodeSession.js";

describe("buildSdkOptions", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const CLAUDE_ENV_VARS = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_PACKAGE_DIR",
    "CLAUDE_DEV_HOST",
    "CLAUDE_DEV_PORT",
  ];

  beforeEach(() => {
    // Save and set env vars so we can verify they get cleaned
    for (const key of CLAUDE_ENV_VARS) {
      savedEnv[key] = process.env[key];
      process.env[key] = "test-value";
    }
    savedEnv["CLAUDE_MEM_MODEL"] = process.env["CLAUDE_MEM_MODEL"];
  });

  afterEach(() => {
    // Restore original env
    for (const key of CLAUDE_ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (savedEnv["CLAUDE_MEM_MODEL"] === undefined) {
      delete process.env["CLAUDE_MEM_MODEL"];
    } else {
      process.env["CLAUDE_MEM_MODEL"] = savedEnv["CLAUDE_MEM_MODEL"];
    }
  });

  function minimalOpts(): SessionOptions {
    return { permissionMode: "bypassPermissions" };
  }

  describe("prompt passthrough", () => {
    it("should pass prompt through unchanged", () => {
      const result = buildSdkOptions("Hello world", minimalOpts());
      assert.equal(result.prompt, "Hello world");
    });

    it("should preserve prompt with special characters", () => {
      const prompt = "Fix the bug in `src/main.ts`\n\nDetails:\n- Line 42";
      const result = buildSdkOptions(prompt, minimalOpts());
      assert.equal(result.prompt, prompt);
    });
  });

  describe("permissionMode mapping", () => {
    it("should map bypassPermissions with allowDangerouslySkipPermissions", () => {
      const result = buildSdkOptions("test", {
        permissionMode: "bypassPermissions",
      });
      assert.equal(result.options.permissionMode, "bypassPermissions");
      assert.equal(result.options.allowDangerouslySkipPermissions, true);
    });

    it("should map acceptEdits without allowDangerouslySkipPermissions", () => {
      const result = buildSdkOptions("test", {
        permissionMode: "acceptEdits",
      });
      assert.equal(result.options.permissionMode, "acceptEdits");
      assert.equal(result.options.allowDangerouslySkipPermissions, undefined);
    });
  });

  describe("settingSources", () => {
    it("should always set settingSources to user, project, local", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.deepEqual(result.options.settingSources, [
        "user",
        "project",
        "local",
      ]);
    });
  });

  describe("systemPrompt", () => {
    it("should set preset claude_code when no appendSystemPrompt", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.deepEqual(result.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
      });
    });

    it("should set preset claude_code with append when appendSystemPrompt provided", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        appendSystemPrompt: "You are a code reviewer.",
      });
      assert.deepEqual(result.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "You are a code reviewer.",
      });
    });
  });

  describe("resumeSessionId mapping", () => {
    it("should map resumeSessionId to resume", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        resumeSessionId: "session-123",
      });
      assert.equal(result.options.resume, "session-123");
    });

    it("should not set resume when resumeSessionId is absent", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.options.resume, undefined);
    });
  });

  describe("maxBudget mapping", () => {
    it("should map maxBudget to maxBudgetUsd", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        maxBudget: 1.5,
      });
      assert.equal(result.options.maxBudgetUsd, 1.5);
    });

    it("should not set maxBudgetUsd when maxBudget is absent", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.options.maxBudgetUsd, undefined);
    });
  });

  describe("maxTurns direct mapping", () => {
    it("should pass maxTurns directly", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        maxTurns: 10,
      });
      assert.equal(result.options.maxTurns, 10);
    });
  });

  describe("model direct mapping", () => {
    it("should pass model directly", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        model: "claude-opus-4-6",
      });
      assert.equal(result.options.model, "claude-opus-4-6");
    });
  });

  describe("cwd direct mapping", () => {
    it("should pass cwd directly", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        cwd: "/home/user/project",
      });
      assert.equal(result.options.cwd, "/home/user/project");
    });
  });

  describe("jsonSchema mapping", () => {
    it("should map jsonSchema to outputFormat json_schema", () => {
      const schema = {
        type: "object",
        properties: { result: { type: "string" } },
      };
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        jsonSchema: schema,
      });
      assert.deepEqual(result.options.outputFormat, {
        type: "json_schema",
        schema,
      });
    });

    it("should not set outputFormat when jsonSchema is absent", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.options.outputFormat, undefined);
    });
  });

  describe("allowedTools mapping", () => {
    it("should pass allowedTools directly", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        allowedTools: ["Read", "Grep", "Glob"],
      });
      assert.deepEqual(result.options.allowedTools, ["Read", "Grep", "Glob"]);
    });
  });

  describe("disallowedTools mapping", () => {
    it("should pass disallowedTools directly", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        disallowedTools: ["Edit", "Write"],
      });
      assert.deepEqual(result.options.disallowedTools, ["Edit", "Write"]);
    });
  });

  describe("timeout mapping", () => {
    it("should create AbortController and return timeoutMs", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        timeout: 30000,
      });
      assert.equal(result.timeoutMs, 30000);
      assert.ok(result.options.abortController instanceof AbortController);
    });

    it("should not create AbortController when timeout is absent", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.timeoutMs, undefined);
      assert.equal(result.options.abortController, undefined);
    });
  });

  describe("environment variable cleaning", () => {
    it("should remove CLAUDECODE env vars from options.env", () => {
      const result = buildSdkOptions("test", minimalOpts());
      const env = result.options.env!;
      for (const key of CLAUDE_ENV_VARS) {
        assert.equal(env[key], undefined, `${key} should be removed from env`);
      }
    });

    it("should default CLAUDE_MEM_MODEL to claude-opus-4-6 when no model specified", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.options.env!["CLAUDE_MEM_MODEL"], "claude-opus-4-6");
    });

    it("should set CLAUDE_MEM_MODEL to the session model when specified", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        model: "claude-sonnet-4-6",
      });
      assert.equal(
        result.options.env!["CLAUDE_MEM_MODEL"],
        "claude-sonnet-4-6",
      );
    });

    it("should preserve other env vars", () => {
      process.env["MY_CUSTOM_VAR"] = "my-value";
      try {
        const result = buildSdkOptions("test", minimalOpts());
        assert.equal(result.options.env!["MY_CUSTOM_VAR"], "my-value");
      } finally {
        delete process.env["MY_CUSTOM_VAR"];
      }
    });
  });

  describe("SdkExtras passthrough", () => {
    it("should pass hooks from extras", () => {
      const hooks: SdkExtras["hooks"] = {
        PreToolUse: [
          {
            hooks: [async () => ({ continue: true })],
          },
        ],
      };
      const result = buildSdkOptions("test", minimalOpts(), { hooks });
      assert.deepEqual(result.options.hooks, hooks);
    });

    it("should pass plugins from extras", () => {
      const plugins: SdkExtras["plugins"] = [
        { type: "local" as const, path: "./my-plugin" },
      ];
      const result = buildSdkOptions("test", minimalOpts(), { plugins });
      assert.deepEqual(result.options.plugins, plugins);
    });

    it("should pass agents from extras", () => {
      const agents: SdkExtras["agents"] = {
        "test-agent": {
          description: "A test agent",
          prompt: "You are a test agent",
        },
      };
      const result = buildSdkOptions("test", minimalOpts(), { agents });
      assert.deepEqual(result.options.agents, agents);
    });

    it("should handle undefined extras gracefully", () => {
      const result = buildSdkOptions("test", minimalOpts());
      assert.equal(result.options.hooks, undefined);
      assert.equal(result.options.plugins, undefined);
      assert.equal(result.options.agents, undefined);
    });
  });

  describe("combined options", () => {
    it("should handle all options simultaneously", () => {
      const schema = { type: "object", properties: {} };
      const result = buildSdkOptions("complex prompt", {
        permissionMode: "acceptEdits",
        maxBudget: 2.0,
        resumeSessionId: "sess-456",
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        appendSystemPrompt: "Be careful.",
        jsonSchema: schema,
        cwd: "/tmp/work",
        timeout: 60000,
        maxTurns: 20,
        model: "claude-opus-4-6",
      });

      assert.equal(result.prompt, "complex prompt");
      assert.equal(result.options.permissionMode, "acceptEdits");
      assert.equal(result.options.allowDangerouslySkipPermissions, undefined);
      assert.equal(result.options.maxBudgetUsd, 2.0);
      assert.equal(result.options.resume, "sess-456");
      assert.deepEqual(result.options.allowedTools, ["Read"]);
      assert.deepEqual(result.options.disallowedTools, ["Bash"]);
      assert.deepEqual(result.options.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "Be careful.",
      });
      assert.deepEqual(result.options.outputFormat, {
        type: "json_schema",
        schema,
      });
      assert.equal(result.options.cwd, "/tmp/work");
      assert.equal(result.timeoutMs, 60000);
      assert.ok(result.options.abortController instanceof AbortController);
      assert.equal(result.options.maxTurns, 20);
      assert.equal(result.options.model, "claude-opus-4-6");
      assert.deepEqual(result.options.settingSources, [
        "user",
        "project",
        "local",
      ]);
    });
  });

  describe("onText and onEvent are not mapped", () => {
    it("should ignore onText and onEvent (CLI-specific callbacks)", () => {
      const result = buildSdkOptions("test", {
        ...minimalOpts(),
        onText: () => {},
        onEvent: () => {},
      });
      // These are CLI-specific and should not appear in SDK options
      // The result should still build successfully
      assert.ok(result.options);
    });
  });
});
