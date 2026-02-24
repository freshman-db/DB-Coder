import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJsonFromText,
  getErrorMessage,
  isPositiveFinite,
  isRecord,
  truncate,
  tryParseJson,
  tryParseReview,
} from "./parse.js";

test("truncate returns short strings unchanged", () => {
  assert.equal(truncate("hello", 10), "hello");
});

test("truncate returns exact-length strings unchanged", () => {
  assert.equal(truncate("12345", 5), "12345");
});

test("truncate shortens over-length strings and appends an ellipsis", () => {
  assert.equal(truncate("123456", 5), "12345…");
});

test("truncate returns empty strings unchanged", () => {
  assert.equal(truncate("", 5), "");
});

test("isRecord identifies plain objects and rejects non-objects", () => {
  assert.equal(isRecord({ key: "value" }), true);
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord("text"), false);
});

test("isPositiveFinite validates only positive finite numbers", () => {
  assert.equal(isPositiveFinite(5), true);
  assert.equal(isPositiveFinite(0), false);
  assert.equal(isPositiveFinite(-1), false);
  assert.equal(isPositiveFinite(Infinity), false);
  assert.equal(isPositiveFinite(Number.NaN), false);
  assert.equal(isPositiveFinite("5"), false);
  assert.equal(isPositiveFinite(null), false);
});

test("getErrorMessage normalizes unknown errors to strings", () => {
  assert.equal(getErrorMessage(new Error("boom")), "boom");
  assert.equal(getErrorMessage("plain message"), "plain message");
  assert.equal(getErrorMessage(42), "42");
  assert.equal(getErrorMessage(null), "null");
  assert.equal(getErrorMessage(undefined), "undefined");
  assert.equal(getErrorMessage({}), "[object Object]");
});

test("extractJsonFromText parses clean JSON", () => {
  const input = '{"status":"ok","count":2}';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: "ok",
    count: 2,
  });
});

test("extractJsonFromText parses JSON with surrounding text", () => {
  const input = 'prefix text {"status":"ok","meta":{"count":2}} suffix text';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: "ok",
    meta: { count: 2 },
  });
});

test("extractJsonFromText handles nested braces in objects and strings", () => {
  const input =
    'prefix {"outer":{"inner":{"value":1}},"message":"hello {world}"} suffix';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    outer: { inner: { value: 1 } },
    message: "hello {world}",
  });
});

test("extractJsonFromText handles multiple JSON objects and matcher selection", () => {
  const input = [
    'metadata: {"requestId":"123"}',
    "payload:",
    '{"projectHealth":87,"issues":[],"opportunities":[],"summary":"ok","nested":{"key":"value"}}',
  ].join("\n");

  const first = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(first, {
    requestId: "123",
  });

  const parsed = extractJsonFromText(input, (value) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "projectHealth" in value,
    ),
  ) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    projectHealth: 87,
    issues: [],
    opportunities: [],
    summary: "ok",
    nested: { key: "value" },
  });
});

test("extractJsonFromText skips malformed JSON and falls back to later valid JSON", () => {
  const input = 'note {"broken": } and {"status":"recovered","ok":true}';
  const parsed = extractJsonFromText(input) as Record<string, unknown> | null;

  assert.deepEqual(parsed, {
    status: "recovered",
    ok: true,
  });
});

test("extractJsonFromText returns null for empty, malformed, or non-string input", () => {
  assert.equal(extractJsonFromText(""), null);
  assert.equal(extractJsonFromText('note {"broken": } only'), null);
  assert.equal(extractJsonFromText(undefined as unknown as string), null);
});

test("tryParseJson parses a valid JSON object string", () => {
  assert.deepEqual(tryParseJson('{"ok":true,"count":2}'), {
    ok: true,
    count: 2,
  });
});

test("tryParseJson returns undefined for malformed JSON", () => {
  assert.equal(tryParseJson('{"broken": }'), undefined);
});

test("tryParseJson returns undefined for an empty string", () => {
  assert.equal(tryParseJson(""), undefined);
});

test("tryParseReview finds the review JSON object even when earlier JSON exists", () => {
  const input = [
    'Metadata: {"requestId":"abc-123"}',
    "Review follows:",
    '{"passed":false,"issues":[{"severity":"high","description":"Issue"}],"summary":"Needs follow-up"}',
  ].join("\n");

  const parsed = tryParseReview(input);

  assert.equal(parsed.passed, false);
  assert.equal(parsed.summary, "Needs follow-up");
  assert.equal(parsed.issues.length, 1);
});

test("tryParseReview keeps valid issues with accepted severity values", () => {
  const parsed = tryParseReview(
    '{"passed":true,"issues":[{"severity":"high","description":"bug","source":"claude"}]}',
  );

  assert.equal(parsed.issues.length, 1);
  assert.deepEqual(parsed.issues[0], {
    severity: "high",
    description: "bug",
    file: undefined,
    line: undefined,
    suggestion: undefined,
    source: "claude",
    confidence: undefined,
  });
});

test("tryParseReview filters issues with invalid severity values", () => {
  const parsed = tryParseReview(
    '{"passed":false,"issues":[{"severity":"major","description":"bug","source":"claude"}]}',
  );

  assert.deepEqual(parsed.issues, []);
});

