export type MemoryCategory = 'habit' | 'experience' | 'standard' | 'workflow' | 'framework' | 'failure' | 'simplification';

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

export type TaskPhase = 'init' | 'scanning' | 'planning' | 'executing' | 'reviewing' | 'reflecting' | 'done' | 'failed' | 'blocked';
export type TaskStatus = 'queued' | 'active' | 'done' | 'failed' | 'blocked' | 'skipped';

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
  executor: 'claude' | 'codex';
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string;
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

export interface ReviewEvent {
  id: number;
  task_id: string;
  attempt: number;
  passed: boolean;
  must_fix_count: number;
  should_fix_count: number;
  issue_categories: string[];
  fix_agent: string | null;
  duration_ms: number | null;
  cost_usd: number;
  created_at: Date;
}

export interface RecurringIssueCategory {
  category: string;
  count: number;
}

export interface ScanResult {
  id: number;
  project_path: string;
  commit_hash: string;
  depth: 'quick' | 'normal' | 'deep';
  result: ProjectAnalysis;
  health_score: number | null;
  cost_usd: number | null;
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
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}
