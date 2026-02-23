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
