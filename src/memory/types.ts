import type { MemoryCategory } from "../types/constants.js";

export type { MemoryCategory } from "../types/constants.js";

export interface Memory {
  id: number;
  category: MemoryCategory;
  title: string;
  content: string;
  tags: string[];
  source_project: string | null;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

export type TaskPhase =
  | "init"
  | "scanning"
  | "planning"
  | "analyzing"
  | "plan-review"
  | "executing"
  | "reviewing"
  | "reflecting"
  | "done"
  | "failed"
  | "blocked";
export type TaskStatus =
  | "queued"
  | "active"
  | "done"
  | "failed"
  | "blocked"
  | "skipped"
  | "pending_review";

export interface Task {
  id: string;
  project_path: string;
  task_description: string;
  phase: TaskPhase;
  priority: number; // 0=P0 urgent, 3=P3 optional
  plan: unknown;
  subtasks: SubTaskRecord[];
  review_results: unknown[];
  iteration: number;
  total_cost_usd: number;
  git_branch: string | null;
  start_commit: string | null;
  depends_on: string[];
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
}

export interface SubTaskRecord {
  id: string;
  description: string;
  executor: "claude" | "codex";
  status: "pending" | "running" | "done" | "failed";
  order?: number;
  result?: string;
  workerError?: string;
}

export interface Persona {
  id: number;
  name: string;
  role: string;
  content: string;
  task_types: string[];
  focus_areas: string[];
  usage_count: number;
  success_rate: number;
  created_at: Date;
  updated_at: Date;
}

export interface TaskLog {
  id: number;
  task_id: string;
  phase: string;
  agent: string;
  input_summary: string | null;
  output_summary: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: Date;
}

export interface OperationalMetrics {
  cycleCount: number;
  avgCycleDurationMs: number;
  taskPassRate: number;
  dailyCostUsd: number;
  queueDepth: number;
  tasksByStatus: Record<string, number>;
  recentHealthScores: number[];
}

export interface ScanResult {
  id: number;
  project_path: string;
  commit_hash: string;
  depth: "quick" | "normal" | "deep";
  result: ProjectAnalysis;
  health_score: number | null;
  cost_usd: number | null;
  module_name: string | null;
  created_at: Date;
}

export interface CodeMetrics {
  typeErrors: number;
  longFunctions: Array<{ file: string; name: string; lines: number }>;
  duplicatePatterns: Array<{ files: string[]; description: string }>;
  deadCode: Array<{ file: string; description: string }>;
}

export interface SimplificationTarget {
  file: string;
  description: string;
  complexity: string;
  suggestion: string;
}

export interface FeatureGap {
  area: string;
  description: string;
  suggestion: string;
}

export interface ProjectAnalysis {
  issues: AnalysisItem[];
  opportunities: AnalysisItem[];
  projectHealth: number; // 0-100
  summary: string;
  codeMetrics?: CodeMetrics;
  simplificationTargets?: SimplificationTarget[];
  featureGaps?: FeatureGap[];
}

export interface AnalysisItem {
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export type PlanReviewStatus = "draft" | "approved" | "rejected" | "expired";
export type ChatStatus =
  | "chatting"
  | "researching"
  | "generating"
  | "ready"
  | "error"
  | "closed";

export interface PlanDraftAnnotation {
  task_index: number;
  action: "approve" | "reject" | "modify";
  comment: string;
  modified_description?: string;
}

export interface PlanDraft {
  id: number;
  project_path: string;
  plan: unknown; // TaskPlan JSON
  analysis_summary: string;
  reasoning: string;
  markdown: string; // human-readable plan
  status: PlanReviewStatus;
  annotations: PlanDraftAnnotation[];
  scan_id: number | null;
  cost_usd: number;
  chat_session_id: string | null; // Agent SDK session ID (for resume)
  chat_status: ChatStatus | null; // chat lifecycle status
  created_at: Date;
  reviewed_at: Date | null;
}

export interface ChatMessage {
  id: number;
  session_id: number; // references plan_drafts.id
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}
