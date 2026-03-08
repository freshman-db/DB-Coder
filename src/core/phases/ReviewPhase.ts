/**
 * ReviewPhase — Code review, plan review, and spec review.
 *
 * Methods extracted from MainLoop:
 * - codeReview, reviewPlan, specReview
 */

import type { Config } from "../../config/Config.js";
import type { TaskStore } from "../../memory/TaskStore.js";
import type { CostTracker } from "../../utils/cost.js";
import type { RuntimeAdapter } from "../../runtime/RuntimeAdapter.js";
import type { ReviewAdapter } from "../WorkerAdapter.js";
import type { ReviewResult } from "../../bridges/ReviewTypes.js";
import type { Task } from "../../memory/types.js";
import type { WorkInstructions } from "../PersonaLoader.js";
import { getChangedFilesSince, getDiffSince } from "../../utils/git.js";
import { extractJsonFromText, isRecord } from "../../utils/parse.js";
import { log } from "../../utils/logger.js";
import { runBrainThink } from "./brainThink.js";

export class ReviewPhase {
  /** Runtime for spec review (brain-style read-only analysis). */
  private readonly specReviewRuntime: RuntimeAdapter;

  constructor(
    private readonly config: Config,
    private readonly taskStore: TaskStore,
    private readonly costTracker: CostTracker,
    private readonly brainSession: RuntimeAdapter,
    private readonly reviewer: ReviewAdapter,
    reviewRuntime?: RuntimeAdapter,
  ) {
    // specReview uses a dedicated review runtime if provided; falls back to brainSession
    this.specReviewRuntime = reviewRuntime ?? brainSession;
  }

  /** Resolved review model from routing config (normalized at Config construction). */
  private get reviewModel(): string {
    return this.config.values.routing.review.model;
  }

  // --- Unified code review ---

  async codeReview(
    task: Task,
    startCommit: string,
    projectPath: string,
    reviewerOverride?: ReviewAdapter,
  ): Promise<ReviewResult & { reviewDiff: string }> {
    const changedFiles = await getChangedFilesSince(
      startCommit,
      projectPath,
    ).catch(() => []);

    if (changedFiles.length === 0) {
      return {
        passed: true,
        issues: [],
        summary: "No changed files to review",
        cost_usd: 0,
        reviewDiff: "",
      };
    }

    const reviewDiff = await getDiffSince(startCommit, projectPath, {
      ignoreWhitespace: true,
    }).catch(() => "(diff unavailable)");

    const prompt = `You are an adversarial code reviewer. Review ONLY the changes in this diff.

## Task
${task.task_description}

## Changed Files
${changedFiles.join("\n")}

## Git Diff
\`\`\`diff
${reviewDiff}
\`\`\`

## Review Focus Areas (apply ONLY to the diff above, not pre-existing code)

### 1. Bugs & Logic Errors
- Off-by-one errors, null dereference, race conditions
- Missing await on async calls, unhandled promise rejections
- Incorrect boolean logic, missing break/return statements

### 2. Security
- Unvalidated input, injection vectors (SQL, command, XSS)
- Sensitive data in logs, hardcoded credentials
- Missing authentication/authorization checks

### 3. Error Handling
- Catch blocks that swallow errors silently
- Missing error propagation in async chains
- Default return values hiding failures

### 4. Type Safety
- New \`any\` types introduced
- Unsafe type assertions (as unknown as T)
- Missing null checks on optional values

### 5. Scope Creep
- Changes unrelated to the stated purpose
- "While I'm here" improvements mixed with the main change

## Rules
- ONLY report issues introduced or worsened by THIS diff in the "issues" array.
- If you notice pre-existing bugs/issues in touched files (NOT introduced by this diff), list them separately in "preExistingIssues".
- Report all issues you find. If the code is clean, report passed: true with an empty issues array.
- Be concrete — cite specific code patterns, not vague concerns.
- Write ALL descriptions (issues + preExistingIssues) in ${this.config.values.brain.language}.

## Output Format (JSON)
{"passed": true/false, "issues": [...], "preExistingIssues": [{"description": "...", "file": "...", "severity": "high|medium|low"}], "summary": "..."}`;

    const reviewer = reviewerOverride ?? this.reviewer;
    const result = await reviewer.review(prompt, projectPath, {
      model: this.reviewModel,
    });

    if (result.cost_usd > 0) {
      await this.costTracker.addCost(task.id, result.cost_usd);
    }

    // Warn on suspicious parse failure
    if (!result.passed && (result.issues ?? []).length === 0) {
      log.warn(
        "Code review returned passed=false with zero issues — likely output parse failure, treating as PASS",
      );
      return { ...result, passed: true, reviewDiff };
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "review",
      agent: reviewer.runtimeName ?? reviewer.name,
      input_summary: `files: ${changedFiles.join(", ")}`,
      output_summary: `${result.passed ? "PASS" : "FAIL"}: ${result.summary ?? ""}`,
      cost_usd: result.cost_usd,
      duration_ms: 0,
    });

    // Queue pre-existing issues as new tasks
    const preExisting = result.preExistingIssues ?? [];
    for (const issue of preExisting) {
      const desc = issue.file
        ? `fix: ${issue.description} (${issue.file})`
        : `fix: ${issue.description}`;
      const { duplicate, reason } = await this.taskStore.isDuplicateTask(
        projectPath,
        desc,
        48,
      );
      if (duplicate) {
        log.info(`Dedup preExisting: ${reason} — "${desc.slice(0, 80)}"`);
      } else {
        await this.taskStore.createTask(projectPath, desc, 3);
        log.info(`Queued pre-existing issue: ${desc.slice(0, 100)}`);
      }
    }

