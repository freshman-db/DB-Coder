import type { ProjectAnalysis, AnalysisItem, SubTaskRecord } from '../memory/types.js';
import type { ReviewIssue } from '../bridges/CodingAgent.js';

export type { ProjectAnalysis, AnalysisItem };

export type TaskType = 'bugfix' | 'security' | 'quality' | 'refactor' | 'simplify' | 'feature' | 'test' | 'docs';

export interface PlanTask {
  id: string;
  description: string;
  priority: number; // 0-3
  executor: 'claude' | 'codex';
  subtasks: PlanSubTask[];
  dependsOn: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  type?: TaskType;
}

export interface PlanSubTask {
  id: string;
  description: string;
  executor: 'claude' | 'codex';
}

export interface TaskPlan {
  tasks: PlanTask[];
  reasoning: string;
}

export interface MergedReviewResult {
  passed: boolean;
  mustFix: ReviewIssue[];     // Both reviewers flagged — must fix
  shouldFix: ReviewIssue[];   // Only one reviewer flagged — optional
  summary: string;
}

export interface ReflectionResult {
  experiences: ExtractedExperience[];
  taskSummary: string;
  adjustments: string[];
}

export interface ExtractedExperience {
  category: 'habit' | 'experience' | 'standard' | 'workflow' | 'framework' | 'failure' | 'simplification';
  title: string;
  content: string;
  tags: string[];
}

export type LoopState = 'idle' | 'scanning' | 'planning' | 'executing' | 'reviewing' | 'reflecting' | 'paused' | 'error'
  | 'researching' | 'awaiting_approval' | 'analyzing' | 'evaluating';

export interface EvaluationScore {
  problemLegitimacy: number;        // -2 to +2: 问题真实性
  solutionProportionality: number;  // -2 to +2: 方案比例
  expectedComplexity: number;       // -2 to +2: 预期复杂度影响
  historicalSuccess: number;        // -2 to +2: 类似任务历史成功率
  total: number;                    // -8 to +8
}

export interface EvaluationResult {
  passed: boolean;       // total > 0
  score: EvaluationScore;
  reasoning: string;
  cost_usd: number;
  duration_ms: number;
}

export interface StatusSnapshot {
  state: LoopState;
  currentTaskId: string | null;
  patrolling: boolean;
  paused: boolean;
}
