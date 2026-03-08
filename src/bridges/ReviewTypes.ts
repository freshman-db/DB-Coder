/**
 * Review result types — shared by CodexBridge, ReviewPhase, BrainPhase,
 * WorkerAdapter, and CycleEvents.
 *
 * Extracted from CodingAgent.ts (Phase 4) so consumers don't need to
 * import the deprecated CodingAgent interface.
 */

export interface PreExistingIssue {
  description: string;
  file?: string;
  severity?: string;
}

export interface ReviewResult {
  passed: boolean;
  issues: ReviewIssue[];
  summary: string;
  cost_usd: number;
  preExistingIssues?: PreExistingIssue[];
}

export interface ReviewIssue {
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
  source: "claude" | "codex";
  confidence?: number; // 0-1, undefined treated as 1.0
}