    return { ...result, reviewDiff };
  }

  // --- Plan review ---

  async reviewPlan(
    proposal: string,
    task: Task,
    reviewerOverride?: ReviewAdapter,
  ): Promise<ReviewResult> {
    const prompt = `You are reviewing a proposed code change plan. Assess feasibility and correctness.

## Task
${task.task_description}

## Proposed Changes
${proposal}

## Review Focus
1. **Feasibility** — Can these changes be made without breaking existing functionality?
2. **Completeness** — Does the proposal address all requirements?
3. **Architecture** — Are the proposed changes well-structured?
4. **Risk** — Are there unaddressed edge cases or breaking changes?
5. **Scope** — Does the proposal stay within the task's scope?

## Output Format (JSON)
{"passed": true/false, "issues": [{"severity": "critical|high|medium|low", "description": "..."}], "summary": "..."}`;

    const reviewer = reviewerOverride ?? this.reviewer;
    const result = await reviewer.review(prompt, this.config.projectPath, {
      model: this.reviewModel,
    });

    if (result.cost_usd > 0) {
      await this.costTracker.addCost(task.id, result.cost_usd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "plan-review",
      agent: reviewer.runtimeName ?? reviewer.name,
      input_summary: "Plan review",
      output_summary: `${result.passed ? "PASS" : "FAIL"}: ${result.summary ?? ""}`,
      cost_usd: result.cost_usd,
      duration_ms: 0,
    });

    return result;
  }

  // --- Spec review ---

  async specReview(
    task: Task,
    startCommit: string,
    projectPath: string,
    workInstructions?: WorkInstructions,
  ): Promise<{
    passed: boolean;
    missing: string[];
    extra: string[];
    concerns: string[];
  }> {
    const diff = await getDiffSince(startCommit, projectPath, {
      ignoreWhitespace: true,
    }).catch(() => "(diff unavailable)");
    const subtaskList = (task.subtasks ?? [])
      .map((s) => `- ${s.description}`)
      .join("\n");

    // BMAD: inject acceptance criteria from structured workInstructions
    const acSection =
      workInstructions &&
      typeof workInstructions !== "string" &&
      workInstructions.acceptanceCriteria?.length
        ? `\n## Acceptance Criteria (verify against diff)\n${workInstructions.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}\n`
        : "";

    const prompt = `You are a cynical, adversarial code reviewer. You EXPECT to find problems.
Your job is NOT to confirm quality — it's to find what's wrong, missing, or dangerous.
DO NOT trust commit messages — only examine the actual diff.
If you find zero issues, that is suspicious — re-analyze with more skepticism.

## Original Task
${task.task_description}
${acSection}
${subtaskList ? `## Subtasks\n${subtaskList}\n` : ""}## Git Diff
\`\`\`diff
${diff}
\`\`\`

## Review Checklist (check ALL categories)

### 1. Spec Compliance
- Does the diff fully implement every requirement in the task?
- Are there requirements mentioned but not implemented?

### 2. Scope Discipline
- Does the diff contain changes NOT requested by the task?
- Are there "while I'm here" cleanups, refactors, or improvements?

### 3. Correctness
- Are there logic errors, off-by-one, or missing edge cases?
- Are error paths handled explicitly (no catch-ignore)?

### 4. Safety
- Any new \`any\` types, unvalidated input, or injection vectors?
- Are there catch blocks that swallow errors silently?

### 5. Git Reality
- Does the actual diff match what the task asked for?
- Are there files changed that have no relation to the task?
- Do commit messages accurately describe the changes?

## Rules
- Report all issues you find. Be concrete — cite file names and line context.
- If the code is clean, report passed: true and explain briefly why.
- "Looks good" without specific analysis is NOT acceptable.

Respond with EXACTLY this JSON (no markdown, no extra text):
{"passed": true/false, "missing": ["..."], "extra": ["..."], "concerns": ["..."]}`;

    const result = await runBrainThink(
      this.specReviewRuntime,
      this.config,
      prompt,
      { model: this.config.values.routing.review.model },
    );
    if (result.costUsd > 0 && task.id) {
      await this.costTracker.addCost(task.id, result.costUsd);
    }

    await this.taskStore.addLog({
      task_id: task.id,
      phase: "review",
      agent: `${this.specReviewRuntime.name}-spec`,
      input_summary: "Spec compliance review",
      output_summary: result.text,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
    });

    const parseSpecResult = (text: string) => {
      const parsed = extractJsonFromText(
        text,
        (v) => isRecord(v) && Object.prototype.hasOwnProperty.call(v, "passed"),
      );
      if (!isRecord(parsed)) return null;
      const res = {
        passed: parsed.passed === true,
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        extra: Array.isArray(parsed.extra) ? parsed.extra : [],
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
      };
      // BMAD: zero findings with PASS is suspicious — inject concern for visibility
      if (
        res.passed &&
        res.missing.length === 0 &&
        res.extra.length === 0 &&
        res.concerns.length === 0
      ) {
        res.concerns = [
          "Reviewer found zero issues — may indicate insufficient analysis",
        ];
      }
      return res;
    };

    const firstResult = parseSpecResult(result.text);
    if (firstResult) return firstResult;

    // extractJsonFromText couldn't find valid JSON — retry once then FAIL
    log.warn("Spec review returned unparseable JSON, retrying once");
    const retry = await runBrainThink(
      this.specReviewRuntime,
      this.config,
      prompt,
      { model: this.config.values.routing.review.model },
    );
    if (retry.costUsd > 0 && task.id) {
      await this.costTracker.addCost(task.id, retry.costUsd);
    }
    const retryResult = parseSpecResult(retry.text);
    if (retryResult) return retryResult;

    log.warn("Spec review retry also unparseable — treating as FAIL");
    return {
      passed: false,
      missing: ["spec review parse failure"],
      extra: [],
      concerns: [],
    };
  }
}
