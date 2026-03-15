import { log } from "../utils/logger.js";
import type {
  OperationalMetrics,
  Task,
  TaskLog,
  SpawnReason,
} from "../memory/types.js";

// --- Typed response interfaces matching routes.ts ---

export interface DailyCost {
  date: string;
  total_cost_usd: number;
  task_count: number;
}

export interface StatusResponse {
  state: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  paused: boolean;
  patrolling: boolean;
  scanInterval: number;
  projectPath: string;
  dailyCosts: DailyCost[];
}

export interface ListTasksResponse {
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GetTaskResponse extends Task {
  logs: TaskLog[];
  childTasks: Task[];
}

export interface CostResponse {
  costs: DailyCost[];
  sessionCost: number;
}

export type MetricsResponse = OperationalMetrics;

export class Client {
  private baseUrl: string;
  private apiToken?: string;

  constructor(port = 18801, host = "127.0.0.1", apiToken?: string) {
    this.baseUrl = `http://${host}:${port}`;
    this.apiToken = apiToken;
  }

  async status(): Promise<StatusResponse> {
    return this.get("/api/status");
  }

  async addTask(
    description: string,
    priority = 2,
    options?: { parentTaskId?: string; spawnReason?: SpawnReason },
  ): Promise<Task> {
    return this.post("/api/tasks", { description, priority, ...options });
  }

  async listTasks(status?: string): Promise<ListTasksResponse> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.get(`/api/tasks${query}`);
  }

  async getBlockedSummary(
    windowHours?: number,
  ): Promise<{ blockedCount: number; recentFailures: unknown[] }> {
    const query =
      windowHours !== undefined ? `?windowHours=${windowHours}` : "";
    return this.get(`/api/tasks/blocked-summary${query}`);
  }

  async getTaskLogs(id: string): Promise<TaskLog[]> {
    return this.get(`/api/tasks/${id}/logs`);
  }

  async requeueTasks(
    taskIds: string[],
  ): Promise<{ requeued: number; requested: number }> {
    return this.post("/api/tasks/requeue", { taskIds });
  }

  async getTask(id: string): Promise<GetTaskResponse> {
    return this.get(`/api/tasks/${id}`);
  }

  async deleteTask(id: string): Promise<{ ok: boolean }> {
    return this.del(`/api/tasks/${id}`);
  }

  async pendingReviewTasks(): Promise<Task[]> {
    return this.get("/api/tasks/pending-review");
  }

  async approveTask(
    id: string,
    notes?: string,
  ): Promise<{ ok: boolean; status: string; notes: string | null }> {
    const body = notes ? { notes } : undefined;
    return this.post(`/api/tasks/${id}/approve`, body);
  }

  async skipTask(id: string): Promise<{ ok: boolean; status: string }> {
    return this.post(`/api/tasks/${id}/skip`);
  }

  async pause(): Promise<{ paused: boolean }> {
    return this.post("/api/control/pause");
  }

  async resume(): Promise<{ paused: boolean }> {
    return this.post("/api/control/resume");
  }

  async triggerScan(
    depth = "normal",
  ): Promise<{ triggered: boolean; depth: string }> {
    return this.post("/api/control/scan", { depth });
  }

  async getCost(): Promise<CostResponse> {
    return this.get("/api/cost");
  }

  async metrics(): Promise<MetricsResponse> {
    return this.get("/api/metrics");
  }

  async patrolStart(): Promise<{ ok: boolean; patrolling: boolean }> {
    return this.post("/api/patrol/start");
  }

  async patrolStop(): Promise<{ ok: boolean; patrolling: boolean }> {
    return this.post("/api/patrol/stop");
  }

  async followLogs(
    onEntry: (entry: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/logs?follow=true`, {
      headers: this.getAuthHeaders(),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const entry = JSON.parse(line.slice(6));
              onEntry(entry);
            } catch (err) {
              log.debug("Failed to parse SSE log entry", { error: err, line });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.getAuthHeaders(), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async del<T = unknown>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private getAuthHeaders(): Record<string, string> {
    if (!this.apiToken) return {};
    return { Authorization: `Bearer ${this.apiToken}` };
  }
}
