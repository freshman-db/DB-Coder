import type { CycleEvent } from '../CycleEvents.js';
import { log } from '../../utils/logger.js';

export interface BudgetInfo {
  remainingUsd: number;
  avgTaskCostUsd: number;
}

export type GetBudgetInfoFn = () => Promise<BudgetInfo>;

export class BudgetGuard {
  constructor(private getBudgetInfo: GetBudgetInfoFn) {}

  async handle(event: CycleEvent): Promise<void> {
    const info = await this.getBudgetInfo();
    if (info.avgTaskCostUsd > 0 && info.remainingUsd < info.avgTaskCostUsd) {
      log.warn('BudgetGuard: insufficient budget', info);
      throw new Error(`Insufficient budget: $${info.remainingUsd.toFixed(2)} remaining, avg task costs $${info.avgTaskCostUsd.toFixed(2)}`);
    }
  }
}
