import { log } from '../utils/logger.js';

interface ClaudeMemResult {
  id: number;
  title?: string;
  text: string;
}

type ProjectMemoryResult<T extends unknown[]> =
  | (T & { ok: true; data: T })
  | (T & { ok: false; error: string });

export class ProjectMemory {
  private baseUrl: string;

  constructor(claudeMemUrl: string) {
    this.baseUrl = claudeMemUrl.replace(/\/$/, '');
  }

  async search(query: string, limit = 10): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const error = `ProjectMemory search failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as { results?: ClaudeMemResult[] };
      const results = data.results ?? [];
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory search failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async timeline(anchor: number, depthBefore = 3, depthAfter = 3): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const res = await fetch(`${this.baseUrl}/api/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor, depth_before: depthBefore, depth_after: depthAfter }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const error = `ProjectMemory timeline failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as { results?: ClaudeMemResult[] };
      const results = data.results ?? [];
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory timeline failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async save(text: string, title?: string, project?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/save_memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, title, project }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      log.warn('ProjectMemory: failed to save, claude-mem may be unavailable');
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 1 }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
