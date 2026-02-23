import { log } from '../utils/logger.js';
import { getErrorMessage } from '../utils/parse.js';
import { calculateRetryDelay } from '../utils/retry.js';

interface ClaudeMemResult {
  id: number;
  title?: string;
  text: string;
}

/** MCP-style response from claude-mem worker */
interface McpResponse {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ProjectMemoryResult<T extends unknown[]> =
  | (T & { ok: true; data: T })
  | (T & { ok: false; error: string });

const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;

export class ProjectMemory {
  private baseUrl: string;

  constructor(claudeMemUrl: string) {
    this.baseUrl = claudeMemUrl.replace(/\/$/, '');
  }

  /** Extract text from claude-mem MCP-style response {content: [{type:"text", text:"..."}]} */
  private extractText(data: McpResponse): string {
    if (data.content && Array.isArray(data.content) && data.content.length > 0) {
      return data.content.map(c => c.text).join('\n');
    }
    return '';
  }

  private async fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
    const retryLimit = Math.max(0, Math.floor(maxRetries));
    const { signal, ...requestOptions } = options;

    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const requestInit: RequestInit = signal
        ? { ...requestOptions, signal: AbortSignal.any([signal, timeoutSignal]) }
        : { ...requestOptions, signal: timeoutSignal };

      try {
        const response = await fetch(url, requestInit);
        if (response.status >= 500 && attempt < retryLimit) {
          await this.waitForRetry(url, attempt, retryLimit, `HTTP ${response.status}`);
          continue;
        }
        return response;
      } catch (error) {
        if (!this.isRetryableFetchError(error) || attempt >= retryLimit) {
          throw error;
        }
        const errorName = typeof error === 'object' && error !== null && 'name' in error
          ? String(error.name)
          : 'UnknownError';
        await this.waitForRetry(url, attempt, retryLimit, errorName);
      }
    }
  }

  private isRetryableFetchError(error: unknown): boolean {
    if (error instanceof TypeError) {
      return true;
    }
    if (typeof error !== 'object' || error === null || !('name' in error)) {
      return false;
    }
    const name = String(error.name);
    return name === 'AbortError' || name === 'TimeoutError';
  }

  private async waitForRetry(url: string, attempt: number, maxRetries: number, reason: string): Promise<void> {
    const delayMs = calculateRetryDelay({
      attempt,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
    });
    const retryAttempt = attempt + 1;
    log.debug(`ProjectMemory retry ${retryAttempt}/${maxRetries} for ${url} in ${delayMs}ms (${reason})`);
    await this.sleep(delayMs);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async search(query: string, limit = 10): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const params = new URLSearchParams({ query, limit: String(limit) });
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/search?${params}`, {});
      if (!res.ok) {
        const error = `ProjectMemory search failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as McpResponse;
      const text = this.extractText(data);
      // Return as a single-element array with the formatted text
      const results: ClaudeMemResult[] = text ? [{ id: 0, text }] : [];
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory search failed: ${getErrorMessage(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async timeline(anchor: number, depthBefore = 3, depthAfter = 3): Promise<ProjectMemoryResult<ClaudeMemResult[]>> {
    try {
      const params = new URLSearchParams({
        anchor: String(anchor),
        depth_before: String(depthBefore),
        depth_after: String(depthAfter),
      });
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/timeline?${params}`, {});
      if (!res.ok) {
        const error = `ProjectMemory timeline failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
        log.warn(error);
        return Object.assign([], { ok: false as const, error });
      }
      const data = await res.json() as McpResponse;
      const text = this.extractText(data);
      const results: ClaudeMemResult[] = text ? [{ id: anchor, text }] : [];
      return Object.assign(results, { ok: true as const, data: results });
    } catch (err) {
      const error = `ProjectMemory timeline failed: ${getErrorMessage(err)}`;
      log.warn(error);
      return Object.assign([], { ok: false as const, error });
    }
  }

  async save(text: string, title?: string, project?: string): Promise<boolean> {
    try {
      const body: Record<string, string> = { text };
      if (title) body.title = title;
      if (project) body.project = project;
      const res = await this.fetchWithRetry(`${this.baseUrl}/api/memory/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      log.warn('ProjectMemory: failed to save, claude-mem may be unavailable');
      return false;
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/search?query=ping&limit=1`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
