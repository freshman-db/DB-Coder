import { log } from '../utils/logger.js';

interface ClaudeMemResult {
  id: number;
  title?: string;
  text: string;
}

export class ProjectMemory {
  private baseUrl: string;

  constructor(claudeMemUrl: string) {
    this.baseUrl = claudeMemUrl.replace(/\/$/, '');
  }

  async search(query: string, limit = 10): Promise<ClaudeMemResult[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { results?: ClaudeMemResult[] };
      return data.results ?? [];
    } catch {
      log.warn('ProjectMemory: claude-mem unavailable, degrading gracefully');
      return [];
    }
  }

  async timeline(anchor: number, depthBefore = 3, depthAfter = 3): Promise<ClaudeMemResult[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchor, depth_before: depthBefore, depth_after: depthAfter }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { results?: ClaudeMemResult[] };
      return data.results ?? [];
    } catch {
      return [];
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
