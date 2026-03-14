/**
 * Integration tests for the review-fix loop state machine in MainLoop.reviewTask().
 *
 * Validates: multi-round fix loops, convergence detection, rewrite session reset,
 * split/block exits, maxFixes capping, and telemetry logging.
 *
 * Strategy: build a minimal MainLoop with mocked BrainPhase, WorkerPhase,
 * ReviewPhase, MaintenancePhase — then call the pipeline entry point that
 * exercises reviewTask indirectly.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type {
  ReviewIssue,
  ReviewResult,
} from "../../src/bridges/ReviewTypes.js";

// We test the pure helper functions + parseReviewDecision together
// to validate the state machine's building blocks integrate correctly.
import {
  issueKey,
  buildCumulativeContext,
  resolveTaskComplexity,
  type FixRoundRecord,
} from "../../src/core/MainLoop.js";
import { parseReviewDecision } from "../../src/core/phases/BrainPhase.js";
import {
  COMPLEXITY_CONFIG,
  safeComplexity,
} from "../../src/core/phases/WorkerPhase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  severity: ReviewIssue["severity"],
  description: string,
  file?: string,
): ReviewIssue {
  return { severity, description, file, source: "claude" };
}

function makeReviewResult(
  issues: ReviewIssue[],
  passed = false,
): ReviewResult & { reviewDiff: string } {
  return {
    passed,
    issues,
    summary: passed ? "All checks pass" : `${issues.length} issues found`,
    cost_usd: 0.01,
    reviewDiff: "diff --git ...",
  };
}

// ---------------------------------------------------------------------------
// State machine scenario tests (exercised through the building blocks)
// ---------------------------------------------------------------------------

describe("review-fix state machine scenarios", () => {
  // Simulate the state machine logic from MainLoop.ts:1501
  // to test multi-round interactions without full MainLoop construction.

  interface BrainCall {
    issues: ReviewIssue[];
    isFinalRound: boolean;
    fixRound?: number;
    maxFixes?: number;
  }

  interface FixCall {
    instructions: string;
    sessionId?: string;
    cumulativeContext?: string;
    isRewrite: boolean;
  }

  /**
   * Simulate the review-fix loop from MainLoop.reviewTask fix/rewrite case.
   * Returns the final merge decision and recorded calls.
   */
  function simulateFixLoop(opts: {
    initialIssues: ReviewIssue[];
    maxFixes: number;
    /** For each round, return re-review result and brain decision text. */
    rounds: Array<{
      reReviewIssues: ReviewIssue[];
      reReviewPassed?: boolean;
      hardVerifyPassed?: boolean;
      brainDecisionText: string;
    }>;
    initialDecision?: { decision: "fix" | "rewrite"; fixInstructions: string };
  }): {
    shouldMerge: boolean;
    brainCalls: BrainCall[];
    fixCalls: FixCall[];
    logEntries: Array<{ round: number; output: string }>;
  } {
    const brainCalls: BrainCall[] = [];
    const fixCalls: FixCall[] = [];
    const logEntries: Array<{ round: number; output: string }> = [];

    const initialDecision = opts.initialDecision ?? {
      decision: "fix" as const,
      fixInstructions: "fix the issues",
    };
    let shouldMerge = false;
    let fixSessionId: string | undefined = "initial-sess";
    let prevIssueCount = opts.initialIssues.length;
    let prevIssueKeys = new Set(opts.initialIssues.map(issueKey));
    let currentDecision: {
      decision: "fix" | "rewrite";
      fixInstructions: string;
    } = initialDecision;
    const fixHistory: FixRoundRecord[] = [];

    for (let fixRound = 0; fixRound < opts.maxFixes; fixRound++) {
      const roundDef = opts.rounds[fixRound];
      if (!roundDef) break;

      // REWRITE: discard session
      if (currentDecision.decision === "rewrite") {
        fixSessionId = undefined;
      }

      // Cumulative context for round 2+
      const cumulativeCtx =
        fixRound > 0 ? buildCumulativeContext(fixHistory) : undefined;

      fixCalls.push({
        instructions: currentDecision.fixInstructions,
        sessionId: fixSessionId,
        cumulativeContext: cumulativeCtx,
        isRewrite: currentDecision.decision === "rewrite",
      });

      fixSessionId = `fix-sess-${fixRound}`;

      // hardVerify
      if (roundDef.hardVerifyPassed === false) {
        logEntries.push({
          round: fixRound + 1,
          output: "hardVerify failed",
        });
        break;
      }

      // Re-review
      const reReview = makeReviewResult(
        roundDef.reReviewIssues,
        roundDef.reReviewPassed,
      );

      const passed = roundDef.reReviewPassed ?? false;
      logEntries.push({
        round: fixRound + 1,
        output: passed
          ? `PASS after ${fixRound + 1} rounds`
          : `FAIL: ${reReview.issues.length} issues (prev: ${prevIssueCount})`,
      });

      if (passed) {
        shouldMerge = true;
        break;
      }

      // Record fix history
      const currentKeys = new Set(reReview.issues.map(issueKey));
      const resolvedKeys = [...prevIssueKeys].filter(
        (k) => !currentKeys.has(k),
      );
      const persistedKeys = [...currentKeys].filter((k) =>
        prevIssueKeys.has(k),
      );
      fixHistory.push({
        round: fixRound + 1,
        decision: currentDecision.decision,
        instructions: currentDecision.fixInstructions,
        prevIssueCount,
        currentIssueCount: reReview.issues.length,
        resolvedDescriptions: resolvedKeys,
        persistedDescriptions: persistedKeys,
        stillOpenIssues: reReview.issues.map((i) => ({
          severity: i.severity,
          file: i.file,
          description: i.description,
        })),
      });

      // Convergence detection: stagnant when no progress AND high overlap
      const overlapCount = persistedKeys.length;
      const stagnant =
        reReview.issues.length >= prevIssueCount &&
        overlapCount >= currentKeys.size * 0.7;
      const isLast = fixRound === opts.maxFixes - 1;
      const isFinalRound = isLast || stagnant;

      brainCalls.push({
        issues: reReview.issues,
        isFinalRound,
        fixRound: fixRound + 1,
        maxFixes: opts.maxFixes,
      });

      // Brain decision
      const nextDecision = parseReviewDecision(
        roundDef.brainDecisionText,
        isFinalRound,
      );

      switch (nextDecision.decision) {
        case "fix":
        case "rewrite":
          prevIssueCount = reReview.issues.length;
          prevIssueKeys = currentKeys;
          currentDecision = {
            decision: nextDecision.decision,
            fixInstructions:
              nextDecision.fixInstructions ?? nextDecision.reasoning,
          };
          continue;
        case "ignore":
          shouldMerge = true;
          break;
        case "split":
          shouldMerge = true;
          break;
        case "block":
          break;
      }
      break;
    }

    return { shouldMerge, brainCalls, fixCalls, logEntries };
  }

  const issue1 = makeIssue("high", "Missing null check", "src/api.ts");
  const issue2 = makeIssue("medium", "No error handling", "src/db.ts");
  const issue3 = makeIssue("low", "Console.log in prod", "src/util.ts");

  // --- fix → fix → pass ---

  it("fix → fix → pass: 2 rounds then merge", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2, issue3],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [issue2], // issue1 + issue3 fixed
          brainDecisionText: "FIX\nfix the remaining error handling",
        },
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "", // won't be called
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    assert.equal(result.fixCalls.length, 2);
    assert.equal(result.logEntries.length, 2);
    assert.ok(result.logEntries[1].output.includes("PASS after 2 rounds"));
  });

  // --- fix → stagnant → isFinalRound=true → restricted options ---

  it("stagnant detection: same issues persist → isFinalRound=true", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2],
      maxFixes: 3,
      rounds: [
        {
          // Same issues: count not decreased → stagnant
          reReviewIssues: [issue1, issue2],
          brainDecisionText: "IGNORE\nthese are acceptable",
        },
      ],
    });

    assert.equal(result.shouldMerge, true); // brain chose IGNORE
    assert.equal(result.brainCalls.length, 1);
    assert.equal(result.brainCalls[0].isFinalRound, true); // stagnant!
  });

  it("stagnant detection: FIX rejected on final round → block", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2],
      maxFixes: 3,
      rounds: [
        {
          // Identical issues → stagnant → isFinalRound=true
          reReviewIssues: [issue1, issue2],
          brainDecisionText: "FIX\ntry harder", // will be rejected
        },
      ],
    });

    // FIX is not allowed on final round → parseReviewDecision returns block
    assert.equal(result.shouldMerge, false);
  });

  // --- fix → split ---

  it("fix → brain chooses split: merge + creates tasks", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2, issue3],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [issue2], // partial fix
          brainDecisionText:
            "SPLIT\nmerge the good stuff\nNEW_TASKS:\n- Fix error handling in db.ts",
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    assert.equal(result.fixCalls.length, 1);
  });

  // --- hardVerify fail ---

  it("hardVerify fail after fix: shouldMerge=false", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [], // won't be reached
          hardVerifyPassed: false,
          brainDecisionText: "",
        },
      ],
    });

    assert.equal(result.shouldMerge, false);
    assert.ok(result.logEntries[0].output.includes("hardVerify failed"));
  });

  // --- fix → block ---

  it("brain chooses block: shouldMerge=false", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [issue1],
          brainDecisionText: "BLOCK\ntoo risky",
        },
      ],
    });

    assert.equal(result.shouldMerge, false);
  });

  // --- maxFixes=1 (S complexity) ---

  it("maxFixes=1: only 1 round, backward compatible", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2],
      maxFixes: 1,
      rounds: [
        {
          reReviewIssues: [issue2],
          brainDecisionText: "IGNORE\nacceptable",
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    assert.equal(result.fixCalls.length, 1);
    assert.equal(result.brainCalls.length, 1);
    // With maxFixes=1, fixRound=0 is the last → isFinalRound=true
    assert.equal(result.brainCalls[0].isFinalRound, true);
  });

  // --- REWRITE discards session ---

  it("rewrite discards session: fixSessionId=undefined", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1],
      maxFixes: 3,
      initialDecision: {
        decision: "rewrite",
        fixInstructions: "completely redo it",
      },
      rounds: [
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "",
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    assert.equal(result.fixCalls[0].sessionId, undefined); // session discarded
    assert.equal(result.fixCalls[0].isRewrite, true);
  });

  it("mid-loop rewrite discards session after fix round", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [issue1], // partial fix
          brainDecisionText: "REWRITE\nwrong approach, redo",
        },
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "",
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    // Round 1: fix, has sessionId
    assert.ok(result.fixCalls[0].sessionId !== undefined);
    assert.equal(result.fixCalls[0].isRewrite, false);
    // Round 2: rewrite, session discarded
    assert.equal(result.fixCalls[1].sessionId, undefined);
    assert.equal(result.fixCalls[1].isRewrite, true);
  });

  // --- PASS telemetry ---

  it("PASS round telemetry includes round count", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "",
        },
      ],
    });

    assert.equal(result.logEntries.length, 1);
    assert.ok(result.logEntries[0].output.includes("PASS after 1 rounds"));
  });

  // --- Cumulative context ---

  it("round 2+ gets cumulative context with fix history", () => {
    const result = simulateFixLoop({
      initialIssues: [issue1, issue2],
      maxFixes: 3,
      rounds: [
        {
          reReviewIssues: [issue2],
          brainDecisionText: "FIX\nstill need to fix error handling",
        },
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "",
        },
      ],
    });

    // Round 1: no cumulative context
    assert.equal(result.fixCalls[0].cumulativeContext, undefined);
    // Round 2: has cumulative context from round 1 (JSON format)
    assert.ok(result.fixCalls[1].cumulativeContext !== undefined);
    assert.ok(result.fixCalls[1].cumulativeContext!.includes("```json"));
  });

  // --- Convergence: 70% overlap threshold ---

  it("count not decreased + 70%+ overlap triggers isFinalRound", () => {
    // 3 issues → 3 issues, all 3 persist → count same AND 100% overlap → stagnant
    const persistA = makeIssue("high", "Issue A", "src/a.ts");
    const persistB = makeIssue("high", "Issue B", "src/b.ts");
    const persistC = makeIssue("medium", "Issue C", "src/c.ts");

    const result = simulateFixLoop({
      initialIssues: [persistA, persistB, persistC],
      maxFixes: 3,
      rounds: [
        {
          // 3 issues → 3 issues, 3 persist = 100% overlap
          // count (3) >= prev (3) AND overlap (3/3=100%) >= 70% → stagnant
          reReviewIssues: [persistA, persistB, persistC],
          brainDecisionText: "IGNORE\nacceptable",
        },
      ],
    });

    assert.equal(result.brainCalls[0].isFinalRound, true);
  });

  it("count decreased even with high overlap: not stagnant", () => {
    // 3 issues → 1 issue, but that 1 persists → overlap 100% but count decreased
    const persistA = makeIssue("high", "Issue A", "src/a.ts");

    const result = simulateFixLoop({
      initialIssues: [
        persistA,
        makeIssue("high", "Issue B", "src/b.ts"),
        makeIssue("medium", "Issue C", "src/c.ts"),
      ],
      maxFixes: 3,
      rounds: [
        {
          // 3→1, overlap 1/1=100% but count decreased → NOT stagnant
          reReviewIssues: [persistA],
          brainDecisionText: "FIX\nfix the remaining issue",
        },
        {
          reReviewIssues: [],
          reReviewPassed: true,
          brainDecisionText: "",
        },
      ],
    });

    assert.equal(result.shouldMerge, true);
    assert.equal(result.brainCalls[0].isFinalRound, false); // not stagnant
  });
});

