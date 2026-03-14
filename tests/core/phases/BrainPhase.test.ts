import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewDecision } from "../../../src/core/phases/BrainPhase.js";

describe("parseReviewDecision", () => {
  // --- Basic keyword recognition ---

  it("parses FIX with multiline instructions", () => {
    const r = parseReviewDecision("FIX\ndo X\nthen Y", false);
    assert.equal(r.decision, "fix");
    assert.equal(r.fixInstructions, "do X\nthen Y");
    assert.equal(r.reasoning, "do X\nthen Y");
  });

  it("parses IGNORE with reasoning", () => {
    const r = parseReviewDecision("IGNORE\nfalse positive", false);
    assert.equal(r.decision, "ignore");
    assert.equal(r.reasoning, "false positive");
    assert.equal(r.fixInstructions, undefined);
  });

  it("parses BLOCK with reasoning", () => {
    const r = parseReviewDecision("BLOCK\ntoo risky", false);
    assert.equal(r.decision, "block");
    assert.equal(r.reasoning, "too risky");
  });

  it("parses REWRITE with instructions", () => {
    const r = parseReviewDecision("REWRITE\nnew approach needed", false);
    assert.equal(r.decision, "rewrite");
    assert.equal(r.fixInstructions, "new approach needed");
  });

  // --- First-line tolerance ---

  it("tolerates FIX: with colon", () => {
    const r = parseReviewDecision("FIX: do this thing", false);
    assert.equal(r.decision, "fix");
    assert.equal(r.fixInstructions, "do this thing");
  });

  it("tolerates FIX — with dash", () => {
    const r = parseReviewDecision("FIX — urgent change needed\ndetails here", false);
    assert.equal(r.decision, "fix");
    assert.ok(r.fixInstructions!.includes("urgent change needed"));
    assert.ok(r.fixInstructions!.includes("details here"));
  });

  it("is case-insensitive for first line", () => {
    const r = parseReviewDecision("fix\ndo stuff", false);
    assert.equal(r.decision, "fix");
  });

  it("handles keyword with no body", () => {
    const r = parseReviewDecision("IGNORE", false);
    assert.equal(r.decision, "ignore");
    assert.equal(r.reasoning, "");
  });

  // --- Same-line content (issue #1 fix) ---

  it("captures same-line content after FIX keyword", () => {
    const r = parseReviewDecision("FIX: do X immediately", false);
    assert.equal(r.decision, "fix");
    assert.equal(r.fixInstructions, "do X immediately");
  });

  it("merges same-line + multiline content", () => {
    const r = parseReviewDecision("FIX: first part\nsecond part", false);
    assert.equal(r.decision, "fix");
    assert.equal(r.fixInstructions, "first part\nsecond part");
  });

  // --- isFinalRound=false: intermediate round allows FIX/REWRITE ---

  it("allows FIX on intermediate round (isFinalRound=false)", () => {
    const r = parseReviewDecision("FIX\ndo something", false);
    assert.equal(r.decision, "fix");
    assert.equal(r.fixInstructions, "do something");
  });

  it("allows REWRITE on intermediate round (isFinalRound=false)", () => {
    const r = parseReviewDecision("REWRITE\nnew approach", false);
    assert.equal(r.decision, "rewrite");
    assert.equal(r.fixInstructions, "new approach");
  });

  // --- isFinalRound=true: final round constraints ---

  it("allows IGNORE on final round", () => {
    const r = parseReviewDecision("IGNORE\nminor issue", true);
    assert.equal(r.decision, "ignore");
  });

  it("allows BLOCK on final round", () => {
    const r = parseReviewDecision("BLOCK\nsevere issue", true);
    assert.equal(r.decision, "block");
  });

  it("allows SPLIT on final round", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNEW_TASKS:\n- task A",
      true,
    );
    assert.equal(r.decision, "split");
  });

  it("rejects FIX on final round, defaults to block", () => {
    const r = parseReviewDecision("FIX\ndo something", true);
    assert.equal(r.decision, "block");
    assert.ok(r.reasoning.includes("parse failure"));
  });

  it("rejects REWRITE on final round, defaults to block", () => {
    const r = parseReviewDecision("REWRITE\nnew approach", true);
    assert.equal(r.decision, "block");
  });

  // --- SPLIT with NEW_TASKS ---

  it("parses SPLIT with NEW_TASKS: delimiter and bullet list", () => {
    const r = parseReviewDecision(
      "SPLIT\nmerge current work\nNEW_TASKS:\n- fix auth bug\n- add tests",
      false,
    );
    assert.equal(r.decision, "split");
    assert.equal(r.reasoning, "merge current work");
    assert.deepEqual(r.newTasks, ["fix auth bug", "add tests"]);
  });

  it("parses SPLIT with numbered list", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNEW_TASKS:\n1. first task\n2) second task",
      false,
    );
    assert.equal(r.decision, "split");
    assert.deepEqual(r.newTasks, ["first task", "second task"]);
  });

  it("parses SPLIT with * bullets", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNEW_TASKS:\n* task one\n* task two",
      false,
    );
    assert.deepEqual(r.newTasks, ["task one", "task two"]);
  });

  it("tolerates New Tasks: delimiter variant", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNew Tasks:\n- task A",
      false,
    );
    assert.equal(r.decision, "split");
    assert.deepEqual(r.newTasks, ["task A"]);
  });

  it("tolerates NEW TASKS: (space instead of underscore)", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNEW TASKS:\n- task A",
      false,
    );
    assert.equal(r.decision, "split");
    assert.deepEqual(r.newTasks, ["task A"]);
  });

  // --- SPLIT without tasks degrades to block ---

  it("degrades to block when SPLIT has no NEW_TASKS delimiter", () => {
    const r = parseReviewDecision(
      "SPLIT\nsome reasoning without tasks",
      false,
    );
    assert.equal(r.decision, "block");
    assert.ok(r.reasoning.includes("Split without follow-up tasks"));
  });

  it("degrades to block when SPLIT has empty task list", () => {
    const r = parseReviewDecision(
      "SPLIT\nreason\nNEW_TASKS:\n\n",
      false,
    );
    assert.equal(r.decision, "block");
  });

  it("does NOT extract bullets from reasoning (no delimiter)", () => {
    const r = parseReviewDecision(
      "SPLIT\n- this is reasoning\n- not a task",
      false,
    );
    assert.equal(r.decision, "block");
    assert.equal(r.newTasks, undefined);
  });

  // --- Parse failure ---

  it("defaults to block on unrecognized first line", () => {
    const r = parseReviewDecision("I think we should fix this", false);
    assert.equal(r.decision, "block");
    assert.ok(r.reasoning.includes("parse failure"));
  });

  it("defaults to block on empty input", () => {
    const r = parseReviewDecision("", false);
    assert.equal(r.decision, "block");
  });

  it("defaults to block when first line is a quoted keyword", () => {
    const r = parseReviewDecision('"IGNORE"\nreasoning', false);
    assert.equal(r.decision, "block");
  });
});
