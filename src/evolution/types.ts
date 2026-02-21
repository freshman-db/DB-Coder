// --- Adjustment categories ---
export type AdjustmentCategory = 'routing' | 'strategy' | 'avoidance' | 'standard' | 'process' | 'config';

export type AdjustmentStatus = 'active' | 'superseded' | 'expired';

export interface Adjustment {
  id: number;
  project_path: string;
  task_id: string | null;
  text: string;
  category: AdjustmentCategory;
  effectiveness: number; // -1.0 to 1.0, starts at 0
  status: AdjustmentStatus;
  created_at: Date;
  updated_at: Date;
}

// --- Goal progress ---
export interface GoalProgress {
  id: number;
  project_path: string;
  goal_index: number;
  progress_pct: number; // 0-100
  evidence: string;
  scan_id: number | null;
  created_at: Date;
}

// --- Health trends ---
export type TrendDirection = 'improving' | 'stable' | 'degrading';

export interface HealthTrend {
  current: number;
  previous: number;
  delta: number;
  direction: TrendDirection;
  dataPoints: number;
}

export interface AreaTrend {
  area: string;
  count: number;
  previousCount: number;
  direction: TrendDirection;
}

// --- Config proposals ---
export type ProposalStatus = 'pending' | 'applied' | 'rejected';

export interface ConfigProposal {
  id: number;
  project_path: string;
  field_path: string;
  current_value: unknown;
  proposed_value: unknown;
  reason: string;
  confidence: number; // 0-1
  status: ProposalStatus;
  created_at: Date;
}

// --- Dynamic prompt context ---
export interface DynamicPromptContext {
  learnedPatterns: string[];
  antiPatterns: string[];
  trendContext: string;
  activeAdjustments: string[];
  goalContext: string;
}