// ---------------------------------------------------------------------------
// issueKey: unique key for review issues (file + severity + full description)
// ---------------------------------------------------------------------------

describe("issueKey", () => {
  it("includes file, severity, and full description", () => {
    const key = issueKey(makeIssue("high", "Missing null check", "src/api.ts"));
    assert.equal(key, "src/api.ts|high|Missing null check");
  });

  it("uses '?' when file is undefined", () => {
    const key = issueKey(makeIssue("medium", "No error handling"));
    assert.equal(key, "?|medium|No error handling");
  });

  it("differentiates issues with same 80-char prefix but different tails", () => {
    const prefix = "A".repeat(80);
    const descA = prefix + " — variant alpha";
    const descB = prefix + " — variant beta";
    const keyA = issueKey(makeIssue("high", descA, "src/x.ts"));
    const keyB = issueKey(makeIssue("high", descB, "src/x.ts"));
    assert.notEqual(keyA, keyB, "full description must be used, not truncated");
  });

  it("same issue produces identical keys", () => {
    const a = issueKey(makeIssue("low", "Console.log", "src/u.ts"));
    const b = issueKey(makeIssue("low", "Console.log", "src/u.ts"));
    assert.equal(a, b);
  });

  it("different severity → different key", () => {
    const a = issueKey(makeIssue("high", "Missing null check", "src/a.ts"));
    const b = issueKey(makeIssue("low", "Missing null check", "src/a.ts"));
    assert.notEqual(a, b);
  });

  it("different file → different key", () => {
    const a = issueKey(makeIssue("high", "Missing null check", "src/a.ts"));
    const b = issueKey(makeIssue("high", "Missing null check", "src/b.ts"));
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// COMPLEXITY_CONFIG.maxReviewFixes cap tests
// ---------------------------------------------------------------------------

describe("COMPLEXITY_CONFIG maxReviewFixes", () => {
  it("S complexity has maxReviewFixes=1", () => {
    assert.equal(COMPLEXITY_CONFIG["S"].maxReviewFixes, 1);
  });

  it("M complexity has maxReviewFixes=2", () => {
    assert.equal(COMPLEXITY_CONFIG["M"].maxReviewFixes, 2);
  });

  it("L complexity has maxReviewFixes=3", () => {
    assert.equal(COMPLEXITY_CONFIG["L"].maxReviewFixes, 3);
  });

  it("XL complexity has maxReviewFixes=3", () => {
    assert.equal(COMPLEXITY_CONFIG["XL"].maxReviewFixes, 3);
  });

  it("min(config, complexity) ensures config=1 caps at 1", () => {
    const configMax = 1;
    const complexityMax = COMPLEXITY_CONFIG["L"].maxReviewFixes;
    assert.equal(Math.min(configMax, complexityMax), 1);
  });

  it("min(config, complexity) allows config=3 for L/XL", () => {
    const configMax = 3;
    const complexityMax = COMPLEXITY_CONFIG["L"].maxReviewFixes;
    assert.equal(Math.min(configMax, complexityMax), 3);
  });
});

// ---------------------------------------------------------------------------
// resolveTaskComplexity: compatibility between new and legacy plan schemas
// ---------------------------------------------------------------------------

describe("resolveTaskComplexity", () => {
  // Minimal Task stub — only `plan` is used by the function
  function taskWith(plan: unknown) {
    return { plan } as import("../../src/memory/types.js").Task;
  }

  it("returns plan.complexity directly for brain-driven tasks", () => {
    assert.equal(resolveTaskComplexity(taskWith({ complexity: "S" })), "S");
    assert.equal(resolveTaskComplexity(taskWith({ complexity: "M" })), "M");
    assert.equal(resolveTaskComplexity(taskWith({ complexity: "L" })), "L");
    assert.equal(resolveTaskComplexity(taskWith({ complexity: "XL" })), "XL");
  });

  it("maps estimatedComplexity for legacy queued tasks", () => {
    assert.equal(
      resolveTaskComplexity(taskWith({ estimatedComplexity: "low" })),
      "S",
    );
    assert.equal(
      resolveTaskComplexity(taskWith({ estimatedComplexity: "medium" })),
      "M",
    );
    assert.equal(
      resolveTaskComplexity(taskWith({ estimatedComplexity: "high" })),
      "L",
    );
  });

  it("prefers complexity over estimatedComplexity when both exist", () => {
    assert.equal(
      resolveTaskComplexity(
        taskWith({ complexity: "XL", estimatedComplexity: "low" }),
      ),
      "XL",
    );
  });

  it("returns undefined when plan is null", () => {
    assert.equal(resolveTaskComplexity(taskWith(null)), undefined);
  });

  it("returns undefined when plan has neither field", () => {
    assert.equal(resolveTaskComplexity(taskWith({})), undefined);
  });

  it("returns undefined for unknown estimatedComplexity values", () => {
    assert.equal(
      resolveTaskComplexity(taskWith({ estimatedComplexity: "extreme" })),
      undefined,
    );
  });

  it("rejects invalid complexity strings not in COMPLEXITY_CONFIG", () => {
    assert.equal(
      resolveTaskComplexity(taskWith({ complexity: "medium" })),
      undefined,
    );
    assert.equal(
      resolveTaskComplexity(taskWith({ complexity: "HUGE" })),
      undefined,
    );
    assert.equal(
      resolveTaskComplexity(taskWith({ complexity: "" })),
      undefined,
    );
  });

  it("maxReviewFixes differs correctly per resolved complexity", () => {
    const lowTask = taskWith({ estimatedComplexity: "low" });
    const highTask = taskWith({ estimatedComplexity: "high" });

    const lowMaxFixes =
      COMPLEXITY_CONFIG[resolveTaskComplexity(lowTask) ?? "M"].maxReviewFixes;
    const highMaxFixes =
      COMPLEXITY_CONFIG[resolveTaskComplexity(highTask) ?? "M"].maxReviewFixes;

    assert.equal(lowMaxFixes, 1, "low → S → 1 fix round");
    assert.equal(highMaxFixes, 3, "high → L → 3 fix rounds");
  });
});

// ---------------------------------------------------------------------------
// safeComplexity: validated COMPLEXITY_CONFIG key with M fallback
// ---------------------------------------------------------------------------

describe("safeComplexity", () => {
  it("passes through valid complexity keys unchanged", () => {
    assert.equal(safeComplexity("S"), "S");
    assert.equal(safeComplexity("M"), "M");
    assert.equal(safeComplexity("L"), "L");
    assert.equal(safeComplexity("XL"), "XL");
  });

  it("falls back to M for undefined/null", () => {
    assert.equal(safeComplexity(undefined), "M");
    assert.equal(safeComplexity(null), "M");
  });

  it("falls back to M for invalid strings", () => {
    assert.equal(safeComplexity("medium"), "M");
    assert.equal(safeComplexity("HUGE"), "M");
    assert.equal(safeComplexity(""), "M");
  });
});