test("tryParseReview filters issues without description", () => {
  const parsed = tryParseReview(
    '{"passed":false,"issues":[{"severity":"high","source":"claude"}]}',
  );

  assert.deepEqual(parsed.issues, []);
});

test("tryParseReview keeps only valid issues from a mixed issues list", () => {
  const parsed = tryParseReview(
    JSON.stringify({
      passed: false,
      issues: [
        { severity: "low", description: "valid low", source: "claude" },
        {
          severity: "major",
          description: "invalid severity",
          source: "claude",
        },
        {
          severity: "critical",
          description: "valid critical",
          source: "codex",
        },
      ],
    }),
  );

  assert.equal(parsed.issues.length, 2);
  assert.deepEqual(
    parsed.issues.map((issue) => issue.severity),
    ["low", "critical"],
  );
});

test("tryParseReview fallback is fail-closed for non-JSON positive text", () => {
  const parsed = tryParseReview("error handling looks good");

  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.summary, "error handling looks good");
});

test("tryParseReview fallback returns failed review for issue text", () => {
  const parsed = tryParseReview("Found critical security vulnerability");

  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.summary, "Found critical security vulnerability");
});

test("tryParseReview handles empty input safely with fail-closed fallback", () => {
  assert.deepEqual(tryParseReview(""), {
    passed: false,
    issues: [],
    summary: "",
  });
});

test("tryParseReview preserves confidence field", () => {
  const json = JSON.stringify({
    passed: false,
    issues: [
      { severity: "high", description: "Bug", confidence: 0.7 },
      { severity: "critical", description: "Real bug", confidence: 0.95 },
      { severity: "medium", description: "No confidence field" },
    ],
    summary: "test",
  });
  const result = tryParseReview(json);
  assert.strictEqual(result.issues[0].confidence, 0.7);
  assert.strictEqual(result.issues[1].confidence, 0.95);
  assert.strictEqual(result.issues[2].confidence, undefined);
});

test("tryParseReview handles non-string input safely with fail-closed fallback", () => {
  let parsed: ReturnType<typeof tryParseReview> | undefined;

  assert.doesNotThrow(() => {
    parsed = tryParseReview(undefined as any);
  });

  assert.deepEqual(parsed, {
    passed: false,
    issues: [],
    summary: "",
  });
});

test("tryParseReview extracts issues from Markdown numbered list", () => {
  const input = [
    "**Findings**",
    "1. High — `src/utils/process.ts:43`: `if (options.input)` is a truthy check",
    "2. Critical — `src/utils/process.ts:60`: `code ?? 0` reports 0 on signal termination",
    "3. Medium — minor style issue in formatting",
  ].join("\n");

  const parsed = tryParseReview(input);

  assert.equal(parsed.passed, false);
  assert.equal(parsed.issues.length, 3);
  assert.equal(parsed.issues[0].severity, "high");
  assert.equal(parsed.issues[0].file, "src/utils/process.ts:43");
  assert.equal(parsed.issues[0].line, 43);
  assert.ok(parsed.issues[0].description.includes("truthy check"));
  assert.equal(parsed.issues[1].severity, "critical");
  assert.equal(parsed.issues[2].severity, "medium");
  assert.equal(parsed.issues[2].file, undefined);
});

test("tryParseReview Markdown fallback remains fail-closed for unrecognized text", () => {
  const input = "The code quality is exceptional. No issues found.";
  const parsed = tryParseReview(input);
  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.issues, []);
});

test("tryParseReview Markdown handles bullet-list format", () => {
  const input =
    "- High — `app.ts:10`: missing null check\n- Low — minor naming concern";
  const parsed = tryParseReview(input);
  assert.equal(parsed.issues.length, 2);
  assert.equal(parsed.issues[0].severity, "high");
  assert.equal(parsed.issues[0].file, "app.ts:10");
  assert.equal(parsed.issues[0].line, 10);
  assert.equal(parsed.issues[1].severity, "low");
});

test("tryParseReview parses Codex-style findings (no severity prefix)", () => {
  const input = [
    "Using some skill context.",
    "",
    "**Findings**",
    "- `src/utils/parse.ts:124` — `passed` is trusted verbatim, so payloads can bypass review gate.",
    "- `src/utils/parse.ts:184` + `src/utils/parse.ts:190` — regex captures file:line inconsistently.",
    "- `src/utils/parse.ts:83` and `src/utils/parse.ts:210` — catch blocks swallow parse failures silently.",
  ].join("\n");

  const parsed = tryParseReview(input);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.issues.length, 3);
  assert.equal(parsed.issues[0].file, "src/utils/parse.ts:124");
  assert.equal(parsed.issues[0].line, 124);
  assert.ok(parsed.issues[0].description.includes("trusted verbatim"));
  // "swallow...silently" should trigger medium severity via inferSeverity
  assert.equal(parsed.issues[2].severity, "medium");
});

test("tryParseReview inferSeverity classifies security terms as critical", () => {
  const input = "- `auth.ts:5` — SQL injection via unsanitized user input";
  const parsed = tryParseReview(input);
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0].severity, "critical");
});
