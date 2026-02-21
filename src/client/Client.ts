import { log } from '../utils/logger.js';

export class Client {
  private baseUrl: string;
  private apiToken?: string;

  constructor(port = 18800, host = '127.0.0.1', apiToken?: string) {
    this.baseUrl = `http://${host}:${port}`;
    this.apiToken = apiToken;
  }

  async status(): Promise<unknown> {
    return this.get('/api/status');
  }

  async addTask(description: string, priority = 2): Promise<unknown> {
    return this.post('/api/tasks', { description, priority });
  }

  async listTasks(): Promise<unknown> {
    return this.get('/api/tasks');
  }

  async getTask(id: string): Promise<unknown> {
    return this.get(`/api/tasks/${id}`);
  }

  async deleteTask(id: string): Promise<unknown> {
    return this.del(`/api/tasks/${id}`);
  }

  async pause(): Promise<unknown> {
    return this.post('/api/control/pause');
  }

  async resume(): Promise<unknown> {
    return this.post('/api/control/resume');
  }

  async triggerScan(depth = 'normal'): Promise<unknown> {
    return this.post('/api/control/scan', { depth });
  }

  async searchMemory(query: string): Promise<unknown> {
    return this.get(`/api/memory?q=${encodeURIComponent(query)}`);
  }

  async addMemory(category: string, title: string, content: string, tags: string[] = []): Promise<unknown> {
    return this.post('/api/memory', { category, title, content, tags });
  }

  async getCost(): Promise<unknown> {
    return this.get('/api/cost');
  }

  async followLogs(onEntry: (entry: unknown) => void): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/logs?follow=true`, {
      headers: this.getAuthHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const entry = JSON.parse(line.slice(6));
            onEntry(entry);
          } catch (err) {
            log.debug('Failed to parse SSE log entry', { error: err, line });
          }
        }
      }
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async post(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async del(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.getAuthHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private getAuthHeaders(): Record<string, string> {
    if (!this.apiToken) return {};
    return { Authorization: `Bearer ${this.apiToken}` };
  }
}
