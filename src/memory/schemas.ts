import type { PlanDraftAnnotation } from "./types.js";

export interface TaskPlanSubtaskJson {
  id: string;
  description: string;
  executor: "claude" | "codex";
}

export interface TaskPlanTaskJson {
  id: string;
  description: string;
  priority: number;
  executor: "claude" | "codex";
  subtasks: TaskPlanSubtaskJson[];
  dependsOn: string[];
  estimatedComplexity: "low" | "medium" | "high";
  type?:
    | "bugfix"
    | "security"
    | "quality"
    | "refactor"
    | "simplify"
    | "feature"
    | "test"
    | "docs";
}

export interface TaskPlanJson {
  tasks: TaskPlanTaskJson[];
  reasoning: string;
}

export interface ReviewAnnotationsJson extends Array<PlanDraftAnnotation> {}

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonArray extends Array<JsonValue> {}

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface ChatMessageMetadata {
  cost?: number;
  requestId?: string;
  [key: string]: JsonValue | undefined;
}
