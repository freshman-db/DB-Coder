import type { ReviewIssue } from "../bridges/ReviewTypes.js";
import type { SessionResult } from "../bridges/ClaudeCodeSession.js";

export type CyclePhase =
  | "decide"
  | "create-task"
  | "execute"
  | "verify"
  | "fix"
  | "review"
  | "reflect"
  | "merge"
  | "deep-review"
  | "maintenance";

export type CycleTiming = "before" | "after" | "error";

export interface CycleEvent {
  phase: CyclePhase;
  timing: CycleTiming;
  taskId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface CycleContext {
  cycleNumber: number;
  startTime: number;
  taskId?: string;
  taskDescription?: string;
  branch?: string;
  startCommit?: string;
  verification?: { passed: boolean; reason?: string };
  codexReview?: { passed: boolean; issues?: ReviewIssue[] };
  workerResult?: SessionResult;
  merged?: boolean;
}

export type EventPattern = string; // 'after:execute', 'after:*', '*:verify', '*'

export function matchPattern(
  pattern: EventPattern,
  phase: CyclePhase,
  timing: CycleTiming,
): boolean {
  if (pattern === "*") return true;
  const [pTiming, pPhase] = pattern.split(":");
  if (!pPhase) return false;
  const timingMatch = pTiming === "*" || pTiming === timing;
  const phaseMatch = pPhase === "*" || pPhase === phase;
  return timingMatch && phaseMatch;
}
