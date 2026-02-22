import type { PromptMetrics, PromptPatch } from '../evolution/types.js';
import type { PlanDraftAnnotation, ProjectAnalysis } from './types.js';

export interface ScanResultJson extends ProjectAnalysis {}

export interface TaskPlanSubtaskJson {
  id: string;
  description: string;
  executor: 'claude' | 'codex';
}

export interface TaskPlanTaskJson {
  id: string;
  description: string;
  priority: number;
  executor: 'claude' | 'codex';
  subtasks: TaskPlanSubtaskJson[];
  dependsOn: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  type?: 'bugfix' | 'security' | 'quality' | 'refactor' | 'simplify' | 'feature' | 'test' | 'docs';
}

export interface TaskPlanJson {
  tasks: TaskPlanTaskJson[];
  reasoning: string;
}

export interface PatchSetJson extends Array<PromptPatch> {}

export interface BaselineMetricsJson extends PromptMetrics {}

export interface ReviewAnnotationsJson extends Array<PlanDraftAnnotation> {}

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonArray extends Array<JsonValue> {}

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type ConfigProposalValue = JsonValue;

export interface ChatMessageMetadata {
  cost?: number;
  requestId?: string;
  [key: string]: JsonValue | undefined;
}
