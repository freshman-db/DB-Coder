import type postgres from "postgres";
import type {
  Task,
  TaskLog,
  TaskStatus,
  ScanResult,
  PlanDraft,
  PlanReviewStatus,
  PlanDraftAnnotation,
  ChatMessage,
  ChatStatus,
  OperationalMetrics,
  Persona,
} from "./types.js";
import type { EvaluationScore } from "../core/types.js";
import type {
  ChatMessageMetadata,
  ReviewAnnotationsJson,
  TaskPlanJson,
} from "./schemas.js";
import { closeDb, getDb } from "../db.js";
import { log } from "../utils/logger.js";

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
  depends_on UUID[] DEFAULT '{}',
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

CREATE INDEX IF NOT EXISTS idx_tasks_description_trgm ON tasks USING gin (task_description gin_trgm_ops);

CREATE TABLE IF NOT EXISTS adjustments (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  task_id UUID REFERENCES tasks(id),
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'strategy',
  effectiveness REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goal_progress (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  goal_index INTEGER NOT NULL,
  progress_pct REAL NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '',
  scan_id INTEGER REFERENCES scan_results(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS config_proposals (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  field_path TEXT NOT NULL,
  current_value JSONB,
  proposed_value JSONB,
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS review_events (
  id SERIAL PRIMARY KEY,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  must_fix_count INTEGER DEFAULT 0,
  should_fix_count INTEGER DEFAULT 0,
  issue_categories JSONB DEFAULT '[]',
  fix_agent TEXT,
  duration_ms INTEGER,
  cost_usd NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on UUID[] DEFAULT '{}';

CREATE TABLE IF NOT EXISTS prompt_versions (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  prompt_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  patches JSONB NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  confidence REAL DEFAULT 0.5,
  effectiveness REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  baseline_metrics JSONB,
  current_metrics JSONB,
  tasks_evaluated INTEGER DEFAULT 0,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_path, prompt_name, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_active
  ON prompt_versions (project_path, prompt_name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS plan_drafts (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  plan JSONB NOT NULL,
  analysis_summary TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  annotations JSONB DEFAULT '[]',
  scan_id INTEGER REFERENCES scan_results(id),
  cost_usd NUMERIC(10,4) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS chat_session_id TEXT;
ALTER TABLE plan_drafts ADD COLUMN IF NOT EXISTS chat_status TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS plan_chat_messages (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS evaluation_score JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS evaluation_reasoning TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS evaluation_events (
  id SERIAL PRIMARY KEY,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  passed BOOLEAN NOT NULL,
  score JSONB NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  cost_usd NUMERIC(10,4) DEFAULT 0,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_state (
  project_path TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_path, key)
);

CREATE TABLE IF NOT EXISTS scan_modules (
  id SERIAL PRIMARY KEY,
  project_path TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  entry_points TEXT[] NOT NULL DEFAULT '{}',
  involved_files TEXT[] NOT NULL DEFAULT '{}',
  data_flow TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_path, name)
);

ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS module_name TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS personas (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  task_types TEXT[] DEFAULT '{}',
  focus_areas TEXT[] DEFAULT '{}',
  usage_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

type TaskUpdateInput = Partial<
  Pick<
    Task,
    | "phase"
    | "status"
    | "plan"
    | "subtasks"
    | "review_results"
    | "iteration"
    | "total_cost_usd"
    | "git_branch"
    | "start_commit"
  >
> & { evaluation_score?: EvaluationScore; evaluation_reasoning?: string };
const TASK_UPDATE_FIELDS: Array<keyof TaskUpdateInput> = [
  "phase",
  "status",
  "plan",
  "subtasks",
  "review_results",
  "iteration",
  "total_cost_usd",
  "git_branch",
  "start_commit",
  "evaluation_score",
  "evaluation_reasoning",
];
const TASK_JSONB_FIELDS = new Set<keyof TaskUpdateInput>([
  "plan",
  "subtasks",
  "review_results",
  "evaluation_score",
]);

export class TaskStore {
  private sql: postgres.Sql | null;
  private isClosed = false;

  constructor(connectionString: string) {
    this.sql = getDb(connectionString);
  }

  /** Returns the live SQL connection, or throws if this instance has been closed. */
  private getSql(): postgres.Sql {
    if (this.isClosed || !this.sql) {
      throw new Error("TaskStore is closed");
    }
    return this.sql;
  }

  async init(): Promise<void> {
    const sql = this.getSql();
    await sql.unsafe(SCHEMA_SQL);
    log.info("TaskStore initialized");
  }

  // --- Tasks ---

  async createTask(
    projectPath: string,
    description: string,
    priority = 2,
    dependsOn: string[] = [],
  ): Promise<Task> {
    const sql = this.getSql();
    const [row] = await sql<Task[]>`
      INSERT INTO tasks (project_path, task_description, priority, depends_on)
      VALUES (${projectPath}, ${description}, ${priority}, ${dependsOn})
      RETURNING *
    `;
    return row;
  }

  async getTask(id: string): Promise<Task | null> {
    const sql = this.getSql();
    const [row] = await sql<Task[]>`SELECT * FROM tasks WHERE id = ${id}`;
    return row ?? null;
  }

  async listTasks(projectPath: string, status?: TaskStatus): Promise<Task[]> {
    const sql = this.getSql();
    if (status) {
      return sql<Task[]>`
        SELECT * FROM tasks WHERE project_path = ${projectPath} AND status = ${status}
        ORDER BY priority ASC, created_at ASC
      `;
    }
    return sql<Task[]>`
      SELECT * FROM tasks WHERE project_path = ${projectPath}
      ORDER BY priority ASC, created_at ASC
    `;
  }

  /** Paginated task list: active → queued → done/failed (by updated_at DESC) */
  async listTasksPaged(
    projectPath: string,
    page = 1,
    pageSize = 20,
    status?: TaskStatus | TaskStatus[],
  ): Promise<{ tasks: Task[]; total: number; page: number; pageSize: number }> {
    const sql = this.getSql();
    const offset = (page - 1) * pageSize;

    const statuses = status ? (Array.isArray(status) ? status : [status]) : [];
    const statusFilter =
      statuses.length > 0 ? sql`AND status = ANY(${statuses})` : sql``;

    const [countRow] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM tasks
      WHERE project_path = ${projectPath} ${statusFilter}
    `;
    const total = parseInt(countRow.count, 10);

    const tasks = await sql<Task[]>`
      SELECT * FROM tasks
      WHERE project_path = ${projectPath} ${statusFilter}
      ORDER BY
        CASE status
          WHEN 'pending_review' THEN 0
          WHEN 'active' THEN 1
          WHEN 'queued' THEN 2
          WHEN 'blocked' THEN 3
          WHEN 'done' THEN 4
          WHEN 'failed' THEN 5
          WHEN 'skipped' THEN 6
          ELSE 7
        END ASC,
        CASE WHEN status IN ('done', 'failed', 'skipped') THEN updated_at END DESC NULLS LAST,
        priority ASC,
        created_at ASC
      LIMIT ${pageSize} OFFSET ${offset}
    `;

    return { tasks, total, page, pageSize };
  }

  async updateTask(id: string, updates: TaskUpdateInput): Promise<void> {
    const sql = this.getSql();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const field of TASK_UPDATE_FIELDS) {
      const value = updates[field];
      if (value === undefined) continue;
      if (TASK_JSONB_FIELDS.has(field)) {
        sets.push(`${field} = $${vals.length + 1}::jsonb`);
      } else {
        sets.push(`${field} = $${vals.length + 1}`);
      }
      vals.push(value);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = NOW()");
    await sql.unsafe(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`,
      [...vals, id] as postgres.ParameterOrJSON<never>[],
    );
  }

  async incrementTaskCost(taskId: string, amount: number): Promise<void> {
    const sql = this.getSql();
    await sql.unsafe(
      "UPDATE tasks SET total_cost_usd = COALESCE(total_cost_usd, 0) + $1 WHERE id = $2",
      [amount, taskId] as postgres.ParameterOrJSON<never>[],
    );
  }

  async deleteTask(id: string): Promise<void> {
    const sql = this.getSql();
    await sql`DELETE FROM task_logs WHERE task_id = ${id}`;
    await sql`DELETE FROM tasks WHERE id = ${id}`;
  }

  async recoverActiveTasks(projectPath: string): Promise<number> {
    const sql = this.getSql();
    const activeTasks = await sql<Array<{ id: string; subtasks: unknown }>>`
      SELECT id, subtasks FROM tasks
      WHERE project_path = ${projectPath} AND status = 'active'
    `;
    if (activeTasks.length === 0) return 0;

    const recoveredWithDoneSubtasks = activeTasks
      .map((task) => ({ id: task.id, done: countDoneSubtasks(task.subtasks) }))
      .filter((task) => task.done > 0)
      .map((task) => `${task.id}: ${task.done} done`);

    if (recoveredWithDoneSubtasks.length > 0) {
      log.warn(
        `Recovering active tasks with completed subtasks (${recoveredWithDoneSubtasks.join(", ")})`,
      );
    }

    const result = await sql`
      UPDATE tasks SET status = 'queued', phase = 'executing', updated_at = NOW()
      WHERE project_path = ${projectPath} AND status = 'active'
    `;
    return result.count;
  }

  async getNextTask(projectPath: string): Promise<Task | null> {
    const sql = this.getSql();
    const [row] = await sql<Task[]>`
      SELECT * FROM tasks
      WHERE project_path = ${projectPath}
        AND status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM unnest(depends_on) AS dep_id
          WHERE dep_id NOT IN (
            SELECT id FROM tasks WHERE status = 'done'
          )
        )
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `;
    return row ?? null;
  }

  async findSimilarTask(
    projectPath: string,
    description: string,
  ): Promise<Task | null> {
    const sql = this.getSql();
    const [row] = await sql<Task[]>`
      SELECT *, similarity(task_description, ${description}) AS sim
      FROM tasks
      WHERE project_path = ${projectPath}
        AND status IN ('queued', 'active')
        AND similarity(task_description, ${description}) > 0.4
      ORDER BY sim DESC
      LIMIT 1
    `;
    return row ?? null;
  }

  async findSimilarCompletedTask(
    projectPath: string,
    description: string,
  ): Promise<Task | null> {
    const sql = this.getSql();
    const [row] = await sql<Task[]>`
      SELECT *, similarity(task_description, ${description}) AS sim
      FROM tasks
      WHERE project_path = ${projectPath}
        AND status = 'done'
        AND similarity(task_description, ${description}) > 0.4
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    return row ?? null;
  }

  /** Check if a similar task has recently failed/blocked (cooldown period) */
  async hasRecentlyFailedSimilar(
    projectPath: string,
    description: string,
    cooldownHours = 24,
  ): Promise<boolean> {
    const sql = this.getSql();
    const [row] = await sql<[{ found: boolean }]>`
      SELECT EXISTS(
        SELECT 1 FROM tasks
        WHERE project_path = ${projectPath}
          AND status IN ('failed', 'blocked')
          AND updated_at > NOW() - INTERVAL '1 hour' * ${cooldownHours}
          AND similarity(task_description, ${description}) > 0.4
      ) AS found
    `;
    return row.found;
  }

  // --- Logs ---

  async addLog(entry: Omit<TaskLog, "id" | "created_at">): Promise<void> {
    const sql = this.getSql();
    await sql`
      INSERT INTO task_logs (task_id, phase, agent, input_summary, output_summary, cost_usd, duration_ms)
      VALUES (${entry.task_id}, ${entry.phase}, ${entry.agent},
              ${entry.input_summary}, ${entry.output_summary},
              ${entry.cost_usd}, ${entry.duration_ms})
    `;
  }

  async getTaskLogs(taskId: string): Promise<TaskLog[]> {
    const sql = this.getSql();
    return sql<TaskLog[]>`
      SELECT * FROM task_logs WHERE task_id = ${taskId} ORDER BY created_at ASC
    `;
  }

  // --- Costs ---

  async addDailyCost(costUsd: number): Promise<void> {
    const sql = this.getSql();
    await sql`
      INSERT INTO daily_costs (date, total_cost_usd, task_count)
      VALUES (CURRENT_DATE, ${costUsd}, 1)
      ON CONFLICT (date) DO UPDATE SET
        total_cost_usd = daily_costs.total_cost_usd + ${costUsd},
        task_count = daily_costs.task_count + 1
    `;
  }

  async getDailyCost(
    date?: string,
  ): Promise<{ total_cost_usd: number; task_count: number }> {
    const sql = this.getSql();
    const d = date ?? new Date().toISOString().slice(0, 10);
    const [row] = await sql<
      Array<{ total_cost_usd: number; task_count: number }>
    >`
      SELECT total_cost_usd, task_count FROM daily_costs WHERE date = ${d}
    `;
    return row ?? { total_cost_usd: 0, task_count: 0 };
  }

  async getRecentCosts(
    days = 7,
  ): Promise<
    Array<{ date: string; total_cost_usd: number; task_count: number }>
  > {
    const sql = this.getSql();
    return sql<
      Array<{ date: string; total_cost_usd: number; task_count: number }>
    >`
      SELECT date::text, total_cost_usd, task_count FROM daily_costs
      ORDER BY date DESC LIMIT ${days}
    `;
  }

  // --- Scans ---

  async getRecentScans(projectPath: string, limit = 10): Promise<ScanResult[]> {
    const sql = this.getSql();
    return sql<ScanResult[]>`
      SELECT * FROM scan_results
      WHERE project_path = ${projectPath}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  async getOperationalMetrics(
    projectPath: string,
  ): Promise<OperationalMetrics> {
    const sql = this.getSql();
    const [
      cycleRows,
      passRateRows,
      queueDepthRows,
      statusRows,
      dailyCost,
      recentScans,
    ] = await Promise.all([
      sql<
        Array<{
          cycle_count: number | string | null;
          avg_cycle_duration_ms: number | string | null;
        }>
      >`
        SELECT
          COUNT(*)::int AS cycle_count,
          COALESCE(AVG(cycle_duration_ms), 0) AS avg_cycle_duration_ms
        FROM (
          SELECT t.id,
                 COALESCE(EXTRACT(EPOCH FROM (MAX(tl.created_at) - MIN(tl.created_at))) * 1000, 0) AS cycle_duration_ms
          FROM tasks t
          LEFT JOIN task_logs tl ON tl.task_id = t.id
          WHERE t.project_path = ${projectPath} AND t.status = 'done'
          GROUP BY t.id
        ) AS completed_cycles
      `,
      sql<
        Array<{
          done_count: number | string | null;
          failed_count: number | string | null;
        }>
      >`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)::int AS done_count,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed_count
        FROM tasks
        WHERE project_path = ${projectPath}
          AND status IN ('done', 'failed')
      `,
      sql<Array<{ queue_depth: number | string | null }>>`
        SELECT COUNT(*)::int AS queue_depth
        FROM tasks
        WHERE project_path = ${projectPath} AND status = 'queued'
      `,
      sql<Array<{ status: string; count: number | string | null }>>`
        SELECT status, COUNT(*)::int AS count
        FROM tasks
        WHERE project_path = ${projectPath}
        GROUP BY status
      `,
      this.getDailyCost(),
      this.getRecentScans(projectPath, 10),
    ]);

    const cycleRow = cycleRows[0];
    const passRateRow = passRateRows[0];
    const queueDepthRow = queueDepthRows[0];

    const doneCount = toFiniteNumber(passRateRow?.done_count);
    const failedCount = toFiniteNumber(passRateRow?.failed_count);
    const totalCompleted = doneCount + failedCount;
    const taskPassRate = totalCompleted > 0 ? doneCount / totalCompleted : 0;

    const tasksByStatus = statusRows.reduce<Record<string, number>>(
      (acc, row) => {
        if (!row?.status) {
          return acc;
        }
        acc[row.status] = toFiniteNumber(row.count);
        return acc;
      },
      {},
    );

    const recentHealthScores = recentScans
      .map((scan) => scan.health_score)
      .filter(
        (score): score is number =>
          typeof score === "number" && Number.isFinite(score),
      );

    return {
      cycleCount: toFiniteNumber(cycleRow?.cycle_count),
      avgCycleDurationMs: toFiniteNumber(cycleRow?.avg_cycle_duration_ms),
      taskPassRate,
      dailyCostUsd: toFiniteNumber(dailyCost.total_cost_usd),
      queueDepth: toFiniteNumber(queueDepthRow?.queue_depth),
      tasksByStatus,
      recentHealthScores,
    };
  }

  async getPendingReviewTasks(projectPath: string): Promise<Task[]> {
    const sql = this.getSql();
    return sql<Task[]>`
      SELECT * FROM tasks
      WHERE project_path = ${projectPath} AND status = 'pending_review'
      ORDER BY priority ASC, created_at ASC
    `;
  }

  // --- Pipeline Health ---

  async getBlockedTaskSummary(
    projectPath: string,
    windowHours = 48,
    limit = 20,
  ): Promise<{
    blockedCount: number;
    recentFailures: Array<{
      taskId: string;
      description: string;
      phase: string;
      agent: string;
      outputSummary: string;
      updatedAt: Date;
    }>;
  }> {
    const sql = this.getSql();
    const [countRow] = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM tasks
      WHERE project_path = ${projectPath}
        AND status IN ('blocked', 'failed')
        AND updated_at > NOW() - make_interval(hours => ${windowHours})
    `;
    const blockedCount = countRow?.count ?? 0;

    const recentFailures = await sql<
      Array<{
        taskId: string;
        description: string;
        phase: string;
        agent: string;
        outputSummary: string;
        updatedAt: Date;
      }>
    >`
      SELECT
        t.id AS "taskId",
        t.task_description AS description,
        COALESCE(lg.phase, t.phase) AS phase,
        COALESCE(lg.agent, '') AS agent,
        COALESCE(lg.output_summary, '') AS "outputSummary",
        t.updated_at AS "updatedAt"
      FROM tasks t
      LEFT JOIN LATERAL (
        SELECT phase, agent, output_summary
        FROM task_logs
        WHERE task_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lg ON true
      WHERE t.project_path = ${projectPath}
        AND t.status IN ('blocked', 'failed')
        AND t.updated_at > NOW() - make_interval(hours => ${windowHours})
      ORDER BY t.updated_at DESC
      LIMIT ${limit}
    `;

    return { blockedCount, recentFailures };
  }

  async requeueBlockedTasks(
    projectPath: string,
    taskIds: string[],
  ): Promise<number> {
    if (taskIds.length === 0) return 0;
    const sql = this.getSql();
    const result = await sql`
      UPDATE tasks
      SET status = 'queued', iteration = 0, updated_at = NOW()
      WHERE id = ANY(${taskIds})
        AND project_path = ${projectPath}
        AND status IN ('blocked', 'failed')
    `;
    return result.count;
  }

  // --- Plan Drafts ---

  async getPlanDraft(id: number): Promise<PlanDraft | null> {
    const sql = this.getSql();
    const [row] = await sql<PlanDraft[]>`
      SELECT * FROM plan_drafts WHERE id = ${id}
    `;
    return row ?? null;
  }

  async listPlanDrafts(
    projectPath: string,
    status?: PlanReviewStatus,
  ): Promise<PlanDraft[]> {
    const sql = this.getSql();
    if (status) {
      return sql<PlanDraft[]>`
        SELECT * FROM plan_drafts
        WHERE project_path = ${projectPath} AND status = ${status}
        ORDER BY created_at DESC
      `;
    }
    return sql<PlanDraft[]>`
      SELECT * FROM plan_drafts
      WHERE project_path = ${projectPath}
      ORDER BY created_at DESC
    `;
  }

  async updatePlanDraftStatus(
    id: number,
    status: PlanReviewStatus,
    annotations?: PlanDraftAnnotation[],
  ): Promise<void> {
    const sql = this.getSql();
    if (annotations) {
      await sql`
        UPDATE plan_drafts
        SET status = ${status}, annotations = ${sql.json(annotations as ReviewAnnotationsJson & postgres.JSONValue)}, reviewed_at = NOW()
        WHERE id = ${id}
      `;
    } else {
      await sql`
        UPDATE plan_drafts
        SET status = ${status}, reviewed_at = NOW()
        WHERE id = ${id}
      `;
    }
  }

  // --- Plan Chat Sessions ---

  async createChatSession(projectPath: string): Promise<PlanDraft> {
    const sql = this.getSql();
    const [row] = await sql<PlanDraft[]>`
      INSERT INTO plan_drafts (project_path, plan, chat_status, status)
      VALUES (${projectPath}, '{"tasks":[]}'::jsonb, 'chatting', 'draft')
      RETURNING *
    `;
    return row;
  }

  async addChatMessage(
    sessionId: number,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChatMessage> {
    const sql = this.getSql();
    const [row] = await sql<ChatMessage[]>`
      INSERT INTO plan_chat_messages (session_id, role, content, metadata)
      VALUES (${sessionId}, ${role}, ${content}, ${sql.json((metadata ?? {}) as ChatMessageMetadata)})
      RETURNING *
    `;
    return row;
  }

  async getChatMessages(sessionId: number): Promise<ChatMessage[]> {
    const sql = this.getSql();
    return sql<ChatMessage[]>`
      SELECT * FROM plan_chat_messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
    `;
  }

  async updateChatStatus(draftId: number, status: ChatStatus): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE plan_drafts SET chat_status = ${status} WHERE id = ${draftId}
    `;
  }

  async updateChatSessionId(
    draftId: number,
    chatSessionId: string,
  ): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE plan_drafts SET chat_session_id = ${chatSessionId} WHERE id = ${draftId}
    `;
  }

  async updatePlanDraftPlan(
    draftId: number,
    data: {
      plan: unknown;
      markdown: string;
      reasoning: string;
      cost_usd: number;
    },
  ): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE plan_drafts
      SET plan = ${sql.json(data.plan as TaskPlanJson & postgres.JSONValue)},
          markdown = ${data.markdown},
          reasoning = ${data.reasoning},
          cost_usd = ${data.cost_usd}
      WHERE id = ${draftId}
    `;
  }

  async getServiceState(
    projectPath: string,
    key: string,
  ): Promise<string | null> {
    const sql = this.getSql();
    const rows =
      await sql`SELECT value FROM service_state WHERE project_path = ${projectPath} AND key = ${key}`;
    return rows.length > 0 ? rows[0].value : null;
  }

  async setServiceState(
    projectPath: string,
    key: string,
    value: string,
  ): Promise<void> {
    const sql = this.getSql();
    await sql`INSERT INTO service_state (project_path, key, value, updated_at)
              VALUES (${projectPath}, ${key}, ${value}, NOW())
              ON CONFLICT (project_path, key) DO UPDATE SET value = ${value}, updated_at = NOW()`;
  }

  // --- Personas ---

  async getPersona(name: string): Promise<Persona | null> {
    const sql = this.getSql();
    const rows = await sql<
      Persona[]
    >`SELECT * FROM personas WHERE name = ${name} LIMIT 1`;
    return rows[0] ?? null;
  }

  async listPersonas(): Promise<Persona[]> {
    const sql = this.getSql();
    return sql<Persona[]>`SELECT * FROM personas ORDER BY name`;
  }

  async upsertPersona(p: {
    name: string;
    role: string;
    content: string;
    task_types: string[];
    focus_areas: string[];
  }): Promise<Persona> {
    const sql = this.getSql();
    const [row] = await sql<Persona[]>`
      INSERT INTO personas (name, role, content, task_types, focus_areas)
      VALUES (${p.name}, ${p.role}, ${p.content}, ${p.task_types}, ${p.focus_areas})
      ON CONFLICT (name) DO UPDATE SET
        role = EXCLUDED.role,
        content = EXCLUDED.content,
        task_types = EXCLUDED.task_types,
        focus_areas = EXCLUDED.focus_areas,
        updated_at = NOW()
      RETURNING *`;
    return row;
  }

  async updatePersonaStats(name: string, success: boolean): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE personas SET
        usage_count = usage_count + 1,
        success_rate = CASE
          WHEN usage_count = 0 THEN ${success ? 1.0 : 0.0}
          ELSE (success_rate * usage_count + ${success ? 1 : 0})::real / (usage_count + 1)
        END,
        updated_at = NOW()
      WHERE name = ${name}`;
  }

  async updatePersonaContent(name: string, content: string): Promise<void> {
    const sql = this.getSql();
    await sql`UPDATE personas SET content = ${content}, updated_at = NOW() WHERE name = ${name}`;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await closeDb();
    this.sql = null;
  }
}

function countDoneSubtasks(subtasks: unknown): number {
  if (!Array.isArray(subtasks)) return 0;
  return subtasks.reduce((count, subtask) => {
    if (typeof subtask !== "object" || subtask === null) return count;
    const status = (subtask as { status?: unknown }).status;
    return status === "done" ? count + 1 : count;
  }, 0);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
