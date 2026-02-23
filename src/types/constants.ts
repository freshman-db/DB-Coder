export const TASK_DESC_MAX_LENGTH = 80;
export const LOG_PREVIEW_LEN = 60;
export const ERROR_PREVIEW_LEN = 200;
export const SUMMARY_PREVIEW_LEN = 500;
export const PLAN_SUMMARY_PREVIEW_LEN = 1000;

export const memoryCategories = [
  'habit',
  'experience',
  'standard',
  'workflow',
  'framework',
  'failure',
  'simplification',
] as const;

export type MemoryCategory = (typeof memoryCategories)[number];

export const promptNames = [
  'brain_system',
  'scan',
  'plan',
  'reflect',
  'executor',
  'reviewer',
  'research',
  'plan_markdown',
  'analysis',
  'evaluator',
] as const;

export type PromptName = (typeof promptNames)[number];
