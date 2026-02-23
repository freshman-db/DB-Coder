import type { CycleEventBus } from '../CycleEventBus.js';
import { FailureLearningStrategy } from './FailureLearningStrategy.js';
import { TaskQualityEvaluator } from './TaskQualityEvaluator.js';
import { DynamicPriorityStrategy, type GetProjectHealthFn } from './DynamicPriorityStrategy.js';

export interface StrategyDeps {
  getProjectHealth: GetProjectHealthFn;
}

export interface RegisteredStrategies {
  failureLearning: FailureLearningStrategy;
  qualityEvaluator: TaskQualityEvaluator;
  dynamicPriority: DynamicPriorityStrategy;
}

export function registerStrategies(bus: CycleEventBus, deps: StrategyDeps): RegisteredStrategies {
  const failureLearning = new FailureLearningStrategy();
  const qualityEvaluator = new TaskQualityEvaluator();
  const dynamicPriority = new DynamicPriorityStrategy(deps.getProjectHealth);

  bus.on('after:verify', (e) => {
    const v = e.data.verification as { passed: boolean } | undefined;
    if (v && !v.passed) failureLearning.recordFailure(e);
  });
  bus.on('error:execute', (e) => failureLearning.recordFailure(e));
  bus.on('after:merge', (e) => {
    if (e.data.merged) {
      qualityEvaluator.evaluate(e);
      const desc = e.data.taskDescription as string | undefined;
      if (desc) failureLearning.recordSuccess(desc);
    }
  });

  return { failureLearning, qualityEvaluator, dynamicPriority };
}

export { FailureLearningStrategy, TaskQualityEvaluator, DynamicPriorityStrategy };
