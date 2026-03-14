import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSeedFile,
  GLOBAL_WORKER_RULES,
  formatWorkInstructions,
} from "../../src/core/PersonaLoader.js";

describe("parseSeedFile", () => {
  it("should parse frontmatter and content from persona seed file", () => {
    const raw = `---
name: test-persona
role: Tester
taskTypes: [feature, bugfix]
focusAreas: [quality]
---

## Identity
A test persona.

## Principles
- Be thorough`;

    const result = parseSeedFile(raw);
    assert.equal(result.name, "test-persona");
    assert.equal(result.role, "Tester");
    assert.deepEqual(result.taskTypes, ["feature", "bugfix"]);
    assert.deepEqual(result.focusAreas, ["quality"]);
    assert.ok(result.content.includes("## Identity"));
    assert.ok(result.content.includes("Be thorough"));
    assert.ok(!result.content.includes("---"));
  });

  it("should handle missing optional fields gracefully", () => {
    const raw = `---
name: minimal
role: Worker
---

Content here.`;

    const result = parseSeedFile(raw);
    assert.equal(result.name, "minimal");
    assert.deepEqual(result.taskTypes, []);
    assert.deepEqual(result.focusAreas, []);
  });

  it("should parse Critical Actions and Anti-Patterns sections into content", () => {
    const raw = `---
name: enhanced-persona
role: Engineer
taskTypes: [feature]
focusAreas: [quality]
---

## Identity
An enhanced persona.

## Critical Actions

### ALWAYS
- Always do X

### NEVER
- Never do Y

## Anti-Patterns
- NEVER pattern Z

## Quality Gates

### Correctness
- Gate 1`;

    const result = parseSeedFile(raw);
    assert.ok(
      result.content.includes("## Critical Actions"),
      "Content should include Critical Actions",
    );
    assert.ok(
      result.content.includes("### ALWAYS"),
      "Content should include ALWAYS subsection",
    );
    assert.ok(
      result.content.includes("### NEVER"),
      "Content should include NEVER subsection",
    );
    assert.ok(
      result.content.includes("## Anti-Patterns"),
      "Content should include Anti-Patterns",
    );
    assert.ok(
      result.content.includes("NEVER pattern Z"),
      "Content should include specific anti-pattern",
    );
    assert.ok(
      result.content.includes("### Correctness"),
      "Content should include Quality Gates subcategories",
    );
  });
});

describe("GLOBAL_WORKER_RULES", () => {
  it("should contain essential autonomous agent rules", () => {
    assert.ok(
      GLOBAL_WORKER_RULES.includes("AUTONOMOUS AGENT RULES"),
      "Should include header",
    );
    assert.ok(
      GLOBAL_WORKER_RULES.includes("SCOPE"),
      "Should include SCOPE rule",
    );
    assert.ok(GLOBAL_WORKER_RULES.includes("HALT"), "Should include HALT rule");
    assert.ok(
      GLOBAL_WORKER_RULES.includes("VERIFY"),
      "Should include VERIFY rule",
    );
    assert.ok(
      GLOBAL_WORKER_RULES.includes("CLAUDE.MD"),
      "Should include CLAUDE.MD rule",
    );
  });

  it("should be a non-empty string", () => {
    assert.ok(typeof GLOBAL_WORKER_RULES === "string");
    assert.ok(
      GLOBAL_WORKER_RULES.length > 50,
      "Rules should have substantial content",
    );
  });

  it("should include pre-commit checklist", () => {
    assert.ok(
      GLOBAL_WORKER_RULES.includes("PRE-COMMIT CHECKLIST"),
      "Should include pre-commit checklist",
    );
  });
});

describe("formatWorkInstructions", () => {
  it("should pass through string directly", () => {
    assert.equal(formatWorkInstructions("do X"), "do X");
  });

  it("should format full structured object with all sections", () => {
    const result = formatWorkInstructions({
      acceptanceCriteria: ["tests pass", "no new errors"],
      filesToModify: ["src/foo.ts"],
      guardrails: ["do not touch config"],
      verificationSteps: ["run tsc", "run tests"],
      references: ["CLAUDE.md"],
    });
    assert.ok(result.includes("### Acceptance Criteria"));
    assert.ok(result.includes("- [ ] tests pass"));
    assert.ok(result.includes("### Files to Modify"));
    assert.ok(result.includes("- src/foo.ts"));
    assert.ok(result.includes("### Guardrails (DO NOT)"));
    assert.ok(result.includes("### Verification Steps"));
    assert.ok(result.includes("1. run tsc"));
    assert.ok(result.includes("### References"));
  });

  it("should format partial object with only some fields", () => {
    const result = formatWorkInstructions({
      acceptanceCriteria: ["it works"],
      guardrails: ["no hacks"],
    });
    assert.ok(result.includes("### Acceptance Criteria"));
    assert.ok(result.includes("### Guardrails (DO NOT)"));
    assert.ok(!result.includes("### Files to Modify"));
    assert.ok(!result.includes("### Verification Steps"));
    assert.ok(!result.includes("### References"));
  });

  it("should return empty string for empty object", () => {
    assert.equal(formatWorkInstructions({}), "");
  });

  it("should return empty string for object with all empty arrays", () => {
    assert.equal(
      formatWorkInstructions({
        acceptanceCriteria: [],
        filesToModify: [],
        guardrails: [],
      }),
      "",
    );
  });
});
