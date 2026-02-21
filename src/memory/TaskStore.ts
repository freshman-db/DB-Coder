import postgres from 'postgres';
import type { Task, TaskLog, TaskPhase, TaskStatus, ScanResult, SubTaskRecord } from './types.js';
import { log } from '../utils/logger.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_path TEXT NOT NULL,
  task_description TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'init',
  priority INTEGER DEFAULT 2,
  plan JSONB,
  subtasks JSONB DEFAULT '[]',
  review_results JSONB DEFAULT '[]',
  iteration INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  git_branch TEXT,
  start_commit TEXT,
  status TEXT DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_logs (
  id SERIAL PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id),
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  cost_usd NUMERIC(10,4),
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scan_results (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  depth TEXT NOT NULL,
  result JSONB NOT NULL,
  health_score INTEGER,
  cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_costs (
  date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
  total_cost_usd NUMERIC(10,4) DEFAULT 0,
  task_count INTEGER DEFAULT 0
);
`;

export class TaskStore {
  private sql: postgres.Sql;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      idle_timeout: 120,
      max_lifetime: 3600,
      max: 10,
    });
  }

  async init(): Promise<void> {
    await this.sql.unsafe(SCHEMA_SQL);
    log.info('TaskStore initialized');
  }

  // --- Tasks ---

  async createTask(projectPath: string, description: string, priority = 2): Promise<Task> {
    const [row] = await this.sql<Task[]>`
      INSERT INTO tasks (project_path, task_description, priority)
      VALUES (${projectPath}, ${description}, ${priority})
      RETURNING *
    `;
    return row;
  }

  async getTask(id: string): Promise<Task | null> {
    const [row] = await this.sql<Task[]>`SELECT * FROM tasks WHERE id = ${id}`;
    return row ?? null;
  }

  async listTasks(projectPath: string, status?: TaskStatus): Promise<Task[]> {
    if (status) {
      return this.sql<Task[]>`
        SELECT * FROM tasks WHERE project_path = ${projectPath} AND status = ${status}
        ORDER BY priority ASC, created_at ASC
      `;
    }
    return this.sql<Task[]>`
      SELECT * FROM tasks WHERE project_path = ${projectPath}
      ORDER BY priority ASC, created_at ASC
    `;
  }

  async updateTask(id: string, updates: Partial<Pick<Task, 'phase' | 'status' | 'plan' | 'subtasks' | 'review_results' | 'iteration' | 'total_cost_usd' | 'git_branch' | 'start_commit'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        if (key === 'plan' || key === 'subtasks' || key === 'review_results') {
          sets.push(`${key} = $${vals.length + 1}::jsonb`);
          vals.push(val);
        } else {
          sets.push(`${key} = $${vals.length + 1}`);
          vals.push(val);
        }
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');
    await this.sql.unsafe(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${vals.length + 1}`,
      [...vals, id] as postgres.ParameterOrJSON<never>[],
    );
  }

  async incrementTaskCost(taskId: string, amount: number): Promise<void> {
    await this.sql.unsafe(
      'UPDATE tasks SET total_cost_usd = COALESCE(total_cost_usd, 0) + $1 WHERE id = $2',
      [amount, taskId] as postgres.ParameterOrJSON<never>[],
    );
  }

  async deleteTask(id: string): Promise<void> {
    await this.sql`DELETE FROM task_logs WHERE task_id = ${id}`;
    await this.sql`DELETE FROM tasks WHERE id = ${id}`;
  }

  async getNextTask(projectPath: string): Promise<Task | null> {
    const [row] = await this.sql<Task[]>`
      SELECT * FROM tasks
      WHERE project_path = ${projectPath} AND status = 'queued'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `;
    return row ?? null;
  }

  // --- Logs ---

  async addLog(entry: Omit<TaskLog, 'id' | 'created_at'>): Promise<void> {
    await this.sql`
      INSERT INTO task_logs (task_id, phase, agent, input_summary, output_summary, cost_usd, duration_ms)
      VALUES (${entry.task_id}, ${entry.phase}, ${entry.agent},
              ${entry.input_summary}, ${entry.output_summary},
              ${entry.cost_usd}, ${entry.duration_ms})
    `;
  }

  async getTaskLogs(taskId: string): Promise<TaskLog[]> {
    return this.sql<TaskLog[]>`
      SELECT * FROM task_logs WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
  }

  // --- Scan Results ---

  async saveScanResult(scan: Omit<ScanResult, 'id' | 'created_at'>): Promise<void> {
    await this.sql`
      INSERT INTO scan_results (project_path, commit_hash, depth, result, health_score, cost_usd)
      VALUES (${scan.project_path}, ${scan.commit_hash}, ${scan.depth},
              ${this.sql.json(scan.result as any)}, ${scan.health_score}, ${scan.cost_usd})
    `;
  }

  async getLastScan(projectPath: string): Promise<ScanResult | null> {
    const [row] = await this.sql<ScanResult[]>`
      SELECT * FROM scan_results
      WHERE project_path = ${projectPath}
      ORDER BY created_at DESC LIMIT 1
    `;
    return row ?? null;
  }

  // --- Costs ---

  async addDailyCost(costUsd: number): Promise<void> {
    await this.sql`
      INSERT INTO daily_costs (date, total_cost_usd, task_count)
      VALUES (CURRENT_DATE, ${costUsd}, 1)
      ON CONFLICT (date) DO UPDATE SET
        total_cost_usd = daily_costs.total_cost_usd + ${costUsd},
        task_count = daily_costs.task_count + 1
    `;
  }

  async getDailyCost(date?: string): Promise<{ total_cost_usd: number; task_count: number }> {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const [row] = await this.sql<Array<{ total_cost_usd: number; task_count: number }>>`
      SELECT total_cost_usd, task_count FROM daily_costs WHERE date = ${d}
    `;
    return row ?? { total_cost_usd: 0, task_count: 0 };
  }

  async getRecentCosts(days = 7): Promise<Array<{ date: string; total_cost_usd: number; task_count: number }>> {
    return this.sql<Array<{ date: string; total_cost_usd: number; task_count: number }>>`
      SELECT date::text, total_cost_usd, task_count FROM daily_costs
      ORDER BY date DESC LIMIT ${days}
    `;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
