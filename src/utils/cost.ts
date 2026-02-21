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

    const sql = (this.store as unknown as { sql: any }).sql;
    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO daily_costs (date, total_cost_usd, task_count)
        VALUES (CURRENT_DATE, ${costUsd}, 1)
        ON CONFLICT (date) DO UPDATE SET
          total_cost_usd = daily_costs.total_cost_usd + ${costUsd},
          task_count = daily_costs.task_count + 1
      `;

      await tx`
        UPDATE tasks
        SET total_cost_usd = total_cost_usd + ${costUsd},
            updated_at = NOW()
        WHERE id = ${taskId}
      `;
    });
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
