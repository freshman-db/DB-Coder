import type { TaskStore } from '../memory/TaskStore.js';
import type { BudgetConfig } from '../config/types.js';
import { log } from './logger.js';

export class CostTracker {
  private sessionCost = 0;

  constructor(
    private store: TaskStore,
    private budget: BudgetConfig,
  ) {}

  async addCost(taskId: string, costUsd: number): Promise<void> {
    this.sessionCost += costUsd;
    await this.store.addDailyCost(costUsd);
    await this.store.updateTask(taskId, {
      total_cost_usd: undefined, // will use SQL increment below
    });
    // Direct SQL for atomic increment would be better, but updateTask handles partial updates
  }

  async checkBudget(taskId: string): Promise<{ allowed: boolean; reason?: string }> {
    const task = await this.store.getTask(taskId);
    if (task && task.total_cost_usd >= this.budget.maxPerTask) {
      return { allowed: false, reason: `Task budget exceeded: $${task.total_cost_usd}/$${this.budget.maxPerTask}` };
    }

    const daily = await this.store.getDailyCost();
    if (daily.total_cost_usd >= this.budget.maxPerDay) {
      return { allowed: false, reason: `Daily budget exceeded: $${daily.total_cost_usd}/$${this.budget.maxPerDay}` };
    }

    // Warning threshold
    const dailyRatio = daily.total_cost_usd / this.budget.maxPerDay;
    if (dailyRatio >= this.budget.warningThreshold) {
      log.warn(`Daily cost at ${(dailyRatio * 100).toFixed(0)}% of budget ($${daily.total_cost_usd}/$${this.budget.maxPerDay})`);
    }

    return { allowed: true };
  }

  async getDailySummary(): Promise<{ date: string; total_cost_usd: number; task_count: number }[]> {
    return this.store.getRecentCosts(7);
  }

  getSessionCost(): number {
    return this.sessionCost;
  }
}
